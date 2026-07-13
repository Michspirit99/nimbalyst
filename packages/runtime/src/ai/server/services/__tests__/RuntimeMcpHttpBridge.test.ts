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

describe('RuntimeMcpHttpBridge', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('lists URL-based MCP tools as OpenAI tools and records dispatch targets', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'sid-1' }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 0, result: {} }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [{ name: 'read-file', description: 'Read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
        },
      }));

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
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
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
});
