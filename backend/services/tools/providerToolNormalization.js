import path from 'path';
import { ACP_UX_TOOL_NAMES, isAcpUxToolName } from './acpUxTools.js';
import { collectInputObjects, isPlainObject, mergeInputObjects, parseMaybeJson } from './toolInputUtils.js';
import { matchToolIdPattern } from './toolIdPattern.js';

export const ACP_UX_MCP_TITLE_TO_TOOL_NAME = Object.freeze({
  'interactive shell': ACP_UX_TOOL_NAMES.invokeShell,
  'invoke shell': ACP_UX_TOOL_NAMES.invokeShell,
  'run shell command': ACP_UX_TOOL_NAMES.invokeShell,
  'invoke subagents': ACP_UX_TOOL_NAMES.invokeSubagents,
  'invoke sub agents': ACP_UX_TOOL_NAMES.invokeSubagents,
  'check subagents': ACP_UX_TOOL_NAMES.checkSubagents,
  'check sub agents': ACP_UX_TOOL_NAMES.checkSubagents,
  'abort subagents': ACP_UX_TOOL_NAMES.abortSubagents,
  'abort sub agents': ACP_UX_TOOL_NAMES.abortSubagents,
  'invoke counsel': ACP_UX_TOOL_NAMES.invokeCounsel,
  'read file': ACP_UX_TOOL_NAMES.readFile,
  'write file': ACP_UX_TOOL_NAMES.writeFile,
  replace: ACP_UX_TOOL_NAMES.replace,
  'replace in file': ACP_UX_TOOL_NAMES.replace,
  'list directory': ACP_UX_TOOL_NAMES.listDirectory,
  glob: ACP_UX_TOOL_NAMES.glob,
  'glob files': ACP_UX_TOOL_NAMES.glob,
  'grep search': ACP_UX_TOOL_NAMES.grepSearch,
  'web fetch': ACP_UX_TOOL_NAMES.webFetch,
  'google web search': ACP_UX_TOOL_NAMES.googleWebSearch
});

const ACP_UX_CORE_TOOL_TITLES = Object.freeze({
  [ACP_UX_TOOL_NAMES.invokeShell]: 'Invoke Shell',
  [ACP_UX_TOOL_NAMES.invokeSubagents]: 'Invoke Subagents',
  [ACP_UX_TOOL_NAMES.invokeCounsel]: 'Invoke Counsel',
  [ACP_UX_TOOL_NAMES.checkSubagents]: 'Check Subagents',
  [ACP_UX_TOOL_NAMES.abortSubagents]: 'Abort Subagents'
});

const ACP_UX_INPUT_KEYS = new Set([
  'description',
  'command',
  'cmd',
  'cwd',
  'model',
  'requests',
  'invocationId',
  'waitForCompletion',
  'question',
  'architect',
  'performance',
  'security',
  'ux',
  'file_path',
  'filePath',
  'path',
  'target',
  'target_path',
  'targetPath',
  'dir_path',
  'dirPath',
  'content',
  'old_string',
  'new_string',
  'oldStr',
  'newStr',
  'old_str',
  'new_str',
  'allow_multiple',
  'pattern',
  'case_sensitive',
  'context',
  'fixed_strings',
  'url',
  'query'
]);

function maybeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function stripToolTitlePrefix(value) {
  return typeof value === 'string' ? value.replace(/^Tool:\s*/i, '').trim() : '';
}

export function titleLookupKey(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function prettyToolTitle(toolName, fallback = 'Tool') {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return ACP_UX_CORE_TOOL_TITLES[normalized]
    || normalized.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function resolveToolNameFromAcpUiMcpTitle(title) {
  const key = titleLookupKey(title);
  const prefixKey = titleLookupKey(String(title || '').split(':')[0]);
  return ACP_UX_MCP_TITLE_TO_TOOL_NAME[key] || ACP_UX_MCP_TITLE_TO_TOOL_NAME[prefixKey] || '';
}

export function collectDeepInputValues(value, output = {}, seen = new Set()) {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object') return output;
  if (seen.has(parsed)) return output;
  seen.add(parsed);

  if (Array.isArray(parsed)) {
    for (const item of parsed) collectDeepInputValues(item, output, seen);
    return output;
  }

  for (const [key, nestedValue] of Object.entries(parsed)) {
    if (ACP_UX_INPUT_KEYS.has(key) && output[key] === undefined) {
      output[key] = nestedValue;
    }
    collectDeepInputValues(nestedValue, output, seen);
  }

  return output;
}

export function inputFromToolUpdate(update = {}, options = {}) {
  const values = [
    update.rawInput,
    update.arguments,
    update.args,
    update.params,
    update.input,
    update.description,
    update.toolCall?.arguments,
    update.toolCall?.args,
    ...(Array.isArray(options.values) ? options.values : [])
  ];
  const standardInput = mergeInputObjects(collectInputObjects(...values));
  let input = options.deep
    ? { ...collectDeepInputValues([...values, update.toolCall]), ...standardInput }
    : { ...standardInput };

  for (const extraInput of options.extraInputs || []) {
    input = {
      ...input,
      ...mergeInputObjects(collectInputObjects(extraInput))
    };
  }

  if (isPlainObject(options.extraInput)) {
    input = { ...input, ...options.extraInput };
  }

  return input;
}

export function mcpInvocationFromRaw(rawValue) {
  const raw = parseMaybeJson(rawValue);
  if (!isPlainObject(raw)) return {};

  const invocation = isPlainObject(raw.invocation) ? raw.invocation : raw;
  const rawArgs = invocation.arguments || invocation.args || raw.arguments || raw.args || {};
  const parsedArgs = parseMaybeJson(rawArgs);
  const tool = invocation.tool || invocation.name || invocation.toolName || invocation.tool_name;

  return {
    server: invocation.server || invocation.mcpServer || invocation.mcp_name,
    tool: maybeString(tool),
    arguments: isPlainObject(parsedArgs) ? parsedArgs : {}
  };
}

export function commandFromRawInput(rawValue) {
  const raw = parseMaybeJson(rawValue);
  if (!isPlainObject(raw)) return '';
  const rawArgs = raw.invocation?.arguments || raw.arguments || raw.args || raw.input || {};
  const parsedArgs = parseMaybeJson(rawArgs);
  const value = raw.command
    || raw.cmd
    || raw.parsed_cmd
    || raw.parsedCmd
    || raw.argv
    || (isPlainObject(parsedArgs) ? parsedArgs.command || parsedArgs.cmd : undefined);

  if (Array.isArray(value)) return value.join(' ');
  return maybeString(value);
}

export function resolvePatternToolName(value, config) {
  const candidate = stripToolTitlePrefix(value);
  if (!candidate) return '';

  const directMatch = matchToolIdPattern(candidate, config);
  if (directMatch?.toolName) return directMatch.toolName.trim().toLowerCase();
  if (isAcpUxToolName(candidate)) return candidate.toLowerCase();

  const withoutGeminiSuffix = candidate.replace(/-\d+-\d+$/, '');
  if (withoutGeminiSuffix !== candidate) {
    const suffixMatch = matchToolIdPattern(withoutGeminiSuffix, config);
    if (suffixMatch?.toolName) return suffixMatch.toolName.trim().toLowerCase();
    if (isAcpUxToolName(withoutGeminiSuffix)) return withoutGeminiSuffix.toLowerCase();
  }

  return '';
}

export function collectToolNameCandidates(value, output = [], seen = new Set()) {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object') {
    if (typeof parsed === 'string') output.push(parsed);
    return output;
  }
  if (seen.has(parsed)) return output;
  seen.add(parsed);

  if (Array.isArray(parsed)) {
    for (const item of parsed) collectToolNameCandidates(item, output, seen);
    return output;
  }

  for (const key of ['toolName', 'tool_name', 'name', 'id', 'tool', 'kind']) {
    if (typeof parsed[key] === 'string') output.push(parsed[key]);
  }

  for (const key of [
    'functionCall',
    'function_call',
    'toolCall',
    'tool_call',
    'rawInput',
    'input',
    'arguments',
    'args',
    'params',
    'invocation',
    'request'
  ]) {
    collectToolNameCandidates(parsed[key], output, seen);
  }

  return output;
}

export function resolveToolNameFromCandidates(candidates, config) {
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
    const nestedCandidates = typeof candidate === 'string' ? [candidate] : collectToolNameCandidates(candidate);
    for (const nestedCandidate of nestedCandidates) {
      const toolName = resolvePatternToolName(nestedCandidate, config);
      if (toolName) return toolName;
    }
  }
  return '';
}

export function toolTitleDetailFromInput(input = {}, options = {}) {
  const filePath = maybeString(
    input.file_path
    || input.filePath
    || input.path
    || input.target
    || input.target_path
    || input.targetPath
    || options.filePath
  );
  if (filePath) return path.basename(filePath);

  return maybeString(
    input.pattern
    || input.query
    || input.url
    || input.description
  );
}

export function appendToolTitleDetail(title, detail) {
  if (!title || !detail) return title || '';
  return title.toLowerCase().includes(String(detail).toLowerCase()) ? title : `${title}: ${detail}`;
}
