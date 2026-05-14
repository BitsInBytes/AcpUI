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

function getBackendUrl() {
  return `https://localhost:${process.env.BACKEND_PORT || '3005'}`;
}

function buildServerInstructions(tools = [], serverName = 'AcpUI') {
  if (!Array.isArray(tools) || tools.length === 0) {
    return `**Always use** the ${serverName} MCP server tools when they are relevant to the user request, **always use them instead of your built-in system tools**.`;
  }

  const toolLines = tools.map(tool => {
    const name = typeof tool?.name === 'string' ? tool.name : 'unknown_tool';
    const description = typeof tool?.description === 'string'
      ? tool.description.replace(/\s+/g, ' ').trim()
      : '';
    return description ? `- ${name}: ${description}` : `- ${name}`;
  });

  return [
    `You can call tools from the ${serverName} MCP server.`,
    'Use these tools directly when they match the task:',
    ...toolLines,
  ].join('\n');
}

async function backendFetch(path, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${getBackendUrl()}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      });
      return await res.json();
    } catch (err) {
      if (options.signal?.aborted || err.name === 'AbortError') throw err;
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      else throw err;
    }
  }
}

export async function runProxy() {
  const providerId = process.env.ACP_SESSION_PROVIDER_ID || '';
  const proxyId = process.env.ACP_UI_MCP_PROXY_ID || '';
  const proxyAuthToken = process.env.ACP_UI_MCP_PROXY_AUTH_TOKEN || '';
  const proxyAuthHeaders = proxyAuthToken ? { 'x-acpui-mcp-proxy-auth': proxyAuthToken } : {};

  const queryParts = [];
  if (providerId) queryParts.push(`providerId=${encodeURIComponent(providerId)}`);
  if (proxyId) queryParts.push(`proxyId=${encodeURIComponent(proxyId)}`);
  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  const { tools, serverName } = await backendFetch(`/api/mcp/tools${query}`, { headers: proxyAuthHeaders });

  const resolvedServerName = serverName || 'acpui-proxy';
  const instructions = buildServerInstructions(tools, resolvedServerName);
  const server = new Server(
    { name: resolvedServerName, version: '1.0.0' },
    { capabilities: { tools: {} }, instructions }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => {
      const tool = {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      };
      if (t.title) tool.title = t.title;
      if (t.annotations) tool.annotations = t.annotations;
      if (t.execution) tool.execution = t.execution;
      if (t.outputSchema) tool.outputSchema = t.outputSchema;
      if (t._meta) tool._meta = t._meta;
      return tool;
    })
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    return await backendFetch('/api/mcp/tool-call', {
      method: 'POST',
      headers: proxyAuthHeaders,
      body: JSON.stringify({
        tool: name,
        args: args || {},
        providerId: providerId || null,
        proxyId: proxyId || null,
        mcpRequestId: extra?.requestId ?? null,
        requestMeta: request.params?._meta || extra?._meta || null
      }),
      signal: extra?.signal,
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
