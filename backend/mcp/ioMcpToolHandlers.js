import {
  readFile,
  writeFile,
  replaceText,
  listDirectory,
  findFiles,
  grepSearch,
  limitTextOutput
} from '../services/ioMcp/filesystem.js';
import { webFetch } from '../services/ioMcp/webFetch.js';
import { googleWebSearch } from '../services/ioMcp/googleWebSearch.js';
import { ACP_UX_TOOL_NAMES } from '../services/tools/acpUxTools.js';

function textResult(text) {
  return { content: [{ type: 'text', text: text || '' }] };
}

const INTERNAL_TOOL_ARG_KEYS = new Set([
  'providerId',
  'acpSessionId',
  'mcpProxyId',
  'mcpRequestId',
  'requestMeta',
  'abortSignal'
]);

const GREP_SEARCH_ARG_KEYS = new Set([
  'description',
  'pattern',
  'dir_path',
  'case_mode',
  'include_globs',
  'exclude_globs',
  'file_types',
  'before_context',
  'after_context',
  'max_matches',
  'result_mode',
  'word_match',
  'multiline',
  'regex_engine',
  'hidden',
  'no_ignore',
  'follow_symlinks',
  'case_sensitive',
  'context',
  'fixed_strings',
  ...INTERNAL_TOOL_ARG_KEYS
]);

function assertSupportedArgs(args, allowedKeys, toolName) {
  const unsupportedKeys = Object.keys(args || {}).filter(key => !allowedKeys.has(key));
  if (unsupportedKeys.length) {
    throw new Error(`${toolName} received unsupported option(s): ${unsupportedKeys.join(', ')}`);
  }
}

export function createIoMcpToolHandlers() {
  return {
    [ACP_UX_TOOL_NAMES.readFile]: async ({ file_path, start_line, end_line }) => {
      return textResult(await readFile(file_path, start_line, end_line));
    },

    [ACP_UX_TOOL_NAMES.writeFile]: async ({ file_path, content }) => {
      await writeFile(file_path, content);
      return textResult(limitTextOutput(content, undefined, `${ACP_UX_TOOL_NAMES.writeFile} output`));
    },

    [ACP_UX_TOOL_NAMES.replace]: async ({ file_path, old_string, new_string, allow_multiple }) => {
      return textResult(await replaceText(file_path, old_string, new_string, allow_multiple));
    },

    [ACP_UX_TOOL_NAMES.listDirectory]: async ({ dir_path }) => {
      const items = await listDirectory(dir_path);
      return textResult(limitTextOutput(items.join('\n'), undefined, `${ACP_UX_TOOL_NAMES.listDirectory} output`));
    },

    [ACP_UX_TOOL_NAMES.glob]: async ({ pattern, dir_path }) => {
      const files = await findFiles(pattern, dir_path);
      return textResult(limitTextOutput(files.join('\n') || 'No files found.', undefined, `${ACP_UX_TOOL_NAMES.glob} output`));
    },

    [ACP_UX_TOOL_NAMES.grepSearch]: async (args = {}) => {
      assertSupportedArgs(args, GREP_SEARCH_ARG_KEYS, ACP_UX_TOOL_NAMES.grepSearch);
      const {
        pattern,
        dir_path,
        case_mode,
        include_globs,
        exclude_globs,
        file_types,
        before_context,
        after_context,
        max_matches,
        result_mode,
        word_match,
        multiline,
        regex_engine,
        hidden,
        no_ignore,
        follow_symlinks,
        case_sensitive,
        context,
        fixed_strings,
        abortSignal
      } = args;
      const result = await grepSearch(pattern, dir_path, {
        caseMode: case_mode,
        includeGlobs: include_globs,
        excludeGlobs: exclude_globs,
        fileTypes: file_types,
        beforeContext: before_context,
        afterContext: after_context,
        maxMatches: max_matches,
        resultMode: result_mode,
        wordMatch: word_match,
        multiline,
        regexEngine: regex_engine,
        hidden,
        noIgnore: no_ignore,
        followSymlinks: follow_symlinks,
        caseSensitive: case_sensitive,
        context,
        fixedStrings: fixed_strings,
        abortSignal
      });
      return textResult(JSON.stringify(result));
    },

    [ACP_UX_TOOL_NAMES.webFetch]: async ({ url, abortSignal }) => {
      return textResult(JSON.stringify(await webFetch(url, { abortSignal })));
    }
  };
}

export function createGoogleSearchMcpToolHandlers() {
  return {
    [ACP_UX_TOOL_NAMES.googleWebSearch]: async ({ query, abortSignal }) => {
      return textResult(await googleWebSearch(query, { abortSignal }));
    }
  };
}
