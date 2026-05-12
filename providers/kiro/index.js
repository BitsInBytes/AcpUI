/**
 * Kiro ACP Provider
 * 
 * Implements the provider interface for Kiro CLI's ACP protocol.
 * Handles Kiro-specific data format quirks, extension protocol, and session file operations.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProvider } from '../../backend/services/providerLoader.js';
import { acpUiToolTitle } from '../../backend/services/tools/acpUiToolTitles.js';
import {
  inputFromToolUpdate,
  prettyToolTitle,
  resolvePatternToolName
} from '../../backend/services/tools/providerToolNormalization.js';
import { matchToolIdPattern, replaceToolIdPattern } from '../../backend/services/tools/toolIdPattern.js';

// Cache for context usage percentage
let _emitProviderExtension = null;
let _writeLog = null;
let _sessionContextCache = new Map(); // sessionId -> contextUsagePercentage
let _contextStateFile = null; // Path to persist context state
let _sessionsWithInitialEmit = new Set(); // Track which sessions we've already emitted initial context for

function _emitCachedContext(sessionId, config) {
  if (!sessionId || _sessionsWithInitialEmit.has(sessionId)) return false;
  _sessionsWithInitialEmit.add(sessionId);
  const persistedPercent = _sessionContextCache.get(sessionId);
  if (persistedPercent !== undefined && _emitProviderExtension) {
    _emitProviderExtension(`${config.protocolPrefix || '_kiro.dev/'}metadata`, {
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
    _writeLog?.(`[KIRO CONTEXT STATE] Failed to load: ${err.message}`);
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
    _writeLog?.(`[KIRO CONTEXT STATE] Failed to save: ${err.message}`);
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

/**
 * Low-level filter for the raw JSON-RPC stream from stdout.
 */
export function intercept(payload) {
  const { config } = getProvider();
  const sessionId = payload?.params?.sessionId || payload?.result?.sessionId;

  if (sessionId) {
    _emitCachedContext(sessionId, config);
  }

  // Handle Kiro's metadata extension to cache context usage
  if (
    payload.method === `${config.protocolPrefix || '_kiro.dev/'}metadata` &&
    payload.params?.sessionId &&
    typeof payload.params?.contextUsagePercentage === 'number'
  ) {
    _sessionContextCache.set(payload.params.sessionId, payload.params.contextUsagePercentage);
    _saveContextState();
  }

  // Kiro reports the active model on agent switch notifications. Normalize that
  // provider-specific field into AcpUI's dynamic model contract so the backend
  // can persist and broadcast the actual current model.
  if (
    payload.method === `${config.protocolPrefix}agent/switched` &&
    typeof payload.params?.model === 'string' &&
    !payload.params.currentModelId
  ) {
    return {
      ...payload,
      params: {
        ...payload.params,
        currentModelId: payload.params.model
      }
    };
  }

  return payload;
}

export function emitCachedContext(sessionId) {
  const { config } = getProvider();
  return _emitCachedContext(sessionId, config);
}

export function normalizeModelState(modelState) {
  return modelState;
}

// --- Data Normalization ---

/** Convert PascalCase to snake_case (e.g. AgentMessageChunk → agent_message_chunk) */
function toSnakeCase(str) {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

/**
 * Normalize a Kiro update to standard ACP format.
 * Kiro sends PascalCase types and flat string content.
 */
export function normalizeUpdate(update) {
  // Normalize PascalCase types
  if (!update.sessionUpdate && update.type) {
    update.sessionUpdate = toSnakeCase(update.type);
  }

  // Normalize flat string content to { text } format
  if (typeof update.content === 'string') {
    return { ...update, _originalContent: update.content, content: { text: update.content } };
  }

  return update;
}

export function normalizeConfigOptions(options) {
  return Array.isArray(options) ? options : [];
}

/**
 * Extract tool output from a Kiro tool_call_update.
 * Kiro uses rawOutput.items[].Text/Json instead of standard content[].
 */
export function extractToolOutput(update) {
  if (update.rawOutput?.items) {
    const parts = update.rawOutput.items.map(item => {
      if (item.Text) return item.Text;
      if (item.Json?.content) {
        return item.Json.content.map(c => c.text || '').join('');
      }
      if (item.Json) return JSON.stringify(item.Json, null, 2);
      return '';
    }).filter(Boolean);
    const joined = parts.join('\n');
    // Skip plain success messages so diffs from tool_start are preserved
    if (joined && !/^Successfully (created|replaced|inserted)\b/i.test(joined)) {
      return joined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Extract file path from a Kiro tool update.
 * Kiro sends file paths in locations[], content[].path, or rawInput.
 */
export function extractFilePath(update, resolvePath) {
  const kind = update.kind || '';
  const title = (update.title || '').toLowerCase();

  // Noise filtering: skip generic commands
  if (title.startsWith('listing') || title.startsWith('running:')) return undefined;

  if (!['edit', 'read'].includes(kind)) {
    const id = (update.toolCallId || '').toLowerCase();
    if (!['write_file', 'replace', 'read_file', 'read_file_parallel'].some(t => id.includes(t))) {
      return undefined;
    }
  }

  // 1. Check locations (Kiro sends these for file tools)
  if (update.locations?.length > 0 && update.locations[0].path) {
    return resolvePath(update.locations[0].path);
  }

  // 2. Check content for diff paths
  if (update.content && Array.isArray(update.content) && update.content.length > 0 && update.content[0].path) {
    return resolvePath(update.content[0].path);
  }

  // 3. Check standard tool arguments
  const args = update.arguments || update.params || update.rawInput;
  if (args) {
    const p = args.path || args.file_path || args.filePath;
    if (p) return resolvePath(p);
  }

  return undefined;
}

/**
 * Extract diff content from a Kiro tool_call.
 * Kiro sends diffs in content[] and rawInput.
 */
export function extractDiffFromToolCall(update, Diff) {
  let toolOutput = undefined;

  if (update.content && Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item.type === 'diff') {
        const oldText = item.oldText || '';
        const newText = item.newText || '';
        if (oldText === newText) continue;
        if (!oldText && newText) toolOutput = Diff.createPatch(item.path || 'file', '', newText, 'old', 'new');
        else if (oldText && newText) toolOutput = Diff.createPatch(item.path || 'file', oldText, newText, 'old', 'new');
      }
    }
  }

  if (!toolOutput && update.rawInput) {
    const cmd = update.rawInput.command;
    const content = update.rawInput.content;
    if (content && (cmd === 'create' || cmd === 'insert')) {
      toolOutput = Diff.createPatch(update.rawInput.path || 'file', '', content, 'old', 'new');
    } else if (cmd === 'strReplace' && update.rawInput.newStr) {
      toolOutput = Diff.createPatch(update.rawInput.path || 'file', update.rawInput.oldStr || '', update.rawInput.newStr, 'old', 'new');
    }
  }

  return toolOutput;
}

// --- Extension Protocol ---

/**
 * Parse a Kiro extension event into a standardized format.
 * Kiro extensions use the _kiro.dev/ prefix.
 */
export function parseExtension(method, params) {
  const { config } = getProvider();
  if (!method.startsWith(config.protocolPrefix)) return null;

  const type = method.slice(config.protocolPrefix.length);

  switch (type) {
    case 'commands/available':
      return { type: 'commands', commands: params.commands };
    case 'metadata':
      return { type: 'metadata', sessionId: params.sessionId, contextUsagePercentage: params.contextUsagePercentage };
    case 'compaction/status':
      return { type: 'compaction', sessionId: params.sessionId, status: params.status, summary: params.summary };
    case 'agent/switched':
      return {
        type: 'agent_switched',
        sessionId: params.sessionId,
        agentName: params.agentName,
        previousAgentName: params.previousAgentName,
        welcomeMessage: params.welcomeMessage,
        currentModelId: params.currentModelId || params.model || null
      };
    case 'session/update':
      return { type: 'session_update', ...params };
    default:
      return { type: 'unknown', method, params };
  }
}

// --- Session File Operations ---

/**
 * Get paths to session files for a given ACP session ID.
 */
export function getSessionPaths(acpId) {
  const { config } = getProvider();
  const dir = config.paths.sessions;
  return {
    jsonl: path.join(dir, `${acpId}.jsonl`),
    json: path.join(dir, `${acpId}.json`),
    tasksDir: path.join(dir, acpId),
  };
}

/**
 * Clone a Kiro ACP session's files with a new ID, optionally pruning the JSONL.
 */
export function cloneSession(oldAcpId, newAcpId, pruneAtTurn) {
  const oldPaths = getSessionPaths(oldAcpId);
  const newPaths = getSessionPaths(newAcpId);

  // Clone JSONL (optionally pruned)
  if (fs.existsSync(oldPaths.jsonl)) {
    const lines = fs.readFileSync(oldPaths.jsonl, 'utf-8').split('\n').filter(l => l.trim());
    if (pruneAtTurn != null) {
      let userTurnCount = 0;
      let pruneAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          // Kiro uses 'Prompt' for user turns
          if (entry.kind === 'Prompt') userTurnCount++;
          if (userTurnCount > pruneAtTurn) { pruneAt = i; break; }
        } catch { /* skip */ }
      }
      fs.writeFileSync(newPaths.jsonl, lines.slice(0, pruneAt).join('\n') + '\n', 'utf-8');
    } else {
      fs.copyFileSync(oldPaths.jsonl, newPaths.jsonl);
    }
  }

  // Clone JSON with ID replacement
  if (fs.existsSync(oldPaths.json)) {
    let json = fs.readFileSync(oldPaths.json, 'utf-8');
    json = json.replaceAll(oldAcpId, newAcpId);
    fs.writeFileSync(newPaths.json, json, 'utf-8');
  }

  // Clone tasks folder
  if (fs.existsSync(oldPaths.tasksDir)) {
    fs.cpSync(oldPaths.tasksDir, newPaths.tasksDir, { recursive: true });
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
  if (paths.jsonl && fs.existsSync(paths.jsonl)) {
    fs.copyFileSync(paths.jsonl, path.join(archiveDir, `${acpId}.jsonl`));
    fs.unlinkSync(paths.jsonl);
  }
  if (paths.json && fs.existsSync(paths.json)) {
    fs.copyFileSync(paths.json, path.join(archiveDir, `${acpId}.json`));
    fs.unlinkSync(paths.json);
  }
  if (paths.tasksDir && fs.existsSync(paths.tasksDir)) {
    fs.cpSync(paths.tasksDir, path.join(archiveDir, 'tasks'), { recursive: true });
    fs.rmSync(paths.tasksDir, { recursive: true, force: true });
  }
}

export function restoreSessionFiles(savedAcpId, archiveDir) {
  const { config } = getProvider();
  const sessionsDir = config.paths.sessions;
  const jsonlSrc = path.join(archiveDir, `${savedAcpId}.jsonl`);
  const jsonSrc = path.join(archiveDir, `${savedAcpId}.json`);
  const tasksSrc = path.join(archiveDir, 'tasks');

  if (fs.existsSync(jsonlSrc)) {
    fs.copyFileSync(jsonlSrc, path.join(sessionsDir, `${savedAcpId}.jsonl`));
  }
  if (fs.existsSync(jsonSrc)) {
    fs.copyFileSync(jsonSrc, path.join(sessionsDir, `${savedAcpId}.json`));
  }
  if (fs.existsSync(tasksSrc)) {
    fs.cpSync(tasksSrc, path.join(sessionsDir, savedAcpId), { recursive: true });
  }
}

// --- Path Helpers ---

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

// --- Lifecycle & Hooks ---

const KIRO_HOOK_MAP = {
  session_start: 'agentSpawn',
  pre_tool: 'preToolUse',
  post_tool: 'postToolUse',
  stop: 'stop',
};

export async function prepareAcpEnvironment(env, context = {}) {
  const { config } = getProvider();
  _emitProviderExtension = context.emitProviderExtension || _emitProviderExtension;
  _writeLog = context.writeLog || _writeLog;

  // Initialize context persistence
  const homePath = expandPath(config.paths?.home || path.join(os.homedir(), '.kiro'));
  _contextStateFile = path.join(homePath, 'acp_session_context.json');
  _loadContextState();

  return env;
}

export async function getHooksForAgent(agentName, hookType) {
  const nativeKey = KIRO_HOOK_MAP[hookType];
  if (!nativeKey || !agentName) return [];
  const configPath = path.join(getAgentsDir(), `${agentName}.json`);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const raw = config.hooks?.[nativeKey] ?? [];
    const entries = Array.isArray(raw) ? raw : [raw];
    return entries.map(e => typeof e === 'string' ? { command: e } : e).filter(e => e?.command);
  } catch {
    return [];
  }
}

export async function performHandshake(acpClient) {
  const { config } = getProvider();
  await acpClient.transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: config.clientInfo || { name: 'ACP-UI', version: '1.0.0' }
  });
}

/**
 * Set the initial agent for a new Kiro session.
 * Kiro uses the /agent slash command (sent as a prompt) to switch agents.
 */
export async function setInitialAgent(acpClient, sessionId, agent) {
  if (!agent) return;

  console.log(`[KIRO PROVIDER] Setting initial agent to: ${agent}`);

  const sendWithTimeout = (method, params, timeout = 30000) => {
    return Promise.race([
      acpClient.transport.sendRequest(method, params),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ]);
  };

  acpClient.stream.beginDraining(sessionId);
  await sendWithTimeout('session/prompt', {
    sessionId: sessionId,
    prompt: [{ type: 'text', text: `/agent ${agent}` }]
  });
  await acpClient.stream.waitForDrainToFinish(sessionId, 1000);
  
  console.log(`[KIRO PROVIDER] Agent switch complete.`);
}

export function buildSessionParams(_agent) {
  return undefined;
}

export function getMcpServerMeta() {
  return undefined;
}

export function onPromptStarted(_sessionId) {
  // Kiro has no prompt-scoped provider polling lifecycle to manage.
}

export function onPromptCompleted(_sessionId) {
  // Kiro has no prompt-scoped provider polling lifecycle to manage.
}

export async function setConfigOption(acpClient, sessionId, optionId, value) {
  if (optionId === 'model') {
    return acpClient.transport.sendRequest('session/set_model', {
      sessionId,
      modelId: value
    });
  }

  // Kiro does not advertise dynamic config options, and session/set_mode crashes
  // current kiro-cli versions. Avoid falling through to generic config methods.
  return null;
}

// --- Tool Normalization ---

/**
 * Normalize a tool call event.
 */
export function normalizeTool(event, update) {
  const { config } = getProvider();
  let toolName = update?.name || event.id || '';
  const input = inputFromToolUpdate(update);

  const configuredToolName = resolvePatternToolName(toolName, config);
  if (configuredToolName) toolName = configuredToolName;

  // If toolName is still a generic ID, extract from title.
  if (toolName.startsWith('tooluse_') || toolName.startsWith('call_') || toolName.startsWith('toolu_')) {
    const titleToolName = resolvePatternToolName(event.title || '', config);
    if (titleToolName) toolName = titleToolName;
  }

  // Clean configured MCP tool ids from the display title
  if (event.title) {
    event = { ...event, title: replaceToolIdPattern(event.title, config) };
  }

  // Resolve generic tool IDs to standard names (built-in tools without MCP prefix)
  if (toolName.startsWith('call_') || toolName.startsWith('toolu_') || toolName.startsWith('tooluse_')) {
    const titleLower = (event.title || '').toLowerCase();
    if (titleLower.includes('bash')) toolName = 'bash';
    else if (titleLower.includes('directory')) toolName = 'list_directory';
    else if (titleLower.includes('read_file_parallel')) toolName = 'read_file_parallel';
    else if (titleLower.includes('read')) toolName = 'read_file';
    else if (titleLower.includes('write')) toolName = 'write_file';
    else if (titleLower.includes('replace')) toolName = 'replace';
  }
  
  const normalizedAcpUiTitle = acpUiToolTitle(toolName, input, { filePath: event.filePath });
  if (normalizedAcpUiTitle) {
    event = { ...event, title: normalizedAcpUiTitle };
  } else if (event.title && toolName) {
    // Format title: replace any "Running: <toolName>" prefix with a human-readable label.
    event = { ...event, title: event.title.replace(/Running:\s*\S+/, prettyToolTitle(toolName)) };
  }

  return { ...event, toolName };
}

export function extractToolInvocation(update = {}, context = {}) {
  const event = context.event || {};
  const { config } = getProvider();
  const normalized = normalizeTool({ ...event }, update);
  const input = inputFromToolUpdate(update);
  const rawName = update.name || update.toolName || event.toolName || event.title || event.id || '';
  const title = update.title || event.title || '';
  const mcpMatch = matchToolIdPattern(rawName, config) || matchToolIdPattern(title, config);
  const canonicalName = normalized.toolName || '';

  return {
    toolCallId: update.toolCallId || event.id,
    kind: mcpMatch ? 'mcp' : (canonicalName ? 'provider_builtin' : 'unknown'),
    rawName,
    canonicalName,
    mcpServer: mcpMatch?.mcpName,
    mcpToolName: mcpMatch?.toolName,
    input,
    title: normalized.title || title,
    filePath: normalized.filePath || event.filePath,
    category: categorizeToolCall({ ...normalized, toolName: canonicalName }) || {}
  };
}

/**
 * Categorize a Kiro tool using configuration metadata.
 */
export function categorizeToolCall(event) {
  const { config } = getProvider();
  const toolName = event.toolName;
  if (!toolName) return null;

  const metadata = (config.toolCategories || {})[toolName];
  if (!metadata) return null;

  return {
    toolCategory: metadata.category,
    isFileOperation: metadata.isFileOperation || false,
    isShellCommand: metadata.isShellCommand || false,
    isStreamable: metadata.isStreamable || false
  };
}

/**
 * Parse a Kiro JSONL session file into the Unified Timeline.
 */
export async function parseSessionHistory(filePath, Diff) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => JSON.parse(l));

    const messages = [];
    let currentAssistant = null;

    for (const entry of entries) {
      const { kind, data } = entry;

      if (kind === 'Prompt') {
        // Flush any pending assistant message
        if (currentAssistant) {
          messages.push(currentAssistant);
          currentAssistant = null;
        }

        const textBlocks = (data.content || []).filter(b => b.kind === 'text');
        const text = textBlocks.map(b => b.data).join('\n');
        if (text) {
          messages.push({ role: 'user', content: text, id: data.message_id });
        }
      } else if (kind === 'AssistantMessage') {
        // Start or append to assistant turn
        if (!currentAssistant) {
          currentAssistant = {
            role: 'assistant',
            content: '',
            id: data.message_id,
            isStreaming: false,
            timeline: []
          };
        }

        for (const block of data.content || []) {
          if (block.kind === 'text') {
            if (currentAssistant.content) currentAssistant.content += '\n\n';
            currentAssistant.content += block.data;
          } else if (block.kind === 'toolUse') {
            const tool = block.data;
            const inp = tool.input || {};
            const titleArg = inp.path || inp.filePath || inp.file_path || inp.command || inp.pattern || inp.query || '';
            const title = titleArg ? `Running ${tool.name}: ${titleArg}` : `Running ${tool.name}`;

            // Generate fallback diffs for write/edit tools
            let fallbackOutput = null;
            const isWrite = ['write', 'write_file', 'strReplace', 'str_replace', 'edit'].includes(tool.name);
            if (isWrite && inp.command === 'strReplace' && inp.newStr) {
              fallbackOutput = Diff.createPatch(inp.path || 'file', inp.oldStr || '', inp.newStr, 'old', 'new');
            } else if (isWrite && inp.newStr && inp.oldStr) {
              fallbackOutput = Diff.createPatch(inp.path || 'file', inp.oldStr, inp.newStr, 'old', 'new');
            } else if (isWrite && inp.content) {
              fallbackOutput = Diff.createPatch(inp.path || 'file', '', inp.content, 'old', 'new');
            }

            currentAssistant.timeline.push({
              type: 'tool',
              isCollapsed: true,
              event: {
                id: tool.toolUseId,
                title,
                status: 'pending_result',
                output: null,
                _fallbackOutput: fallbackOutput,
                startTime: Date.now(),
                endTime: Date.now()
              }
            });
          }
        }
      } else if (kind === 'ToolResults') {
        // Attach results to pending tool calls
        if (currentAssistant && data.results) {
          for (const [toolUseId, resultData] of Object.entries(data.results)) {
            const toolStep = currentAssistant.timeline.find(
              t => t.type === 'tool' && t.event.id === toolUseId
            );
            if (toolStep) {
              toolStep.event.status = 'completed';
              let toolOutput = extractToolOutput(resultData);
              if (toolOutput === undefined) {
                toolOutput = toolStep.event._fallbackOutput || undefined;
              }
              toolStep.event.output = toolOutput;
            }
          }
        }
      }
    }

    if (currentAssistant) messages.push(currentAssistant);

    // Final cleanup of fallback meta-data
    for (const msg of messages) {
      for (const step of (msg.timeline || [])) {
        if (step.type === 'tool' && step.event) {
          if (!step.event.output && step.event._fallbackOutput) {
            step.event.output = step.event._fallbackOutput;
          }
          delete step.event._fallbackOutput;
        }
      }
    }

    return messages;
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}
