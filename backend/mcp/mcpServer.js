/**
 * MCP Tool Handlers.
 *
 * Plain async functions -- no MCP SDK dependency.
 * The stdio proxy (stdio-proxy.js) handles the MCP protocol; these are the implementations.
 * Called via POST /api/mcp/tool-call from the proxy.
 *
 * Tool schemas (JSON Schema for the ACP) are defined separately in routes/mcpApi.js.
 * IMPORTANT: When adding/renaming/removing tools here, also update the schemas in mcpApi.js.
 *
 * Exports:
 *   getMcpServers()           -- stdio MCP server config for session/new mcpServers array
 *   createToolHandlers(io)    -- returns { toolName: handler(args) } map
 */
import { getProvider, getProviderModuleSync } from '../services/providerLoader.js';
import { writeLog } from '../services/logger.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { createHash } from 'crypto';
import { subAgentInvocationManager } from './subAgentInvocationManager.js';
import { loadCounselConfig } from '../services/counselConfig.js';
import { createMcpProxyBinding } from './mcpProxyRegistry.js';
import { shellRunManager } from '../services/shellRunManager.js';
import {
  mcpExecutionRegistry,
  publicMcpToolInput,
  toolCallIdFromMcpContext
} from '../services/tools/mcpExecutionRegistry.js';
import {
  isCounselMcpEnabled,
  isGoogleSearchMcpEnabled,
  isInvokeShellMcpEnabled,
  isIoMcpEnabled,
  isSubagentsMcpEnabled
} from '../services/mcpConfig.js';
import { ACP_UX_TOOL_NAMES } from '../services/tools/acpUxTools.js';
import { createGoogleSearchMcpToolHandlers, createIoMcpToolHandlers } from './ioMcpToolHandlers.js';

const DEFAULT_MAX_SHELL_RESULT_LINES = 1000;

export function getMaxShellResultLines(env = process.env) {
  const parsed = Number.parseInt(env.MAX_SHELL_RESULT_LINES || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SHELL_RESULT_LINES;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashInvocationInput(input) {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 16);
}

function buildSubAgentInvocationKey({ providerId, acpSessionId, mcpProxyId, mcpRequestId, requestMeta, toolName, input }) {
  if (!providerId) return null;
  const sessionScope = acpSessionId || mcpProxyId;
  if (!sessionScope) return null;

  const scope = `${providerId}::${sessionScope}::${toolName}`;
  if (mcpRequestId !== undefined && mcpRequestId !== null && mcpRequestId !== '') {
    return `${scope}::mcp-request::${String(mcpRequestId)}`;
  }

  const toolCallId = toolCallIdFromMcpContext({ requestMeta, toolName });
  if (toolCallId) return `${scope}::tool-call::${String(toolCallId)}`;

  return `${scope}::fingerprint::${hashInvocationInput(input)}`;
}

function wrapToolHandlers(tools, io) {
  const wrapped = {};
  for (const [toolName, handler] of Object.entries(tools)) {
    wrapped[toolName] = async (args = {}) => {
      const input = publicMcpToolInput(toolName, args);
      const execution = mcpExecutionRegistry.begin({
        io,
        providerId: args.providerId,
        sessionId: args.acpSessionId,
        acpSessionId: args.acpSessionId,
        mcpProxyId: args.mcpProxyId,
        mcpRequestId: args.mcpRequestId,
        requestMeta: args.requestMeta,
        toolName,
        input
      });

      try {
        const result = await handler(args);
        mcpExecutionRegistry.complete(execution, result);
        return result;
      } catch (err) {
        mcpExecutionRegistry.fail(execution, err);
        throw err;
      }
    };
  }
  return wrapped;
}

/**
 * Returns the stdio MCP server config for passing in session/new mcpServers array.
 * The ACP spawns this as a child process and communicates via stdin/stdout.
 */
export function getMcpServers(providerId = null, { acpSessionId = null } = {}) {
  const provider = getProvider(providerId);
  const name = provider.config.mcpName;
  if (!name) return [];
  const providerModule = getProviderModuleSync(provider.id);
  const mcpServerMeta = providerModule.getMcpServerMeta?.();
  const proxyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'stdio-proxy.js');
  const proxyId = createMcpProxyBinding({ providerId: provider.id, acpSessionId });
  return [{
    name,
    command: 'node',
    args: [proxyPath],
    env: [
      { name: 'ACP_SESSION_PROVIDER_ID', value: String(provider.id) },
      { name: 'ACP_UI_MCP_PROXY_ID', value: proxyId },
      { name: 'BACKEND_PORT', value: String(process.env.BACKEND_PORT || 3005) },
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
    ],
    ...(mcpServerMeta ? { _meta: mcpServerMeta } : {})
  }];
}

/**
 * Creates tool handlers bound to io.
 * Returns a map of { toolName: handler(args) }.
 */
export function createToolHandlers(io) {
  const tools = {};

  const runShellInvocation = async ({ description, command, cwd, providerId, acpSessionId, mcpRequestId, requestMeta }) => {
    const workingDir = cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
    const maxLines = getMaxShellResultLines();

    if (providerId && acpSessionId) {
      const toolCallId = toolCallIdFromMcpContext({
        requestMeta,
        mcpRequestId,
        toolName: ACP_UX_TOOL_NAMES.invokeShell
      });
      shellRunManager.setIo?.(io);
      writeLog(`[MCP SHELL] Running: ${command} in ${workingDir}`);
      return shellRunManager.startPreparedRun({
        providerId,
        acpSessionId,
        toolCallId,
        mcpRequestId,
        description,
        command,
        cwd: workingDir,
        maxLines
      });
    }

    writeLog('[MCP SHELL] Missing provider/session context; tool call aborted');
    return { content: [{ type: 'text', text: 'Error: Shell execution context unavailable' }] };
  };

  if (isInvokeShellMcpEnabled()) {
    tools[ACP_UX_TOOL_NAMES.invokeShell] = runShellInvocation;
  }

  const runSubagentInvocation = async ({
    requests,
    model,
    providerId,
    acpSessionId,
    mcpProxyId,
    mcpRequestId,
    requestMeta,
    abortSignal,
    _skipToolState = false,
    idempotencyToolName = ACP_UX_TOOL_NAMES.invokeSubagents
  }) => {
    const idempotencyKey = buildSubAgentInvocationKey({
      providerId,
      acpSessionId,
      mcpProxyId,
      mcpRequestId,
      requestMeta,
      toolName: idempotencyToolName,
      input: { requests, model }
    });
    subAgentInvocationManager.setIo(io);
    return subAgentInvocationManager.runInvocation({
      requests,
      model,
      providerId,
      parentAcpSessionId: acpSessionId,
      idempotencyKey,
      abortSignal
    });
  };

  if (isSubagentsMcpEnabled()) {
    tools[ACP_UX_TOOL_NAMES.invokeSubagents] = runSubagentInvocation;
  }

  /**
   * Counsel tool -- spawns multiple sub-agents with different perspectives to evaluate a question.
   * Reuses the ux_invoke_subagents infrastructure with structured role prompts from counsel.json.
   *
   * Agent list is built from counsel.json (loaded via counselConfig.js):
   *   - config.core[] agents are always included (Advocate, Critic, Pragmatist)
   *   - config.optional.{key} agents are added when the matching boolean flag is true
   * Each agent entry has { name, prompt } -- the prompt defines the agent's perspective/role.
   *
   * Delegates to ux_invoke_subagents so counsel agents get the same session lifecycle,
   * UI visibility, and cleanup as any other sub-agent.
   */
  const runCounselInvocation = async ({
    question,
    architect,
    performance,
    security,
    ux,
    providerId,
    acpSessionId,
    mcpProxyId,
    mcpRequestId,
    requestMeta,
    abortSignal
  }) => {
    const config = loadCounselConfig();
    const agents = [...(config.core || [])];

    if (architect && config.optional?.architect) agents.push(config.optional.architect);
    if (performance && config.optional?.performance) agents.push(config.optional.performance);
    if (security && config.optional?.security) agents.push(config.optional.security);
    if (ux && config.optional?.ux) agents.push(config.optional.ux);

    if (!agents.length) {
      return { content: [{ type: 'text', text: 'Error: No counsel agents configured' }] };
    }

    const requests = agents.map(agent => ({
      prompt: `${agent.prompt}\n\nThe question/topic to evaluate:\n\n${question}`,
      name: agent.name,
    }));

    return runSubagentInvocation({
      requests,
      providerId,
      acpSessionId,
      mcpProxyId,
      mcpRequestId,
      requestMeta,
      abortSignal,
      _skipToolState: true,
      idempotencyToolName: ACP_UX_TOOL_NAMES.invokeCounsel
    });
  };

  if (isCounselMcpEnabled()) {
    tools[ACP_UX_TOOL_NAMES.invokeCounsel] = runCounselInvocation;
  }

  if (isIoMcpEnabled()) {
    Object.assign(tools, createIoMcpToolHandlers());
  }

  if (isGoogleSearchMcpEnabled()) {
    Object.assign(tools, createGoogleSearchMcpToolHandlers());
  }

  return wrapToolHandlers(tools, io);
}
