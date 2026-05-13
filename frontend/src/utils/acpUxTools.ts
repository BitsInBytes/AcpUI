import type { StreamEventData, SystemEvent } from '../types';

export const ACP_UX_TOOL_NAMES = Object.freeze({
  invokeShell: 'ux_invoke_shell',
  invokeSubagents: 'ux_invoke_subagents',
  invokeCounsel: 'ux_invoke_counsel',
  checkSubagents: 'ux_check_subagents',
  abortSubagents: 'ux_abort_subagents',
  readFile: 'ux_read_file',
  writeFile: 'ux_write_file',
  replace: 'ux_replace',
  listDirectory: 'ux_list_directory',
  glob: 'ux_glob',
  grepSearch: 'ux_grep_search',
  webFetch: 'ux_web_fetch',
  googleWebSearch: 'ux_google_web_search'
});

export const ACP_UX_RESULT_TYPES = Object.freeze({
  grepSearch: 'ux_grep_search_result'
});

export type AcpUxToolName = (typeof ACP_UX_TOOL_NAMES)[keyof typeof ACP_UX_TOOL_NAMES];

type ToolNameEvent = Partial<Pick<SystemEvent & StreamEventData, 'canonicalName' | 'toolName' | 'mcpToolName'>>;

export const ACP_UX_CORE_TOOL_NAMES = Object.freeze([
  ACP_UX_TOOL_NAMES.invokeShell,
  ACP_UX_TOOL_NAMES.invokeSubagents,
  ACP_UX_TOOL_NAMES.invokeCounsel,
  ACP_UX_TOOL_NAMES.checkSubagents,
  ACP_UX_TOOL_NAMES.abortSubagents
] as const);

export const ACP_UX_SUB_AGENT_START_TOOL_NAMES = Object.freeze([
  ACP_UX_TOOL_NAMES.invokeSubagents,
  ACP_UX_TOOL_NAMES.invokeCounsel
] as const);

export const ACP_UX_SUB_AGENT_STATUS_TOOL_NAMES = Object.freeze([
  ACP_UX_TOOL_NAMES.checkSubagents,
  ACP_UX_TOOL_NAMES.abortSubagents
] as const);

const ACP_UX_TOOL_NAME_SET = new Set<string>(Object.values(ACP_UX_TOOL_NAMES));
const ACP_UX_SUB_AGENT_START_TOOL_NAME_SET = new Set<string>(ACP_UX_SUB_AGENT_START_TOOL_NAMES);
const ACP_UX_SUB_AGENT_STATUS_TOOL_NAME_SET = new Set<string>(ACP_UX_SUB_AGENT_STATUS_TOOL_NAMES);

function normalizeToolName(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

export function toolNameFromEvent(event?: ToolNameEvent | null) {
  return event?.canonicalName || event?.toolName || event?.mcpToolName || '';
}

export function isAcpUxToolName(value?: string | null) {
  return ACP_UX_TOOL_NAME_SET.has(normalizeToolName(value));
}

export function isAcpUxShellToolName(value?: string | null) {
  return normalizeToolName(value) === ACP_UX_TOOL_NAMES.invokeShell;
}

export function isAcpUxShellToolEvent(event?: ToolNameEvent | null) {
  return isAcpUxShellToolName(toolNameFromEvent(event));
}

export function isAcpUxSubAgentStartToolName(value?: string | null) {
  return ACP_UX_SUB_AGENT_START_TOOL_NAME_SET.has(normalizeToolName(value));
}

export function isAcpUxSubAgentStartToolEvent(event?: ToolNameEvent | null) {
  return isAcpUxSubAgentStartToolName(toolNameFromEvent(event));
}

export function isAcpUxSubAgentStatusToolName(value?: string | null) {
  return ACP_UX_SUB_AGENT_STATUS_TOOL_NAME_SET.has(normalizeToolName(value));
}

export function isAcpUxSubAgentToolName(value?: string | null) {
  return isAcpUxSubAgentStartToolName(value) || isAcpUxSubAgentStatusToolName(value);
}
