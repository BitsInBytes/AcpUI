import { toolCallState } from './toolCallState.js';

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

function normalizeProviderInvocation(result) {
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
      titleSource: result.display?.titleSource || (result.title ? 'provider' : undefined)
    }),
    category: result.category || {},
    filePath: result.filePath
  };
}

export function resolveToolInvocation({
  providerId,
  sessionId,
  update,
  event,
  providerModule,
  phase
}) {
  const providerResult = providerModule?.extractToolInvocation?.(update, {
    providerId,
    sessionId,
    event,
    phase: phase || phaseFor(update, event)
  });
  const providerInvocation = normalizeProviderInvocation(providerResult);
  const toolCallId = providerInvocation.toolCallId || update?.toolCallId || event?.id;
  const cached = toolCallState.get(providerId, sessionId, toolCallId);
  const resolvedPhase = phase || phaseFor(update, event);
  const eventToolName = event?.toolName || update?.toolName;

  const invocation = toolCallState.upsert({
    providerId,
    sessionId,
    toolCallId,
    phase: resolvedPhase,
    status: update?.status,
    identity: compactObject({
      ...(cached?.identity || {}),
      ...(providerInvocation.identity || {}),
      canonicalName: providerInvocation.identity?.canonicalName || cached?.identity?.canonicalName || eventToolName,
      rawName: providerInvocation.identity?.rawName || cached?.identity?.rawName || eventToolName
    }),
    input: {
      ...(cached?.input || {}),
      ...(providerInvocation.input || {})
    },
    display: compactObject({
      title: providerInvocation.display?.title || event?.title || update?.title || cached?.display?.title,
      titleSource: providerInvocation.display?.titleSource || (event?.title || update?.title ? 'provider' : cached?.display?.titleSource)
    }),
    category: {
      ...(cached?.category || {}),
      ...(providerInvocation.category || {})
    },
    filePath: providerInvocation.filePath || event?.filePath || cached?.filePath,
    output: event?.output,
    raw: {
      providerInvocation
    }
  });

  return invocation;
}

export function applyInvocationToEvent(event, invocation) {
  if (!invocation) return event;
  const identity = invocation.identity || {};
  const category = invocation.category || {};
  return {
    ...event,
    ...(identity.canonicalName ? { toolName: identity.canonicalName, canonicalName: identity.canonicalName } : {}),
    ...(identity.mcpServer ? { mcpServer: identity.mcpServer } : {}),
    ...(identity.mcpToolName ? { mcpToolName: identity.mcpToolName } : {}),
    ...(invocation.filePath ? { filePath: invocation.filePath } : {}),
    ...(invocation.display?.title ? { title: invocation.display.title } : {}),
    ...category
  };
}
