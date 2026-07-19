import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SyntheticProtocol, type OpenAITool } from '../SyntheticProtocol';

// Mock the fetch API for testing
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Build a mock streaming Response whose body yields the given SSE chunks. */
function mockSseResponse(chunks: string[]): any {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) return { done: false, value: encoder.encode(chunks[i++]) };
          return { done: true, value: undefined };
        },
      }),
    },
    text: async () => '',
  };
}

// SSE chunks use a real trailing newline (the wire format). Build each
// payload as a JS object then JSON.stringify so the JSON is always valid
// (hand-writing the JSON led to brace/escape mismatches).
const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n`;
const txt = (c: string) => sse({ choices: [{ delta: { content: c } }] });
const reasoning = (c: string) => sse({ choices: [{ delta: { reasoning_content: c } }] });
const toolCallStart = (index: number, id: string, name: string) =>
  sse({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: '' } }] } }] });
// arguments is a JSON-encoded string per the OpenAI streaming spec.
const toolCallArgs = (index: number, args: object) =>
  sse({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(args) } }] } }] });
const usageChunk = sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const usage = (promptTokens: number, completionTokens: number) =>
  sse({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } });
const DONE = `data: [DONE]\n`;

const NO_TOOLS: OpenAITool[] = [];

describe('SyntheticProtocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('createSession returns a fresh session with empty history', async () => {
    const p = new SyntheticProtocol();
    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS } });
    expect(s.id).toMatch(/^syn_/);
    expect(s.messages).toEqual([]);
    expect(s.platform).toBe('synthetic');
  });

  it('resumeSession seeds history from priorMessages', async () => {
    const p = new SyntheticProtocol();
    const prior = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'hi' }];
    const s = await p.resumeSession('sess-1', { workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS, priorMessages: prior } });
    expect(s.id).toBe('sess-1');
    expect(s.messages).toEqual(prior);
  });

  it('errors if no toolExecutor is set', async () => {
    const p = new SyntheticProtocol();
    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS } });
    const events: any[] = [];
    for await (const e of p.sendMessage(s, { content: 'hi' })) events.push(e);
    expect(events[0]).toMatchObject({ type: 'error', error: expect.stringContaining('toolExecutor') });
  });

  it('errors if no apiKey is configured', async () => {
    const p = new SyntheticProtocol();
    p.toolExecutor = async () => ({ content: '', result: { success: true } });
    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: '', baseUrl: 'u', model: 'm', tools: NO_TOOLS } });
    const events: any[] = [];
    for await (const e of p.sendMessage(s, { content: 'hi' })) events.push(e);
    expect(events[0]).toMatchObject({ type: 'error', error: expect.stringContaining('API key') });
  });

  it('streams a simple text turn and completes (no tool calls)', async () => {
    const p = new SyntheticProtocol();
    p.toolExecutor = async () => ({ content: '', result: { success: true } });
    mockFetch.mockResolvedValueOnce(mockSseResponse([txt('he'), txt('llo'), usageChunk, DONE]) as any);

    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', tools: NO_TOOLS, contextWindow: 131072 } });
    const events: any[] = [];
    for await (const e of p.sendMessage(s, { content: 'hi' })) events.push(e);

    const text = events.filter((e) => e.type === 'text').map((e) => e.content);
    expect(text).toEqual(['he', 'llo']);
    const completes = events.filter((e) => e.type === 'complete');
    expect(completes).toHaveLength(1);
    expect(completes[0].content).toBe('hello');
    expect(completes[0].usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(completes[0].contextFillTokens).toBe(10);
    expect(completes[0].contextWindow).toBe(131072);
    expect(mockFetch).toHaveBeenCalledTimes(1); // no second turn — no tool calls
  });

  it('surfaces reasoning_content as reasoning, not final answer text', async () => {
    const p = new SyntheticProtocol();
    p.toolExecutor = async () => ({ content: '', result: { success: true } });
    mockFetch.mockResolvedValueOnce(mockSseResponse([reasoning('thinking...'), txt('answer'), DONE]) as any);

    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS } });
    const events: any[] = [];
    for await (const e of p.sendMessage(s, { content: 'hi' })) events.push(e);
    const reasoningEvents = events.filter((e) => e.type === 'reasoning').map((e) => e.content);
    const text = events.filter((e) => e.type === 'text').map((e) => e.content);
    const complete = events.find((e) => e.type === 'complete');
    expect(reasoningEvents).toEqual(['thinking...']);
    expect(text).toEqual(['answer']);
    expect(complete.content).toBe('answer');
  });

  it('completes when the stream ends without a [DONE] sentinel', async () => {
    const p = new SyntheticProtocol();
    p.toolExecutor = async () => ({ content: '', result: { success: true } });
    // No DONE chunk — stream just ends.
    mockFetch.mockResolvedValueOnce(mockSseResponse([txt('hi'), usageChunk]) as any);

    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS } });
    const events: any[] = [];
    for await (const e of p.sendMessage(s, { content: 'hi' })) events.push(e);
    expect(events.filter((e) => e.type === 'text').map((e) => e.content)).toEqual(['hi']);
    const completes = events.filter((e) => e.type === 'complete');
    expect(completes).toHaveLength(1);
    expect(completes[0].content).toBe('hi');
  });

  it('runs the tool loop: tool_call -> execute -> feed back -> final answer', async () => {
    const p = new SyntheticProtocol();
    const executor = vi.fn(async (_name: string, args: any) => ({
      content: JSON.stringify({ ok: true, args }),
      result: { success: true, result: { ok: true, args } },
    }));
    p.toolExecutor = executor;

    // Turn 1: model calls readFile({ path: "/a" })
    mockFetch.mockResolvedValueOnce(
      mockSseResponse([toolCallStart(0, 'call_1', 'readFile'), toolCallArgs(0, { path: '/a' }), DONE]) as any
    );
    // Turn 2: model sees the tool result and answers
    mockFetch.mockResolvedValueOnce(mockSseResponse([txt('done'), DONE]) as any);

    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS } });
    const events: any[] = [];
    for await (const e of p.sendMessage(s, { content: 'read /a' })) events.push(e);

    // Executor was called once with the tool name + parsed args.
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0]).toBe('readFile');
    expect(executor.mock.calls[0][1]).toEqual({ path: '/a' });

    // Events: tool_call, tool_result, then text + complete.
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolCall.name).toBe('readFile');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].toolResult.name).toBe('readFile');
    expect(events.filter((e) => e.type === 'text').map((e) => e.content)).toEqual(['done']);
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1);

    // Two fetches: the second turn's body must include the tool-result message
    // with role 'tool' and tool_call_id.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMsg = secondBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('call_1');
    // The assistant message carrying the tool_call must precede the tool result.
    const assistantToolMsg = secondBody.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(assistantToolMsg).toBeDefined();
    expect(assistantToolMsg.tool_calls[0].function.name).toBe('readFile');
  });

  it('assistant message with only tool_calls keeps a `content` key (null), not missing', async () => {
    // Synthetic.new rejects assistant messages that omit `content` entirely with
    // "missing key 'content'". When the model returns only tool_calls (no
    // text), `content` must still be present (null) so the request validates.
    const p = new SyntheticProtocol();
    p.toolExecutor = vi.fn(async () => ({ content: 'ok', result: { success: true } }));

    // Turn 1: tool call with NO preceding text delta (content stays empty).
    mockFetch.mockResolvedValueOnce(
      mockSseResponse([toolCallStart(0, 'call_1', 'readFile'), toolCallArgs(0, { path: '/a' }), DONE]) as any
    );
    // Turn 2: final answer.
    mockFetch.mockResolvedValueOnce(mockSseResponse([txt('done'), DONE]) as any);

    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS } });
    for await (const _e of p.sendMessage(s, { content: 'read /a' })) { void _e; }

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const assistantToolMsg = secondBody.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(assistantToolMsg).toBeDefined();
    // `content` key must be present (null), not omitted.
    expect(Object.prototype.hasOwnProperty.call(assistantToolMsg, 'content')).toBe(true);
    expect(assistantToolMsg.content).toBeNull();
  });


  it('aggregates usage across tool-loop API calls', async () => {
    const p = new SyntheticProtocol();
    p.toolExecutor = vi.fn(async () => ({ content: JSON.stringify({ ok: true }), result: { success: true } }));

    mockFetch.mockResolvedValueOnce(
      mockSseResponse([toolCallStart(0, 'call_1', 'readFile'), toolCallArgs(0, { path: '/a' }), usage(20, 2), DONE]) as any
    );
    mockFetch.mockResolvedValueOnce(mockSseResponse([txt('done'), usage(30, 4), DONE]) as any);

    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS } });
    const events: any[] = [];
    for await (const e of p.sendMessage(s, { content: 'read /a' })) events.push(e);

    const complete = events.find((e) => e.type === 'complete');
    expect(complete.usage).toEqual({ input_tokens: 50, output_tokens: 6, total_tokens: 56 });
    expect(complete.contextFillTokens).toBe(30); // latest request prompt size, not cumulative consumed tokens
  });

  it('stops the loop with an error after maxLoopTurns', async () => {
    const p = new SyntheticProtocol();
    p.toolExecutor = async () => ({ content: '{}', result: { success: true } });
    // Every turn returns a tool call -> never converges. Use
    // mockImplementation so each fetch gets a FRESH response object (a shared
    // mockResolvedValue would reuse one reader whose cursor is exhausted
    // after the first turn, making later turns look empty).
    mockFetch.mockImplementation(async () => mockSseResponse([toolCallStart(0, 'call_1', 'readFile'), toolCallArgs(0, {}), DONE]));

    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'm', tools: NO_TOOLS, maxLoopTurns: 2 } });
    const events: any[] = [];
    for await (const e of p.sendMessage(s, { content: 'loop' })) events.push(e);
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].error).toMatch(/exceeded 2 turns/);
  });

  it('sends the model id it was given verbatim (no prefix stripping in protocol)', async () => {
    const p = new SyntheticProtocol();
    p.toolExecutor = async () => ({ content: '', result: { success: true } });
    mockFetch.mockResolvedValueOnce(mockSseResponse([txt('ok'), DONE]) as any);
    const s = await p.createSession({ workspacePath: '/w', raw: { apiKey: 'k', baseUrl: 'u', model: 'hf:zai-org/GLM-4.7-Flash', tools: NO_TOOLS } });
    for await (const _ of p.sendMessage(s, { content: 'hi' })) void 0;
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('hf:zai-org/GLM-4.7-Flash');
  });
});
