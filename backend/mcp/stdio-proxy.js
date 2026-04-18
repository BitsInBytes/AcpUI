/**
 * Stdio MCP Proxy
 *
 * Thin passthrough between the ACP (via stdio) and the backend (via HTTPS API).
 * The ACP spawns this process for each session that has MCP servers configured.
 * It registers tool definitions fetched from the backend and forwards every
 * tool call to POST /api/mcp/tool-call for execution.
 *
 * All real tool logic (PTY, sub-agents, sockets) stays in the backend process.
 * This proxy is intentionally stateless and generic.
 *
 * IMPORTANT: Tool schemas are defined in routes/mcpApi.js (GET /api/mcp/tools).
 * If you add/rename/remove tools in mcp/mcpServer.js, update the schemas there too.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Accept self-signed certs for localhost backend communication
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BACKEND_PORT = process.env.BACKEND_PORT || '3005';
const BACKEND_URL = `https://localhost:${BACKEND_PORT}`;

async function backendFetch(path, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      });
      return await res.json();
    } catch (err) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      else throw err;
    }
  }
}

export async function runProxy() {
  const { tools, serverName } = await backendFetch(`/api/mcp/tools?providerId=${process.env.ACP_SESSION_PROVIDER_ID || ''}`);

  const server = new Server(
    { name: serverName || 'acpui-proxy', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await backendFetch('/api/mcp/tool-call', {
      method: 'POST',
      body: JSON.stringify({ tool: name, args: args || {}, providerId: process.env.ACP_SESSION_PROVIDER_ID || null }),
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('stdio-proxy.js')) {
  runProxy().catch(err => {
    process.stderr.write(`[MCP PROXY] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
