/**
 * SyntheticRawParser -- parses Synthetic.new raw agent messages into canonical
 * transcript event descriptors.
 *
 * SyntheticProvider logs compact JSON envelopes into ai_agent_messages during
 * streaming so the canonical transcript pipeline can render the turn in real
 * time, just like the built-in agent providers.
 */

import type { RawMessage } from '../TranscriptTransformer';
import type { CanonicalEventDescriptor, IRawMessageParser, ParseContext } from './IRawMessageParser';

interface SyntheticEnvelope {
  type: 'assistant_message' | 'tool_call_started' | 'tool_call_completed' | 'turn_ended' | 'system_message';
  [key: string]: unknown;
}

export class SyntheticRawParser implements IRawMessageParser {
  async parseMessage(msg: RawMessage, _context: ParseContext): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    if (msg.direction === 'input') {
      const text = String(msg.content ?? '').trim();
      if (!text) return [];
      return [{ type: 'user_message', text, createdAt: msg.createdAt }];
    }

    const raw = String(msg.content ?? '');
    if (raw.length === 0) return [];

    const parsed = this.tryParseEnvelope(raw.trim());
    if (!parsed) {
      return [{ type: 'assistant_message', text: raw, createdAt: msg.createdAt }];
    }

    switch (parsed.type) {
      case 'assistant_message':
        return [{
          type: 'assistant_message',
          text: String(parsed.text ?? ''),
          createdAt: msg.createdAt,
        }];

      case 'tool_call_started':
        return [{
          type: 'tool_call_started',
          toolName: String(parsed.toolName ?? 'unknown'),
          toolDisplayName: String(parsed.toolDisplayName ?? parsed.toolName ?? 'unknown'),
          arguments: (parsed.arguments as Record<string, unknown>) ?? {},
          targetFilePath: (parsed.targetFilePath as string | null | undefined) ?? null,
          mcpServer: (parsed.mcpServer as string | null | undefined) ?? null,
          mcpTool: (parsed.mcpTool as string | null | undefined) ?? null,
          providerToolCallId: (parsed.providerToolCallId as string | null | undefined) ?? undefined,
          subagentId: (parsed.subagentId as string | null | undefined) ?? null,
          createdAt: msg.createdAt,
        }];

      case 'tool_call_completed':
        return [{
          type: 'tool_call_completed',
          providerToolCallId: String(parsed.providerToolCallId ?? ''),
          status: (parsed.status === 'error' ? 'error' : 'completed'),
          result: parsed.result !== undefined ? String(parsed.result) : undefined,
          isError: parsed.isError === true,
          exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined,
          durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : undefined,
        }];

      case 'turn_ended':
        return [{
          type: 'turn_ended',
          contextFill: (parsed.contextFill as any) ?? { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, totalContextTokens: 0 },
          contextWindow: typeof parsed.contextWindow === 'number' ? parsed.contextWindow : 0,
          cumulativeUsage: (parsed.cumulativeUsage as any) ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 },
          contextCompacted: parsed.contextCompacted === true,
          subagentId: (parsed.subagentId as string | null | undefined) ?? null,
          createdAt: msg.createdAt,
        }];

      case 'system_message':
        return [{
          type: 'system_message',
          text: String(parsed.text ?? raw),
          systemType: (parsed.systemType as any) ?? 'status',
          searchable: parsed.searchable !== false,
          createdAt: msg.createdAt,
        }];
    }
  }

  private tryParseEnvelope(raw: string): SyntheticEnvelope | null {
    if (!raw.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(raw) as SyntheticEnvelope;
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') return parsed;
    } catch {
      // fall through
    }
    return null;
  }
}
