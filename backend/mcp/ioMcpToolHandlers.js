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

    [ACP_UX_TOOL_NAMES.grepSearch]: async ({ pattern, dir_path, case_sensitive, context, fixed_strings, abortSignal }) => {
      const result = await grepSearch(pattern, dir_path, {
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
    [ACP_UX_TOOL_NAMES.googleWebSearch]: async ({ query }) => {
      return textResult(await googleWebSearch(query));
    }
  };
}
