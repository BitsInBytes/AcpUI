import fs from 'fs';
import path from 'path';
import { getProvider } from '../../backend/services/providerLoader.js';

/**
 * Low-level filter for the raw JSON-RPC stream from stdout.
 */
export function intercept(payload) {
  return payload;
}

/**
 * Standardize the update object format before it reaches generic logic.
 */
export function normalizeUpdate(update) {
  return update;
}

/**
 * Finds Gemini session files by searching the temp directories.
 * gemini-cli stores sessions in ~/.gemini/tmp/{project}/chats/session-{timestamp}-{shortId}.jsonl
 */
export function getSessionPaths(acpId) {
  const { config } = getProvider();
  const tmpBase = config.paths.sessions;
  
  if (!fs.existsSync(tmpBase)) return { jsonl: '', json: '', tasksDir: '' };

  // Ensure we use the short version of the ID if a full UUID was passed
  const shortId = acpId.includes('-') ? acpId.split('-')[0] : acpId;
  
  try {
    const projectDirs = fs.readdirSync(tmpBase, { withFileTypes: true })
                          .filter(dirent => dirent.isDirectory())
                          .map(dirent => dirent.name);
    
    for (const proj of projectDirs) {
       const chatsDir = path.join(tmpBase, proj, 'chats');
       if (fs.existsSync(chatsDir)) {
          const files = fs.readdirSync(chatsDir);
          
          // Search for files containing the shortId
          const targets = files.filter(f => f.includes(shortId));
          
          const jsonlFile = targets.find(f => f.endsWith('.jsonl'));
          const jsonFile = targets.find(f => f.endsWith('.json'));
          
          if (jsonlFile || jsonFile) {
            return {
              jsonl: jsonlFile ? path.join(chatsDir, jsonlFile) : '',
              json: jsonFile ? path.join(chatsDir, jsonFile) : '',
              tasksDir: path.join(tmpBase, proj, shortId)
            };
          }
       }
    }
  } catch (err) {
    console.error(`[GEMINI PROVIDER] Error finding session files: ${err.message}`);
  }

  // Fallback to standard location if not found in temp
  return {
    jsonl: path.join(tmpBase, `${shortId}.jsonl`),
    json: path.join(tmpBase, `${shortId}.json`),
    tasksDir: path.join(tmpBase, shortId),
  };
}

/**
 * Extract tool output from a Gemini tool_call_update.
 * Gemini usually follows standard ACP content[] but can send legacy result objects.
 */
export function extractToolOutput(update) {
  if (update.content && Array.isArray(update.content)) {
    const result = update.content
      .filter(c => c.type === 'content' && c.content?.type === 'text')
      .map(c => c.content.text)
      .join('\n');
    return result || undefined;
  }
  
  // Legacy fallback for Gemini CLI results (supports both full update and direct result object)
  const legacyResult = update.result || update;
  if (legacyResult.Success?.items) {
    const parts = legacyResult.Success.items.map(i => {
      if (i.Text) return i.Text;
      if (i.Json?.content) return i.Json.content.map(c => c.text || '').join('');
      if (i.Json) return JSON.stringify(i.Json);
      return '';
    }).filter(Boolean);
    return parts.join('\n') || undefined;
  }
  
  if (legacyResult.Error) {
    return `Error: ${legacyResult.Error.message}`;
  }
  
  return undefined;
}

/**
 * Extract file path from a Gemini tool update.
 */
export function extractFilePath(update, resolvePath) {
  const title = (update.title || '').toLowerCase();
  if (title.startsWith('listing') || title.startsWith('running:')) return undefined;

  // 1. Check locations (standard ACP)
  if (update.locations?.length > 0 && update.locations[0].path) {
    return resolvePath(update.locations[0].path);
  }

  // 2. Check standard tool arguments
  const args = update.arguments || update.params || update.rawInput;
  if (args) {
    const p = args.path || args.file_path || args.filePath;
    if (p) return resolvePath(p);
  }

  return undefined;
}

/**
 * Extract diff content from a Gemini tool_call.
 */
export function extractDiffFromToolCall(update, Diff) {
  if (update.content && Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item.type === 'diff') {
        return Diff.createPatch(update.toolCallId || 'file', item.oldText || '', item.newText || '', 'old', 'new');
      }
    }
  }
  return undefined;
}

/**
 * Perform Gemini-specific handshake steps.
 * The Gemini daemon holds the initialize response until after authenticate is received,
 * so both must be in-flight simultaneously via Promise.all.
 */
export async function performHandshake(acpClient) {
  const { config } = getProvider();

  const initPromise = acpClient.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: config.clientInfo || { name: 'AcpUI', version: '1.0.0' }
  });

  const authMethodId = process.env.GEMINI_CLI_SERVICES_API_KEY ? 'gemini-api-key' : 'oauth-personal';
  const authParams = process.env.GEMINI_CLI_SERVICES_API_KEY
    ? { methodId: authMethodId, _meta: { 'api-key': process.env.GEMINI_CLI_SERVICES_API_KEY } }
    : { methodId: authMethodId };

  const authPromise = acpClient.sendRequest('authenticate', authParams);
  await Promise.all([initPromise, authPromise]);
}

/**
 * Clone a Gemini ACP session's files with a new ID.
 */
export function cloneSession(oldAcpId, newAcpId, pruneAtTurn) {
  const oldPaths = getSessionPaths(oldAcpId);

  if (!oldPaths.jsonl && !oldPaths.json) return;

  // Destination dir (we'll put clones in the same folder as the original)
  const destDir = oldPaths.jsonl ? path.dirname(oldPaths.jsonl) : path.dirname(oldPaths.json);

  // Gemini CLI expects files to start with "session-" to be discoverable.
  // We use the full newAcpId in the filename to ensure exact matching during session/load.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const newBaseName = `session-${ts}-${newAcpId}`;

  // Clone JSONL (optionally pruned)
  if (oldPaths.jsonl && fs.existsSync(oldPaths.jsonl)) {
    const lines = fs.readFileSync(oldPaths.jsonl, 'utf-8').split('\n').filter(l => l.trim());
    if (pruneAtTurn != null) {
      let userTurnCount = 0;
      let pruneAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.kind === 'Prompt') userTurnCount++;
          if (userTurnCount > pruneAtTurn) { pruneAt = i; break; }
        } catch { /* skip */ }
      }
      fs.writeFileSync(path.join(destDir, `${newBaseName}.jsonl`), lines.slice(0, pruneAt).join('\n') + '\n', 'utf-8');
    } else {
      fs.copyFileSync(oldPaths.jsonl, path.join(destDir, `${newBaseName}.jsonl`));
    }
  }

  // Clone JSON with ID replacement
  if (oldPaths.json && fs.existsSync(oldPaths.json)) {
    let json = fs.readFileSync(oldPaths.json, 'utf-8');
    json = json.replaceAll(oldAcpId, newAcpId);
    fs.writeFileSync(path.join(destDir, `${newBaseName}.json`), json, 'utf-8');
  }

  // Clone tasks folder
  if (oldPaths.tasksDir && fs.existsSync(oldPaths.tasksDir)) {
    const newTasksDir = path.join(path.dirname(oldPaths.tasksDir), newAcpId);
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
  const sessionsRoot = config.paths.sessions;
  
  const jsonlSrcFile = fs.readdirSync(archiveDir).find(f => f.endsWith('.jsonl'));
  const jsonSrcFile = fs.readdirSync(archiveDir).find(f => f.endsWith('.json'));

  if (jsonlSrcFile) {
    fs.copyFileSync(path.join(archiveDir, jsonlSrcFile), path.join(sessionsRoot, jsonlSrcFile));
  }
  if (jsonSrcFile) {
    fs.copyFileSync(path.join(archiveDir, jsonSrcFile), path.join(sessionsRoot, jsonSrcFile));
  }
  const tasksSrc = path.join(archiveDir, 'tasks');
  if (fs.existsSync(tasksSrc)) {
    fs.cpSync(tasksSrc, path.join(sessionsRoot, savedAcpId), { recursive: true });
  }
}

/**
 * Normalize a tool call event.
 */
export function normalizeTool(event, update) {
  let toolName = update?.name || event.id || '';
  
  if (toolName.startsWith('call_') || toolName.startsWith('toolu_')) {
    const titleLower = (event.title || '').toLowerCase();
    if (titleLower.includes('directory')) toolName = 'list_directory';
    else if (titleLower.includes('read')) toolName = 'read_file';
    else if (titleLower.includes('write')) toolName = 'write_file';
    else if (titleLower.includes('replace')) toolName = 'replace';
    else if (titleLower.includes('edit')) toolName = 'edit';
  }
  
  return { ...event, toolName };
}

/**
 * Categorize a Gemini tool using configuration metadata.
 */
export function categorizeToolCall(event) {
  const { config } = getProvider();
  const toolName = event.toolName;
  if (!toolName) return null;

  const metadata = (config.toolCategories || {})[toolName];
  if (!metadata) return null;

  return {
    toolCategory: metadata.category,
    isFileOperation: metadata.isFileOperation || false
  };
}

/**
 * Parse a Gemini extension event into a standardized format.
 */
export function parseExtension(method, params) {
  const { config } = getProvider();
  if (!method.startsWith(config.protocolPrefix)) return null;

  const type = method.slice(config.protocolPrefix.length);

  switch (type) {
    case 'metadata':
      return { type: 'metadata', sessionId: params.sessionId, contextUsagePercentage: params.contextUsagePercentage };
    default:
      return { type: 'unknown', method, params };
  }
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

const GEMINI_HOOK_MAP = {
  session_start: 'SessionStart',
  pre_tool: 'PreToolUse',
  post_tool: 'PostToolUse',
  stop: 'Stop',
};

export async function getHooksForAgent(_agentName, hookType) {
  const nativeKey = GEMINI_HOOK_MAP[hookType];
  if (!nativeKey) return [];
  const { config } = getProvider();
  const settingsPath = path.join(path.dirname(config.paths.agents), 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const entries = settings?.hooks?.[nativeKey] ?? [];
    return entries.flatMap(entry =>
      (entry.hooks ?? []).map(h => ({ command: h.command, ...(entry.matcher ? { matcher: entry.matcher } : {}) }))
    ).filter(e => e?.command);
  } catch {
    return [];
  }
}

export async function setInitialAgent(acpClient, sessionId, agent) {
  return;
}

export async function setConfigOption(acpClient, sessionId, optionId, value) {
  if (optionId === 'model') {
    return acpClient.sendRequest('session/set_model', {
      sessionId,
      modelId: value
    });
  }

  if (optionId === 'mode') {
    return acpClient.sendRequest('session/set_mode', {
      sessionId,
      modeId: value
    });
  }

  // Gemini ACP does not implement session/set_config_option.
  return null;
}

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
        // If no current assistant turn, start one; otherwise append to it
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

            // For write/edit tools, generate a diff as fallback output
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
        // Attach results to pending tool calls on current assistant
        if (currentAssistant && data.results) {
          for (const [toolUseId, resultData] of Object.entries(data.results)) {
            const toolStep = currentAssistant.timeline.find(
              t => t.type === 'tool' && t.event.id === toolUseId
            );
            if (toolStep) {
              toolStep.event.status = 'completed';
              
              // Use provider-specific extractor
              let toolOutput = extractToolOutput(resultData);

              // Generic Diff Fallback: Use the fallback generated during tool_start if provider output is empty
              if (toolOutput === undefined) {
                toolOutput = toolStep.event._fallbackOutput || undefined;
              }

              toolStep.event.output = toolOutput;
            }
          }
        }
      }
    }

    // Flush final assistant message
    if (currentAssistant) {
      messages.push(currentAssistant);
    }

    // Apply fallback outputs for tools that had no result
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
