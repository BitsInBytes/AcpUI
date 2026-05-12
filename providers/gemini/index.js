import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProvider } from '../../backend/services/providerLoader.js';
import { acpUiToolTitle } from '../../backend/services/tools/acpUiToolTitles.js';
import { ACP_UX_TOOL_NAMES, isAcpUxToolName } from '../../backend/services/tools/acpUxTools.js';
import {
  collectToolNameCandidates,
  inputFromToolUpdate,
  resolveToolNameFromAcpUiMcpTitle,
  resolveToolNameFromCandidates
} from '../../backend/services/tools/providerToolNormalization.js';
import { matchToolIdPattern } from '../../backend/services/tools/toolIdPattern.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache for arguments to reconstruct outputs that Gemini CLI drops
const toolArgCache = new Map();
// Context % and Quota % State
let _emitProviderExtension = null;
let _writeLog = null;
let _lastSessionId = null;
let _sessionContextInfo = new Map(); // sessionId -> { percent, inputTokens, ... }
let _quotaProjectId = null;
let _sessionQuotaInfo = new Map();
let _quotaFetchInFlight = false;
let _quotaPollTimer = null;
let _latestQuotaStatus = null;
let _activePromptCount = 0; // Only poll quota while prompts are in-flight
let _inFlightSessions = new Set(); // Track which sessions have active prompts

// Token accumulation tracking (not from quota API, but from actual turn results)
let _accumulatedTokensBySession = new Map(); // sessionId -> { inputTokens, outputTokens, lastUpdated }
let _tokenStateFile = null; // Path to persist token state
let _sessionsWithInitialEmit = new Set(); // Track which sessions we've already emitted initial context for

const CONTEXT_WINDOWS = {
  'gemma-4-31b-it':       256_000,
  'gemma-4-26b-a4b-it':   256_000,
  'gemini-3.1-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
};
const DEFAULT_CONTEXT_WINDOW = 1_048_576;

function _emitCachedContext(sessionId) {
  if (!sessionId || _sessionsWithInitialEmit.has(sessionId)) return false;
  _sessionsWithInitialEmit.add(sessionId);
  const persisted = _accumulatedTokensBySession.get(sessionId);
  if (!persisted || !_emitProviderExtension) return false;

  const { config } = getProvider();
  const model = persisted.model || 'gemini-3-flash-preview';
  const windowSize = CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
  const percent = Math.min(100, (persisted.inputTokens / windowSize) * 100);
  _emitProviderExtension(`${config.protocolPrefix}metadata`, {
    sessionId,
    contextUsagePercentage: percent
  });
  return true;
}

export function emitCachedContext(sessionId) {
  return _emitCachedContext(sessionId);
}

export function normalizeModelState(modelState) {
  return modelState;
}

function normalizeCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands
    .filter(command => command && typeof command.name === 'string')
    .map(command => ({
      name: command.name.startsWith('/') ? command.name : `/${command.name}`,
      description: command.description || '',
      ...(command.input?.hint ? { meta: { hint: command.input.hint } } : {})
    }));
}

/**
 * Intercept raw messages from the Gemini process and translate them into
 * standardized ACP protocol messages.
 */
export function intercept(payload) {

  try {
    const { config } = getProvider();

    // 1. Handle Notifications & Updates
    if (payload?.method === 'session/update' || payload?.method === 'session/notification') {
      const sessionId = payload.params?.sessionId;
      const update = payload.params?.update;

      if (update?.sessionUpdate === 'available_commands_update') {
        return {
          id: payload.id,
          method: `${config.protocolPrefix}commands/available`,
          params: {
            sessionId,
            commands: normalizeCommands(update.availableCommands)
          }
        };
      }

      if (sessionId) {
        _lastSessionId = sessionId;

        // On first detection of a session, emit persisted context % if available
        _emitCachedContext(sessionId);
      }

      // Log usage_update events to understand the token flow
      if (update?.sessionUpdate === 'usage_update') {
        return null;
      }

      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        if (update.toolCallId) {
          cacheToolInput(update.toolCallId, inputFromUpdate(update, { sessionId }), sessionId);
        }
      }
    }

    // 2. Handle Final Response Results (Turn Completion)
    if (payload?.result?.stopReason) {
      const sessionId = payload.result.sessionId || _lastSessionId;

      if (payload.result?._meta?.quota && sessionId) {
        const quota = payload.result._meta.quota;


        // The API returns CUMULATIVE token counts for the session, not per-turn deltas
        // Use the value directly - don't accumulate
        const inputTokens = quota.token_count?.input_tokens ?? 0;
        const outputTokens = quota.token_count?.output_tokens ?? 0;
        const model = quota.model_usage?.[0]?.model ?? '';

        // Store the cumulative value for this session
        const accum = { inputTokens, outputTokens, lastUpdated: new Date().toISOString() };
        _accumulatedTokensBySession.set(sessionId, accum);


        // Save to disk for persistence across session switches
        _saveTokenState();

        const windowSize = CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
        const percent = (inputTokens / windowSize) * 100;

        // Clamp to 100% max (safety check in case of API anomalies)
        const clampedPercent = Math.min(100, percent);


        if (_emitProviderExtension) {
          _sessionContextInfo.set(sessionId, { percent: clampedPercent, inputTokens, windowSize, model });
          _emitProviderExtension(`${config.protocolPrefix}metadata`, {
            sessionId,
            contextUsagePercentage: clampedPercent
          });
        }

        // Trigger quota refresh on completion
        if (payload.result.stopReason === 'end_turn' && _quotaProjectId) {
           _fetchAndEmitQuota(sessionId, config.paths.home, { emitInitial: true });
        }
      }
    }
  } catch (err) {}

  return payload;
}

/**
 * Normalize a Gemini update to standard ACP format.
 */
export function normalizeUpdate(update) {
  const isMessage = update.sessionUpdate === 'agent_message_chunk';
  const isThought = update.sessionUpdate === 'agent_thought_chunk';
  
  if ((isMessage || isThought) && update.content) {
    // 1. Handle standard object shape: { type: 'text', text: "..." }
    if (typeof update.content.text === 'string') {
      update.content.text = stripReminder(update.content.text);
    } 
    // 2. Handle array of parts (Gemini standard shape in some contexts)
    else if (Array.isArray(update.content)) {
      update.content.forEach(part => {
        if (part && typeof part.text === 'string') {
          part.text = stripReminder(part.text);
        }
      });
    }
    // 3. Handle raw string (if daemon deviates)
    else if (typeof update.content === 'string') {
      update.content = stripReminder(update.content);
    }
  }
  return update;
}

export function normalizeConfigOptions(options) {
  return Array.isArray(options) ? options : [];
}

/**
 * Strip out the system-reminder tag and its contents from a string.
 */
export function stripReminder(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<system-reminder(?: [^>]*)?>[\s\S]*?<\/system-reminder>/gi, '');
}

/**
 * Extract tool output from a Gemini tool_call_update.
 *
 * Gemini sends content as an array of typed blocks:
 *   { type: 'content', content: { type: 'text', text: '...' } }
 *   { type: 'diff',    path, oldText, newText }
 *
 * The acpUpdateHandler has a standard fallback for these shapes, but we
 * handle them here first so the provider controls the exact rendering.
 */
export function extractToolOutput(update) {
  // Fix for Gemini read_file returning only a summary string instead of file contents
  if (update.status === 'completed' && update.toolCallId?.startsWith('read_file')) {
    let filePath = update.locations?.[0]?.path;
    if (filePath && fs.existsSync(filePath)) {
      try {
        let content = fs.readFileSync(filePath, 'utf-8');
        
        let raw = update.result ?? update.rawOutput ?? update.content;
        let summary = '';
        if (Array.isArray(raw)) {
           summary = raw.map(c => c.type === 'content' ? c.content?.text : '').join('');
        } else if (typeof raw === 'string') {
           summary = raw;
        } else if (raw?.content && Array.isArray(raw.content)) {
           summary = raw.content.map(c => c.type === 'content' ? c.content?.text : '').join('');
        }
        
        const lineMatch = summary.match(/Read lines (\d+)-(\d+)/i);
        if (lineMatch) {
          const start = Math.max(0, parseInt(lineMatch[1], 10) - 1);
          const end = parseInt(lineMatch[2], 10);
          content = content.split('\n').slice(start, end).join('\n');
        }
        
        // Strip out the system-reminder tag and its contents
        return stripReminder(content);
      } catch (e) {}
    }
  }

  // 1. Prioritize result field (where read_file output lives)
  // Gemini result can be a PartListUnion OR an object { content: PartListUnion }
  let raw = update.result ?? update.rawOutput ?? update.content;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.content) {
    raw = raw.content;
  }

  // 2. If it's a PartListUnion (Gemini's standard content shape)
  if (Array.isArray(raw)) {
    const parts = raw
      .map(c => {
        if (typeof c === 'string') return c;
        if (c.type === 'text' && c.text) return c.text;
        if (c.text && typeof c.text === 'string') return c.text;
        if (c.type === 'content' && c.content?.type === 'text') return c.content.text;
        if (c.type === 'diff') {
          const oldText = c.oldText || '';
          const newText = c.newText || '';
          const isWriteFile = update.toolCallId && update.toolCallId.startsWith('write_file');
          
          if (isWriteFile || (!oldText && newText)) {
            // Pure addition or full overwrite -> return raw text so frontend syntax-highlights it
            return newText;
          }
          
          // Returning null for true diff blocks so they are filtered out from parts.
          // This allows extractToolOutput to return undefined,
          // ensuring the backend generates the real diff via its standard fallback.
          return null;
        }
        return null;
      })
      .filter(c => c !== null);

    if (parts.length > 0) return stripReminder(parts.join('\n'));
  }

  // 3. If it's a plain string
  if (typeof raw === 'string') return stripReminder(raw);

  // 4. Check resultDisplay (pre-formatted by some versions of the CLI)
  if (update.resultDisplay && typeof update.resultDisplay === 'string') {
    return stripReminder(update.resultDisplay);
  }

  // 5. Fallback for structured objects (like list_directory or grep_search)
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.message === 'string') return stripReminder(raw.message);
    if (typeof raw.summary === 'string') return stripReminder(raw.summary);
    return JSON.stringify(raw, null, 2);
  }

  // 6. Fix for Gemini list_directory returning no output
  if (update.status === 'completed' && update.toolCallId?.startsWith('list_directory')) {
    if (!raw || (Array.isArray(raw) && raw.length === 0)) {
       const argsRaw = toolArgCache.get(update.toolCallId) || {};
       const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : argsRaw;
       let dirPath = args?.dir_path || args?.path || '';
       
       if (!dirPath && update.title) {
          const rawTitle = update.title.replace(/^['"]|['"]$/g, '').trim();
          dirPath = rawTitle.startsWith('Listing Directory:') ? rawTitle.slice(18).trim() : rawTitle;
       }
       
       if (dirPath) {
          let fullPath;
          const candidates = [
             process.env.DEFAULT_WORKSPACE_CWD,
             process.cwd(),
             path.resolve(process.cwd(), '..')
          ].filter(Boolean);
          
          for (const c of candidates) {
              const p = path.resolve(c, dirPath);
              try {
                  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
                      fullPath = p;
                      break;
                  }
              } catch(e) {}
          }
          
          if (fullPath) {
             try {
                const files = fs.readdirSync(fullPath);
                return files.length > 0 ? files.join('\n') : '(empty directory)';
             } catch(e) {}
          }
       }
    }
  }
  
  // 7. Fix for empty search outputs
  if (update.status === 'completed' && (!raw || (Array.isArray(raw) && raw.length === 0))) {
     if (update.toolCallId?.startsWith('grep_search') || update.toolCallId?.startsWith('glob')) {
         return 'No matches found.';
     }
  }

  return undefined;
}

/**
 * Extract file path from a Gemini tool update.
 */
export function extractFilePath(update, resolvePath) {
  const title = (update.title || '').toLowerCase();
  if (title.startsWith('listing') || title.startsWith('running:')) return undefined;

  // 1. Check locations array (Standard ACP feature)
  if (update.locations && Array.isArray(update.locations)) {
    for (const loc of update.locations) {
      if (loc.path) return resolvePath(loc.path);
    }
  }

  // 2. Check content array for explicit diff paths
  if (update.content && Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item.type === 'diff' && item.path) return resolvePath(item.path);
    }
  }

  // 3. Check tool arguments (Common in many tool implementations)
  let args = update.arguments || update.params || update.rawInput;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  
  if (args) {
    const p = args.path || args.file_path || args.filePath || args.target || args.dir_path;
    if (p && typeof p === 'string') return resolvePath(p);
  }

  return undefined;
}

/**
 * Extract output from a Gemini tool_call start event.
 *
 * Called before normalizeTool runs, so update.toolName is not yet set.
 * We use update.kind (ACP ToolKind) instead to identify operation type.
 *
 * Returns:
 *   - A unified diff string for search-replace edits (diff content in update.content)
 *   - Raw file content for write/create operations (content in update.arguments)
 *   - undefined when no output should be shown at tool start
 */
export function extractDiffFromToolCall(update, Diff) {
  const isWriteFile = update.toolCallId && update.toolCallId.startsWith('write_file');

  // 1. Edit with diff blocks (e.g. search-replace, write_file)
  if (update.content && Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item.type === 'diff') {
        const oldText = item.oldText || '';
        const newText = item.newText || '';
        if (isWriteFile || (!oldText && newText)) {
          // Pure addition -> return raw text
          return newText;
        }
        return Diff.createPatch(item.path || update.toolCallId || 'file', oldText, newText, 'old', 'new');
      }
    }
  }

  // 2. Write/create operation — return raw content for syntax highlighting.
  //    args.content is only present for write-type tools (not reads or searches).
  let args = update.arguments || update.rawInput;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  if (args?.content && typeof args.content === 'string') {
    return args.content;
  }

  return undefined;
}

/**
 * Maps Gemini's ACP ToolKind values to the tool names used in provider.json
 * toolCategories. Gemini CLI emits `kind` as a ToolKind enum string ("read",
 * "edit", etc.) — NOT the function name — so we cannot use MCP prefix stripping
 * on the human-readable title.
 *
 * Source: toAcpToolKind() in gemini-cli packages/cli/src/acp/acpClient.ts
 */
const KIND_TO_TOOL_NAME = {
  read:    'read_file',
  edit:    'edit_file',
  search:  'grep',
  delete:  'edit_file',
  move:    'edit_file',
  execute: 'execute',
  think:   'think',
  fetch:   'fetch',
  other:   'other',
};

function toolInputCacheKey(sessionId, toolCallId) {
  return sessionId && toolCallId ? `${sessionId}::${toolCallId}` : '';
}

function isNonEmptyInput(input) {
  return Boolean(input && typeof input === 'object' && Object.keys(input).length > 0);
}

function cacheToolInput(toolCallId, input, sessionId) {
  if (!toolCallId || !isNonEmptyInput(input)) return;
  toolArgCache.set(toolCallId, input);
  const scopedKey = toolInputCacheKey(sessionId, toolCallId);
  if (scopedKey) toolArgCache.set(scopedKey, input);
}

function getCachedToolInput(toolCallId, sessionId) {
  const scopedKey = toolInputCacheKey(sessionId, toolCallId);
  if (scopedKey && toolArgCache.has(scopedKey)) return toolArgCache.get(scopedKey);
  return sessionId ? (toolArgCache.get(toolCallId) || {}) : {};
}

function inputFromUpdate(update = {}, context = {}) {
  const toolCallId = update.toolCallId || update.id || context.event?.id;
  const sessionId = context.sessionId || context.event?.sessionId;
  const directInput = inputFromToolUpdate(update, { deep: true });
  const cachedInput = getCachedToolInput(toolCallId, sessionId);
  const input = { ...cachedInput, ...directInput };

  cacheToolInput(toolCallId, input, sessionId);
  return input;
}

function resolveToolNameFromMcpTitle(title) {
  return resolveToolNameFromAcpUiMcpTitle(title);
}

/**
 * Normalize a tool call event: map ACP ToolKind → toolName and clean up title.
 */
export function normalizeTool(event, update) {
  const { config } = getProvider();
  const clientName = config.clientInfo?.name || 'AcpUI';

  // 1. Identify the tool name.
  // Priority:
  //   a) Specific AcpUI MCP function-call metadata
  //   b) AcpUI MCP human title suffix
  //   c) Original provider toolName
  //   d) Extracted from Gemini toolCallId/title
  //   e) Mapped from ACP ToolKind (kind)

  let title = (event.title || '').replace(/\r?\n/g, ' ').trim();
  const originalTitle = title;
  const rawId = event.id || update?.toolCallId || '';
  const kind = update?.kind || '';
  const input = inputFromUpdate(update, { sessionId: event.sessionId, event });

  // Strip the MCP server suffix if present (e.g. " (AcpUI MCP Server)")
  const suffixRegex = new RegExp('\\s*\\(' + clientName + ' MCP Server\\)' + String.fromCharCode(36), 'i');
  const isAcpUiMcpTitle = suffixRegex.test(originalTitle);
  title = title.replace(suffixRegex, '');

  const toolNameCandidates = [
    event.toolName,
    update?.toolName,
    update?.name,
    update?.displayName,
    rawId,
    update?.toolCallId,
    title,
    originalTitle,
    ...collectToolNameCandidates([
      update?.rawInput,
      update?.arguments,
      update?.args,
      update?.params,
      update?.input,
      update?.description,
      update?.toolCall
    ])
  ];
  const candidateToolName = resolveToolNameFromCandidates(toolNameCandidates, config);
  const titleToolName = isAcpUiMcpTitle ? resolveToolNameFromMcpTitle(title) : '';

  let toolName = candidateToolName || titleToolName || event.toolName || '';
  const patternMatch = matchToolIdPattern(rawId, config) || matchToolIdPattern(title, config);
  const lowerTitle = title.toLowerCase();

  // Handle MCP tool identifiers in ID or Title
  if (candidateToolName) {
    toolName = candidateToolName;
  } else if (titleToolName) {
    toolName = titleToolName;
  } else if (patternMatch?.toolName) {
    toolName = patternMatch.toolName;
  } else if (lowerTitle.includes('invoke sub agents') || lowerTitle === ACP_UX_TOOL_NAMES.invokeSubagents) {
    toolName = ACP_UX_TOOL_NAMES.invokeSubagents;
  } else if (lowerTitle === ACP_UX_TOOL_NAMES.invokeCounsel) {
    toolName = ACP_UX_TOOL_NAMES.invokeCounsel;
  } else if (lowerTitle.startsWith('running:')) {
    toolName = ACP_UX_TOOL_NAMES.invokeShell;
  }

  // Fallback to ACP Kind mapping or ID extraction if still not identified
  if (!toolName) {
    if (kind && KIND_TO_TOOL_NAME[kind]) {
      toolName = KIND_TO_TOOL_NAME[kind];
    } else {
      toolName = rawId.replace(/-\d+-\d+$/, '');
      if (!toolName) toolName = kind || '';
    }
  }

  // 2. Finalize Title
  // Custom override for UI-owned tools to ensure the frontend trigger matches
  if (toolName === ACP_UX_TOOL_NAMES.invokeSubagents) {
    title = 'Invoke Subagents';
  } else if (toolName === ACP_UX_TOOL_NAMES.invokeCounsel) {
    title = 'Invoke Counsel';
  } else if (toolName === ACP_UX_TOOL_NAMES.invokeShell) {
    // Idempotent: if already normalized on a previous normalizeTool call, preserve it
    if (!title.toLowerCase().startsWith('invoke shell:')) {
      // 1. Try robust input extraction for a description field
      const shellDesc = input.description;

      if (shellDesc) {
        title = 'Invoke Shell: ' + shellDesc;
      } else if (title.toLowerCase().startsWith('running:')) {
        // 2. Gemini sends "Running: <description>" - extract the description
        const afterRunning = title.slice('running:'.length).trim();
        title = afterRunning ? 'Invoke Shell: ' + afterRunning : 'Invoke Shell';
      } else {
        title = 'Invoke Shell';
      }
    }
  } else {
    const acpTitle = acpUiToolTitle(toolName, input, { filePath: event.filePath });
    if (acpTitle) {
      title = acpTitle;
    } else if (toolName === 'replace' || toolName === 'edit_file' || rawId.startsWith('replace')) {
      if (title.includes('=>') || title.length > 50) {
        title = 'Editing';
      }
    } else if (toolName === 'read_file' || rawId.startsWith('read_file')) {
      if (!title.toLowerCase().includes('read')) {
        title = 'Reading';
      }
    } else if (toolName === 'write_file' || rawId.startsWith('write_file')) {
      if (!title.toLowerCase().includes('writ')) {
        title = 'Writing';
      }
    } else if (toolName === 'list_directory' || rawId.startsWith('list_directory')) {
      if (!title.toLowerCase().includes('list')) {
        title = 'Listing Directory: ' + title;
      }
    } else if (toolName === 'glob' || rawId.startsWith('glob')) {
      if (!title.toLowerCase().includes('search')) {
        title = 'Searching for: ' + title;
      }
    } else if (toolName === 'grep_search' || rawId.startsWith('grep_search')) {
      if (!title.toLowerCase().includes('search')) {
        title = 'Searching: ' + title;
      }
    }
  }

  // If the title looks like a raw snake_case tool name or is missing, synthesize a pretty one
  if (!title || /^[a-z0-9_]+$/.test(title)) {
    const nameToUse = title || toolName;
    if (nameToUse) {
      title = nameToUse.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    }
  }

  // Ensure filePath is visible in the title
  if (event.filePath && title && !title.toLowerCase().includes(path.basename(event.filePath).toLowerCase())) {
    title += ': ' + path.basename(event.filePath);
  }

  return { ...event, toolName, title };
}

export function extractToolInvocation(update = {}, context = {}) {
  const event = context.event || {};
  const sessionId = context.sessionId || event.sessionId;
  const { config } = getProvider();
  const normalized = normalizeTool({ ...event, sessionId }, update);
  const input = inputFromUpdate(update, { sessionId, event });
  const canonicalName = normalized.toolName || '';
  const rawName = update.toolName || update.name || update.toolCallId || event.id || update.title || event.title || '';
  const patternMatch = matchToolIdPattern(rawName, config) ||
    matchToolIdPattern(update.title || event.title || '', config);
  const isAcpUiTool = isAcpUxToolName(canonicalName);
  const isMcpTool = Boolean(patternMatch) || isAcpUiTool;

  const normalizedFilePath = normalized.filePath || event.filePath;
  const normalizedAcpUiTitle = isAcpUiTool
    ? acpUiToolTitle(canonicalName, input, { filePath: normalizedFilePath })
    : null;
  let finalTitle = normalizedAcpUiTitle || normalized.title || event.title || update.title || '';
  if (isAcpUiTool && normalizedAcpUiTitle) {
    finalTitle = normalizedAcpUiTitle;
  } else if (isAcpUiTool && (finalTitle === 'Invoke Shell' || finalTitle === 'Invoke Subagents' || finalTitle === 'Invoke Counsel')) {
    // If we have a generic title for an AcpUI tool, return empty to allow the resolver to use cached title
    finalTitle = '';
  }

  return {
    toolCallId: update.toolCallId || event.id,
    kind: isMcpTool ? 'mcp' : (canonicalName ? 'provider_builtin' : 'unknown'),
    rawName,
    canonicalName,
    mcpServer: patternMatch?.mcpName || (isAcpUiTool ? config.mcpName : undefined),
    mcpToolName: patternMatch?.toolName || (isAcpUiTool ? canonicalName : undefined),
    input,
    title: finalTitle,
    filePath: normalizedFilePath,
    category: categorizeToolCall({ ...normalized, toolName: canonicalName }) || {}
  };
}

/**
 * Categorize a provider-specific tool.
 */
export function categorizeToolCall(event) {
  const { config } = getProvider();
  const toolName = event.toolName;
  if (!toolName) return null;

  // ACP standard tools should be categorized dynamically by the provider
  if (toolName === 'ux_invoke_subagents' || toolName === 'ux_invoke_counsel') {
    return { toolCategory: 'sub_agent', isFileOperation: false };
  } else if (toolName === 'ux_invoke_shell') {
    return { toolCategory: 'shell', isShellCommand: true, isFileOperation: false };
  }

  const metadata = (config.toolCategories || {})[toolName];
  if (!metadata) {
    return null;
  }

  return {
    toolCategory: metadata.category,
    isFileOperation: metadata.isFileOperation || false,
  };
}

export function parseExtension(method, params) {
  const { config } = getProvider();
  if (!method.startsWith(config.protocolPrefix)) return null;

  const type = method.slice(config.protocolPrefix.length);
  let result = null;

  switch (type) {
    case 'commands/available':
      result = { type: 'commands', commands: params.commands };
      break;
    case 'metadata':
      result = { type: 'metadata', sessionId: params.sessionId, contextUsagePercentage: params.contextUsagePercentage };
      break;
    case 'provider/status':
      result = { type: 'provider_status', status: params.status };
      break;
    default:
      result = { type: 'unknown', method, params };
  }
  return result;
}

/**
 * Reads the Gemini API key from the user.json `apiKey` field.
 * If not set, the Gemini CLI falls back to credentials it saved from a
 * previous interactive `gemini` session (~/.gemini/).
 */
function resolveApiKey() {
  const { config } = getProvider();
  return config.apiKey || undefined;
}

export async function prepareAcpEnvironment(env, context = {}) {

  _emitProviderExtension = context.emitProviderExtension;
  _writeLog = context.writeLog;

  // Do NOT inject the API key as GEMINI_API_KEY into the subprocess environment.
  // If the CLI sees that env var at startup it persists it to ~/.gemini/settings.json,
  // permanently overwriting any previously configured auth method (e.g. OAuth).
  // The key is passed exclusively via the ACP authenticate request (see performHandshake).

  const { config } = getProvider();
  const apiKey = resolveApiKey();

  // Initialize token state persistence
  try {
    const homePath = config.paths?.home || process.env.HOME || process.env.USERPROFILE;
    _tokenStateFile = path.join(homePath, '.gemini', 'acp_session_tokens.json');
    _loadTokenState();
  } catch (err) {
    _writeLog?.(`[GEMINI TOKEN STATE] Init error: ${err.message}`);
  }

  if (!apiKey && config.fetchQuotaStatus) {
    _startQuotaFetching(config.paths.home).catch(err =>
      _writeLog?.(`[GEMINI QUOTA] Init failed: ${err.message}`)
    );
  }

  return env;
}

export async function setConfigOption(acpClient, sessionId, optionId, value) {
  if (optionId === 'mode') {
    return acpClient.transport.sendRequest('session/set_mode', {
      sessionId,
      modeId: value
    });
  }

  if (optionId === 'model') {
    return acpClient.transport.sendRequest('session/set_model', {
      sessionId,
      modelId: value
    });
  }

  // Gemini doesn't fully support arbitrary set_config_option yet, return empty
  return null;
}

export async function setInitialAgent(_acpClient, _sessionId, _agent) {
  return;
}

export function getMcpServerMeta() {
  return undefined;
}

// --- Session File Operations ---

/**
 * Gemini CLI names session files as:
 *   session-{2026-04-18T10-30}-{first8charsOfUUID}.jsonl
 *
 * The short ID is safeSessionId.slice(0, 8) in the CLI, where
 * sanitizeFilenamePart() keeps dashes in UUIDs. Since the first UUID
 * segment is exactly 8 hex chars, this equals acpId.split('-')[0].
 *
 * e.g. "a1b2c3d4-e5f6-7890-1234-567890abcdef" → shortId = "a1b2c3d4"
 *
 * Source: chatRecordingService.ts lines 391-410
 */
function getShortId(acpId) {
  return acpId.split('-')[0] || acpId;
}

/**
 * Gemini CLI stores sessions in project-scoped subdirectories:
 *   <sessionsRoot>/<project-hash>/chats/session-{timestamp}-{shortId}.jsonl
 */
function findSessionDir(sessionsRoot, acpId) {
  if (!fs.existsSync(sessionsRoot)) return sessionsRoot;

  const shortId = getShortId(acpId);

  try {
    const projectDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
                          .filter(dirent => dirent.isDirectory())
                          .map(dirent => dirent.name);

    for (const proj of projectDirs) {
      const chatsDir = path.join(sessionsRoot, proj, 'chats');
      if (fs.existsSync(chatsDir)) {
        const files = fs.readdirSync(chatsDir);
        const targets = files.filter(f => f.includes(shortId) && f.endsWith('.jsonl'));

        if (targets.length > 0) {
          return chatsDir;
        }
      }
    }
  } catch (err) {
    // ignore — fall through to sessionsRoot
  }
  return sessionsRoot;
}

function getExactSessionFile(sessionDir, acpId, extension) {
  const shortId = getShortId(acpId);
  try {
    if (fs.existsSync(sessionDir)) {
      const files = fs.readdirSync(sessionDir);
      const target = files.find(f => f.includes(shortId) && f.endsWith(extension));
      if (target) return path.join(sessionDir, target);
    }
  } catch (e) {}

  // Fallback to exact match just in case
  return path.join(sessionDir, `${acpId}${extension}`);
}

export function getSessionPaths(acpId) {
  const { config } = getProvider();
  const dir = findSessionDir(config.paths.sessions, acpId);

  const jsonlPath = getExactSessionFile(dir, acpId, '.jsonl');
  const jsonPath = getExactSessionFile(dir, acpId, '.json');

  return {
    jsonl: jsonlPath,
    json: jsonPath,
    tasksDir: path.join(dir, acpId),
  };
}

export function getSessionDir() {
  const { config } = getProvider();
  return config.paths.sessions;
}

export function getAttachmentsDir() {
  const { config } = getProvider();
  return config.paths.attachments;
}

export function getAgentsDir() {
  const { config } = getProvider();
  return config.paths.agents;
}

export function cloneSession(oldAcpId, newAcpId, pruneAtTurn) {
  const oldPaths = getSessionPaths(oldAcpId);
  if (!oldPaths.jsonl && !oldPaths.json) return;

  const sessionDir = oldPaths.jsonl ? path.dirname(oldPaths.jsonl) : path.dirname(oldPaths.json);
  
  // Mirror Gemini CLI's naming: session-{2026-04-18T10-30}-{first8chars}.jsonl
  const ts = new Date().toISOString().slice(0, 16).replace(/:/g, '-');
  const shortNewId = getShortId(newAcpId);
  const newBaseName = `session-${ts}-${shortNewId}`;

  const newJsonl = path.join(sessionDir, `${newBaseName}.jsonl`);
  const newJson = path.join(sessionDir, `${newBaseName}.json`);

  if (oldPaths.jsonl && fs.existsSync(oldPaths.jsonl)) {
    const lines = fs.readFileSync(oldPaths.jsonl, 'utf-8').split('\n').filter(l => l.trim());
    if (pruneAtTurn != null) {
      let userTurnCount = 0;
      let pruneAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          // Only real user messages count as turns; skip $set/$rewindTo/metadata lines
          if (entry.type === 'user') {
            userTurnCount++;
          }
          if (userTurnCount > pruneAtTurn) {
            pruneAt = i;
            break;
          }
        } catch {}
      }
      fs.writeFileSync(newJsonl, lines.slice(0, pruneAt).map(l => l.replaceAll(oldAcpId, newAcpId)).join('\n') + '\n', 'utf-8');
    } else {
      const content = fs.readFileSync(oldPaths.jsonl, 'utf-8');
      fs.writeFileSync(newJsonl, content.replaceAll(oldAcpId, newAcpId), 'utf-8');
    }
  }

  if (oldPaths.json && fs.existsSync(oldPaths.json)) {
    let json = fs.readFileSync(oldPaths.json, 'utf-8');
    json = json.replaceAll(oldAcpId, newAcpId);
    fs.writeFileSync(newJson, json, 'utf-8');
  }

  if (oldPaths.tasksDir && fs.existsSync(oldPaths.tasksDir)) {
    const newTasksDir = path.join(sessionDir, newAcpId);
    fs.cpSync(oldPaths.tasksDir, newTasksDir, { recursive: true });
  }
}

export function deleteSessionFiles(acpId) {
  const paths = getSessionPaths(acpId);
  if (paths.jsonl && fs.existsSync(paths.jsonl)) fs.unlinkSync(paths.jsonl);
  if (paths.json && fs.existsSync(paths.json)) fs.unlinkSync(paths.json);

  // Also clear token accumulation and emit tracking for this session
  if (_accumulatedTokensBySession.has(acpId)) {
    _accumulatedTokensBySession.delete(acpId);
    _saveTokenState();
  }
  if (_sessionsWithInitialEmit.has(acpId)) {
    _sessionsWithInitialEmit.delete(acpId);
  }
  if (paths.tasksDir && fs.existsSync(paths.tasksDir)) fs.rmSync(paths.tasksDir, { recursive: true, force: true });
}

export function archiveSessionFiles(acpId, archiveDir) {
  const paths = getSessionPaths(acpId);
  if (paths.jsonl && fs.existsSync(paths.jsonl)) {
    fs.copyFileSync(paths.jsonl, path.join(archiveDir, path.basename(paths.jsonl)));
    fs.unlinkSync(paths.jsonl);
  }
  if (paths.json && fs.existsSync(paths.json)) {
    fs.copyFileSync(paths.json, path.join(archiveDir, path.basename(paths.json)));
    fs.unlinkSync(paths.json);
  }
  if (paths.tasksDir && fs.existsSync(paths.tasksDir)) {
    fs.cpSync(paths.tasksDir, path.join(archiveDir, 'tasks'), { recursive: true });
    fs.rmSync(paths.tasksDir, { recursive: true, force: true });
  }
  
  const sessionDir = paths.jsonl ? path.dirname(paths.jsonl) : '';
  if (sessionDir) {
    fs.writeFileSync(
      path.join(archiveDir, 'restore_meta.json'),
      JSON.stringify({ sessionDir }, null, 2)
    );
  }
}

/**
 * Extract a plain text string from a Gemini PartListUnion content value.
 *
 * Gemini's `content` field can be:
 *   - string               → return as-is
 *   - string[]             → join with newlines
 *   - Part[]               → extract each Part's .text, join
 *   - undefined / null     → return ''
 *
 * (Types from @google/genai: Part = { text?: string } | { inlineData: ... } | ...)
 */
function extractTextFromContent(content) {
  let text = '';
  if (!content) text = '';
  else if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map(p => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return stripReminder(text);
}

/**
 * Extract display text from a Gemini ToolCallRecord's result field.
 *
 * ToolCallRecord.result is PartListUnion — same shape as content.
 * ToolCallRecord.resultDisplay may hold a pre-formatted string or structured
 * display object; we use it when it's a plain string.
 */
function extractToolResultText(toolCall) {
  // Prefer pre-formatted display string if available
  if (toolCall.resultDisplay && typeof toolCall.resultDisplay === 'string') {
    return stripReminder(toolCall.resultDisplay);
  }
  // Fall back to extracting text from the raw result parts
  return extractTextFromContent(toolCall.result) || undefined;
}

/**
 * Parse a Gemini CLI session .jsonl file into the AcpUI Unified Timeline format.
 *
 * Gemini JSONL record types (from chatRecordingTypes.ts):
 *
 *   Line 1 (metadata):   { sessionId, projectHash, startTime, lastUpdated, kind? }
 *   Message records:     { id, timestamp, type, content, toolCalls?, thoughts? }
 *     type === 'user'  → user message
 *     type === 'gemini'→ assistant message; toolCalls[] and thoughts[] are embedded here
 *     type === 'info'|'error'|'warning' → skip (system messages)
 *   Update records:      { $set: { ...partialConversationRecord } }  → skip
 *   Rewind records:      { $rewindTo: "messageId" }  → prune messages after that id
 */
export async function parseSessionHistory(filePath, Diff) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());

    // We build an ordered list of message records first, applying rewinds as we go.
    // messagesById preserves insertion order for later traversal.
    const messageIds = [];
    const messagesById = new Map();

    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }

      // $rewindTo: remove all messages that were added after the target id
      if (record.$rewindTo) {
        const rewindTarget = record.$rewindTo;
        const idx = messageIds.indexOf(rewindTarget);
        if (idx !== -1) {
          // Remove everything after the rewind target
          const toRemove = messageIds.splice(idx + 1);
          toRemove.forEach(id => messagesById.delete(id));
        }
        continue;
      }

      // $set: metadata update — skip
      if (record.$set) continue;

      // First metadata line: { sessionId, projectHash, startTime, ... } — no `id` field
      // Message records always have `id` (a UUID string).
      if (typeof record.id !== 'string') continue;

      // Skip system/informational messages — they aren't part of the conversation
      if (record.type === 'info' || record.type === 'error' || record.type === 'warning') continue;

      // Accept user and gemini message records
      if (record.type === 'user' || record.type === 'gemini') {
        messagesById.set(record.id, record);
        if (!messageIds.includes(record.id)) {
          messageIds.push(record.id);
        }
      }
    }

    // Now convert to AcpUI message format
    const messages = [];

    for (const id of messageIds) {
      const entry = messagesById.get(id);
      if (!entry) continue;

      if (entry.type === 'user') {
        const text = extractTextFromContent(entry.content).trim();
        if (!text) continue;
        messages.push({
          role: 'user',
          content: text,
          id: entry.id,
        });
      }

      else if (entry.type === 'gemini') {
        const timeline = [];

        // 1. Thoughts — shown before tool calls and text in the timeline
        if (Array.isArray(entry.thoughts)) {
          for (const thought of entry.thoughts) {
            const thoughtText = thought.description || thought.subject || '';
            if (thoughtText) {
              timeline.push({ type: 'thought', content: thoughtText });
            }
          }
        }

        // 2. Tool calls — embedded in the assistant message record
        if (Array.isArray(entry.toolCalls)) {
          for (const toolCall of entry.toolCalls) {
            // Build a human-readable title
            const baseName = toolCall.displayName || toolCall.name || 'Tool';
            const args = toolCall.args || {};
            const argPath = args.path || args.file_path || args.filePath
                         || args.command || args.pattern || args.query || '';
            const title = argPath ? `${baseName}: ${argPath}` : baseName;

            // Extract tool output from the recorded result
            let output = extractToolResultText(toolCall);

            // Fall back to reconstructing output from args when the CLI didn't
            // record a result (common for write/edit operations).
            if (!output) {
              if (args.old_string && args.new_string) {
                // True search-replace edit → show as a diff
                output = Diff.createPatch(
                  args.path || args.file_path || 'file',
                  args.old_string, args.new_string, 'old', 'new'
                );
              } else if (args.content) {
                // Write/create → show raw content so the frontend can syntax-highlight it
                output = args.content;
              }
            }

            const filePath = args.path || args.file_path || args.filePath || undefined;

            timeline.push({
              type: 'tool',
              isCollapsed: true,
              event: {
                id: toolCall.id,
                title,
                filePath,
                status: toolCall.status === 'error' ? 'failed' : 'completed',
                output: output || null,
              },
            });
          }
        }

        // 3. Assistant text
        const text = extractTextFromContent(entry.content).trim();

        messages.push({
          role: 'assistant',
          content: text,
          id: entry.id,
          isStreaming: false,
          timeline,
        });
      }
    }

    return messages;
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

export function restoreSessionFiles(savedAcpId, archiveDir) {
  const { config } = getProvider();
  const sessionsRoot = config.paths.sessions;

  let targetDir = sessionsRoot;
  const metaPath = path.join(archiveDir, 'restore_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.sessionDir) {
        targetDir = meta.sessionDir;
      }
    } catch { /* ignore */ }
  }

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const jsonlSrcFile = fs.readdirSync(archiveDir).find(f => f.endsWith('.jsonl'));
  const jsonSrcFile = fs.readdirSync(archiveDir).find(f => f.endsWith('.json'));
  const tasksSrc = path.join(archiveDir, 'tasks');

  if (jsonlSrcFile) {
    fs.copyFileSync(path.join(archiveDir, jsonlSrcFile), path.join(targetDir, jsonlSrcFile));
  }
  if (jsonSrcFile) {
    fs.copyFileSync(path.join(archiveDir, jsonSrcFile), path.join(targetDir, jsonSrcFile));
  }
  if (fs.existsSync(tasksSrc)) {
    fs.cpSync(tasksSrc, path.join(targetDir, savedAcpId), { recursive: true });
  }
}

export async function getHooksForAgent(_agentName, hookType) {
  return [];
}

export function buildSessionParams(agent) {
  // Gemini agent switching or metadata can be passed if supported by the CLI
  if (agent) return { _meta: { agent } };
  return undefined;
}

export async function performHandshake(acpClient) {
  const { config } = getProvider();
  
  // Do NOT claim `fs` capability. If we declare it, Gemini CLI routes all file
  // reads/writes through JSON-RPC proxy requests to us (fs/read_text_file,
  // fs/write_text_file) and stalls indefinitely when we don't respond.
  // Since AcpUI and Gemini CLI run on the same machine, direct local FS access
  // is correct — no proxy needed.
  const initPromise = acpClient.transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: { terminal: true },
    clientInfo: config.clientInfo || { name: 'AcpUI', version: '1.0.0' }
  });

  const apiKey = resolveApiKey();

  // Authenticate using the appropriate method:
  // - With apiKey:    gemini-api-key + key in _meta. Saves selectedType to CLI
  //                   settings, but that is intentional for API key users.
  // - Without apiKey: oauth-personal. Tells the CLI to use its saved OAuth
  //                   tokens. Writes selectedType: "oauth-personal" to settings,
  //                   but since that is already set, it is a no-op in practice.
  const authPromise = apiKey
    ? acpClient.transport.sendRequest('authenticate', {
        methodId: 'gemini-api-key',
        _meta: { 'api-key': apiKey },
      })
    : acpClient.transport.sendRequest('authenticate', {
        methodId: 'oauth-personal',
      });

  await Promise.all([initPromise, authPromise]);
}

// --- Quota Fetching (OAuth Only) ---

// OAuth client secret for token refresh calls.
//
// WHY THIS IS SAFE TO HARDCODE:
// This is an "installed application" OAuth client. Google explicitly permits
// embedding both the client ID and secret in source code for this app type:
//   https://developers.google.com/identity/protocols/oauth2#installed
// "The process results in a client ID and, in some cases, a client secret,
//  which you embed in the source code of your application. (In this context,
//  the client secret is obviously not treated as a secret.)"
//
// SOURCE: Taken directly from the Gemini CLI's own OAuth module:
//   packages/core/src/code_assist/oauth2.ts  (OAUTH_CLIENT_SECRET, line 75)
// If the Gemini CLI rotates this value, update it here to match.
const OAUTH_CLIENT_SECRET = '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';

function _extractClientId(homePath) {
  try {
    const credsPath = path.join(homePath, 'oauth_creds.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    if (!creds.id_token) return null;
    const payload = JSON.parse(
      Buffer.from(creds.id_token.split('.')[1], 'base64url').toString('utf8')
    );
    return payload.azp || null;
  } catch {
    return null;
  }
}

function _readTokenFromDisk(homePath) {
  try {
    const credsPath = path.join(homePath, 'oauth_creds.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    return creds.access_token || null;
  } catch {
    return null;
  }
}

async function _requestQuota(token) {
  const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ project: _quotaProjectId })
  });

  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json()
  };
}

async function _refreshAndSaveToken(homePath) {
  const clientId = _extractClientId(homePath);
  if (!clientId) {
    _writeLog?.('[GEMINI QUOTA] Could not derive client_id from oauth_creds.json — skipping refresh');
    return null;
  }

  const credsPath = path.join(homePath, 'oauth_creds.json');
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  } catch {
    return null;
  }

  if (!creds.refresh_token) return null;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token,
        client_id: clientId,
        client_secret: OAUTH_CLIENT_SECRET
      })
    });

    if (!res.ok) {
      _writeLog?.(`[GEMINI QUOTA] Token refresh failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    creds.access_token = data.access_token;
    if (data.expires_in) {
      creds.expiry_date = Date.now() + data.expires_in * 1000;
    }
    if (data.refresh_token) {
      creds.refresh_token = data.refresh_token;
    }
    fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), 'utf8');
    return data.access_token;
  } catch (e) {
    _writeLog?.(`[GEMINI QUOTA] Token refresh error: ${e.message}`);
    return null;
  }
}

export function stopQuotaFetching() {
  _stopQuotaPolling();
  _activePromptCount = 0;
  _inFlightSessions.clear();
}

/**
 * Called by the backend immediately before session/prompt is sent.
 * Registers the session as active and starts quota polling if needed.
 * Using an explicit hook instead of intercept()-based detection avoids false
 * positives from session/load history drain messages (user_message_chunk,
 * tool_call with status:completed, agent_message_chunk) that look identical
 * to live traffic inside intercept() but never produce a stopReason result.
 */
export function onPromptStarted(sessionId) {
  if (sessionId && !_inFlightSessions.has(sessionId)) {
    _inFlightSessions.add(sessionId);
    _activePromptCount++;
    _ensureQuotaPolling();
  }
}

/**
 * Called by the backend in a finally block after session/prompt resolves or
 * rejects (including cancellation). Decrements the active counter and stops
 * quota polling when no prompts remain in flight.
 */
export function onPromptCompleted(sessionId) {
  if (sessionId && _inFlightSessions.has(sessionId)) {
    _inFlightSessions.delete(sessionId);
    if (_activePromptCount > 0) _activePromptCount--;
    if (_activePromptCount === 0) _stopQuotaPolling();
  }
}

function _stopQuotaPolling() {
  if (_quotaPollTimer) {
    clearInterval(_quotaPollTimer);
    _quotaPollTimer = null;
  }
}

function _ensureQuotaPolling() {
  if (_quotaPollTimer || _activePromptCount === 0) return;

  const { config } = getProvider();
  const intervalMs = Number(config.quotaStatusIntervalMs || 30_000);
  if (intervalMs <= 0) return;


  _quotaPollTimer = setInterval(() => {
    _fetchAndEmitQuota(_lastSessionId || 'poll', config.paths.home, { emitInitial: true })
      .catch(err => _writeLog?.(`[GEMINI QUOTA] Poll failed: ${err.message}`));
  }, intervalMs);
  _quotaPollTimer.unref?.();
}

async function _requestLoadCodeAssist(token) {
  return fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      metadata: {
        ideName: 'IDE_UNSPECIFIED',
        pluginType: 'GEMINI',
        ideVersion: '1.0.0',
        platform: 'PLATFORM_UNSPECIFIED',
        updateChannel: 'stable'
      }
    })
  });
}

async function _startQuotaFetching(homePath) {
  stopQuotaFetching();
  try {
    const { config } = getProvider();
    let token = _readTokenFromDisk(homePath);
    if (!token) return;

    // Discover cloudaicompanionProject ID (required for quota calls)
    let loadRes = await _requestLoadCodeAssist(token);

    if (loadRes.status === 401) {
      // Re-read from disk first (another process may have refreshed it)
      token = _readTokenFromDisk(homePath);
      loadRes = await _requestLoadCodeAssist(token);

      if (loadRes.status === 401) {
        // Only now do we refresh and save new creds
        token = await _refreshAndSaveToken(homePath);
        if (!token) return;
        loadRes = await _requestLoadCodeAssist(token);
      }
    }

    if (!loadRes.ok) {
      throw new Error(`loadCodeAssist returned ${loadRes.status}`);
    }

    const loadData = await loadRes.json();
    if (!loadData.cloudaicompanionProject) {
      _writeLog?.('[GEMINI QUOTA] No project found (Free Tier). Skipping quota checks.');
      return;
    }

    _quotaProjectId = loadData.cloudaicompanionProject;
    _writeLog?.(`[GEMINI QUOTA] Discovered Project ID: ${_quotaProjectId}`);

    // Emit immediately — mirrors Codex emitInitial: true
    await _fetchAndEmitQuota(_lastSessionId || 'init', homePath, { emitInitial: true });

    // Polling will start automatically when the first prompt is sent (_ensureQuotaPolling)
    // and stop when the last prompt completes (_stopQuotaPolling)
  } catch (err) {
    _writeLog?.(`[GEMINI QUOTA] Init failed: ${err.message}`);
  }
}

async function _fetchAndEmitQuota(sessionId, homePath, options = {}) {
  if (!_quotaProjectId || _quotaFetchInFlight) return;

  _quotaFetchInFlight = true;
  try {
    let token = _readTokenFromDisk(homePath);
    if (!token) return;

    let res = await _requestQuota(token);

    if (res.status === 401) {
      // Re-read from disk first (another process may have refreshed it)
      token = _readTokenFromDisk(homePath);
      res = await _requestQuota(token);

      if (res.status === 401) {
        // Only now do we refresh and save new creds
        token = await _refreshAndSaveToken(homePath);
        if (!token) return;
        res = await _requestQuota(token);
      }
    }

    if (!res.ok) return;

    const data = await res.json();
    if (data.buckets && Array.isArray(data.buckets)) {
      _sessionQuotaInfo.set('global', data.buckets);
      const status = _buildStatus();
      _latestQuotaStatus = status;
      if (_emitProviderExtension && (sessionId !== 'init' || options.emitInitial)) {
        _emitStatus(sessionId);
      }
    }
  } catch (e) {
    // Ignore transient network errors
  } finally {
    _quotaFetchInFlight = false;
  }
}

function _buildStatus() {
  const buckets = _sessionQuotaInfo.get('global') || [];
  const { config } = getProvider();

  const groupedBuckets = new Map();

  for (const bucket of buckets) {
    if (!bucket.modelId || bucket.remainingFraction === undefined) continue;

    // Convert remaining fraction to usage fraction
    const usageFraction = Math.max(0, 1 - bucket.remainingFraction);
    
    // Determine friendly label
    let label = bucket.modelId;
    if (bucket.modelId.includes('pro')) {
      label = 'Pro';
    } else if (bucket.modelId.includes('flash-8b') || bucket.modelId.includes('light') || bucket.modelId.includes('lite')) {
      label = 'Light';
    } else if (bucket.modelId.includes('flash')) {
      label = 'Flash';
    }

    // Keep the most restrictive (highest usage) bucket for each label
    const existing = groupedBuckets.get(label);
    if (!existing || usageFraction > existing.usageFraction) {
      groupedBuckets.set(label, {
        ...bucket,
        label,
        usageFraction
      });
    }
  }

  const items = [];
  const detailsItems = [];

  // Sort labels: Pro first, then Flash, then Light, then others
  const sortedLabels = Array.from(groupedBuckets.keys()).sort((a, b) => {
    const priority = { 'Pro': 1, 'Flash': 2, 'Light': 3 };
    const pA = priority[a] || 99;
    const pB = priority[b] || 99;
    if (pA !== pB) return pA - pB;
    return a.localeCompare(b);
  });

  for (const label of sortedLabels) {
    const bucket = groupedBuckets.get(label);
    const usageFraction = bucket.usageFraction;
    
    // Determine tone based on usage
    let tone = 'info';
    if (usageFraction >= 0.9) tone = 'danger';
    else if (usageFraction >= 0.7) tone = 'warning';
    
    // Format reset time
    let resetText = '';
    if (bucket.resetTime) {
       const date = new Date(bucket.resetTime);
       if (!Number.isNaN(date.getTime())) {
          resetText = date.toLocaleString([], {
             month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
          });
       }
    }
    
    const item = {
      id: bucket.modelId,
      label: label,
      value: `${Math.round(usageFraction * 100)}%`,
      detail: resetText ? `Resets ${resetText}` : undefined,
      tone,
      progress: { value: usageFraction }
    };
    
    detailsItems.push(item);
    
    // Add both Pro and Flash to summary bars in side panel
    if (label === 'Pro' || label === 'Flash') {
       items.push({ ...item, id: `summary-${label.toLowerCase()}` });
    }
  }

  return {
    providerId: 'gemini',
    title: 'Gemini',
    updatedAt: new Date().toISOString(),
    summary: {
      title: 'Usage',
      items: items
    },
    sections: detailsItems.length > 0 ? [{
      id: 'limits',
      title: 'Usage Windows',
      items: detailsItems
    }] : []
  };
}

function _emitStatus(sessionId) {
  if (!_emitProviderExtension || !_latestQuotaStatus) return;
  const { config } = getProvider();
  _emitProviderExtension(`${config.protocolPrefix}provider/status`, {
    status: _latestQuotaStatus
  });
}

/**
 * Loads token accumulation state from disk on startup.
 * This ensures context % is preserved when switching between sessions.
 */
function _loadTokenState() {
  try {
    if (!_tokenStateFile) return;
    if (!fs.existsSync(_tokenStateFile)) return;

    const data = JSON.parse(fs.readFileSync(_tokenStateFile, 'utf8'));
    if (data && typeof data === 'object') {
      _accumulatedTokensBySession = new Map(Object.entries(data));
    }
  } catch (err) {
    _writeLog?.(`[GEMINI TOKEN STATE] Failed to load: ${err.message}`);
  }
}

/**
 * Saves token accumulation state to disk for persistence (atomic write).
 * Uses temp file + rename pattern to avoid corruption from concurrent writes or crashes.
 */
function _saveTokenState() {
  try {
    if (!_tokenStateFile) return;

    // Ensure directory exists
    const dir = path.dirname(_tokenStateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Convert Map to object for JSON serialization
    const data = {};
    for (const [sessionId, accum] of _accumulatedTokensBySession.entries()) {
      data[sessionId] = accum;
    }

    // Write to temp file first, then atomically rename
    // This prevents corruption if:
    // - Multiple sessions write simultaneously
    // - Process crashes mid-write
    const tempFile = _tokenStateFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, _tokenStateFile);
  } catch (err) {
    _writeLog?.(`[GEMINI TOKEN STATE] Failed to save: ${err.message}`);
  }
}
