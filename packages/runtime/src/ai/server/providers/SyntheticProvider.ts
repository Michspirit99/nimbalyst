/**
 * Synthetic.new agent provider for Nimbalyst
 *
 * Synthetic.new is a hosted inference API exposing open-weight models
 * (Llama, Qwen, DeepSeek, Kimi, GLM, etc.) via an OpenAI-compatible chat
 * completions API. Unlike the other agent providers (claude-code/codex/opencode/
 * copilot-cli) which delegate the agent loop to an external SDK, Synthetic.new
 * has no agent backend — so the agent loop (tool-call → execute → feed back →
 * continue) lives in our `SyntheticProtocol`. This provider is the thin
 * `BaseAgentProvider` wrapper that wires MCP config, logging, the transcript
 * adapter, and the tool executor, then delegates streaming to the protocol.
 *
 * See `design/agents/agent-provider-architecture.md` and
 * `nimbalyst-local/plans/synthetic-agent-provider.md`.
 */

import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { buildClaudeCodeSystemPrompt } from '../../prompt';
import {
  DocumentContext,
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
  AIModel,
  ChatAttachment,
  ToolResult,
} from '../types';
import { ModelIdentifier } from '../ModelIdentifier';
import { SyntheticProtocol, type OpenAITool } from '../protocols/SyntheticProtocol';
import { McpConfigService } from '../services/McpConfigService';
import {
  areTrackerToolsEnabled,
  getMcpConfigService,
  isInternalMcpServerEnabled,
  resolveTrackersWorkspacePath,
} from '../services/mcpServerConfig';
import { RuntimeMcpHttpBridge, type RuntimeMcpToolTarget } from '../services/RuntimeMcpHttpBridge';
import type { MCPServerConfig } from '../../../types/MCPServerConfig';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';
import { AgentMessagesRepository } from '../../../storage/repositories/AgentMessagesRepository';
import type { ProtocolEvent } from '../protocols/ProtocolInterface';

interface SyntheticProviderDeps {
  protocol?: SyntheticProtocol;
}

/**
 * Resolve an MCP tool target by its OpenAI function name.
 *
 * First tries the exact namespaced name (`mcp__<server>__<tool>`). Some models
 * call an always-loaded core tool (e.g. `update_session_meta`, served on the
 * `nimbalyst` core server) with a different first-party server prefix (e.g.
 * `mcp__nimbalyst-host__update_session_meta`); the exact lookup misses, so we
 * fall back to resolving by base tool name across all registered targets so the
 * call still lands on the owning server instead of failing with "Unknown tool".
 */
export function resolveMcpTargetByName(
  targets: Map<string, RuntimeMcpToolTarget>,
  name: string,
): RuntimeMcpToolTarget | undefined {
  const exact = targets.get(name);
  if (exact) return exact;
  const baseName = name.replace(/^mcp__[^\s]+__/, '');
  if (baseName === name) return undefined;
  for (const target of targets.values()) {
    if (target.toolName === baseName) return target;
  }
  return undefined;
}

export interface SyntheticConfig extends ProviderConfig {
  baseUrl?: string;
}

export class SyntheticProvider extends BaseAgentProvider {
  static readonly DEFAULT_BASE_URL = 'https://api.synthetic.new/openai/v1';
  static readonly DEFAULT_MODEL = 'hf:Qwen/Qwen3.6-72B-Instruct';

  private readonly protocol: SyntheticProtocol;
  private readonly mcpConfigService: McpConfigService;
  private readonly mcpBridge = new RuntimeMcpHttpBridge();
  private baseUrl: string = SyntheticProvider.DEFAULT_BASE_URL;

  // MCP config loader (injected from the Electron main process at startup).
  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;

  constructor(deps?: SyntheticProviderDeps) {
    super();
    this.protocol = deps?.protocol ?? new SyntheticProtocol();
    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: SyntheticProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: null,
    });
  }

  async initialize(config: SyntheticConfig): Promise<void> {
    // Merge (don't replace): MessageStreamingHandler's per-turn credential
    // refresh calls initialize with {apiKey, model, maxTokens, temperature}
    // and no baseUrl — preserve a previously-configured baseUrl / default.
    this.config = { ...(this.config ?? {}), ...config } as ProviderConfig;
    this.baseUrl = config.baseUrl || this.baseUrl || SyntheticProvider.DEFAULT_BASE_URL;

    if (!this.config.apiKey) {
      throw new Error('API key is required for Synthetic.new provider');
    }
  }

  getProviderName(): string {
    return 'synthetic';
  }

  getProviderSessionData(sessionId: string): { providerSessionId: string | undefined } | null {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    if (!providerSessionId) return null;
    return { providerSessionId };
  }

  public static setMcpConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    SyntheticProvider.mcpConfigLoader = loader;
  }

  static getKnownSlashCommands(): string[] {
    return ['compact'];
  }

  getSlashCommands(): string[] {
    return SyntheticProvider.getKnownSlashCommands();
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      mcpSupport: true,
      edits: true,
      resumeSession: true,
      supportsFileTools: true,
    };
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[]
  ): AsyncIterableIterator<StreamChunk> {
    const systemPrompt = this.buildSystemPrompt(documentContext, workspacePath);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

    if (sessionId && (systemPrompt || userMessageAddition || (attachments && attachments.length > 0))) {
      const attachmentSummaries = attachments?.map((att) => ({
        type: att.type,
        filename: att.filename || 'unknown',
        mimeType: att.mimeType,
        filepath: att.filepath,
      })) ?? [];
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: attachmentSummaries,
        timestamp: Date.now(),
      });
    }

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const configuredModel = (this.config?.model as string | undefined) || SyntheticProvider.DEFAULT_MODEL;
      const model = configuredModel.replace('synthetic:', '');

      if (message.trim() === '/compact') {
        yield* this.compactSession({
          systemPrompt,
          sessionId,
          messages: messages ?? [],
          model,
          abortSignal: abortController.signal,
        });
        return;
      }

      // Build the OpenAI-format message history seed from prior session state.
      // Synthetic.new has no provider-side session backend. On model switch the
      // cached provider/protocol is destroyed, so we must be able to reconstruct
      // context from persisted agent messages rather than relying on in-memory
      // protocol history or the legacy SessionData.messages array alone.
      const priorMessages = await this.buildPriorMessages(systemPrompt, messages ?? [], sessionId);

      if (sessionId) {
        await this.logAgentMessageBestEffort(sessionId, 'input', messageWithContext);
      }

      // Gather MCP servers and expose URL-based MCP tools as OpenAI functions.
      // SDK-backed providers hand this to their backend; Synthetic owns the
      // loop, so it uses RuntimeMcpHttpBridge for listTools/callTool.
      const mcpConfigWorkspacePath = documentContext?.mcpConfigWorkspacePath || workspacePath;
      const mcpServers = mcpConfigWorkspacePath
        ? await this.mcpConfigService.getMcpServersConfig({ sessionId: sessionId ?? '', workspacePath: mcpConfigWorkspacePath })
        : {};

      // `model` was normalized above by stripping the "synthetic:" provider
      // prefix — Synthetic.new wants the raw "hf:org/Model" id.

      // Built-in tools + URL-based MCP tools in OpenAI function-calling format.
      let mcpToolTargets = new Map<string, RuntimeMcpToolTarget>();
      let mcpTools: OpenAITool[] = [];
      if (Object.keys(mcpServers).length > 0) {
        const listed = await this.mcpBridge.listOpenAITools(mcpServers as Record<string, any>);
        mcpTools = listed.tools;
        mcpToolTargets = listed.targets;
      }
      const tools: OpenAITool[] = [
        ...(this.getToolsInOpenAIFormat() as OpenAITool[]),
        ...mcpTools,
      ];

      const sessionOptions = {
        workspacePath: workspacePath ?? '',
        model,
        mcpServers,
        raw: {
          apiKey: this.config?.apiKey,
          baseUrl: this.baseUrl,
          model,
          tools,
          priorMessages,
          contextWindow: SyntheticProvider.contextWindowForModel(model),
          abortSignal: abortController.signal,
        },
      };

      const existingSessionId = sessionId ? this.sessions.getSessionId(sessionId) : undefined;
      const session = existingSessionId
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      // Wire the tool executor: delegate to the centralized BaseAIProvider
      // helper, which checks the tool registry, dispatches via the registered
      // tool handler, and emits tool:start / tool:complete / tool:error events.
      // (Phase 2 will additionally dispatch MCP tool names to an MCP client.)
      this.protocol.toolExecutor = async (name, args) => {
        let result: unknown;
        try {
          const mcpTarget = resolveMcpTargetByName(mcpToolTargets, name);
          if (mcpTarget) {
            result = await this.mcpBridge.callTool(mcpTarget, args);
          } else {
            result = await this.executeToolCall(name, args);
          }
        } catch (err: any) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Error: ${msg}`, result: { success: false, error: msg } as ToolResult };
        }
        const content = typeof result === 'string' ? result : safeStringify(result);
        return { content, result: { success: true, result } as ToolResult };
      };

      if (sessionId) {
        this.sessions.setProviderSessionData(sessionId, { providerSessionId: session.id });
      }

      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');
      transcriptAdapter.userMessage(
        messageWithContext,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any
      );

      for await (const event of this.protocol.sendMessage(session, {
        content: messageWithContext,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
      })) {
        if (abortController.signal.aborted) throw new Error('Operation cancelled');

        // Persist raw protocol events for transcript reconstruction (Phase 3
        // will add a dedicated SyntheticRawParser; until then we still log so
        // the raw audit trail is complete and resume has history to replay).
        if (sessionId && event.type === 'raw_event') {
          // no raw events today; reserved.
        }

        for (const item of transcriptAdapter.processEvent(event as ProtocolEvent)) {
          switch (item.kind) {
            case 'text': {
              yield { type: 'text', content: item.text };
              if (sessionId) {
                this.logAgentMessageNonBlocking(sessionId, this.getProviderName(), 'output', item.text, {
                  searchable: true,
                  hidden: false,
                });
              }
              break;
            }
            case 'tool_call': {
              yield { type: 'tool_call', toolCall: item.toolCall };
              if (sessionId) {
                this.logAgentMessageNonBlocking(sessionId, this.getProviderName(), 'output', JSON.stringify({
                  type: 'tool_call_started',
                  toolName: item.toolCall.name,
                  toolDisplayName: item.toolCall.name,
                  arguments: item.toolCall.arguments ?? {},
                  providerToolCallId: item.toolCall.id ?? null,
                }), { searchable: false, hidden: false });
              }
              break;
            }
            case 'tool_result': {
              yield {
                type: 'tool_call',
                toolCall: { id: item.toolResult.id, name: item.toolResult.name, result: item.toolResult.result },
              };
              if (sessionId) {
                this.logAgentMessageNonBlocking(sessionId, this.getProviderName(), 'output', JSON.stringify({
                  type: 'tool_call_completed',
                  providerToolCallId: item.toolResult.id ?? null,
                  status: 'completed',
                  result: safeStringify(item.toolResult.result),
                  isError: false,
                }), { searchable: false, hidden: false });
              }
              break;
            }
            case 'complete': {
              yield {
                type: 'complete',
                content: item.event.content,
                isComplete: true,
                usage: item.event.usage,
                contextFillTokens: item.event.contextFillTokens,
                contextWindow: item.event.contextWindow,
              };
              if (sessionId) {
                this.logAgentMessageNonBlocking(sessionId, this.getProviderName(), 'output', JSON.stringify({
                  type: 'turn_ended',
                  contextFill: {
                    inputTokens: item.event.contextFillTokens ?? item.event.usage?.input_tokens ?? 0,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                    outputTokens: item.event.usage?.output_tokens ?? 0,
                    totalContextTokens: item.event.contextFillTokens ?? item.event.usage?.input_tokens ?? 0,
                  },
                  contextWindow: item.event.contextWindow ?? 0,
                  cumulativeUsage: {
                    inputTokens: item.event.usage?.input_tokens ?? 0,
                    outputTokens: item.event.usage?.output_tokens ?? 0,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                    costUSD: 0,
                    webSearchRequests: 0,
                  },
                  contextCompacted: false,
                }), { searchable: false, hidden: false });
              }
              break;
            }
            case 'error':
              yield { type: 'error', error: item.message };
              if (sessionId) {
                this.logAgentMessageNonBlocking(sessionId, this.getProviderName(), 'output', JSON.stringify({ type: 'system_message', text: item.message, systemType: 'error', searchable: false }), {
                  searchable: false,
                  hidden: false,
                });
              }
              break;
            case 'raw_event':
            case 'reasoning':
            case 'planning_mode':
            case 'unknown':
              break;
          }
        }
      }

      if (sessionId) {
        await this.flushPendingWrites();
        await this.processTranscriptMessages(sessionId);
      }
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        console.error('[SyntheticProvider] Error in sendMessage:', errorMessage);
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  abort(): void {
    super.abort();
  }

  // Drive the transcript transformer incrementally so canonical events
  // appear in the UI while the session is still streaming (mirrors OpenCode).
  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().processNewMessages(sessionId, this.getProviderName());
      }
    } catch {
      // Best effort -- the next call (or end-of-turn ensureUpToDate) catches up.
    }
  }

  private async buildPriorMessages(systemPrompt: string, messages: any[], sessionId?: string): Promise<unknown[]> {
    // Prefer persisted Synthetic agent messages when available. This is the
    // durable source that survives provider cache invalidation caused by a model
    // switch. Fall back to legacy SessionData.messages for tests/older sessions.
    if (sessionId) {
      try {
        const agentMessages = await AgentMessagesRepository.list(sessionId, { includeHidden: true, limit: 2000 });
        const syntheticMessages = agentMessages.filter((msg) => msg.source === this.getProviderName());
        const reconstructed = buildPriorMessagesFromAgentMessages(systemPrompt, syntheticMessages);
        if (reconstructed.length > 1) return reconstructed;
      } catch {
        // Repository is optional in unit tests and early startup; fallback below.
      }
    }
    return buildPriorMessages(systemPrompt, messages);
  }

  private async *compactSession(options: {
    systemPrompt: string;
    sessionId?: string;
    messages: any[];
    model: string;
    abortSignal: AbortSignal;
  }): AsyncIterableIterator<StreamChunk> {
    if (!options.sessionId) {
      yield { type: 'error', error: 'Synthetic /compact requires an active session' };
      return;
    }

    const priorMessages = await this.buildPriorMessages(options.systemPrompt, options.messages, options.sessionId);
    const conversationText = priorMessages
      .filter((msg: any) => msg?.role !== 'system')
      .map((msg: any) => `${String(msg.role || 'message').toUpperCase()}: ${stringContent(msg.content)}`)
      .filter((line) => line.trim().length > 0)
      .join('\n\n');

    if (!conversationText.trim()) {
      yield { type: 'text', content: 'Nothing to compact yet.' };
      yield { type: 'complete', content: 'Nothing to compact yet.', isComplete: true };
      return;
    }

    const summary = await this.generateCompactionSummary({
      model: options.model,
      conversationText,
      abortSignal: options.abortSignal,
    });

    await this.logAgentMessageBestEffort(
      options.sessionId,
      'output',
      summary,
      {
        searchable: false,
        hidden: true,
        metadata: { syntheticCompaction: true, compactedAt: new Date().toISOString() },
      }
    );

    const notice = 'Conversation compacted. Future Synthetic turns will use a summary of the earlier context.';
    yield { type: 'text', content: notice };
    yield { type: 'complete', content: notice, isComplete: true };
  }

  private async generateCompactionSummary(options: {
    model: string;
    conversationText: string;
    abortSignal: AbortSignal;
  }): Promise<string> {
    const apiKey = this.config?.apiKey;
    if (!apiKey) throw new Error('Synthetic.new API key not configured');

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'You compact coding-agent conversations. Preserve user goals, decisions, constraints, files touched, tool results, unresolved tasks, and any facts needed to continue. Be concise but complete.',
          },
          {
            role: 'user',
            content: `Compact this conversation for future context. Return only the compacted summary.\n\n${options.conversationText}`,
          },
        ],
      }),
      signal: options.abortSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Synthetic /compact failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
    }

    const json = await response.json() as any;
    const summary = json?.choices?.[0]?.message?.content;
    if (typeof summary !== 'string' || !summary.trim()) {
      throw new Error('Synthetic /compact failed: empty summary');
    }
    return summary.trim();
  }

  protected buildSystemPrompt(documentContext?: DocumentContext, workspacePath?: string): string {
    const worktreePath = documentContext?.worktreePath;
    const isVoiceMode = (documentContext as any)?.isVoiceMode;
    const voiceModeCodingAgentPrompt = (documentContext as any)?.voiceModeCodingAgentPrompt;

    let prompt = buildClaudeCodeSystemPrompt({
      hasSessionNaming: isInternalMcpServerEnabled(),
      toolReferenceStyle: 'codex',
      worktreePath,
      isVoiceMode,
      voiceModeCodingAgentPrompt,
      enableAgentTeams: false,
      trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    });

    prompt += `

## Synthetic.new Tool Use

You are running through Synthetic.new's OpenAI-compatible chat API. Nimbalyst owns the agent loop, so be deliberate with tool calls and converge quickly.

- Current workspace: ${workspacePath || 'not provided'}
- You can read files, search the workspace, and apply edits using the provided tools.
- When asked about the codebase, use listFiles/searchFiles/readFile to explore before answering.
- Prefer minimal, complete edits via applyDiff.
- Never write an empty change. Always provide a minimal, complete change that addresses the request.
- Do not repeatedly call the same tool with the same arguments. If a tool fails twice, explain the blocker or choose a different approach.
- Once you have enough information to answer or implement the requested change, stop calling tools and provide the final answer.
`;

    return prompt;
  }

  // --- Model discovery (used by ModelRegistry + the settings panel) ---

  static async getModels(apiKey: string, baseUrl: string = SyntheticProvider.DEFAULT_BASE_URL): Promise<AIModel[]> {
    if (!apiKey) return this.getDefaultModels();
    try {
      const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) {
        console.error('[SyntheticProvider] Failed to fetch models:', response.status);
        return this.getDefaultModels();
      }
      const data = await response.json();
      return data.data.map((model: any) => ({
        id: ModelIdentifier.create('synthetic', model.id).combined,
        name: this.formatModelName(model.id),
        provider: 'synthetic' as const,
        maxTokens: model.max_tokens || model.max_completion_tokens || 4096,
        contextWindow: model.context_length || 4096,
      }));
    } catch (error) {
      console.error('[SyntheticProvider] Failed to fetch models:', error);
      return this.getDefaultModels();
    }
  }

  static getDefaultModels(): AIModel[] {
    return [
      { id: ModelIdentifier.create('synthetic', 'hf:Qwen/Qwen3.6-72B-Instruct').combined, name: 'Qwen 3.6 72B Instruct', provider: 'synthetic' as const, maxTokens: 32768, contextWindow: 131072 },
      { id: ModelIdentifier.create('synthetic', 'hf:meta-llama/Meta-Llama-3.1-405B-Instruct').combined, name: 'Meta Llama 3.1 405B Instruct', provider: 'synthetic' as const, maxTokens: 16384, contextWindow: 131072 },
    ];
  }

  static getDefaultModel(): string {
    return ModelIdentifier.create('synthetic', SyntheticProvider.DEFAULT_MODEL).combined;
  }

  private static contextWindowForModel(modelId: string): number {
    const normalized = modelId.replace(/^synthetic:/, '');
    const known = this.getDefaultModels().find((model) => model.id === ModelIdentifier.create('synthetic', normalized).combined);
    return known?.contextWindow || 131072;
  }

  private static formatModelName(modelId: string): string {
    let cleaned = modelId;
    const synAliasMatch = cleaned.match(/^(?:hf:)?syn:(.+)$/);
    if (synAliasMatch) {
      const category = synAliasMatch[1];
      return `Synthetic ${category.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (l) => l.toUpperCase())}`;
    }
    cleaned = cleaned.replace(/^[a-z]+:/, '');
    const slashIndex = cleaned.indexOf('/');
    if (slashIndex > 0) {
      const org = cleaned.slice(0, slashIndex);
      const model = cleaned.slice(slashIndex + 1);
      if (model.toLowerCase().startsWith(org.toLowerCase())) {
        cleaned = `${org} ${model.slice(org.length).replace(/^[-_]/, '')}`;
      } else {
        cleaned = `${org} ${model}`;
      }
    }
    return cleaned.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (l) => l.toUpperCase());
  }
}

/** Convert the session's prior messages into an OpenAI-format message seed. */
function buildPriorMessages(systemPrompt: string, messages: any[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (!msg || !msg.content || String(msg.content).trim() === '') continue;
    if (msg.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: msg.toolCall?.id || `tool_${Date.now()}`, content: String(msg.content) });
    } else {
      out.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: String(msg.content) });
    }
  }
  return out;
}

function buildPriorMessagesFromAgentMessages(systemPrompt: string, agentMessages: Array<{ direction: string; content: string; hidden?: boolean; createdAt?: Date; metadata?: Record<string, unknown> }>): unknown[] {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
  let latestCompactionIndex = -1;
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    if (agentMessages[i].metadata?.syntheticCompaction === true) {
      latestCompactionIndex = i;
      break;
    }
  }
  if (latestCompactionIndex >= 0) {
    appendCoalescedMessage(
      out,
      'assistant',
      `Compacted summary of earlier conversation:\n${agentMessages[latestCompactionIndex].content}`
    );
  }
  const replayMessages = latestCompactionIndex >= 0 ? agentMessages.slice(latestCompactionIndex + 1) : agentMessages;

  for (const msg of replayMessages) {
    if (msg.hidden) continue;
    const raw = String(msg.content ?? '');
    if (!raw.trim()) continue;

    if (msg.direction === 'input') {
      appendCoalescedMessage(out, 'user', raw.trim());
      continue;
    }

    const envelope = tryParseSyntheticEnvelope(raw.trim());
    if (envelope) {
      // Tool/status envelopes are transcript metadata. They are not safe to
      // replay as assistant text without the exact OpenAI tool_call structure.
      if (envelope.type !== 'assistant_message') continue;
      const text = String(envelope.text ?? '');
      if (text) appendCoalescedMessage(out, 'assistant', text);
      continue;
    }

    // Plain output rows are streamed assistant text chunks. Preserve leading
    // whitespace while coalescing adjacent chunks into one assistant message.
    appendCoalescedMessage(out, 'assistant', raw);
  }

  return out;
}

function appendCoalescedMessage(out: Array<Record<string, unknown>>, role: 'user' | 'assistant', content: string): void {
  if (!content) return;
  const last = out[out.length - 1];
  if (last?.role === role && typeof last.content === 'string') {
    const separator = role === 'user' ? '\n\n' : '';
    last.content = `${last.content}${separator}${content}`;
  } else {
    out.push({ role, content });
  }
}

function tryParseSyntheticEnvelope(raw: string): { type?: string; text?: unknown } | null {
  if (!raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function stringContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
