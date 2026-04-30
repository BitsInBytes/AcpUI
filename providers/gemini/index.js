import fs from 'fs';
import path from 'path';
import { getProvider } from '../../backend/services/providerLoader.js';

/**
 * Intercept raw messages from the Gemini process and translate them into 
 * standardized ACP protocol messages.
 */
export function intercept(payload) {
  // Pass through by default. The Gemini CLI mostly emits standard ACP events.
  return payload;
}

/**
 * Normalize a Gemini update to standard ACP format.
 */
export function normalizeUpdate(update) {
  return update;
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
          // Returning empty string for 'diff' type blocks because the backend
          // will generate the real diff via extractDiffFromToolCall or the standard fallback.
          // This prevents the "--- file +++ file" header from showing up twice in the UI.
          return '';
        }
        return null;
      })
      .filter(c => c !== null);

    if (parts.length > 0) return parts.join('\n');
  }

  // 3. If it's a plain string
  if (typeof raw === 'string') return raw;

  // 4. Check resultDisplay (pre-formatted by some versions of the CLI)
  if (update.resultDisplay && typeof update.resultDisplay === 'string') {
    return update.resultDisplay;
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
    const p = args.path || args.file_path || args.filePath || args.target;
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
  const kind = update.kind || '';

  // 1. Edit with diff blocks (e.g. search-replace) — generate a unified diff
  if (kind === 'edit' && update.content && Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item.type === 'diff') {
        return Diff.createPatch(item.path || update.toolCallId || 'file', item.oldText || '', item.newText || '', 'old', 'new');
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

/**
 * Normalize a tool call event: map ACP ToolKind → toolName and clean up title.
 */
export function normalizeTool(event, update) {
  const { config } = getProvider();
  const clientName = config.clientInfo?.name || 'AcpUI';

  // 1. Identify the tool name. 
  // Priority: 
  //   a) Specific sub-agent overrides
  //   b) Original toolName from event
  //   c) Extracted from Gemini title (human-readable title)
  //   d) Extracted from Gemini toolCallId (technical ID)
  //   e) Mapped from ACP ToolKind (kind)

  let title = (event.title || '').replace(/\r?\n/g, ' ').trim();
  const rawId = event.id || update?.toolCallId || '';
  const kind = update?.kind || '';

  // Strip the MCP server suffix if present (e.g. " (AcpUI MCP Server)")
  const suffixRegex = new RegExp(`\\s*\\(${clientName} MCP Server\\)$`, 'i');
  title = title.replace(suffixRegex, '');

  let toolName = event.toolName || '';

  // Handle MCP tool identifiers in ID or Title
  if (!toolName) {
    if (rawId.includes('ux_invoke_subagents') || title.toLowerCase().includes('invoke sub agents') || title.toLowerCase() === 'ux_invoke_subagents') {
      toolName = 'ux_invoke_subagents';
    } else if (rawId.includes('ux_invoke_counsel') || title.toLowerCase() === 'ux_invoke_counsel') {
      toolName = 'ux_invoke_counsel';
    } else if (rawId.includes('ux_invoke_shell') || title.toLowerCase().startsWith('running:')) {
      toolName = 'ux_invoke_shell';
    }
  }

  // Fallback to ACP Kind mapping if still not identified
  if (!toolName) {
    toolName = KIND_TO_TOOL_NAME[kind] || kind || '';
  }

  // 2. Finalize Title
  // Custom override for UI-owned tools to ensure the frontend trigger matches
  if (toolName === 'ux_invoke_subagents') {
    title = 'Invoke Subagents';
  } else if (toolName === 'ux_invoke_counsel') {
    title = 'Invoke Counsel';
  } else if (toolName === 'ux_invoke_shell') {
    title = 'Invoke Shell';
  }

  // If the title looks like a raw snake_case tool name or is missing, synthesize a pretty one
  if (!title || /^[a-z0-9_]+$/.test(title)) {
    const nameToUse = title || toolName;
    if (nameToUse) {
      title = nameToUse.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    }
  }

  return { ...event, toolName, title };
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
    case 'metadata':
      result = { type: 'metadata', sessionId: params.sessionId, contextUsagePercentage: params.contextUsagePercentage };
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
  // Do NOT inject the API key as GEMINI_API_KEY into the subprocess environment.
  // If the CLI sees that env var at startup it persists it to ~/.gemini/settings.json,
  // permanently overwriting any previously configured auth method (e.g. OAuth).
  // The key is passed exclusively via the ACP authenticate request (see performHandshake).
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
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
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
    return toolCall.resultDisplay;
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
