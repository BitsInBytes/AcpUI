import { Router } from 'express';
import { createToolHandlers } from '../mcp/mcpServer.js';
import { getProvider } from '../services/providerLoader.js';
import { writeLog } from '../services/logger.js';
import { modelOptionsFromProviderConfig } from '../services/modelOptions.js';
import { resolveMcpProxy } from '../mcp/mcpProxyRegistry.js';

function resolveToolContext(providerId, proxyId) {
  const proxy = resolveMcpProxy(proxyId);
  return {
    providerId: proxy?.providerId || providerId || null,
    acpSessionId: proxy?.acpSessionId || null,
    mcpProxyId: proxy?.proxyId || proxyId || null
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
 * the JSON Schema definitions in the GET /tools response below, AND the proxy will
 * pick up the changes automatically on next ACP session creation.
 */
export default function createMcpApiRoutes(io) {
  const router = Router();
  const tools = createToolHandlers(io);

  /**
   * GET /tools — returns tool definitions with JSON Schema for the stdio proxy.
   * The proxy registers these with the ACP so the agent knows what tools are available.
   * SYNC THIS with the tool handlers in mcpServer.js when adding/changing tools.
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
    const toolList = [
      { name: 'ux_invoke_shell', title: 'Interactive shell', description: 'Execute a shell command in a real terminal with live streaming output and user-interactive stdin while the process is running. Always use this tool for shell commands; never use system shell, bash, or powershell tools when they are present. This is a full replacement for shell execution. Use for running build commands, tests, scripts, package installs, CLIs that may prompt, and other command-line operations. Multiple ux_invoke_shell calls may be invoked concurrently; each command gets its own terminal. Use parallel calls for independent commands that do not contend for the same files, ports, packages, or other shared resources. The tool call returns after the command exits or the user terminates it, and the terminal becomes read-only after exit.', annotations: {
        title: 'Interactive shell',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }, _meta: {
        'acpui/concurrentInvocationsSupported': true
      }, inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A short description (1 sentence, 3-10 words) that will be displayed to the user when this command runs so they can understand the purpose of the command at a glance.' },
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (absolute path)' },
        },
        required: ['description', 'command'],
      }},
      { name: 'ux_invoke_subagents', description: 'Spawn and coordinate multiple AI agents in parallel. Each agent runs as a visible session in the UI. Returns when all agents complete.', inputSchema: {
        type: 'object',
        properties: {
          model: { 
            type: 'string', 
            description: modelDescription
          },
          requests: {
            type: 'array',
            description: 'Array of sub-agent requests to run in parallel',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'The task prompt for this agent' },
                name: { type: 'string', description: 'Short display name for this agent' },
                agent: { type: 'string', description: 'Agent name' },
                cwd: { type: 'string', description: 'Working directory' },
              },
              required: ['prompt'],
            },
          },
        },
        required: ['requests'],
      }},
      { name: 'ux_invoke_counsel', description: 'Spawn multiple AI sub-agents with different perspectives to evaluate a question or decision. Always includes Advocate (argues for), Critic (argues against), and Pragmatist (practical assessment). Optionally include domain experts.', inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, decision, or topic to evaluate from multiple perspectives' },
          architect: { type: 'boolean', description: 'Include a Software Architecture expert' },
          performance: { type: 'boolean', description: 'Include a Software Performance expert' },
          security: { type: 'boolean', description: 'Include a Software Security expert' },
          ux: { type: 'boolean', description: 'Include a Software UX expert' },
        },
        required: ['question'],
      }},
    ];
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

    const handler = tools[toolName];
    if (!handler) {
      res.status(404).json({ error: `Unknown tool: ${toolName}` });
      return;
    }

    let abortSignal = null;
    try {
      abortSignal = createToolCallAbortSignal(req, res, toolName);
      const context = resolveToolContext(providerId || null, proxyId || null);
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
