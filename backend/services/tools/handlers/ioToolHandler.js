import { acpUiToolTitle } from '../acpUiToolTitles.js';
import { acpUxIoToolConfig } from '../acpUxTools.js';
import { toolCallState } from '../toolCallState.js';

function filePathFor(canonicalName, input = {}, event = {}) {
  if (!acpUxIoToolConfig(canonicalName)?.usesFilePath) {
    return event.filePath;
  }
  return input.file_path || input.filePath || input.path || event.filePath;
}

function applyIoToolMetadata(ctx, invocation, event) {
  const canonicalName = invocation.identity?.canonicalName || event.canonicalName || event.toolName;
  const input = invocation.input || {};
  const filePath = filePathFor(canonicalName, input, event);
  const title = acpUiToolTitle(canonicalName, input, { filePath }) || event.title;
  const category = acpUxIoToolConfig(canonicalName)?.category || {};

  const record = toolCallState.upsert({
    providerId: ctx.providerId,
    sessionId: ctx.sessionId,
    toolCallId: invocation.toolCallId,
    input,
    display: title ? { title, titleSource: 'tool_handler' } : undefined,
    category,
    filePath
  });

  return {
    ...event,
    ...category,
    canonicalName,
    toolName: canonicalName,
    ...(filePath ? { filePath } : {}),
    title: record.display?.title || title || event.title
  };
}

export const ioToolHandler = {
  onStart: applyIoToolMetadata,
  onUpdate: applyIoToolMetadata,
  onEnd: applyIoToolMetadata
};
