import { toolCallState } from './toolCallState.js';
import { isAcpUxToolName } from './acpUxTools.js';
import { invocationFromMcpExecution, mcpExecutionRegistry } from './mcpExecutionRegistry.js';

function phaseFor(update, event) {
  if (event?.type === 'tool_start' || update?.sessionUpdate === 'tool_call') return 'start';
  if (event?.type === 'tool_end' || update?.status) return 'end';
  return 'update';
}

function compactObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

function normalizeInvocation(result, defaultTitleSource = 'provider') {
  if (!result || typeof result !== 'object') return {};
  const identity = result.identity || {};
  return {
    toolCallId: result.toolCallId,
    identity: compactObject({
      kind: identity.kind || result.kind,
      canonicalName: identity.canonicalName || result.canonicalName,
      rawName: identity.rawName || result.rawName,
      mcpServer: identity.mcpServer || result.mcpServer,
      mcpToolName: identity.mcpToolName || result.mcpToolName
    }),
    input: result.input || {},
    display: compactObject({
      title: result.display?.title || result.title,
      titleSource: result.display?.titleSource || (result.title ? defaultTitleSource : undefined)
    }),
    category: result.category || {},
    filePath: result.filePath,
    output: result.output,
    status: result.status,
    execution: result.execution
  };
}

function isAcpUiMcpIdentity(identity = {}, acpUiMcpServerName) {
  if (identity.kind === 'acpui_mcp') return true;
  if (isAcpUxToolName(identity.canonicalName) || isAcpUxToolName(identity.mcpToolName)) return true;
  if (!acpUiMcpServerName) return false;
  return identity.mcpServer === acpUiMcpServerName;
}

function lookupMcpExecution({ providerId, sessionId, update, event, toolCallId, providerInvocation, cached }) {
  const toolName = providerInvocation.identity?.canonicalName
    || cached?.identity?.canonicalName
    || event?.toolName
    || update?.toolName
    || providerInvocation.identity?.mcpToolName
    || cached?.identity?.mcpToolName;

  if (!toolCallId && !toolName) return null;
  if (toolName && !isAcpUxToolName(toolName)) return null;

  return mcpExecutionRegistry.find({
    providerId,
    sessionId,
    toolCallId,
    toolName
  });
}

export function resolveToolInvocation({
  providerId,
  sessionId,
  update,
  event,
  providerModule,
  phase,
  acpUiMcpServerName
}) {
  const providerResult = providerModule?.extractToolInvocation?.(update, {
    providerId,
    sessionId,
    event,
    phase: phase || phaseFor(update, event)
  });
  const providerInvocation = normalizeInvocation(providerResult, 'provider');
  const initialToolCallId = providerInvocation.toolCallId || update?.toolCallId || event?.id;
  const cached = toolCallState.get(providerId, sessionId, initialToolCallId);
  const mcpInvocation = normalizeInvocation(invocationFromMcpExecution(lookupMcpExecution({
    providerId,
    sessionId,
    update,
    event,
    toolCallId: initialToolCallId,
    providerInvocation,
    cached
  })), 'mcp_handler');
  const toolCallId = mcpInvocation.toolCallId || initialToolCallId;
  const resolvedPhase = phase || phaseFor(update, event);
  const eventToolName = event?.toolName || update?.toolName;

  const mergedIdentity = compactObject({
    ...(providerInvocation.identity || {}),
    ...(cached?.identity || {}),
    ...(mcpInvocation.identity || {}),
    canonicalName: mcpInvocation.identity?.canonicalName
      || cached?.identity?.canonicalName
      || providerInvocation.identity?.canonicalName
      || eventToolName,
    rawName: mcpInvocation.identity?.rawName
      || cached?.identity?.rawName
      || providerInvocation.identity?.rawName
      || eventToolName,
    mcpServer: mcpInvocation.identity?.mcpServer
      || cached?.identity?.mcpServer
      || providerInvocation.identity?.mcpServer,
    mcpToolName: mcpInvocation.identity?.mcpToolName
      || cached?.identity?.mcpToolName
      || providerInvocation.identity?.mcpToolName
  });
  if (isAcpUiMcpIdentity(mergedIdentity, acpUiMcpServerName)) {
    mergedIdentity.kind = 'acpui_mcp';
    if (!mergedIdentity.mcpServer && acpUiMcpServerName) mergedIdentity.mcpServer = acpUiMcpServerName;
    if (!mergedIdentity.mcpToolName && mergedIdentity.canonicalName) {
      mergedIdentity.mcpToolName = mergedIdentity.canonicalName;
    }
  }

  const invocation = toolCallState.upsert({
    providerId,
    sessionId,
    toolCallId,
    phase: resolvedPhase,
    identity: mergedIdentity,
    input: {
      ...(cached?.input || {}),
      ...(providerInvocation.input || {}),
      ...(mcpInvocation.input || {})
    },
    display: compactObject({
      title: mcpInvocation.display?.title
        || providerInvocation.display?.title
        || event?.title
        || update?.title
        || cached?.display?.title,
      titleSource: mcpInvocation.display?.titleSource
        || providerInvocation.display?.titleSource
        || (event?.title || update?.title ? 'provider' : undefined)
        || cached?.display?.titleSource
    }),
    category: {
      ...(providerInvocation.category || {}),
      ...(cached?.category || {}),
      ...(mcpInvocation.category || {})
    },
    filePath: mcpInvocation.filePath || cached?.filePath || providerInvocation.filePath || event?.filePath,
    output: event?.output ?? mcpInvocation.output,
    status: event?.status || mcpInvocation.status || cached?.status,
    raw: {
      providerInvocation,
      mcpExecution: mcpInvocation.execution
    }
  });

  return invocation;
}

export function applyInvocationToEvent(event, invocation) {
  if (!invocation) return event;
  const identity = invocation.identity || {};
  const category = invocation.category || {};
  const isAcpUxTool = identity.kind === 'acpui_mcp';
  return {
    ...event,
    ...(identity.canonicalName ? { toolName: identity.canonicalName, canonicalName: identity.canonicalName } : {}),
    ...(identity.mcpServer ? { mcpServer: identity.mcpServer } : {}),
    ...(identity.mcpToolName ? { mcpToolName: identity.mcpToolName } : {}),
    ...(isAcpUxTool ? { isAcpUxTool: true } : {}),
    ...(invocation.filePath ? { filePath: invocation.filePath } : {}),
    ...(invocation.output !== undefined && event.output === undefined ? { output: invocation.output } : {}),
    ...(invocation.status && !event.status ? { status: invocation.status } : {}),
    ...(invocation.display?.title ? { title: invocation.display.title } : {}),
    ...(invocation.display?.titleSource ? { titleSource: invocation.display.titleSource } : {}),
    ...category
  };
}
