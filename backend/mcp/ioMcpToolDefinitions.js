import { ACP_UX_TOOL_NAMES } from '../services/tools/acpUxTools.js';

export function getIoMcpToolDefinitions() {
  return [
    {
      name: ACP_UX_TOOL_NAMES.readFile,
      title: 'Read file',
      description: 'Read UTF-8 text from a local file. Use this AcpUI MCP tool for file reads when it is available.',
      annotations: {
        title: 'Read file',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to read.' },
          start_line: { type: 'number', description: 'Optional 1-based line number to start reading from.' },
          end_line: { type: 'number', description: 'Optional 1-based line number to stop reading at, inclusive.' }
        },
        required: ['file_path']
      }
    },
    {
      name: ACP_UX_TOOL_NAMES.writeFile,
      title: 'Write file',
      description: 'Write complete UTF-8 text content to a local file, creating missing parent directories and overwriting existing files.',
      annotations: {
        title: 'Write file',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to write.' },
          content: { type: 'string', description: 'The complete file content to write.' }
        },
        required: ['file_path', 'content']
      }
    },
    {
      name: ACP_UX_TOOL_NAMES.replace,
      title: 'Replace in file',
      description: 'Replace text within a local file. Exact matches are preferred; tolerant matching handles line endings, quote style, indentation, and close fuzzy matches.',
      annotations: {
        title: 'Replace in file',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to modify.' },
          old_string: { type: 'string', description: 'The text to replace.' },
          new_string: { type: 'string', description: 'The replacement text.' },
          allow_multiple: { type: 'boolean', description: 'If true, replace all exact occurrences. Default is false.' }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    },
    {
      name: ACP_UX_TOOL_NAMES.listDirectory,
      title: 'List directory',
      description: 'List files and subdirectories directly inside a local directory. Directory names are suffixed with a slash.',
      annotations: {
        title: 'List directory',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          dir_path: { type: 'string', description: 'The directory path to list.' }
        },
        required: ['dir_path']
      }
    },
    {
      name: ACP_UX_TOOL_NAMES.glob,
      title: 'Glob files',
      description: 'Find local files matching a glob pattern. Use the optional description as the user-facing tool header instead of the raw pattern.',
      annotations: {
        title: 'Glob files',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Optional short user-facing description for the tool header.' },
          pattern: { type: 'string', description: 'The glob pattern to match, for example **/*.js.' },
          dir_path: { type: 'string', description: 'Optional directory to search within. Defaults to the current backend working directory.' }
        },
        required: ['pattern']
      }
    },
    {
      name: ACP_UX_TOOL_NAMES.grepSearch,
      title: 'Grep search',
      description: 'Search local file contents with ripgrep. Use the optional description as the user-facing tool header instead of the raw pattern.',
      annotations: {
        title: 'Grep search',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Optional short user-facing description for the tool header.' },
          pattern: { type: 'string', description: 'The regular expression or fixed string to search for.' },
          dir_path: { type: 'string', description: 'Optional directory to search within. Defaults to the current backend working directory.' },
          case_mode: { type: 'string', enum: ['smart', 'sensitive', 'insensitive'], description: 'Case handling mode. Defaults to smart.' },
          include_globs: { type: 'array', items: { type: 'string' }, description: 'Optional include globs. Each entry is passed as --glob <glob>.' },
          exclude_globs: { type: 'array', items: { type: 'string' }, description: 'Optional exclude globs. Each entry is passed as --glob !<glob>.' },
          file_types: { type: 'array', items: { type: 'string' }, description: 'Optional ripgrep file types to include (for example: ts, js, md).' },
          before_context: { type: 'number', description: 'Optional number of context lines before each match.' },
          after_context: { type: 'number', description: 'Optional number of context lines after each match.' },
          max_matches: { type: 'number', description: 'Optional maximum matches per file, mapped to ripgrep --max-count.' },
          result_mode: { type: 'string', enum: ['matches', 'files', 'count'], description: 'Result shape: detailed matches, unique files, or aggregate count.' },
          word_match: { type: 'boolean', description: 'If true, only match complete words.' },
          multiline: { type: 'boolean', description: 'If true, allow matches across line boundaries.' },
          regex_engine: { type: 'string', enum: ['default', 'pcre2', 'auto'], description: 'Regex engine mode. auto maps to ripgrep auto-hybrid mode.' },
          hidden: { type: 'boolean', description: 'If true, include hidden files and directories.' },
          no_ignore: { type: 'boolean', description: 'If true, do not respect ignore files.' },
          follow_symlinks: { type: 'boolean', description: 'If true, follow symbolic links. Requires io.allowedRoots to include * because symlinks can leave configured roots.' },
          case_sensitive: { type: 'boolean', description: 'Backward-compatible shorthand for case_mode (true => sensitive, false => insensitive).' },
          context: { type: 'number', description: 'Backward-compatible shorthand for before_context and after_context.' },
          fixed_strings: { type: 'boolean', description: 'If true, treat the pattern as a literal string.' }
        },
        required: ['pattern'],
        additionalProperties: false
      }
    },
    {
      name: ACP_UX_TOOL_NAMES.webFetch,
      title: 'Web fetch',
      description: 'Fetch a URL and return text content. HTML pages are reduced to normalized body text.',
      annotations: {
        title: 'Web fetch',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch.' }
        },
        required: ['url']
      }
    }
  ];
}

export function getGoogleSearchMcpToolDefinitions() {
  return [
    {
      name: ACP_UX_TOOL_NAMES.googleWebSearch,
      title: 'Google web search',
      description: 'Perform a grounded Google Search using Google services and return a synthesized answer with citations.',
      annotations: {
        title: 'Google web search',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' }
        },
        required: ['query']
      }
    }
  ];
}
