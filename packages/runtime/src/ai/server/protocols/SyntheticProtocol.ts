/**
 * SyntheticProtocol — AgentProtocol adapter for Synthetic.new
 *
 * Synthetic.new is a stateless OpenAI-compatible `/chat/completions` endpoint
 * with NO agent backend (unlike Claude SDK / Codex SDK / opencode, which
 * delegate the loop to an external SDK). So this protocol IS the agent loop:
 *
 *   send (with tools) → stream text + tool_calls → execute tools →
 *   feed `tool` results back → repeat until the model stops calling tools →
 *   emit `complete`.
 *
 * Session state is a Nimbalyst-managed message history (the server has no
 * session id). `resumeSession` replays a prior history supplied by the
 * provider (reconstructed from `ai_agent_messages`), exactly what the chat
 * providers already do implicitly.
 *
 * The SSE parsing handles `reasoning_content` separately from final answer
 * text plus the [DONE]-less end-of-stream fallback observed from Synthetic.new.
 */

import type {
  AgentProtocol,
  ProtocolEvent,
  ProtocolMessage,
  ProtocolSession,
  SessionOptions,
  ToolResult,
} from './ProtocolInterface';

/** OpenAI-format tool, passed in via SessionOptions.raw.tools. */
export interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

/** Tool executor injected by the provider. Returns the string content for the
 * `tool` role message + a structured ToolResult for the transcript event. */
export type SyntheticToolExecutor = (
  name: string,
  args: Record<string, unknown>
) => Promise<{ content: string; result: ToolResult }>;

export interface SyntheticProtocolSession extends ProtocolSession {
  /** Running OpenAI-format message history (system + turns + tool results). */
  messages: unknown[];
}

export interface SyntheticSessionOptionsExtra {
  apiKey: string;
  baseUrl: string;
  /** Model id (already stripped of the "synthetic:" prefix). */
  model: string;
  /** OpenAI-format tools offered to the model every turn. */
  tools: OpenAITool[];
  /** Prior conversation history to seed a resumed session ([] for new). */
  priorMessages?: unknown[];
  /** Maximum context window for the active model, used for UI context-fill display. */
  contextWindow?: number;
  abortSignal?: AbortSignal;
  /** Max turns of the tool loop before forcing stop (safety valve). */
  maxLoopTurns?: number;
}

function parseToolCallArguments(id: string, argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch (error) {
    console.warn('[SyntheticProtocol] Failed to parse tool call arguments:', id, argumentsJson, error);
    return undefined;
  }
}

/** One streamed item from a turn: either a live text delta or the final result. */
type StreamedItem =
  | { kind: 'text'; content: string }
  | { kind: 'reasoning'; content: string }
  | { kind: 'final'; text: string; toolCalls: AccumulatedToolCall[]; usage: UsageData | undefined };

interface AccumulatedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
}

export class SyntheticProtocol implements AgentProtocol {
  readonly platform = 'synthetic';

  /** Injected by the provider before each sendMessage. */
  toolExecutor: SyntheticToolExecutor | null = null;

  createSession(options: SessionOptions): Promise<SyntheticProtocolSession> {
    const extra = (options.raw ?? {}) as Partial<SyntheticSessionOptionsExtra>;
    const seed = extra.priorMessages ?? [];
    return Promise.resolve({
      id: cryptoRandomId(),
      platform: this.platform,
      raw: options.raw ?? {},
      messages: [...seed],
    });
  }

  resumeSession(sessionId: string, options: SessionOptions): Promise<SyntheticProtocolSession> {
    const extra = (options.raw ?? {}) as Partial<SyntheticSessionOptionsExtra>;
    // Resume = replay prior history. Synthetic has no server session; the
    // provider reconstructs the OpenAI messages from ai_agent_messages and
    // passes them as priorMessages. We seed our running history with them.
    const seed = extra.priorMessages ?? [];
    return Promise.resolve({
      id: sessionId,
      platform: this.platform,
      raw: options.raw ?? {},
      messages: [...seed],
    });
  }

  forkSession(sessionId: string, options: SessionOptions): Promise<SyntheticProtocolSession> {
    // Synthetic has no native fork primitive. Create a fresh session seeded
    // with a copy of the parent's history (passed via raw.priorMessages by the
    // provider); higher layers record parentage in the DB.
    return this.createSession(options);
  }

  async *sendMessage(
    session: SyntheticProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    if (!this.toolExecutor) {
      yield { type: 'error', error: 'SyntheticProtocol has no toolExecutor set' };
      return;
    }

    // Per-turn config is passed via the session's raw, re-read each turn so
    // config changes (key rotation, toolset updates) take effect without
    // recreating the session.
    const raw = (session.raw ?? {}) as Partial<SyntheticSessionOptionsExtra>;
    const apiKey = raw.apiKey;
    const baseUrl = raw.baseUrl || 'https://api.synthetic.new/openai/v1';
    const tools = raw.tools ?? [];
    const abortSignal = raw.abortSignal;
    const maxLoopTurns = raw.maxLoopTurns ?? 25;

    if (!apiKey) {
      yield { type: 'error', error: 'Synthetic.new API key not configured' };
      return;
    }

    // Append the user's message to the running history.
    session.messages.push({ role: 'user', content: message.content });

    let turn = 0;
    let aggregateUsage: UsageData | undefined;
    let latestContextFillTokens: number | undefined;
    while (true) {
      turn++;
      if (turn > maxLoopTurns) {
        yield { type: 'error', error: `Synthetic agent loop exceeded ${maxLoopTurns} turns` };
        return;
      }

      const body = {
        model: raw.model,
        messages: session.messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        stream: true,
        stream_options: { include_usage: true },
      };

      // Stream one turn, yielding live text deltas, then collect the final.
      let final: { text: string; toolCalls: AccumulatedToolCall[]; usage: UsageData | undefined } = {
        text: '',
        toolCalls: [],
        usage: undefined,
      };
      for await (const item of this.streamTurn(`${baseUrl}/chat/completions`, apiKey, body, abortSignal)) {
        if (item.kind === 'text') {
          yield { type: 'text', content: item.content };
        } else if (item.kind === 'reasoning') {
          yield { type: 'reasoning', content: item.content };
        } else {
          final = { text: item.text, toolCalls: item.toolCalls, usage: item.usage };
          aggregateUsage = addUsage(aggregateUsage, item.usage);
          if (typeof item.usage?.input_tokens === 'number') {
            latestContextFillTokens = item.usage.input_tokens;
          }
        }
      }

      // Append the assistant turn to history (OpenAI requires the assistant
      // message that contained tool_calls to be present before tool results).
      // `content` must always be present (null when the turn had only tool
      // calls and no text) or the upstream API rejects it with
      // "missing key 'content'".
      const assistantMessage: Record<string, unknown> = {
        role: 'assistant',
        content: final.text || null,
      };
      if (final.toolCalls.length > 0) {
        assistantMessage.tool_calls = final.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsJson },
        }));
      }
      session.messages.push(assistantMessage);

      if (final.toolCalls.length === 0) {
        // No more tool calls — turn is done.
        yield {
          type: 'complete',
          content: final.text,
          usage: aggregateUsage
            ? {
                input_tokens: aggregateUsage.input_tokens || 0,
                output_tokens: aggregateUsage.output_tokens || 0,
                total_tokens: (aggregateUsage.input_tokens || 0) + (aggregateUsage.output_tokens || 0),
              }
            : undefined,
          contextFillTokens: latestContextFillTokens,
          contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined,
        };
        return;
      }

      // Execute each tool call, yield events, feed results back into history.
      for (const tc of final.toolCalls) {
        const args = parseToolCallArguments(tc.id, tc.argumentsJson) as Record<string, unknown> | undefined;
        yield { type: 'tool_call', toolCall: { id: tc.id, name: tc.name, arguments: args } };

        let execResult: { content: string; result: ToolResult };
        try {
          execResult = await this.toolExecutor(tc.name, args ?? {});
        } catch (err: any) {
          execResult = {
            content: JSON.stringify({ error: err?.message ?? String(err) }),
            result: { success: false, error: err?.message ?? String(err) },
          };
        }

        yield { type: 'tool_result', toolResult: { id: tc.id, name: tc.name, result: execResult.result } };

        // OpenAI tool-result message: role 'tool', tool_call_id, string content.
        session.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: execResult.content,
        });
      }
      // Loop again — the model sees the tool results and continues.
    }
  }

  /**
   * Stream one `/chat/completions` turn as an async generator. Yields
   * `{ kind: 'text' }` for each live text/reasoning delta (so the caller can
   * emit live `text` ProtocolEvents) and a single `{ kind: 'final' }` at the
   * end with the full text, accumulated tool calls, and usage.
   *
   * Handles `reasoning_content` as protocol reasoning (not assistant answer
   * text) and the optional `data: [DONE]` sentinel (Synthetic.new's stream
   * often just ends with reader `done`).
   */
  private async *streamTurn(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    abortSignal: AbortSignal | undefined
  ): AsyncIterable<StreamedItem> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 500);
      throw new Error(
        `Synthetic.new returned ${response.status}: ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from Synthetic.new');

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let usage: UsageData | undefined;
    const toolCallMap = new Map<number, AccumulatedToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (line.trim() === 'data: [DONE]') continue;
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (json.usage) {
            usage = { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens };
          }
          if (delta?.content) {
            fullContent += delta.content;
            yield { kind: 'text', content: delta.content };
          }
          if (delta?.reasoning_content) {
            yield { kind: 'reasoning', content: delta.reasoning_content };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallMap.get(idx);
              if (existing) {
                existing.argumentsJson += tc.function?.arguments || '';
              } else {
                toolCallMap.set(idx, {
                  id: tc.id || `call_${idx}_${Date.now()}`,
                  name: tc.function?.name || '',
                  argumentsJson: tc.function?.arguments || '',
                });
              }
            }
          }
        } catch (jsonError) {
          const message = jsonError instanceof Error ? jsonError.message : String(jsonError);
          console.warn('[SyntheticProtocol] Failed to parse SSE data chunk:', message);
        }
      }
    }

    // Flush trailing bytes + any remaining buffered line (Synthetic often ends
    // the stream without a `data: [DONE]` sentinel).
    const tail = buffer + decoder.decode();
    if (tail.startsWith('data: ') && tail.trim() !== 'data: [DONE]') {
      try {
        const json = JSON.parse(tail.slice(6));
        const delta = json.choices?.[0]?.delta;
        if (json.usage) usage = { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens };
        if (delta?.content) {
          fullContent += delta.content;
          yield { kind: 'text', content: delta.content };
        }
        if (delta?.reasoning_content) {
          yield { kind: 'reasoning', content: delta.reasoning_content };
        }
      } catch {
        /* non-fatal trailing parse */
      }
    }

    yield { kind: 'final', text: fullContent, toolCalls: Array.from(toolCallMap.values()), usage };
  }

  abortSession(_session: SyntheticProtocolSession): void {
    // Abort flows via the AbortSignal passed in SessionOptions.raw.abortSignal;
    // the fetch in streamTurn rejects. No extra bookkeeping needed.
  }

  cleanupSession(_session: SyntheticProtocolSession): void {
    // Stateless HTTP client; nothing to clean up.
  }
}

function addUsage(current: UsageData | undefined, next: UsageData | undefined): UsageData | undefined {
  if (!next) return current;
  return {
    input_tokens: (current?.input_tokens || 0) + (next.input_tokens || 0),
    output_tokens: (current?.output_tokens || 0) + (next.output_tokens || 0),
  };
}

function cryptoRandomId(): string {
  return `syn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
