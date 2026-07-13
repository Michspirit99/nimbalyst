import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMcpHttpBridge } from '../RuntimeMcpHttpBridge';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, headers?: Record<string, string>): any {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers?.[name.toLowerCase()] ?? headers?.[name] ?? null },
    text: async () => JSON.stringify(body),
  };
}

function sseResponse(body: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
    text: async () => `event: message\ndata: ${JSON.stringify(body)}\n\n`,
  };
}

function queueToolListing(toolName = 'read-file', sessionId = 'sid-1'): void {
  mockFetch
    .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': sessionId }))
    .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 0, result: {} }))
    .mockResolvedValueOnce(jsonResponse({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [{ name: toolName, description: 'Read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
      },
    }));
}

describe('RuntimeMcpHttpBridge', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('lists URL-based MCP tools as OpenAI tools and records dispatch targets', async () => {
    queueToolListing();

    const bridge = new RuntimeMcpHttpBridge();
    const listed = await bridge.listOpenAITools({
      'nimbalyst-core': { url: 'http://127.0.0.1:41001/mcp/core', headers: { Authorization: 'Bearer token' } },
    });

    expect(listed.tools).toEqual([{ type: 'function', function: {
      name: 'mcp__nimbalyst-core__read-file',
      description: 'Read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    } }]);
    expect(listed.targets.get('mcp__nimbalyst-core__read-file')).toMatchObject({
      serverName: 'nimbalyst-core',
      toolName: 'read-file',
    });
    expect(listed.unsupportedServers).toEqual([]);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
    expect(mockFetch.mock.calls[0][1].redirect).toBe('error');
    expect(mockFetch.mock.calls[2][1].headers['mcp-session-id']).toBe('sid-1');
  });

  it('calls MCP tools and parses SSE JSON-RPC responses', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'sid-1' }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 0, result: {} }))
      .mockResolvedValueOnce(sseResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
      }));

    const bridge = new RuntimeMcpHttpBridge();
    const target = {
      serverName: 'nimbalyst',
      toolName: 'read_file',
      config: { url: 'http://127.0.0.1:41001/mcp/core' },
    };

    await expect(bridge.callTool(target, { path: 'a.ts' })).resolves.toEqual({ ok: true });
    const body = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(body).toMatchObject({ method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.ts' } } });
  });

  it('requires HTTPS for non-local MCP servers', async () => {
    const bridge = new RuntimeMcpHttpBridge();
    const listed = await bridge.listOpenAITools({
      remote: { url: 'http://example.com/mcp' },
    });

    expect(listed.tools).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks cloud metadata and link-local MCP destinations', async () => {
    const bridge = new RuntimeMcpHttpBridge();
    const listed = await bridge.listOpenAITools({
      metadata: { url: 'http://169.254.169.254/latest/meta-data' },
    });

    expect(listed.tools).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports stdio MCP servers as unsupported for this bridge', async () => {
    const bridge = new RuntimeMcpHttpBridge();
    const listed = await bridge.listOpenAITools({
      filesystem: { transport: 'stdio', command: 'mcp-server-filesystem' },
    });

    expect(listed.unsupportedServers).toEqual(['filesystem']);
    expect(listed.tools).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('isolates MCP session state by credential fingerprint', async () => {
    queueToolListing('read-file', 'sid-a');
    queueToolListing('read-file', 'sid-b');

    const bridge = new RuntimeMcpHttpBridge();
    await bridge.listOpenAITools({
      first: { url: 'https://mcp.example.com/rpc', headers: { Authorization: 'Bearer a' } },
    });
    await bridge.listOpenAITools({
      second: { url: 'https://mcp.example.com/rpc', headers: { Authorization: 'Bearer b' } },
    });

    expect(mockFetch.mock.calls[0][1].headers['mcp-session-id']).toBeUndefined();
    expect(mockFetch.mock.calls[3][1].headers['mcp-session-id']).toBeUndefined();
    expect(mockFetch.mock.calls[2][1].headers['mcp-session-id']).toBe('sid-a');
    expect(mockFetch.mock.calls[5][1].headers['mcp-session-id']).toBe('sid-b');
  });

  it('keeps long normalized tool names unique with a stable hash suffix', async () => {
    const longPrefix = 'x'.repeat(80);
    queueToolListing(`${longPrefix}-one`);
    queueToolListing(`${longPrefix}-two`);

    const bridge = new RuntimeMcpHttpBridge();
    const first = await bridge.listOpenAITools({ first: { url: 'https://one.example.com/mcp' } });
    const second = await bridge.listOpenAITools({ second: { url: 'https://two.example.com/mcp' } });

    const firstName = first.tools[0].function.name;
    const secondName = second.tools[0].function.name;
    expect(firstName.length).toBeLessThanOrEqual(64);
    expect(secondName.length).toBeLessThanOrEqual(64);
    expect(firstName).not.toBe(secondName);
  });
});
