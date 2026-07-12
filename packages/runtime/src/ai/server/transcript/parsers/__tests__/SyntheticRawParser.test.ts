import { describe, expect, it } from 'vitest';
import { SyntheticRawParser } from '../SyntheticRawParser';
import type { RawMessage } from '../../TranscriptTransformer';

const baseMsg = (overrides: Partial<RawMessage>): RawMessage => ({
  id: 1,
  sessionId: 's1',
  source: 'synthetic',
  direction: 'output',
  content: '',
  createdAt: new Date('2026-07-12T00:00:00Z'),
  ...overrides,
});

describe('SyntheticRawParser', () => {
  it('parses plain assistant output as assistant_message', async () => {
    const p = new SyntheticRawParser();
    const events = await p.parseMessage(baseMsg({ content: 'hello' }), {
      sessionId: 's1',
      hasToolCall: () => false,
      hasSubagent: () => false,
      findByProviderToolCallId: async () => null,
      findActiveToolCallByRawProviderId: async () => null,
    });
    expect(events).toEqual([{ type: 'assistant_message', text: 'hello', createdAt: expect.any(Date) }]);
  });

  it('preserves leading whitespace in streamed assistant chunks', async () => {
    const p = new SyntheticRawParser();
    const events = await p.parseMessage(baseMsg({ content: ' hello' }), {
      sessionId: 's1',
      hasToolCall: () => false,
      hasSubagent: () => false,
      findByProviderToolCallId: async () => null,
      findActiveToolCallByRawProviderId: async () => null,
    });
    expect(events).toEqual([{ type: 'assistant_message', text: ' hello', createdAt: expect.any(Date) }]);
  });

  it('parses synthetic tool call envelopes', async () => {
    const p = new SyntheticRawParser();
    const events = await p.parseMessage(baseMsg({ content: JSON.stringify({
      type: 'tool_call_started',
      toolName: 'readFile',
      toolDisplayName: 'readFile',
      arguments: { path: '/tmp/a' },
      providerToolCallId: 'call_1',
    }) }), {
      sessionId: 's1',
      hasToolCall: () => false,
      hasSubagent: () => false,
      findByProviderToolCallId: async () => null,
      findActiveToolCallByRawProviderId: async () => null,
    });
    expect(events[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'readFile',
      toolDisplayName: 'readFile',
      arguments: { path: '/tmp/a' },
      providerToolCallId: 'call_1',
    });
  });
});
