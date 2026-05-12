export const ACP_UX_TOOL_NAMES = Object.freeze({
  invokeShell: 'ux_invoke_shell',
  invokeSubagents: 'ux_invoke_subagents',
  invokeCounsel: 'ux_invoke_counsel',
  readFile: 'ux_read_file',
  writeFile: 'ux_write_file',
  replace: 'ux_replace',
  listDirectory: 'ux_list_directory',
  glob: 'ux_glob',
  grepSearch: 'ux_grep_search',
  webFetch: 'ux_web_fetch',
  googleWebSearch: 'ux_google_web_search'
});

export const ACP_UX_CORE_TOOL_NAMES = Object.freeze([
  ACP_UX_TOOL_NAMES.invokeShell,
  ACP_UX_TOOL_NAMES.invokeSubagents,
  ACP_UX_TOOL_NAMES.invokeCounsel
]);

export const ACP_UX_IO_TOOL_CONFIG = Object.freeze({
  [ACP_UX_TOOL_NAMES.readFile]: Object.freeze({
    headerTitle: 'Read File',
    headerDetail: 'fileBasename',
    category: Object.freeze({ toolCategory: 'file_read', isFileOperation: true }),
    usesFilePath: true
  }),
  [ACP_UX_TOOL_NAMES.writeFile]: Object.freeze({
    headerTitle: 'Write File',
    headerDetail: 'fileBasename',
    category: Object.freeze({ toolCategory: 'file_write', isFileOperation: true }),
    usesFilePath: true
  }),
  [ACP_UX_TOOL_NAMES.replace]: Object.freeze({
    headerTitle: 'Replace In File',
    headerDetail: 'fileBasename',
    category: Object.freeze({ toolCategory: 'file_edit', isFileOperation: true }),
    usesFilePath: true
  }),
  [ACP_UX_TOOL_NAMES.listDirectory]: Object.freeze({
    headerTitle: 'List Directory',
    headerDetail: 'directoryPath',
    category: Object.freeze({ toolCategory: 'glob', isFileOperation: true }),
    usesFilePath: false
  }),
  [ACP_UX_TOOL_NAMES.glob]: Object.freeze({
    headerTitle: 'Glob',
    headerDetail: 'descriptionOrPattern',
    category: Object.freeze({ toolCategory: 'glob', isFileOperation: true }),
    usesFilePath: false
  }),
  [ACP_UX_TOOL_NAMES.grepSearch]: Object.freeze({
    headerTitle: 'Search',
    headerDetail: 'descriptionOrPattern',
    category: Object.freeze({ toolCategory: 'grep', isFileOperation: true }),
    usesFilePath: false
  }),
  [ACP_UX_TOOL_NAMES.webFetch]: Object.freeze({
    headerTitle: 'Fetch',
    headerDetail: 'url',
    category: Object.freeze({ toolCategory: 'fetch', isFileOperation: false }),
    usesFilePath: false
  }),
  [ACP_UX_TOOL_NAMES.googleWebSearch]: Object.freeze({
    headerTitle: 'Web Search',
    headerDetail: 'query',
    category: Object.freeze({ toolCategory: 'web_search', isFileOperation: false }),
    usesFilePath: false
  })
});

export const ACP_UX_IO_TOOL_NAMES = Object.freeze(Object.keys(ACP_UX_IO_TOOL_CONFIG));

const ACP_UX_TOOL_NAME_SET = new Set([
  ...ACP_UX_CORE_TOOL_NAMES,
  ...ACP_UX_IO_TOOL_NAMES
]);

function normalizeToolName(value) {
  return String(value || '').trim().toLowerCase();
}

export function isAcpUxToolName(value) {
  return ACP_UX_TOOL_NAME_SET.has(normalizeToolName(value));
}

export function acpUxIoToolConfig(value) {
  return ACP_UX_IO_TOOL_CONFIG[normalizeToolName(value)] || null;
}

export function acpUxToolTitleConfig(value) {
  return acpUxIoToolConfig(value);
}
