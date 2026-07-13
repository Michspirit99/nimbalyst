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
 * handled