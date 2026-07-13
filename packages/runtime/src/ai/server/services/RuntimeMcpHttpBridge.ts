/**
 * RuntimeMcpHttpBridge
 *
 * Minimal MCP Streamable HTTP client used by providers that do not have an
 * external agent SDK/backend to handle MCP for them. It supports URL-based MCP
 * server configs (the internal Nimbalyst MCP servers and remote HTTP/SSE
 * servers) by:
 *   - initialize + notifications/initialized
 *   - tools/list
 *   - tools/call
 *
 * Stdio MCP servers still require a process transport and are intentionally not
 * handled here; SDK-backed providers continue to support those natively.
 */

import { createHash } from 'node:crypto';
import type { OpenAITool } from '../protocols/SyntheticProtocol';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RuntimeMcpServerConfig {
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  transport?: string;
  [key: string]: unknown;
}

export interface RuntimeMcpToolTarget {
  serverName: string;
  toolName: string;
  config: RuntimeMcpServerConfig;
}

export interface RuntimeMcpToolListing {
  tools: OpenAITool[];
  targets: Map<string, RuntimeMcpToolTarget>;
  unsupportedServers: string[];
}

interface McpSessionState {
  sessionId: string | null;
  initialized: boolean;
  nextId: number;
}

const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_MAX_RESPONSE_BYTES = 1_000_000;
const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.internal',
]);

export class RuntimeMcpHttpBridge {
  private readonly sessions = new Map<string, McpSessionState>();

  async listOpenAITools(mcpServers: Record<string, RuntimeMcpServerConfig>): Promise<RuntimeMcpToolListing> {
    const tools: OpenAITool[] = [];
    const targets = new Map<string, RuntimeMcpToolTarget>();
    const unsupportedServers: string[] = [];

    for (const [serverName, config] of Object.entries(mcpServers)) {
      if (!config?.url) {
        if (isStdioConfig(config)) {
          unsupportedServers.push(serverName);
          console.warn('[RuntimeMcpHttpBridge] Skipping unsupported stdio MCP server:', serverName);
        }
        continue;
      }

      try {
        validateMcpUrl(config.url);
        const listed = await this.listTools(config);
        for (const tool of listed) {
          if (!tool?.name) continue;
          const openAIName = toOpenAIMcpToolName(serverName, String(tool.name));
          if (targets.has(openAIName)) {
            throw new Error(`MCP tool name collision after normalization: ${openAIName}`);
          }
          tools.push({
            type: 'function',
            function: {
              name: openAIName,
              description: String(tool.description || `${serverName}: ${tool.name}`),
              parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            },
          });
          targets.set(openAIName, { serverName, toolName: String(tool.name), config });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[RuntimeMcpHttpBridge] Failed to list MCP tools:', serverName, message);
      }
    }

    return { tools, targets, unsupportedServers };
  }

  async callTool(target: RuntimeMcpToolTarget, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized(target.config);
    const rpc = await this.postRpc(target.config, {
      jsonrpc: '2.0',
      id: this.nextId(target.config),
      method: 'tools/call',
      params: { name: target.toolName, arguments: args },
    });
    if (rpc.error) throw new Error(`MCP tool ${target.serverName}.${target.toolName} failed: ${rpc.error.message}`);
    return normalizeToolResult(rpc.result);
  }

  private async listTools(config: RuntimeMcpServerConfig): Promise<any[]> {
    await this.ensureInitialized(config);
    const rpc = await this.postRpc(config, {
      jsonrpc: '2.0',
      id: this.nextId(config),
      method: 'tools/list',
      params: {},
    });
    if (rpc.error) throw new Error(`MCP tools/list failed: ${rpc.error.message}`);
    const result = rpc.result as { tools?: unknown } | undefined;
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  private async ensureInitialized(config: RuntimeMcpServerConfig): Promise<void> {
    const state = this.state(config);
    if (state.initialized) return;

    const rpc = await this.postRpc(config, {
      jsonrpc: '2.0',
      id: this.nextId(config),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nimbalyst-runtime-synthetic', version: '0.1.0' },
      },
    }, true);
    if (rpc.error) throw new Error(`MCP initialize failed: ${rpc.error.message}`);

    try {
      await this.postNotification(config, { jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch {
      // Non-fatal. Some servers tolerate missing initialized notifications;
      // others may not expose tools until after this succeeds, so best effort.
    }

    state.initialized = true;
  }

  private async postRpc(config: RuntimeMcpServerConfig, body: unknown, captureSession = false): Promise<JsonRpcResponse> {
    const { res, text } = await this.post(config, body);
    if (captureSession) {
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.state(config).sessionId = sid;
    }
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    return extractJsonRpc(res, text);
  }

  private async postNotification(config: RuntimeMcpServerConfig, body: unknown): Promise<void> {
    const { res, text } = await this.post(config, body);
    if (!res.ok) throw new Error(`MCP notification HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  private async post(config: RuntimeMcpServerConfig, body: unknown): Promise<{ res: Response; text: string }> {
    if (!config.url) throw new Error('MCP server config has no url');
    validateMcpUrl(config.url);

    const state = this.state(config);
    const headers: Record<string, string> = {
      ...(config.headers ?? {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (state.sessionId) headers['mcp-session-id'] = state.sessionId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MCP_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await readResponseTextLimited(res, MCP_MAX_RESPONSE_BYTES);
      return { res, text };
    } finally {
      clearTimeout(timeout);
    }
  }

  private state(config: RuntimeMcpServerConfig): McpSessionState {
    const key = sessionKey(config);
    let state = this.sessions.get(key);
    if (!state) {
      state = { sessionId: null, initialized: false, nextId: 1 };
      this.sessions.set(key, state);
    }
    return state;
  }

  private nextId(config: RuntimeMcpServerConfig): number {
    const state = this.state(config);
    return state.nextId++;
  }
}

function validateMcpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MCP server URL is invalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported MCP URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('MCP server URLs must not contain embedded credentials');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(hostname) || isLinkLocalIpv4(hostname)) {
    throw new Error(`Blocked MCP server host: ${hostname}`);
  }
  if (url.protocol === 'http:' && !isLocalOrPrivateHost(hostname)) {
    throw new Error('Remote MCP servers must use HTTPS');
  }

  return url;
}

function isStdioConfig(config: RuntimeMcpServerConfig | undefined): boolean {
  if (!config) return false;
  const transport = String(config.transport ?? config.type ?? '').toLowerCase();
  return transport === 'stdio' || typeof config.command === 'string';
}

function isLocalOrPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return true;

  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isLinkLocalIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 169
    && parts[1] === 254;
}

function sessionKey(config: RuntimeMcpServerConfig): string {
  const headerEntries = Object.entries(config.headers ?? {})
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const credentialFingerprint = createHash('sha256')
    .update(JSON.stringify(headerEntries))
    .digest('hex')
    .slice(0, 16);
  return `${config.url ?? ''}|${String(config.transport ?? config.type ?? 'http')}|${credentialFingerprint}`;
}

async function readResponseTextLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`MCP response exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function extractJsonRpc(res: Response, text: string): JsonRpcResponse {
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('text/event-stream')) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(dataLines[i]);
        if (parsed && typeof parsed === 'object' && 'id' in parsed) return parsed as JsonRpcResponse;
      } catch {
        // continue scanning
      }
    }
    throw new Error('Could not parse MCP SSE response');
  }

  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new Error(`Could not parse MCP JSON response: ${text.slice(0, 300)}`);
  }
}

function normalizeToolResult(result: unknown): unknown {
  const candidate = result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const textBlocks = Array.isArray(candidate?.content)
    ? candidate.content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    : [];
  if (textBlocks.length === 1) {
    const text = textBlocks[0].text as string;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

function toOpenAIMcpToolName(serverName: string, toolName: string): string {
  const base = `mcp__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
  if (base.length <= 64) return base;
  const suffix = createHash('sha256').update(`${serverName}\0${toolName}`).digest('hex').slice(0, 8);
  return `${base.slice(0, 55)}_${suffix}`;
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  return sanitized || 'unknown';
}
