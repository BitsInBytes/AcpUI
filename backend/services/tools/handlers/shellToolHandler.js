import { shellRunManager } from '../../shellRunManager.js';
import { normalizeText } from '../toolInputUtils.js';
import { toolCallState } from '../toolCallState.js';

function shellTitle(description) {
  const normalized = normalizeText(description);
  return normalized ? `Invoke Shell: ${normalized}` : '';
}

function applyShellDescriptionTitle(ctx, invocation, event) {
  const description = normalizeText(invocation.input?.description);
  const title = shellTitle(description);
  const shellRunId = invocation.toolSpecific?.shellRunId;
  const nextEvent = shellRunId ? { ...event, shellRunId } : event;
  if (!title) return nextEvent;

  toolCallState.upsert({
    providerId: ctx.providerId,
    sessionId: ctx.sessionId,
    toolCallId: invocation.toolCallId,
    display: { title, titleSource: 'tool_handler' }
  });

  return { ...nextEvent, title };
}

export const shellToolHandler = {
  onStart(ctx, invocation, event) {
    const description = normalizeText(invocation.input?.description);
    const command = typeof invocation.input?.command === 'string' ? invocation.input.command : '';
    const hasCommand = normalizeText(command) !== '';
    const cwd = invocation.input?.cwd || null;
    const mcpRequestId = invocation.raw?.mcpExecution?.mcpRequestId ?? null;

    shellRunManager.setIo?.(ctx.acpClient.io);
    const existingRun = shellRunManager.findRun?.({
      providerId: ctx.providerId,
      sessionId: ctx.sessionId,
      toolCallId: invocation.toolCallId,
      mcpRequestId,
      command,
      cwd,
      statuses: ['pending', 'starting', 'running', 'exiting', 'exited'],
      allowToolCallIdMismatch: true
    });
    const prepared = existingRun
      ? (shellRunManager.snapshot?.(existingRun) || existingRun)
      : hasCommand
        ? shellRunManager.prepareRun({
          providerId: ctx.providerId,
          sessionId: ctx.sessionId,
          toolCallId: invocation.toolCallId,
          mcpRequestId,
          description,
          command,
          cwd
        })
        : null;

    const title = shellTitle(description) || event.title;
    const resolvedCommand = prepared?.command || command;
    const resolvedCwd = prepared?.cwd || cwd;
    const input = { description };
    if (resolvedCommand) input.command = resolvedCommand;
    if (resolvedCwd) input.cwd = resolvedCwd;
    const stateUpdate = {
      providerId: ctx.providerId,
      sessionId: ctx.sessionId,
      toolCallId: invocation.toolCallId,
      input,
      display: { title, titleSource: title === event.title ? 'provider' : 'tool_handler' }
    };
    if (prepared?.runId) stateUpdate.toolSpecific = { shellRunId: prepared.runId };
    toolCallState.upsert(stateUpdate);

    if (!prepared?.runId) {
      return {
        ...event,
        ...(resolvedCommand ? { command: resolvedCommand } : {}),
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
        title
      };
    }

    return {
      ...event,
      shellRunId: prepared.runId,
      shellInteractive: true,
      shellState: prepared.status,
      command: prepared.command,
      cwd: prepared.cwd,
      title
    };
  },

  onUpdate(ctx, invocation, event) {
    return applyShellDescriptionTitle(ctx, invocation, event);
  },

  onEnd(ctx, invocation, event) {
    return applyShellDescriptionTitle(ctx, invocation, event);
  }
};
