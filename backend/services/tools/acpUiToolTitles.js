import path from 'path';
import { acpUxToolTitleConfig } from './acpUxTools.js';

function headerValue(value) {
  return String(value || '').trim();
}

function isExplicitFalse(value) {
  return value === false || String(value || '').trim().toLowerCase() === 'false';
}

export function isSubAgentStatusWaitEnabled(input = {}) {
  const waitForCompletion = input.waitForCompletion ?? input.wait_for_completion;
  return !isExplicitFalse(waitForCompletion);
}

export function subAgentCheckToolTitle(input = {}) {
  return isSubAgentStatusWaitEnabled(input)
    ? 'Check Subagents: Waiting for agents to finish'
    : 'Check Subagents: Quick status check';
}

export function basenameForToolPath(value) {
  const text = headerValue(value);
  if (!text) return '';
  return path.posix.basename(text.replace(/\\/g, '/')) || path.basename(text);
}

export function acpUiToolTitle(toolName, input = {}, options = {}) {
  const config = acpUxToolTitleConfig(toolName);
  if (!config) return null;

  const filePath = input.file_path || input.filePath || input.path || options.filePath;
  const fileBasename = basenameForToolPath(filePath);
  const descriptionOrPattern = headerValue(input.description) || headerValue(input.pattern);
  const directoryPath = headerValue(input.dir_path || input.dirPath || input.path);
  const detailValues = {
    fileBasename,
    directoryPath,
    descriptionOrPattern,
    url: headerValue(input.url),
    query: headerValue(input.query)
  };
  const detail = detailValues[config.headerDetail] || '';

  return detail ? `${config.headerTitle}: ${detail}` : config.headerTitle;
}
