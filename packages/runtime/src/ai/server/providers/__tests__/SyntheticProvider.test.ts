import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SyntheticProvider, resolveMcpTargetByName, safeStringify } from '../SyntheticProvider';
import { AgentMessagesRepository } from '../../../../storage/repositories/AgentMessagesRepository';
import type { RuntimeMcpToolTarget } from '../../services/RuntimeMcpHttpBridge';

// Mock the fetch API for testing
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SyntheticProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    AgentMessagesRepository.clearStore();
  });

  describe('initialize', () => {
    it('throws an error without API key', async () => {
      const provider = new SyntheticProvider();
      await expect(
        provider.initialize({} as any)
      ).rejects.toThrow('API key is required for Synthetic.new provider');
    });

    it('initializes successfully with API key and baseUrl', async () => {
      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.synthetic.new/openai/v1'
      });

      expect(provider['baseUrl']).toBe('https://api.synthetic.new/openai/v1');
    });

    it('uses default baseUrl if not provided', async () => {
      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key'
      });

      expect(provider['baseUrl']).toBe('https://api.synthetic.new/openai/v1');
    });
  });

  describe('getModels', () => {
    it('returns default models when no API key provided', async () => {
      const models = await SyntheticProvider.getModels('');
      expect(models.length).toBeGreaterThan(0);
      models.forEach(model => {
        expect(model.provider).toBe('synthetic');
      });
    });

    it('fetches models from Synthetic.new API with valid API key', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { id: 'hf:Qwen/Qwen3.6-72B-Instruct', max_tokens: 8192, context_length: 32768 },
            { id: 'hf:syn:coding', max_tokens: 8192, context_length: 32768 },
            { id: 'hf:meta-llama/Meta-Llama-3.1-405B-Instruct', max_tokens: 16384, context_length: 131072 }
          ]
        })
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const models = await SyntheticProvider.getModels('test-api-key');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.synthetic.new/openai/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-api-key'
          })
        })
      );

      expect(models.length).toBe(3);
      expect(models[0].id).toBe('synthetic:hf:Qwen/Qwen3.6-72B-Instruct');
      expect(models[0].name).toBe('Qwen 3.6 72B Instruct');
      expect(models[0].maxTokens).toBe(8192);
      expect(models[0].contextWindow).toBe(32768);
    });

    it('returns default models when fetch fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockRejectedValue(new Error('Failed to fetch models'));

      const models = await SyntheticProvider.getModels('test-api-key');
      expect(models).toEqual(SyntheticProvider.getDefaultModels());
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[SyntheticProvider] Failed to fetch models:',
        expect.any(Error)
      );
    });

    it('handles different model ID formats correctly', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { id: 'hf:Qwen/Qwen3.6-72B-Instruct', max_tokens: 8192, context_length: 32768 },
            { id: 'hf:syn:coding', max_tokens: 8192, context_length: 32768 },
            { id: 'hf:syn:chat', max_tokens: 4096, context_length: 16384 }
          ]
        })
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const models = await SyntheticProvider.getModels('test-api-key');

      expect(models).toEqual([
        {
          id: 'synthetic:hf:Qwen/Qwen3.6-72B-Instruct',
          name: 'Qwen 3.6 72B Instruct',
          provider: 'synthetic',
          maxTokens: 8192,
          contextWindow: 32768
        },
        {
          id: 'synthetic:hf:syn:coding',
          name: 'Synthetic Coding',
          provider: 'synthetic',
          maxTokens: 8192,
          contextWindow: 32768
        },
        {
          id: 'synthetic:hf:syn:chat',
          name: 'Synthetic Chat',
          provider: 'synthetic',
          maxTokens: 4096,
          contextWindow: 16384
        }
      ]);
    });
  });

  describe('getDefaultModel', () => {
    it('returns the default model ID', () => {
      const model = SyntheticProvider.getDefaultModels()[0].id;
      const defaultModel = SyntheticProvider.getDefaultModel();

      expect(defaultModel).toBe(model);
    });
  });

  describe('getCapabilities', () => {
    it('returns correct capabilities', () => {
      const provider = new SyntheticProvider();

      const capabilities = provider.getCapabilities();

      expect(capabilities).toEqual({
        streaming: true,
        tools: true,
        mcpSupport: true,
        edits: true,
        resumeSession: true,
        supportsFileTools: true
      });
    });
  });

  describe('ModelIdentifier edge case', () => {
    it('handles model IDs with embedded colons (hf:org/model)', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { id: 'hf:Qwen/Qwen3.6-72B-Instruct', max_tokens: 8192, context_length: 32768 },
            { id: 'hf:meta-llama/Meta-Llama-3.1-405B-Instruct', max_tokens: 16384, context_length: 131072 }
          ]
        })
      };

      mockFetch.mockResolvedValue(mockResponse as any);

      const models = await SyntheticProvider.getModels('test-api-key');

      // These should have 'synthetic:' prefix only, not twice (e.g. synthetic:hf:org/model)
      expect(models[0].id).toBe('synthetic:hf:Qwen/Qwen3.6-72B-Instruct');
      expect(models[1].id).toBe('synthetic:hf:meta-llama/Meta-Llama-3.1-405B-Instruct');
    });
  });

  describe('formatModelName', () => {
    it('formats model IDs correctly', () => {
      const name1 = SyntheticProvider['formatModelName']('hf:Qwen/Qwen3.6-72B-Instruct');
      expect(name1).toBe('Qwen 3.6 72B Instruct');

      const name2 = SyntheticProvider['formatModelName']('hf:syn:coding');
      expect(name2).toBe('Synthetic Coding');

      const name3 = SyntheticProvider['formatModelName']('hf:meta-llama/Meta-Llama-3.1-405B-Instruct');
      expect(name3).toBe('Meta Llama 3.1 405B Instruct');

      const name4 = SyntheticProvider['formatModelName']('hf:syn:chat-v2');
      expect(name4).toBe('Synthetic Chat V2');

      // Bare syn: (without the required hf: prefix) is still recognized for display purposes
      const name5 = SyntheticProvider['formatModelName']('syn:coding');
      expect(name5).toBe('Synthetic Coding');
    });
  });

  describe('sendMessage', () => {
    // Build a mock streaming Response whose body yields the given SSE chunks.
    // Each chunk is a template literal whose trailing newline is a real newline
    // (valid inside backticks) — avoids escape-sequence mangling.
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
              if (i < chunks.length) {
                return { done: false, value: encoder.encode(chunks[i++]) };
              }
              return { done: true, value: undefined };
            }
          })
        },
        text: async () => ''
      };
    }

    // SSE chunks end with a real newline (the wire format uses \n as the line
    // terminator). Using template literals keeps the newline literal and valid.
    const TEXT_DELTA_CHUNK = `data: {"choices":[{"delta":{"content":"hi"}}]}
`;
    const DONE_CHUNK = `data: [DONE]
`;
    // Reasoning-model chunk: reasoning_content present, content empty/absent.
    // GLM-4.7-Flash / DeepSeek / Qwen3 stream CoT via reasoning_content.
    const REASONING_CHUNK = `data: {"choices":[{"delta":{"reasoning":"Analyzing","reasoning_content":"Analyzing"}}]}
`;
    const REASONING_CHUNK_NULL = `data: {"choices":[{"delta":{"content":"","reasoning_content":null}}]}
`;

    it('sends the raw model id (without the synthetic: prefix) to the API', async () => {
      // Synthetic.new model ids contain their own colon (e.g. hf:Qwen/...).
      // The combined id stored in config is "synthetic:hf:Qwen/...", but the API
      // must receive the raw "hf:Qwen/..." id. Sending the combined id makes
      // Synthetic.new return 400: "URL must begin with https://huggingface.co".
      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key',
        model: 'synthetic:hf:Qwen/Qwen3.6-72B-Instruct'
      });

      mockFetch.mockResolvedValue(mockSseResponse([TEXT_DELTA_CHUNK, DONE_CHUNK]) as any);

      for await (const chunk of provider.sendMessage('hello', undefined, undefined)) {
        // drain the stream
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('hf:Qwen/Qwen3.6-72B-Instruct');
      expect(body.model).not.toContain('synthetic:');
    });

    it('falls back to the raw DEFAULT_MODEL when no model is configured', async () => {
      const provider = new SyntheticProvider();
      await provider.initialize({ apiKey: 'test-api-key' });

      mockFetch.mockResolvedValue(mockSseResponse([TEXT_DELTA_CHUNK, DONE_CHUNK]) as any);

      for await (const chunk of provider.sendMessage('hello', undefined, undefined)) {
        // drain the stream
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('hf:Qwen/Qwen3.6-72B-Instruct');
      expect(body.model).not.toContain('synthetic:');
    });

    it('keeps reasoning_content out of normal assistant text/final answer', async () => {
      // Reasoning models (GLM-4.7-Flash, DeepSeek, Qwen3) stream chain-of-thought
      // via `reasoning_content`. It should not be merged into normal assistant
      // text or the persisted final answer.
      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key',
        model: 'synthetic:hf:zai-org/GLM-4.7-Flash'
      });

      mockFetch.mockResolvedValue(mockSseResponse([
        REASONING_CHUNK_NULL, // first chunk: content "", reasoning_content null -> skipped
        REASONING_CHUNK,       // reasoning token -> yielded as text
        TEXT_DELTA_CHUNK,      // real content -> yielded as text
        DONE_CHUNK
      ]) as any);

      const chunks: any[] = [];
      for await (const chunk of provider.sendMessage('hello', undefined, undefined)) {
        chunks.push(chunk);
      }

      const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);
      expect(textChunks).toEqual(['hi']);
      const complete = chunks.find(c => c.type === 'complete');
      expect(complete.content).toBe('hi');
    });

    it('exposes /compact as a native Synthetic slash command', () => {
      const provider = new SyntheticProvider();
      expect(provider.getSlashCommands()).toEqual(['compact']);
      expect(SyntheticProvider.getKnownSlashCommands()).toEqual(['compact']);
    });

    it('compacts persisted Synthetic history and stores a hidden checkpoint', async () => {
      const create = vi.fn(async () => {});
      AgentMessagesRepository.setStore({
        create,
        list: vi.fn(async () => [
          { sessionId: 'session-1', source: 'synthetic', direction: 'input', content: 'Implement the blue-ferret feature' },
          { sessionId: 'session-1', source: 'synthetic', direction: 'output', content: 'I updated src/ferret.ts' },
        ] as any),
      });

      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key',
        model: 'synthetic:hf:Qwen/Qwen3.6-72B-Instruct'
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Blue-ferret feature implemented in src/ferret.ts.' } }] }),
      } as any);

      const chunks: any[] = [];
      for await (const chunk of provider.sendMessage('/compact', undefined, 'session-1', [])) {
        chunks.push(chunk);
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.stream).toBe(false);
      expect(body.model).toBe('hf:Qwen/Qwen3.6-72B-Instruct');
      expect(body.messages[1].content).toContain('Implement the blue-ferret feature');

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        source: 'synthetic',
        direction: 'output',
        content: 'Blue-ferret feature implemented in src/ferret.ts.',
        hidden: true,
        searchable: false,
        metadata: expect.objectContaining({ syntheticCompaction: true }),
      }));
      expect(chunks.some((chunk) => chunk.type === 'complete' && chunk.content.includes('Conversation compacted'))).toBe(true);
    });

    it('replays only the latest Synthetic compaction checkpoint plus later visible messages', async () => {
      AgentMessagesRepository.setStore({
        create: vi.fn(async () => {}),
        list: vi.fn(async () => [
          { sessionId: 'session-1', source: 'synthetic', direction: 'input', content: 'Old detail that should be compacted away' },
          { sessionId: 'session-1', source: 'synthetic', direction: 'output', content: 'Compact summary: keep blue-ferret facts', hidden: true, metadata: { syntheticCompaction: true } },
          { sessionId: 'session-1', source: 'synthetic', direction: 'input', content: 'New detail after compaction' },
          { sessionId: 'session-1', source: 'synthetic', direction: 'output', content: 'Acknowledged new detail' },
        ] as any),
      });

      const provider = new SyntheticProvider();
      await provider.initialize({ apiKey: 'test-api-key' });
      mockFetch.mockResolvedValue(mockSseResponse([TEXT_DELTA_CHUNK, DONE_CHUNK]) as any);

      for await (const _chunk of provider.sendMessage('Continue', undefined, 'session-1', [])) {
        // drain
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const serialized = JSON.stringify(body.messages);
      expect(serialized).toContain('Compact summary: keep blue-ferret facts');
      expect(serialized).toContain('New detail after compaction');
      expect(serialized).not.toContain('Old detail that should be compacted away');
    });

    it('reconstructs context from persisted Synthetic agent messages after provider recreation/model switch', async () => {
      AgentMessagesRepository.setStore({
        create: vi.fn(async () => {}),
        list: vi.fn(async () => [
          { sessionId: 'session-1', source: 'synthetic', direction: 'input', content: 'Remember the codeword: blue-ferret' },
          { sessionId: 'session-1', source: 'synthetic', direction: 'output', content: 'Got it — blue-ferret.' },
        ] as any),
      });

      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key',
        model: 'synthetic:hf:meta-llama/Meta-Llama-3.1-405B-Instruct'
      });

      mockFetch.mockResolvedValue(mockSseResponse([TEXT_DELTA_CHUNK, DONE_CHUNK]) as any);

      // Simulates a post-model-switch provider instance: no legacy
      // session.messages are supplied, so context must come from ai_agent_messages.
      for await (const _chunk of provider.sendMessage('What is the codeword?', undefined, 'session-1', [])) {
        // drain the stream
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('hf:meta-llama/Meta-Llama-3.1-405B-Instruct');
      expect(body.messages).toEqual(expect.arrayContaining([
        { role: 'user', content: 'Remember the codeword: blue-ferret' },
        { role: 'assistant', content: 'Got it — blue-ferret.' },
        { role: 'user', content: 'What is the codeword?' },
      ]));
    });

    it('emits a complete chunk when the stream ends without a [DONE] sentinel', async () => {
      // Synthetic.new's stream for some models just ends (reader `done: true`)
      // without an explicit `data: [DONE]` line. Previously the `complete` chunk
      // was only emitted inside the `[DONE]` handler, so the handler's
      // `case 'complete'` never fired, the spinner stayed up forever, and the
      // message was never saved. The post-loop fallback must emit completion.
      const provider = new SyntheticProvider();
      await provider.initialize({
        apiKey: 'test-api-key',
        model: 'synthetic:hf:zai-org/GLM-4.7-Flash'
      });

      // NO DONE_CHUNK — stream just ends after a content delta.
      mockFetch.mockResolvedValue(mockSseResponse([TEXT_DELTA_CHUNK]) as any);

      const chunks: any[] = [];
      for await (const chunk of provider.sendMessage('hello', undefined, undefined)) {
        chunks.push(chunk);
      }

      const textChunks = chunks.filter(c => c.type === 'text').map(c => c.content);
      expect(textChunks).toEqual(['hi']);
      const completes = chunks.filter(c => c.type === 'complete');
      expect(completes.length).toBe(1); // exactly one completion (no double)
      expect(completes[0].isComplete).toBe(true);
      expect(completes[0].content).toBe('hi');
    });
  });
});

describe('resolveMcpTargetByName', () => {
  function target(serverName: string, toolName: string): RuntimeMcpToolTarget {
    return { serverName, toolName, config: { url: `http://127.0.0.1/${serverName}` } as any };
  }

  it('resolves an exact namespaced tool name', () => {
    const targets = new Map<string, RuntimeMcpToolTarget>([
      ['mcp__nimbalyst__update_session_meta', target('nimbalyst', 'update_session_meta')],
      ['mcp__nimbalyst-host__create_session', target('nimbalyst-host', 'create_session')],
    ]);
    expect(resolveMcpTargetByName(targets, 'mcp__nimbalyst__update_session_meta')?.toolName)
      .toBe('update_session_meta');
  });

  it('falls back to base tool name when the model uses a wrong server prefix', () => {
    // `update_session_meta` is registered under the `nimbalyst` core server, but
    // the model called it with the `nimbalyst-host` prefix. Should still resolve.
    const targets = new Map<string, RuntimeMcpToolTarget>([
      ['mcp__nimbalyst__update_session_meta', target('nimbalyst', 'update_session_meta')],
    ]);
    expect(resolveMcpTargetByName(targets, 'mcp__nimbalyst-host__update_session_meta')?.toolName)
      .toBe('update_session_meta');
  });

  it('returns undefined for a non-MCP name with no matching target', () => {
    const targets = new Map<string, RuntimeMcpToolTarget>([
      ['mcp__nimbalyst__update_session_meta', target('nimbalyst', 'update_session_meta')],
    ]);
    expect(resolveMcpTargetByName(targets, 'some_builtin_tool')).toBeUndefined();
  });

  it('returns undefined when no registered target matches the base name', () => {
    const targets = new Map<string, RuntimeMcpToolTarget>();
    expect(resolveMcpTargetByName(targets, 'mcp__nimbalyst-host__nope')).toBeUndefined();
  });
});

describe('safeStringify', () => {
  it('passes strings through unchanged', () => {
    expect(safeStringify('hello')).toBe('hello');
  });

  it('returns an empty string for undefined (never the undefined value)', () => {
    // JSON.stringify(undefined) returns the *value* undefined, which would drop
    // a tool-result `content` key and trigger "missing key 'content'" upstream.
    const result = safeStringify(undefined);
    expect(typeof result).toBe('string');
    expect(result).toBe('');
  });

  it('serializes null as the string "null"', () => {
    expect(safeStringify(null)).toBe('null');
  });

  it('serializes objects as JSON', () => {
    expect(safeStringify({ ok: true })).toBe('{"ok":true}');
  });

  it('falls back to String() for non-serializable values', () => {
    const circular: any = {};
    circular.self = circular;
    expect(typeof safeStringify(circular)).toBe('string');
  });
});

// Opt-in integration test
const runSyntheticIntegration = process.env.RUN_SYNTHETIC_INTEGRATION === '1';

describe.skipIf(!runSyntheticIntegration)('SyntheticProvider live integration', () => {
  it('connects to real Synthetic.new API and streams a response', async () => {
    const apiKey = process.env.SYNTHETIC_API_KEY || '';

    if (!apiKey) {
      console.warn('SKIP: SYNTHETIC_API_KEY not set');
      return;
    }

    const provider = new SyntheticProvider();
    await provider.initialize({
      apiKey,
      model: 'hf:syn:coding'
    });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('Say hello in a single sentence.', undefined, 'test-session')) {
      chunks.push(chunk);
      if (chunks.length === 1) break; // Just verify we can stream
    }

    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk).toBeDefined();
    expect(finalChunk.content).toBeDefined();
    expect(typeof finalChunk.content).toBe('string');
    expect(finalChunk.content.length).toBeGreaterThan(0);
  });
});
