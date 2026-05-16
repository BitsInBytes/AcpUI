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
import { writeLog } from '../services/logger.js';
import { createHash } from 'crypto';
import { subAgentInvocationManager } from './subAgentInvocationManager.js';
import { loadCounselConfig } from '../services/counselConfig.js';
import { shellRunManager } from '../services/shellRunManager.js';
import {
  mcpExecutionRegistry,
  publicMcpToolInput,
  toolCallIdFromMcpContext
} from '../services/tools/mcpExecutionRegistry.js';
import { getSubagentsMcpConfig } from '../services/mcpConfig.js';
import { ACP_UX_TOOL_NAMES } from '../services/tools/acpUxTools.js';
import { isSubAgentStatusWaitEnabled } from '../services/tools/acpUiToolTitles.js';
import { createGoogleSearchMcpToolHandlers, createIoMcpToolHandlers } from './ioMcpToolHandlers.js';
import { buildMcpServersForProvider } from './mcpServerConfig.js';
import { getMcpToolEnablement } from './mcpToolMetadata.js';

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
  return buildMcpServersForProvider(providerId, { acpSessionId });
}

/**
 * Creates tool handlers bound to io.
 * Returns a map of { toolName: handler(args) }.
 */
export function createToolHandlers(io) {
  const tools = {};
  const toolEnablement = getMcpToolEnablement();

  const runShellInvocation = async ({ description, command, cwd, providerId, acpSessionId, mcpRequestId, requestMeta, abortSignal }) => {
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
      const startArgs = {
        providerId,
        acpSessionId,
        toolCallId,
        mcpRequestId,
        description,
        command,
        cwd: workingDir,
        maxLines
      };
      if (abortSignal) startArgs.abortSignal = abortSignal;
      return shellRunManager.startPreparedRun(startArgs);
    }

    writeLog('[MCP SHELL] Missing provider/session context; tool call aborted');
    return { content: [{ type: 'text', text: 'Error: Shell execution context unavailable' }] };
  };

  if (toolEnablement.invokeShell) {
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
    const parentToolCallId = toolCallIdFromMcpContext({
      requestMeta,
      mcpRequestId,
      toolName: idempotencyToolName
    });
    subAgentInvocationManager.setIo(io);
    return subAgentInvocationManager.runInvocation({
      requests,
      model,
      providerId,
      parentAcpSessionId: acpSessionId,
      parentToolCallId,
      parentToolName: idempotencyToolName,
      idempotencyKey,
      abortSignal
    });
  };

  if (toolEnablement.subagents) {
    tools[ACP_UX_TOOL_NAMES.invokeSubagents] = runSubagentInvocation;
  }

  const runCheckSubagentsInvocation = async ({ invocationId, providerId, waitForCompletion, wait_for_completion, abortSignal }) => {
    const { statusWaitTimeoutMs, statusPollIntervalMs } = getSubagentsMcpConfig();
    const shouldWait = isSubAgentStatusWaitEnabled({ waitForCompletion, wait_for_completion });
    subAgentInvocationManager.setIo(io);
    return subAgentInvocationManager.getInvocationStatus({
      providerId,
      invocationId,
      waitTimeoutMs: shouldWait ? statusWaitTimeoutMs : 0,
      pollIntervalMs: statusPollIntervalMs,
      abortSignal
    });
  };

  const runAbortSubagentsInvocation = async ({ invocationId, providerId, abortSignal }) => {
    const { statusPollIntervalMs } = getSubagentsMcpConfig();
    subAgentInvocationManager.setIo(io);
    await subAgentInvocationManager.cancelInvocation(providerId, invocationId);
    return subAgentInvocationManager.getInvocationStatus({
      providerId,
      invocationId,
      waitTimeoutMs: 0,
      pollIntervalMs: statusPollIntervalMs,
      abortSignal
    });
  };

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

  if (toolEnablement.counsel) {
    tools[ACP_UX_TOOL_NAMES.invokeCounsel] = runCounselInvocation;
  }

  if (toolEnablement.subagentStatus) {
    tools[ACP_UX_TOOL_NAMES.checkSubagents] = runCheckSubagentsInvocation;
    tools[ACP_UX_TOOL_NAMES.abortSubagents] = runAbortSubagentsInvocation;
  }

  if (toolEnablement.io) {
    Object.assign(tools, createIoMcpToolHandlers());
  }

  if (toolEnablement.googleSearch) {
    Object.assign(tools, createGoogleSearchMcpToolHandlers());
  }

  return wrapToolHandlers(tools, io);
}
