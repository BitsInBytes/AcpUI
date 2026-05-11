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
  if (!title) return event;

  toolCallState.upsert({
    providerId: ctx.providerId,
    sessionId: ctx.sessionId,
    toolCallId: invocation.toolCallId,
    display: { title, titleSource: 'tool_handler' }
  });

  return { ...event, title };
}

export const shellToolHandler = {
  onStart(ctx, invocation, event) {
    const description = normalizeText(invocation.input?.description);
    const command = invocation.input?.command || '';
    const cwd = invocation.input?.cwd || null;

    shellRunManager.setIo?.(ctx.acpClient.io);
    const prepared = shellRunManager.prepareRun({
      providerId: ctx.providerId,
      sessionId: ctx.sessionId,
      toolCallId: invocation.toolCallId,
      description,
      command,
      cwd
    });

    const title = shellTitle(description) || event.title;
    toolCallState.upsert({
      providerId: ctx.providerId,
      sessionId: ctx.sessionId,
      toolCallId: invocation.toolCallId,
      input: { description, command: prepared.command, cwd: prepared.cwd },
      display: { title, titleSource: title === event.title ? 'provider' : 'tool_handler' },
      toolSpecific: { shellRunId: prepared.runId }
    });

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
