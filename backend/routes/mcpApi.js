import { Router } from 'express';
import { createToolHandlers } from '../mcp/mcpServer.js';
import { getProvider } from '../services/providerLoader.js';
import { writeLog } from '../services/logger.js';
import { modelOptionsFromProviderConfig } from '../services/modelOptions.js';
import { resolveMcpProxy } from '../mcp/mcpProxyRegistry.js';
import {
  isCounselMcpEnabled,
  isGoogleSearchMcpEnabled,
  isInvokeShellMcpEnabled,
  isIoMcpEnabled,
  isSubagentsMcpEnabled
} from '../services/mcpConfig.js';
import {
  getAbortSubagentsMcpToolDefinition,
  getCheckSubagentsMcpToolDefinition,
  getCounselMcpToolDefinition,
  getInvokeShellMcpToolDefinition,
  getSubagentsMcpToolDefinition
} from '../mcp/coreMcpToolDefinitions.js';
import { getGoogleSearchMcpToolDefinitions, getIoMcpToolDefinitions } from '../mcp/ioMcpToolDefinitions.js';

const MCP_PROXY_AUTH_HEADER = 'x-acpui-mcp-proxy-auth';

function resolveToolContext(providerId, proxyId) {
  const proxy = resolveMcpProxy(proxyId);
  return {
    providerId: proxy?.providerId || providerId || null,
    acpSessionId: proxy?.acpSessionId || null,
    mcpProxyId: proxy?.proxyId || proxyId || null
  };
}

function readProxyAuthToken(req) {
  const headerValue = req.get?.(MCP_PROXY_AUTH_HEADER);
  if (typeof headerValue === 'string' && headerValue.trim()) return headerValue.trim();

  const raw = req?.headers?.[MCP_PROXY_AUTH_HEADER];
  if (Array.isArray(raw)) return raw[0] || '';
  if (typeof raw === 'string') return raw.trim();
  return '';
}

function resolveExecutionContext(providerId, proxyId, proxyAuthToken) {
  if (!proxyId) {
    return { error: 'MCP proxy context is required', status: 401 };
  }

  const proxy = resolveMcpProxy(proxyId);
  if (!proxy) {
    return { error: `Unknown MCP proxy: ${proxyId}`, status: 403 };
  }

  if (!proxyAuthToken) {
    return { error: 'Missing MCP proxy auth token', status: 401 };
  }

  if (!proxy.authToken || proxy.authToken !== proxyAuthToken) {
    return { error: 'Invalid MCP proxy auth token', status: 403 };
  }

  if (!proxy.acpSessionId) {
    return { error: `MCP proxy ${proxyId} is not bound to an ACP session`, status: 403 };
  }

  if (providerId && proxy.providerId !== providerId) {
    return { error: `MCP proxy provider mismatch: expected ${proxy.providerId}`, status: 403 };
  }

  return {
    context: {
      providerId: proxy.providerId,
      acpSessionId: proxy.acpSessionId,
      mcpProxyId: proxy.proxyId
    }
  };
}

function createToolCallAbortSignal(req, res, toolName) {
  const controller = new globalThis.AbortController();
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    writeLog(`[MCP API] Tool ${toolName} aborted: ${reason}`);
    controller.abort(new Error(reason));
  };

  req.on?.('aborted', () => abort('request aborted'));
  res.on?.('close', () => {
    if (!res.writableEnded) abort('response closed');
  });

  return controller.signal;
}

function canWriteResponse(res, abortSignal) {
  return !abortSignal.aborted && !res.destroyed && !res.writableEnded;
}

/**
 * Internal API for the stdio MCP proxy.
 * The proxy forwards tool calls here; we execute them using the real tool handlers.
 *
 * IMPORTANT: If you add/rename/remove tools in mcpServer.js, you must also update
 * the MCP tool definition modules, AND the proxy will pick up the changes
 * automatically on next ACP session creation.
 */
export default function createMcpApiRoutes(io) {
  const router = Router();
  const tools = createToolHandlers(io);

  /**
   * GET /tools — returns tool definitions with JSON Schema for the stdio proxy.
   * The proxy registers these with the ACP so the agent knows what tools are available.
   * SYNC THIS with the tool handlers and definition modules when adding/changing tools.
   */
  router.get('/tools', (req, res) => {
    const query = req?.query || {};
    const context = resolveToolContext(query.providerId || null, query.proxyId || null);
    const providerConfig = getProvider(context.providerId).config;
    const serverName = providerConfig.mcpName || 'acpui';
    const quickModels = modelOptionsFromProviderConfig(providerConfig.models || {});
    const modelDescription = quickModels.length > 0
      ? `Optional model to use for these agents. Pass the model id. Available: ${quickModels.map(model => `${model.name} (id: ${model.id})`).join(', ')}`
      : 'Optional model id to use for these agents.';
    const toolList = [];
    if (isInvokeShellMcpEnabled()) {
      toolList.push(getInvokeShellMcpToolDefinition());
    }
    if (isSubagentsMcpEnabled()) {
      toolList.push(getSubagentsMcpToolDefinition({ modelDescription }));
    }
    if (isCounselMcpEnabled()) {
      toolList.push(getCounselMcpToolDefinition());
    }
    if (isSubagentsMcpEnabled() || isCounselMcpEnabled()) {
      toolList.push(getCheckSubagentsMcpToolDefinition());
      toolList.push(getAbortSubagentsMcpToolDefinition());
    }
    if (isIoMcpEnabled()) {
      toolList.push(...getIoMcpToolDefinitions());
    }
    if (isGoogleSearchMcpEnabled()) {
      toolList.push(...getGoogleSearchMcpToolDefinitions());
    }
    res.json({ tools: toolList, serverName });
  });

  /**
   * POST /tool-call — executes a tool and returns the result.
   * No timeout — the stdio proxy waits as long as needed (no HTTP timeout issue).
   */
  router.post('/tool-call', async (req, res) => {
    req.setTimeout(0);
    res.setTimeout(0);
    if (req.socket) req.socket.setTimeout(0);

    const { tool: toolName, args, providerId, proxyId, mcpRequestId, requestMeta } = req.body;
    writeLog(`[MCP API] Tool call: ${toolName}`);

    const proxyAuthToken = readProxyAuthToken(req);
    const resolvedExecution = resolveExecutionContext(providerId || null, proxyId || null, proxyAuthToken);
    if (resolvedExecution.error) {
      res.status(resolvedExecution.status).json({ error: resolvedExecution.error });
      return;
    }

    const handler = tools[toolName];
    if (!handler) {
      res.status(404).json({ error: `Unknown tool: ${toolName}` });
      return;
    }

    let abortSignal = null;
    try {
      abortSignal = createToolCallAbortSignal(req, res, toolName);
      const context = resolvedExecution.context;
      const handlerArgs = { ...(args || {}) };
      if (context.providerId) handlerArgs.providerId = context.providerId;
      if (context.acpSessionId) handlerArgs.acpSessionId = context.acpSessionId;
      if (context.mcpProxyId) handlerArgs.mcpProxyId = context.mcpProxyId;
      if (mcpRequestId !== undefined && mcpRequestId !== null) handlerArgs.mcpRequestId = mcpRequestId;
      if (requestMeta) handlerArgs.requestMeta = requestMeta;
      handlerArgs.abortSignal = abortSignal;
      const result = await handler(handlerArgs);
      writeLog(`[MCP API] Tool ${toolName} completed`);
      if (canWriteResponse(res, abortSignal)) res.json(result);
    } catch (err) {
      writeLog(`[MCP API] Tool ${toolName} error: ${err.message}`);
      if (!abortSignal?.aborted && !res.destroyed && !res.writableEnded) {
        res.json({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
      }
    }
  });

  return router;
}
