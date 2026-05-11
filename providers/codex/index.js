import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProvider } from '../../backend/services/providerLoader.js';
import { collectInputObjects, mergeInputObjects } from '../../backend/services/tools/toolInputUtils.js';
import { matchToolIdPattern } from '../../backend/services/tools/toolIdPattern.js';

const MODEL_OPTION_IDS = new Set(['model']);
const REASONING_OPTION_IDS = new Set(['reasoning_effort', 'effort']);
const COMMAND_AUTH_METHODS = new Set(['chatgpt', 'codex-api-key', 'openai-api-key']);
const DEFAULT_QUOTA_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const REFRESH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

let _emitProviderExtension = null;
let _writeLog = null;
let _lastSessionId = null;
let _quotaPollTimer = null;
let _quotaFetchInFlight = false;
let _quotaRefreshInFlight = false;
let _latestQuotaStatus = null;
let _activePromptCount = 0; // Only poll quota while prompts are in-flight
let _inFlightSessions = new Set(); // Track sessions with active prompts
let _sessionContextCache = new Map(); // sessionId -> contextUsagePercentage
let _contextStateFile = null; // Path to persist context state
let _sessionsWithInitialEmit = new Set(); // Track which sessions we've already emitted initial context for

function _emitCachedContext(sessionId, config) {
  if (!sessionId || _sessionsWithInitialEmit.has(sessionId)) return false;
  _sessionsWithInitialEmit.add(sessionId);
  const persistedPercent = _sessionContextCache.get(sessionId);
  if (persistedPercent !== undefined && _emitProviderExtension) {
    _emitProviderExtension(`${config.protocolPrefix || '_codex/'}metadata`, {
      sessionId,
      contextUsagePercentage: persistedPercent
    });
    return true;
  }
  return false;
}

/**
 * Loads context usage state from disk on startup.
 */
function _loadContextState() {
  try {
    if (!_contextStateFile) return;
    if (!fs.existsSync(_contextStateFile)) return;

    const data = JSON.parse(fs.readFileSync(_contextStateFile, 'utf8'));
    if (data && typeof data === 'object') {
      _sessionContextCache = new Map(Object.entries(data));
    }
  } catch (err) {
    _writeLog?.(`[CODEX CONTEXT STATE] Failed to load: ${err.message}`);
  }
}

/**
 * Saves context usage state to disk for persistence (atomic write).
 */
function _saveContextState() {
  try {
    if (!_contextStateFile) return;

    const dir = path.dirname(_contextStateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = {};
    for (const [sessionId, percent] of _sessionContextCache.entries()) {
      data[sessionId] = percent;
    }

    const tempFile = `${_contextStateFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, _contextStateFile);
  } catch (err) {
    _writeLog?.(`[CODEX CONTEXT STATE] Failed to save: ${err.message}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function expandPath(value) {
  if (!value || typeof value !== 'string') return '';
  const home = os.homedir() || process.env.USERPROFILE || process.env.HOME || '';
  const expanded = value
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || home)
    .replace(/\$HOME/g, process.env.HOME || home);
  return path.resolve(expanded);
}

function configPaths() {
  const { config } = getProvider();
  const paths = config.paths || {};
  const home = expandPath(paths.home || path.join(os.homedir(), '.codex'));
  return {
    home,
    sessions: expandPath(paths.sessions || path.join(home, 'sessions')),
    agents: expandPath(paths.agents || path.join(home, 'agents')),
    attachments: expandPath(paths.attachments || path.join(home, 'attachments')),
    archive: expandPath(paths.archive || path.join(home, 'archive'))
  };
}

function normalizeSelectOptions(options) {
  if (!Array.isArray(options)) return options;
  return options
    .map(option => {
      if (typeof option === 'string' && option.trim()) {
        return { value: option, name: option };
      }
      if (!isObject(option)) return null;
      const value = option.value ?? option.id ?? option.modelId;
      if (value === undefined || value === null || value === '') return null;
      return {
        value: String(value),
        name: option.name || option.displayName || String(value),
        ...(option.description ? { description: option.description } : {})
      };
    })
    .filter(Boolean);
}

function extractModelOptionsFromConfig(configOptions) {
  if (!Array.isArray(configOptions)) return [];
  const modelOption = configOptions.find(option =>
    option &&
    option.id === 'model' &&
    option.type === 'select' &&
    Array.isArray(option.options)
  );
  if (!modelOption) return [];

  const seen = new Set();
  const normalized = [];
  for (const option of normalizeSelectOptions(modelOption.options)) {
    const id = typeof option?.value === 'string' ? option.value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      name: option.name || id,
      ...(option.description ? { description: option.description } : {})
    });
  }
  return normalized;
}

export function normalizeModelState(modelState = {}, source = {}) {
  const normalizedOptions = [];
  const seen = new Set();
  const candidateOptions = [
    ...(Array.isArray(modelState.modelOptions) ? modelState.modelOptions : []),
    ...extractModelOptionsFromConfig(source?.configOptions)
  ];
  for (const option of candidateOptions) {
    const modelId = typeof option?.id === 'string' ? option.id.trim() : '';
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    normalizedOptions.push({
      ...option,
      id: modelId,
      name: option.name || option.displayName || modelId
    });
  }

  const currentModelId = typeof modelState.currentModelId === 'string'
    ? modelState.currentModelId.trim()
    : modelState.currentModelId;
  return {
    ...modelState,
    currentModelId,
    modelOptions: normalizedOptions,
    replaceModelOptions: true
  };
}

export function normalizeConfigOptions(options) {
  if (!Array.isArray(options)) return [];

  return options
    .filter(option => option && typeof option.id === 'string' && !MODEL_OPTION_IDS.has(option.id))
    .map(option => {
      const normalized = {
        ...option,
        currentValue: option.currentValue ?? option.current_value
      };
      if (Array.isArray(option.options)) {
        normalized.options = normalizeSelectOptions(option.options);
      }
      if (REASONING_OPTION_IDS.has(option.id)) {
        normalized.kind = 'reasoning_effort';
      }
      return normalized;
    });
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

export function intercept(payload) {
  try {
    const { config } = getProvider();
    const sessionId = payload?.params?.sessionId || payload?.result?.sessionId;
    if (sessionId) _lastSessionId = sessionId;

    if (sessionId) {
      _emitCachedContext(sessionId, config);
    }

    // Handle Codex's usage_update to cache context usage
    if (
      payload.method === 'session/update' &&
      payload.params?.update?.sessionUpdate === 'usage_update' &&
      payload.params?.sessionId
    ) {
      const update = payload.params.update;
      if (typeof update.used === 'number' && typeof update.size === 'number' && update.size > 0) {
        const percent = Math.min(100, (update.used / update.size) * 100);
        _sessionContextCache.set(payload.params.sessionId, percent);
        _saveContextState();
      }
    }

  } catch {}

  if (
    payload?.method === 'session/update' &&
    payload.params?.update?.sessionUpdate === 'available_commands_update'
  ) {
    const { config } = getProvider();
    return {
      id: payload.id,
      method: `${config.protocolPrefix}commands/available`,
      params: {
        sessionId: payload.params.sessionId,
        commands: normalizeCommands(payload.params.update.availableCommands)
      }
    };
  }

  if (
    payload?.method === 'session/update' &&
    payload.params?.update?.sessionUpdate === 'config_option_update'
  ) {
    const { config } = getProvider();
    const configOptions = payload.params.update.configOptions;
    const options = normalizeConfigOptions(configOptions);
    const modelOptions = extractModelOptionsFromConfig(configOptions);
    const removeOptionIds = Array.isArray(payload.params.update.removeOptionIds)
      ? payload.params.update.removeOptionIds.filter(id => !MODEL_OPTION_IDS.has(id))
      : undefined;
    const shouldReplaceOptions = options.length > 0 || Boolean(removeOptionIds?.length);

    if (
      options.length === 0 &&
      modelOptions.length === 0 &&
      (!removeOptionIds || removeOptionIds.length === 0)
    ) {
      return null;
    }

    return {
      id: payload.id,
      method: `${config.protocolPrefix}config_options`,
      params: {
        sessionId: payload.params.sessionId,
        options,
        replace: shouldReplaceOptions,
        ...(modelOptions.length > 0 ? { modelOptions } : {}),
        ...(removeOptionIds ? { removeOptionIds } : {})
      }
    };
  }

  // Codex wraps the user-facing error detail in error.data.message while the top-level
  // error.message is the generic JSON-RPC sentinel (e.g. "Internal error"). Promote
  // data.message so the real cause surfaces in logs and in the UI error box.
  if (payload?.error?.data?.message) {
    return {
      ...payload,
      error: {
        ...payload.error,
        message: payload.error.data.message
      }
    };
  }

  return payload;
}

export function emitCachedContext(sessionId) {
  const { config } = getProvider();
  return _emitCachedContext(sessionId, config);
}

export function normalizeUpdate(update) {
  return update;
}

function contentBlockText(block) {
  if (typeof block === 'string') return block;
  if (!isObject(block)) return '';

  if (typeof block.text === 'string') return block.text;
  if (block.type === 'input_text' && typeof block.text === 'string') return block.text;
  if (block.type === 'output_text' && typeof block.text === 'string') return block.text;
  if (block.type === 'content') return contentBlockText(block.content);
  if (Array.isArray(block.content)) return block.content.map(contentBlockText).filter(Boolean).join('\n');
  if (isObject(block.content)) return contentBlockText(block.content);
  if (typeof block.message === 'string') return block.message;
  return '';
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentBlockText).filter(Boolean).join('\n');
  if (!isObject(value)) return '';

  if (Array.isArray(value.content)) return extractText(value.content);
  if (isObject(value.content)) return contentBlockText(value.content);
  if (typeof value.text === 'string') return value.text;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.formattedOutput === 'string') return value.formattedOutput;
  if (typeof value.formatted_output === 'string') return value.formatted_output;
  if (typeof value.aggregatedOutput === 'string') return value.aggregatedOutput;
  if (typeof value.aggregated_output === 'string') return value.aggregated_output;
  return '';
}

function resultText(rawOutput) {
  const raw = parseMaybeJson(rawOutput);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return extractText(raw);
  if (!isObject(raw)) return '';

  const stdout = raw.stdout || '';
  const stderr = raw.stderr || '';
  const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\n' : '');
  if (combined) return combined;

  if (raw.result !== undefined) {
    const result = raw.result?.Ok ?? raw.result?.ok ?? raw.result;
    const text = extractText(result);
    if (text) return text;
  }

  const text = extractText(raw);
  if (text) return text;

  return JSON.stringify(raw, null, 2);
}

export function extractToolOutput(update) {
  if (Array.isArray(update.content)) {
    const parts = update.content
      .map(item => item?.type === 'diff' ? null : contentBlockText(item))
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }

  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return resultText(update.rawOutput);
  }

  if (update.result !== undefined && update.result !== null) {
    return resultText(update.result);
  }

  return undefined;
}

function findPathInRaw(rawValue) {
  const raw = parseMaybeJson(rawValue);
  if (!isObject(raw)) return undefined;

  const invocationArgs = raw.invocation?.arguments || raw.arguments || raw.args || {};
  const candidates = [
    raw.path,
    raw.file_path,
    raw.filePath,
    raw.target_path,
    raw.targetPath,
    raw.diff?.path,
    invocationArgs.path,
    invocationArgs.file_path,
    invocationArgs.filePath,
    invocationArgs.target_path,
    invocationArgs.targetPath
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }

  if (Array.isArray(raw.locations)) {
    for (const location of raw.locations) {
      if (typeof location?.path === 'string' && location.path.trim()) return location.path;
    }
  }

  const changes = raw.changes || raw.file_changes || raw.fileChanges;
  if (isObject(changes)) {
    const firstPath = Object.keys(changes).find(Boolean);
    if (firstPath) return firstPath;
  }

  return undefined;
}

export function extractFilePath(update, resolvePath = p => p) {
  if (Array.isArray(update.locations)) {
    for (const location of update.locations) {
      if (location?.path) return resolvePath(location.path);
    }
  }

  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item?.type === 'diff' && item.path) return resolvePath(item.path);
    }
  }

  const rawPath = findPathInRaw(update.rawInput) || findPathInRaw(update.rawOutput);
  return rawPath ? resolvePath(rawPath) : undefined;
}

function createUnifiedDiff(filePath, oldText, newText, Diff) {
  if (!Diff?.createPatch) return undefined;
  return Diff.createPatch(filePath || 'file', oldText || '', newText || '', 'old', 'new');
}

function diffFromChanges(changes, Diff) {
  if (!isObject(changes)) return undefined;
  const patches = [];

  for (const [filePath, change] of Object.entries(changes)) {
    if (!isObject(change)) continue;
    const readyDiff = change.unifiedDiff || change.unified_diff || change.diff || change.patch;
    if (typeof readyDiff === 'string' && readyDiff.trim()) {
      patches.push(readyDiff);
      continue;
    }

    const oldText = change.oldText ?? change.old_text ?? change.old ?? change.before ?? '';
    const newText = change.newText ?? change.new_text ?? change.new ?? change.after ?? change.content ?? '';
    patches.push(createUnifiedDiff(filePath, oldText, newText, Diff));
  }

  return patches.filter(Boolean).join('\n');
}

export function extractDiffFromToolCall(update, Diff) {
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item?.type === 'diff') {
        return createUnifiedDiff(item.path || update.toolCallId || 'file', item.oldText || '', item.newText || '', Diff);
      }
    }
  }

  const raw = parseMaybeJson(update.rawInput);
  if (isObject(raw)) {
    return diffFromChanges(raw.changes || raw.file_changes || raw.fileChanges, Diff);
  }

  return undefined;
}

function normalizeToolName(name) {
  if (!name || typeof name !== 'string') return '';
  const { config } = getProvider();
  const patternMatch = matchToolIdPattern(name, config);
  if (patternMatch?.toolName) return patternMatch.toolName.trim().toLowerCase();

  const normalized = name
    .replace(/^Tool:\s*/i, '')
    .trim()
    .toLowerCase();

  if (normalized === 'shell_command') return 'shell';
  if (normalized === 'apply_patch') return 'edit_file';
  return normalized;
}

function toolNameFromTitle(title) {
  if (!title || typeof title !== 'string') return '';
  const { config } = getProvider();
  const patternMatch = matchToolIdPattern(title.replace(/^Tool:\s*/i, ''), config);
  if (patternMatch?.toolName) return normalizeToolName(patternMatch.toolName);

  const lower = title.toLowerCase();
  if (lower.includes('web search')) return 'web_search';
  if (lower.includes('fetch')) return 'fetch';
  if (lower.includes('think')) return 'think';
  return '';
}

function commandFromRaw(rawValue) {
  const raw = parseMaybeJson(rawValue);
  if (!isObject(raw)) return '';
  const rawArgs = raw.invocation?.arguments || raw.arguments || raw.args || {};
  const parsedArgs = parseMaybeJson(rawArgs);
  const value = raw.command
    || raw.cmd
    || raw.parsed_cmd
    || raw.parsedCmd
    || raw.argv
    || (isObject(parsedArgs) ? parsedArgs.command : undefined);
  if (Array.isArray(value)) return value.join(' ');
  if (typeof value === 'string') return value;
  return '';
}

function invocationFromRaw(rawValue) {
  const raw = parseMaybeJson(rawValue);
  if (!isObject(raw)) return {};
  const invocation = raw.invocation || raw;
  const rawArgs = invocation.arguments || invocation.args || raw.arguments || raw.args || {};
  const parsedArgs = parseMaybeJson(rawArgs);
  return {
    server: invocation.server,
    tool: invocation.tool || invocation.name,
    arguments: isObject(parsedArgs) ? parsedArgs : {}
  };
}

function inferToolName(update, event) {
  const invocation = invocationFromRaw(update.rawInput);
  if (invocation.tool) return normalizeToolName(invocation.tool);

  const titleName = toolNameFromTitle(update.title || event.title);
  if (titleName) return titleName;

  const kind = update.kind || update.toolKind || '';
  if (kind === 'execute') return 'shell';
  if (kind === 'read') return 'read_file';
  if (['edit', 'delete', 'move'].includes(kind)) return 'edit_file';
  if (kind === 'search') return 'search';
  if (kind === 'fetch') return 'fetch';
  if (kind === 'think') return 'think';
  if (kind === 'web_search') return 'web_search';

  return normalizeToolName(event.toolName || update.toolCallId || '');
}

function titleForTool(toolName, event, update) {
  const filePath = event.filePath || extractFilePath(update, p => p);
  const basename = filePath ? path.basename(filePath) : '';
  const rawTitle = update.title || event.title || '';
  const invocation = invocationFromRaw(update.rawInput);
  const args = invocation.arguments || {};

  if (toolName === 'ux_invoke_shell') {
    const command = args.command || commandFromRaw(update.rawInput);
    return command ? `Run shell command: ${command}` : 'Run shell command';
  }
  if (toolName === 'ux_invoke_subagents') return 'Run subagents';
  if (toolName === 'ux_invoke_counsel') return 'Run counsel';
  if (toolName === 'shell' || toolName === 'execute') {
    const command = commandFromRaw(update.rawInput);
    return command ? `Run command: ${command}` : 'Run command';
  }
  if (toolName === 'read_file') return basename ? `Read file: ${basename}` : 'Read file';
  if (toolName === 'edit_file') return basename ? `Edit file: ${basename}` : 'Edit file';
  if (toolName === 'write_file') return basename ? `Write file: ${basename}` : 'Write file';
  if (toolName === 'search') return args.pattern || args.query ? `Search: ${args.pattern || args.query}` : 'Search';
  if (toolName === 'web_search') return args.query ? `Web search: ${args.query}` : 'Web search';
  if (toolName === 'fetch') return args.url ? `Fetch: ${args.url}` : 'Fetch';
  if (toolName === 'think') return 'Think';

  if (rawTitle.startsWith('Tool: ')) return rawTitle.slice(6);
  return rawTitle || 'Tool';
}

export function normalizeTool(event, update = {}) {
  const toolName = inferToolName(update, event);
  const filePath = event.filePath || extractFilePath(update, p => p);
  return {
    ...event,
    ...(toolName ? { toolName } : {}),
    ...(filePath ? { filePath } : {}),
    title: titleForTool(toolName, { ...event, filePath }, update)
  };
}

export function extractToolInvocation(update = {}, context = {}) {
  const event = context.event || {};
  const normalized = normalizeTool({ ...event }, update);
  const invocation = invocationFromRaw(update.rawInput);
  const input = {
    ...mergeInputObjects(collectInputObjects(
      update.rawInput,
      update.arguments,
      update.params,
      update.input,
      update.toolCall?.arguments
    )),
    ...(invocation.arguments || {})
  };
  const canonicalName = normalized.toolName || '';
  const rawName = invocation.tool || update.toolName || update.name || event.toolName || update.title || event.title || '';

  return {
    toolCallId: update.toolCallId || event.id,
    kind: invocation.server || invocation.tool ? 'mcp' : (canonicalName ? 'provider_builtin' : 'unknown'),
    rawName,
    canonicalName,
    mcpServer: invocation.server,
    mcpToolName: invocation.tool,
    input,
    title: normalized.title || update.title || event.title,
    filePath: normalized.filePath,
    category: categorizeToolCall({ ...normalized, toolName: canonicalName }) || {}
  };
}

export function categorizeToolCall(event) {
  const { config } = getProvider();
  const toolName = normalizeToolName(event.toolName || event.title);
  return config.toolCategories?.[toolName] || null;
}

export function parseExtension(method, params = {}) {
  const { config } = getProvider();
  const prefix = config.protocolPrefix || '_codex/';
  if (!method?.startsWith(prefix)) return null;

  const name = method.slice(prefix.length);
  if (name === 'commands/available') {
    return { type: 'available_commands', commands: params.commands || [] };
  }
  if (name === 'config_options') {
    return { type: 'config_options', options: params.options || [] };
  }
  if (name === 'provider/status') {
    return { type: 'provider_status', status: params.status };
  }
  if (name === 'metadata') {
    return { type: 'metadata', ...params };
  }
  return { type: 'unknown', method, params };
}

function resolveConfiguredApiKey(config) {
  if (config.codexApiKey) return { methodId: 'codex-api-key' };
  if (config.openaiApiKey) return { methodId: 'openai-api-key' };
  if (config.apiKey) {
    return config.apiKeyEnv === 'OPENAI_API_KEY'
      ? { methodId: 'openai-api-key' }
      : { methodId: 'codex-api-key' };
  }
  if (process.env.CODEX_API_KEY) return { methodId: 'codex-api-key' };
  if (process.env.OPENAI_API_KEY) return { methodId: 'openai-api-key' };
  return null;
}

function resolveAuthMethod(config) {
  const configured = String(config.authMethod || 'auto').trim().toLowerCase();
  if (configured === 'none' || configured === 'false' || configured === 'disabled') return null;
  if (configured === 'auto' || configured === '') return resolveConfiguredApiKey(config);
  if (COMMAND_AUTH_METHODS.has(configured)) return { methodId: configured };
  return null;
}

export async function prepareAcpEnvironment(env, context = {}) {
  const { config } = getProvider();
  const next = { ...env };

  if (config.codexApiKey) next.CODEX_API_KEY = config.codexApiKey;
  if (config.openaiApiKey) next.OPENAI_API_KEY = config.openaiApiKey;
  if (config.apiKey) {
    const keyName = config.apiKeyEnv === 'OPENAI_API_KEY' ? 'OPENAI_API_KEY' : 'CODEX_API_KEY';
    next[keyName] = config.apiKey;
  }
  if (config.noBrowser === true) next.NO_BROWSER = '1';

  _emitProviderExtension = context.emitProviderExtension || _emitProviderExtension;
  _writeLog = context.writeLog || _writeLog;

  // Initialize context persistence
  const homePath = expandPath(config.paths?.home || path.join(os.homedir(), '.codex'));
  _contextStateFile = path.join(homePath, 'acp_session_context.json');
  _loadContextState();

  if (config.fetchQuotaStatus) {
    startQuotaFetching(config.paths?.home).catch(err =>
      _writeLog?.(`[CODEX QUOTA] Init failed: ${err?.message || String(err)}`)
    );
  }

  return next;
}

export function getQuotaState() {
  return _latestQuotaStatus;
}

export function stopQuotaFetching() {
  _stopQuotaPolling();
  _activePromptCount = 0;
  _inFlightSessions.clear();
}

export function onPromptStarted(sessionId) {
  const { config } = getProvider();
  if (!config.fetchQuotaStatus) return;

  if (sessionId) _lastSessionId = sessionId;
  if (sessionId && !_inFlightSessions.has(sessionId)) {
    _inFlightSessions.add(sessionId);
    _activePromptCount++;
    _ensureQuotaPolling();
  }
}

export function onPromptCompleted(sessionId) {
  const { config } = getProvider();
  if (!config.fetchQuotaStatus) return;

  if (sessionId) _lastSessionId = sessionId;
  if (sessionId && _inFlightSessions.has(sessionId)) {
    _inFlightSessions.delete(sessionId);
    if (_activePromptCount > 0) _activePromptCount--;
    if (_activePromptCount === 0) _stopQuotaPolling();

    fetchAndEmitQuota(sessionId, config.paths?.home).catch(err =>
      _writeLog?.(`[CODEX QUOTA] Turn-complete refresh failed: ${err?.message || String(err)}`)
    );
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
    fetchAndEmitQuota(_lastSessionId || 'poll', config.paths?.home).catch(err =>
      _writeLog?.(`[CODEX QUOTA] Poll failed: ${err?.message || String(err)}`)
    );
  }, intervalMs);
  _quotaPollTimer.unref?.();
}

async function startQuotaFetching(homePath) {
  _stopQuotaPolling();
  _activePromptCount = 0;
  const { config } = getProvider();
  await fetchAndEmitQuota(_lastSessionId || 'init', homePath, { emitInitial: true });
  // Polling will start automatically when the first prompt is sent (_ensureQuotaPolling)
  // and stop when the last prompt completes (_stopQuotaPolling)
}

export async function fetchAndEmitQuota(sessionId = _lastSessionId || 'init', homePath, options = {}) {
  if (_quotaFetchInFlight) return null;
  _quotaFetchInFlight = true;
  try {
    const { config } = getProvider();
    const quota = await fetchCodexQuota({
      homePath: homePath || config.paths?.home,
      endpoint: config.quotaStatusEndpoint || DEFAULT_QUOTA_ENDPOINT,
      refreshOnUnauthorized: config.refreshQuotaOAuth !== false
    });
    const status = buildCodexProviderStatus(quota.body, quota);
    _latestQuotaStatus = status;
    if (_emitProviderExtension && (sessionId !== 'init' || options.emitInitial)) {
      _emitProviderExtension(`${config.protocolPrefix}provider/status`, { status });
    }
    return status;
  } finally {
    _quotaFetchInFlight = false;
  }
}

export async function fetchCodexQuota({
  homePath,
  endpoint = DEFAULT_QUOTA_ENDPOINT,
  refreshOnUnauthorized = true
} = {}) {
  const codexHome = expandPath(homePath || configPaths().home);
  let { authPath, auth } = readCodexAuth(codexHome);
  let response = await requestCodexQuota(endpoint, auth);

  if (response.status === 401 && refreshOnUnauthorized) {
    ({ auth } = readCodexAuth(codexHome));
    response = await requestCodexQuota(endpoint, auth);
    if (response.status === 401) {
      await refreshCodexOAuthToken(authPath, auth);
      ({ auth } = readCodexAuth(codexHome));
      response = await requestCodexQuota(endpoint, auth);
    }
  }

  if (!response.ok) {
    throw new Error(`Codex quota request failed: ${response.status} ${response.statusText}`);
  }

  return { ...response, authPath };
}

export function readCodexAuth(codexHome) {
  const authPath = path.join(expandPath(codexHome), 'auth.json');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (!auth.tokens?.access_token) {
    throw new Error(`No ChatGPT OAuth access token found in ${authPath}`);
  }
  return { authPath, auth };
}

async function requestCodexQuota(endpoint, auth) {
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: codexAuthHeaders(auth)
  });
  const contentType = res.headers?.get?.('content-type') || '';
  const text = await res.text();
  let body = text;
  if (contentType.includes('application/json') || text.trim().startsWith('{')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    body,
    headers: res.headers?.entries ? Object.fromEntries(res.headers.entries()) : {}
  };
}

function codexAuthHeaders(auth) {
  const tokens = auth.tokens || {};
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    'User-Agent': 'AcpUI Codex quota status'
  };
  const accountId = tokens.account_id || tokens.id_token?.chatgpt_account_id;
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;
  if (tokens.id_token?.chatgpt_account_is_fedramp) headers['X-OpenAI-Fedramp'] = 'true';
  return headers;
}

function extractClientIdFromAccessToken(auth) {
  try {
    const tokens = auth.tokens || {};
    const accessToken = tokens.access_token;
    if (!accessToken) return null;

    // JWT format: header.payload.signature
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')
    );
    return payload.client_id || null;
  } catch {
    return null;
  }
}

function resolveQuotaOAuthClientId(auth) {
  if (!auth) return null;
  return extractClientIdFromAccessToken(auth);
}

export async function refreshCodexOAuthToken(authPath, auth) {
  if (_quotaRefreshInFlight) return null;
  _quotaRefreshInFlight = true;
  try {
    const { config } = getProvider();
    const clientId = resolveQuotaOAuthClientId(auth);
    if (!clientId) {
      throw new Error('Codex OAuth refresh: client_id could not be derived from access_token JWT. Ensure auth.json contains a valid access_token with client_id field.');
    }
    const refreshToken = auth.tokens?.refresh_token;
    if (!refreshToken) throw new Error('No refresh_token found in Codex auth.json');

    const res = await fetch(config.quotaOAuthRefreshEndpoint || REFRESH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new Error(`Codex OAuth refresh failed: ${res.status} ${res.statusText}`);
    }
    if (!body || typeof body !== 'object' || !body.access_token) {
      throw new Error('Codex OAuth refresh response did not include access_token');
    }

    if (!auth.tokens) auth.tokens = {};
    if (body.id_token && typeof auth.tokens.id_token === 'object') {
      auth.tokens.id_token.raw_jwt = body.id_token;
    }
    auth.tokens.access_token = body.access_token;
    if (body.refresh_token) auth.tokens.refresh_token = body.refresh_token;
    auth.last_refresh = new Date().toISOString();
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf8');
    return auth;
  } finally {
    _quotaRefreshInFlight = false;
  }
}

export function buildCodexProviderStatus(body, meta = {}) {
  const windows = [];
  const primary = normalizeQuotaWindow(body?.rate_limit?.primary_window);
  const secondary = normalizeQuotaWindow(body?.rate_limit?.secondary_window);
  if (primary) windows.push(buildQuotaItem('primary', '5h', primary));
  if (secondary) windows.push(buildQuotaItem('secondary', '7d', secondary));

  const details = [
    body?.plan_type ? { id: 'plan', label: 'Plan', value: String(body.plan_type) } : null,
    body?.rate_limit?.allowed !== undefined
      ? { id: 'allowed', label: 'Allowed', value: body.rate_limit.allowed ? 'Yes' : 'No', tone: body.rate_limit.allowed ? 'success' : 'danger' }
      : null,
    body?.rate_limit_reached_type
      ? { id: 'limit-reached-type', label: 'Limit reached', value: String(body.rate_limit_reached_type), tone: 'warning' }
      : null
  ].filter(Boolean);

  const credits = body?.credits ? [
    { id: 'credits-has', label: 'Has credits', value: body.credits.has_credits ? 'Yes' : 'No' },
    { id: 'credits-unlimited', label: 'Unlimited credits', value: body.credits.unlimited ? 'Yes' : 'No' },
    body.credits.balance !== undefined ? { id: 'credits-balance', label: 'Credit balance', value: String(body.credits.balance) } : null,
    body.credits.overage_limit_reached !== undefined
      ? { id: 'credits-overage', label: 'Overage limit', value: body.credits.overage_limit_reached ? 'Reached' : 'Available', tone: body.credits.overage_limit_reached ? 'warning' : 'neutral' }
      : null
  ].filter(Boolean) : [];

  return {
    providerId: 'codex',
    title: 'Codex',
    updatedAt: new Date().toISOString(),
    summary: { title: 'Usage', items: windows },
    sections: [
      windows.length ? { id: 'limits', title: 'Usage Windows', items: windows } : null,
      details.length ? { id: 'account', title: 'Account', items: details } : null,
      credits.length ? { id: 'credits', title: 'Credits', items: credits } : null,
      meta.authPath ? { id: 'source', title: 'Source', items: [{ id: 'auth-path', label: 'Auth file', value: meta.authPath }] } : null
    ].filter(Boolean)
  };
}

function normalizeQuotaWindow(window) {
  if (!window) return null;
  const usedPercent = Number(window.used_percent);
  const windowMinutes = window.window_minutes ?? (
    typeof window.limit_window_seconds === 'number' ? Math.round(window.limit_window_seconds / 60) : null
  );
  return {
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : 0,
    windowMinutes,
    resetAt: window.reset_at
  };
}

function buildQuotaItem(id, label, window) {
  const usage = Math.max(0, Math.min(100, window.usedPercent));
  const used = Math.round(usage);
  let tone = 'info';
  if (usage >= 90) tone = 'danger';
  else if (usage >= 70) tone = 'warning';
  const resetText = formatReset(window.resetAt);
  return {
    id,
    label,
    value: `${used}%`,
    detail: resetText ? `Resets ${resetText}` : undefined,
    tone,
    progress: { value: usage / 100 }
  };
}

function formatReset(resetAt) {
  if (!resetAt) return '';
  const date = new Date(Number(resetAt) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export async function performHandshake(acpClient) {
  const { config } = getProvider();
  await acpClient.transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: { terminal: true },
    clientInfo: config.clientInfo || { name: 'AcpUI', version: '1.0.0' }
  });

  const auth = resolveAuthMethod(config);
  if (auth) {
    await acpClient.transport.sendRequest('authenticate', auth);
  }
}

export async function setConfigOption(acpClient, sessionId, optionId, value) {
  if (optionId === 'mode') {
    return await acpClient.transport.sendRequest('session/set_mode', { sessionId, modeId: value });
  }
  if (optionId === 'model') {
    return await acpClient.transport.sendRequest('session/set_model', { sessionId, modelId: value });
  }

  const result = await acpClient.transport.sendRequest('session/set_config_option', {
    sessionId,
    configId: optionId,
    value
  });

  return result?.configOptions
    ? { ...result, configOptions: normalizeConfigOptions(result.configOptions) }
    : result;
}

function readDirRecursive(root, predicate) {
  if (!root || !fs.existsSync(root)) return null;
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (predicate(fullPath, entry.name)) {
        return fullPath;
      }
    }
  }

  return null;
}

function findSessionFile(acpId) {
  const { sessions } = configPaths();
  if (!acpId || !sessions) return null;

  const byName = readDirRecursive(sessions, (_filePath, name) =>
    name.endsWith('.jsonl') && name.includes(acpId)
  );
  if (byName) return byName;

  return readDirRecursive(sessions, (filePath, name) => {
    if (!name.endsWith('.jsonl')) return false;
    try {
      return fs.readFileSync(filePath, 'utf8').includes(acpId);
    } catch {
      return false;
    }
  });
}

export function getSessionPaths(acpId) {
  const { sessions } = configPaths();
  const jsonl = findSessionFile(acpId) || path.join(sessions, `${acpId}.jsonl`);
  return {
    jsonl,
    json: jsonl.replace(/\.jsonl$/i, '.json'),
    tasksDir: path.join(path.dirname(jsonl), acpId)
  };
}

function rolloutFilename(acpId) {
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
  return `rollout-${timestamp}-${acpId}.jsonl`;
}

function isUserBoundary(record, preferEventUser) {
  if (preferEventUser) {
    return record?.type === 'event_msg' && record.payload?.type === 'user_message';
  }
  return record?.type === 'response_item' &&
    record.payload?.type === 'message' &&
    record.payload?.role === 'user';
}

function getRecordTurnId(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'turn_context') return record.payload?.turn_id || null;
  if (record.type === 'event_msg') return record.payload?.turn_id || null;
  if (record.type === 'response_item') return record.payload?.turn_id || record.turn_id || null;
  return record.payload?.turn_id || record.turn_id || null;
}

function buildTurnMetadata(records) {
  const turnStartIndexes = new Map();
  const recordTurnIds = new Array(records.length).fill(null);
  let currentTurnId = null;

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;

    const explicitTurnId = getRecordTurnId(record);
    if (explicitTurnId) currentTurnId = explicitTurnId;

    const effectiveTurnId = explicitTurnId || currentTurnId || null;
    recordTurnIds[index] = effectiveTurnId;

    if (effectiveTurnId && !turnStartIndexes.has(effectiveTurnId)) {
      turnStartIndexes.set(effectiveTurnId, index);
    }

    if (record.type === 'event_msg') {
      const eventType = record.payload?.type;
      if ((eventType === 'task_complete' || eventType === 'turn_aborted') && effectiveTurnId === currentTurnId) {
        currentTurnId = null;
      }
    }
  }

  return { turnStartIndexes, recordTurnIds };
}

function pruneRolloutLines(lines, pruneAtTurn) {
  if (!Number.isFinite(pruneAtTurn) || pruneAtTurn <= 0) return lines;
  const records = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  });

  const preferEventUser = records.some(record =>
    record?.type === 'event_msg' && record.payload?.type === 'user_message'
  );
  const { turnStartIndexes, recordTurnIds } = buildTurnMetadata(records);

  let seenUserTurns = 0;
  for (let index = 0; index < records.length; index++) {
    if (!isUserBoundary(records[index], preferEventUser)) continue;
    seenUserTurns++;
    if (seenUserTurns > pruneAtTurn) {
      const turnId = recordTurnIds[index];
      const turnStartIndex = turnId ? turnStartIndexes.get(turnId) : null;
      return lines.slice(0, Number.isInteger(turnStartIndex) ? turnStartIndex : index);
    }
  }

  return lines;
}

export function cloneSession(oldAcpId, newAcpId, pruneAtTurn) {
  const oldJsonl = findSessionFile(oldAcpId);
  if (!oldJsonl || !fs.existsSync(oldJsonl)) return;

  const sessionDir = path.dirname(oldJsonl);
  const oldBasename = path.basename(oldJsonl);
  const newBasename = oldBasename.includes(oldAcpId)
    ? oldBasename.replaceAll(oldAcpId, newAcpId)
    : rolloutFilename(newAcpId);
  const newJsonl = path.join(sessionDir, newBasename);

  const lines = fs.readFileSync(oldJsonl, 'utf8').split(/\r?\n/).filter(line => line.length > 0);
  const selectedLines = pruneRolloutLines(lines, pruneAtTurn)
    .map(line => line.replaceAll(oldAcpId, newAcpId));

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(newJsonl, `${selectedLines.join('\n')}\n`, 'utf8');

  const oldJson = oldJsonl.replace(/\.jsonl$/i, '.json');
  if (fs.existsSync(oldJson)) {
    const newJson = newJsonl.replace(/\.jsonl$/i, '.json');
    const content = fs.readFileSync(oldJson, 'utf8').replaceAll(oldAcpId, newAcpId);
    fs.writeFileSync(newJson, content, 'utf8');
  }

  const oldTasksDir = path.join(sessionDir, oldAcpId);
  const newTasksDir = path.join(sessionDir, newAcpId);
  if (fs.existsSync(oldTasksDir)) {
    fs.cpSync(oldTasksDir, newTasksDir, { recursive: true });
  }
}

export function deleteSessionFiles(acpId) {
  const paths = getSessionPaths(acpId);
  if (paths.jsonl && fs.existsSync(paths.jsonl)) fs.unlinkSync(paths.jsonl);
  if (paths.json && fs.existsSync(paths.json)) fs.unlinkSync(paths.json);
  if (paths.tasksDir && fs.existsSync(paths.tasksDir)) fs.rmSync(paths.tasksDir, { recursive: true, force: true });
}

export function archiveSessionFiles(acpId, archiveDir) {
  const paths = getSessionPaths(acpId);
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const meta = {
    sessionDir: paths.jsonl ? path.dirname(paths.jsonl) : configPaths().sessions,
    jsonlFile: paths.jsonl ? path.basename(paths.jsonl) : null,
    jsonFile: paths.json && fs.existsSync(paths.json) ? path.basename(paths.json) : null,
    tasksDirName: acpId
  };

  fs.writeFileSync(path.join(archiveDir, 'restore_meta.json'), JSON.stringify(meta, null, 2), 'utf8');

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
}

export function restoreSessionFiles(savedAcpId, archiveDir) {
  const { sessions } = configPaths();
  let meta = {};
  const metaPath = path.join(archiveDir, 'restore_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      meta = {};
    }
  }

  const targetDir = meta.sessionDir || sessions;
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const entries = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
  const jsonlFile = meta.jsonlFile || entries.find(file => file.endsWith('.jsonl'));
  const jsonFile = meta.jsonFile || entries.find(file => file.endsWith('.json'));

  if (jsonlFile && fs.existsSync(path.join(archiveDir, jsonlFile))) {
    fs.copyFileSync(path.join(archiveDir, jsonlFile), path.join(targetDir, jsonlFile));
  }
  if (jsonFile && fs.existsSync(path.join(archiveDir, jsonFile))) {
    fs.copyFileSync(path.join(archiveDir, jsonFile), path.join(targetDir, jsonFile));
  }

  const tasksSrc = path.join(archiveDir, 'tasks');
  if (fs.existsSync(tasksSrc)) {
    fs.cpSync(tasksSrc, path.join(targetDir, meta.tasksDirName || savedAcpId), { recursive: true });
  }
}

function newAssistantMessage(id) {
  return { role: 'assistant', content: '', id: id || `${Date.now()}`, isStreaming: false, timeline: [] };
}

function addAssistantText(state, text, id) {
  if (!text || !text.trim()) return;
  if (!state.currentAssistant) state.currentAssistant = newAssistantMessage(id);
  if (state.currentAssistant.content) state.currentAssistant.content += '\n\n';
  state.currentAssistant.content += text.trim();
}

function addThought(state, text) {
  if (!text || !text.trim()) return;
  if (!state.currentAssistant) state.currentAssistant = newAssistantMessage();
  state.currentAssistant.timeline.push({ type: 'thought', content: text.trim() });
}

function flushAssistant(state) {
  if (!state.currentAssistant) return;
  if (state.currentAssistant.content || state.currentAssistant.timeline.length > 0) {
    state.messages.push(state.currentAssistant);
  }
  state.currentAssistant = null;
}

function addUserMessage(state, text, id) {
  if (!text || !text.trim()) return;
  const trimmed = text.trim();
  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'user' && last.content === trimmed) return;
  flushAssistant(state);
  state.messages.push({ role: 'user', content: trimmed, id: id || `${Date.now()}` });
}

function addTool(state, toolEvent) {
  if (!toolEvent?.id) return;
  const existing = state.tools.get(toolEvent.id);
  if (existing) {
    Object.assign(existing, toolEvent);
    return;
  }
  if (!state.currentAssistant) state.currentAssistant = newAssistantMessage();
  state.currentAssistant.timeline.push({
    type: 'tool',
    isCollapsed: true,
    event: toolEvent
  });
  state.tools.set(toolEvent.id, toolEvent);
}

function updateTool(state, id, fields) {
  const existing = state.tools.get(id);
  if (existing) {
    Object.assign(existing, fields);
    return;
  }
  addTool(state, {
    id,
    title: fields.title || 'Tool',
    status: fields.status || 'completed',
    output: fields.output || null,
    filePath: fields.filePath
  });
}

function payloadId(payload) {
  return payload?.call_id || payload?.callId || payload?.id || payload?.tool_call_id || payload?.toolCallId || `${Date.now()}`;
}

function toolEventFromPayload(payload, title, status = 'pending_result', output = null) {
  const update = {
    toolCallId: payloadId(payload),
    title,
    kind: payload?.kind,
    rawInput: payload,
    content: payload?.content,
    rawOutput: payload
  };
  return normalizeTool({
    id: payloadId(payload),
    title,
    status,
    output,
    filePath: extractFilePath(update, p => p)
  }, update);
}

function normalizeMessagePhase(phase) {
  return typeof phase === 'string' ? phase.trim().toLowerCase() : '';
}

function parseCallArguments(argumentsValue) {
  const parsed = parseMaybeJson(argumentsValue);
  return isObject(parsed) ? parsed : {};
}

function extractReasoningSummary(summary) {
  if (typeof summary === 'string') return summary.trim();
  if (!Array.isArray(summary)) return '';

  const parts = [];
  for (const item of summary) {
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item.trim());
      continue;
    }
    if (!isObject(item)) continue;

    const text = item.text || item.summary || item.message || extractText(item.content);
    if (typeof text === 'string' && text.trim()) {
      parts.push(text.trim());
    }
  }
  return parts.join('\n').trim();
}

function resultTextFromCallOutput(outputValue, Diff) {
  const parsed = parseMaybeJson(outputValue);
  if (isObject(parsed)) {
    const wrappedOutput = parsed.output;
    if (wrappedOutput !== undefined) {
      const nested = parseMaybeJson(wrappedOutput);
      if (isObject(nested)) {
        const diff = diffFromChanges(nested.changes || nested.file_changes || nested.fileChanges, Diff);
        return diff || resultText(nested);
      }
      return resultText(wrappedOutput);
    }

    const diff = diffFromChanges(parsed.changes || parsed.file_changes || parsed.fileChanges, Diff);
    return diff || resultText(parsed);
  }

  return resultText(parsed);
}

function buildToolPayloadFromFunctionCall(payload) {
  const args = parseCallArguments(payload.arguments);
  return {
    ...payload,
    arguments: args,
    invocation: {
      server: payload.server,
      tool: payload.name,
      arguments: args
    }
  };
}

function buildToolPayloadFromCustomToolCall(payload) {
  return {
    ...payload,
    invocation: {
      server: payload.server,
      tool: payload.name,
      arguments: payload.input
    },
    arguments: payload.input
  };
}

function resetFromCompactedRecord(record, state) {
  const replacementHistory = record?.payload?.replacement_history;
  if (!Array.isArray(replacementHistory)) return;

  state.messages = [];
  state.currentAssistant = null;
  state.tools.clear();

  for (let index = 0; index < replacementHistory.length; index++) {
    const item = replacementHistory[index];
    if (!isObject(item) || item.type !== 'message' || item.role !== 'user') continue;
    const text = extractText(item.content || item.text || item.message);
    addUserMessage(state, text, `${record.timestamp || Date.now()}-compact-${index}`);
  }
}

function handleEventMsg(record, state, Diff) {
  const payload = record.payload || {};
  const type = payload.type;

  if (type === 'user_message') {
    addUserMessage(state, payload.message || payload.text || '', record.timestamp);
  } else if (type === 'agent_message') {
    const phase = normalizeMessagePhase(payload.phase);
    const message = payload.message || payload.text || '';
    if (phase === 'commentary') {
      addThought(state, message);
    } else {
      addAssistantText(state, message, record.timestamp);
    }
  } else if (type === 'agent_reasoning' || type === 'agent_reasoning_raw_content') {
    addThought(state, payload.text || payload.message || payload.reasoning || '');
  } else if (type === 'exec_command_begin') {
    addTool(state, toolEventFromPayload(payload, 'Run command'));
  } else if (type === 'exec_command_end') {
    const status = payload.exit_code === 0 || payload.exitCode === 0 || payload.status === 'completed' ? 'completed' : 'failed';
    updateTool(state, payloadId(payload), {
      status,
      output: resultText(payload),
      filePath: findPathInRaw(payload),
      endTime: Date.now()
    });
  } else if (type === 'mcp_tool_call_begin') {
    const invocation = payload.invocation || {};
    addTool(state, toolEventFromPayload(payload, `Tool: ${invocation.server || ''}/${invocation.tool || 'tool'}`));
  } else if (type === 'mcp_tool_call_end') {
    updateTool(state, payloadId(payload), { status: payload.error ? 'failed' : 'completed', output: resultText(payload), endTime: Date.now() });
  } else if (type === 'web_search_begin') {
    addTool(state, toolEventFromPayload(payload, 'Web search'));
  } else if (type === 'web_search_end') {
    updateTool(state, payloadId(payload), { status: payload.error ? 'failed' : 'completed', output: resultText(payload), endTime: Date.now() });
  } else if (type === 'patch_apply_begin') {
    addTool(state, toolEventFromPayload(payload, 'Edit file'));
  } else if (type === 'patch_apply_end' || type === 'patch_apply_updated') {
    updateTool(state, payloadId(payload), {
      status: payload.success === false || payload.error ? 'failed' : 'completed',
      output: diffFromChanges(payload.changes || payload.file_changes || payload.fileChanges, Diff) || resultText(payload),
      filePath: findPathInRaw(payload),
      endTime: Date.now()
    });
  } else if (type === 'error') {
    const message = payload.message || payload.error || '';
    addAssistantText(state, message, record.timestamp);
  }
}

function handleResponseItem(record, state, Diff, allowUserFallback, allowAssistantFallback) {
  const payload = record.payload || {};
  const payloadType = payload.type;

  if (payloadType === 'message') {
    const text = extractText(payload.content);
    if (payload.role === 'user') {
      if (allowUserFallback) {
        addUserMessage(state, text, payload.id || record.timestamp);
      }
    } else if (payload.role === 'assistant') {
      if (allowAssistantFallback) {
        const phase = normalizeMessagePhase(payload.phase);
        if (phase === 'commentary') {
          addThought(state, text);
        } else {
          addAssistantText(state, text, payload.id || record.timestamp);
        }
      }
    }
    return;
  }

  if (payloadType === 'reasoning') {
    const summaryText = extractReasoningSummary(payload.summary);
    if (summaryText) addThought(state, summaryText);
    return;
  }

  if (payloadType === 'function_call') {
    const callPayload = buildToolPayloadFromFunctionCall(payload);
    addTool(state, toolEventFromPayload(callPayload, payload.name || 'Tool'));
    return;
  }

  if (payloadType === 'function_call_output') {
    const callId = payload.call_id || payload.callId || payloadId(payload);
    const output = resultTextFromCallOutput(payload.output, Diff);
    updateTool(state, callId, {
      status: 'completed',
      output,
      endTime: Date.now()
    });
    return;
  }

  if (payloadType === 'custom_tool_call') {
    const callPayload = buildToolPayloadFromCustomToolCall(payload);
    const status = payload.status === 'failed' ? 'failed' : 'pending_result';
    addTool(state, toolEventFromPayload(callPayload, payload.name || 'Tool', status));
    return;
  }

  if (payloadType === 'custom_tool_call_output') {
    const callId = payload.call_id || payload.callId || payloadId(payload);
    const output = resultTextFromCallOutput(payload.output, Diff);
    updateTool(state, callId, {
      status: 'completed',
      output,
      endTime: Date.now()
    });
  }
}

export async function parseSessionHistory(filePath, Diff) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const state = { messages: [], currentAssistant: null, tools: new Map() };
    const records = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);

    const hasEventUserMessages = records.some(record =>
      record.type === 'event_msg' && record.payload?.type === 'user_message'
    );
    const hasEventAgentMessages = records.some(record =>
      record.type === 'event_msg' && record.payload?.type === 'agent_message'
    );

    for (const record of records) {
      if (record.type === 'compacted') {
        resetFromCompactedRecord(record, state);
        continue;
      }

      if (record.type === 'event_msg') {
        handleEventMsg(record, state, Diff);
        continue;
      }

      if (record.type === 'response_item') {
        handleResponseItem(record, state, Diff, !hasEventUserMessages, !hasEventAgentMessages);
      }
    }

    flushAssistant(state);
    return state.messages;
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

export async function setInitialAgent(_acpClient, _sessionId, _agent) {
  return;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function getMcpServerMeta() {
  const { config } = getProvider();
  if (config.acpSupportsMcpTimeouts !== true) return undefined;

  const startupTimeoutSec = parsePositiveInteger(config.acpMcpStartupTimeoutSec);
  const toolTimeoutSec = parsePositiveInteger(config.acpMcpToolTimeoutSec);
  if (startupTimeoutSec === undefined && toolTimeoutSec === undefined) return undefined;

  const timeoutOverrides = {
    ...(startupTimeoutSec !== undefined ? { startup_timeout_sec: startupTimeoutSec } : {}),
    ...(toolTimeoutSec !== undefined ? { tool_timeout_sec: toolTimeoutSec } : {})
  };

  return {
    codex_acp: { ...timeoutOverrides }
  };
}

export function buildSessionParams(_agent) {
  return undefined;
}

export function getSessionDir() {
  return configPaths().sessions;
}

export function getAttachmentsDir() {
  return configPaths().attachments;
}

export function getAgentsDir() {
  return configPaths().agents;
}

export async function getHooksForAgent(_agentName, _hookType) {
  return [];
}
