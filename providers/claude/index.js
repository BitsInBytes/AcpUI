import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProvider } from '../../backend/services/providerLoader.js';
import { getLatestClaudeQuota, startClaudeQuotaProxy } from './quotaProxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Intercept raw messages from the Claude process and translate them into 
 * standardized ACP protocol messages.
 */
export function intercept(payload) {
  // console.log('intercept called', payload);

  // Handle Claude's dynamic config options (Effort, Mode, etc.)
  if (
    payload.method === 'session/update' &&
    payload.params?.update?.sessionUpdate === 'config_option_update' &&
    payload.params?.update?.configOptions
  ) {
    const { config } = getProvider();
    // Filter out 'model' since we have a dedicated UI for it
    const options = payload.params.update.configOptions
      .filter(o => o.id !== 'model')
      .map(o => o.id === 'effort' ? { ...o, kind: 'reasoning_effort' } : o);

    // Claude can emit model-only updates after prompts or session loads. After the
    // dedicated model option is filtered out, that must not clear saved effort data.
    if (options.length === 0) return null;

    return {
      method: `${config.protocolPrefix}config_options`,
      params: {
        sessionId: payload.params.sessionId,
        options,
        replace: true
      }
    };
  }

  // Handle Claude's specific way of announcing available commands.
  // Normalize each command into the shape the generic UI pipeline expects:
  //   - Prepend '/' to the name (Claude Code ACP omits it, e.g. "compact" → "/compact").
  //   - Map input.hint → meta.hint so the dropdown knows which commands need arguments
  //     and won't auto-submit them before the user has typed their input.
  if (
    payload.method === 'session/update' &&
    payload.params?.update?.sessionUpdate === 'available_commands_update' &&
    payload.params?.update?.availableCommands
  ) {
    const { config } = getProvider();
    const commands = payload.params.update.availableCommands.map(cmd => ({
      name: cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`,
      description: cmd.description,
      ...(cmd.input?.hint ? { meta: { hint: cmd.input.hint } } : {}),
    }));
    return {
      id: payload.id,
      method: `${config.protocolPrefix}commands/available`,
      params: { commands }
    };
  }

  // Otherwise, return the original payload unchanged
  return payload;
}

/**
 * Normalize a Claude update to standard ACP format.
 */
export function normalizeUpdate(update) {
  return update;
}

/**
 * Extract tool output from a Claude tool_call_update.
 */
export function extractToolOutput(update) {
  // If the tool is still running (streaming rawInput) and it's a write/edit tool,
  // stream the content being generated into the output so the user can see it in real-time.
  if (update.rawInput && update.sessionUpdate === 'tool_call_update' && update.status !== 'completed') {
    let argsObj = null;
    if (typeof update.rawInput === 'string') {
      try {
        argsObj = JSON.parse(update.rawInput);
      } catch {
        // If it's incomplete JSON, we can't reliably parse the content out yet
      }
    } else {
      argsObj = update.rawInput;
    }

    if (argsObj) {
      if (argsObj.content) return argsObj.content;
      if (argsObj.newStr) return argsObj.newStr;
    }
  }
  
  let outputArray = update.rawOutput || update.content;
  if ((!outputArray || (Array.isArray(outputArray) && outputArray.length === 0)) && update._meta?.claudeCode?.toolResponse) {
    const toolResponse = extractClaudeToolResponse(update._meta.claudeCode.toolResponse);
    if (toolResponse) return toolResponse;
  }

  if (typeof outputArray === 'string') {
    // If there's ALSO a content array (like Read tool), prefer the content array
    // because it often contains better formatted text (like markdown wrappers).
    if (update.content && Array.isArray(update.content) && update.content.length > 0) {
      outputArray = update.content;
    } else {
      const toolName = update._meta?.claudeCode?.toolName?.toLowerCase() || '';
      // If it's a generic success message for write/edit, ignore it so the UI preserves the streaming code block
      if (/successfully/i.test(outputArray) && (toolName === 'write' || toolName === 'edit' || toolName === 'strreplace')) {
        return undefined;
      }
      return outputArray;
    }
  }
  
  if (outputArray && Array.isArray(outputArray)) {
    const result = outputArray
      .filter(c => c.type === 'text' || c.type === 'content')
      .map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'content' && c.content?.type === 'text') return c.content.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return result || undefined;
  }
  return undefined;
}

function extractClaudeToolResponse(toolResponse) {
  if (!toolResponse) return undefined;
  if (typeof toolResponse === 'string') return toolResponse;

  if (Array.isArray(toolResponse)) {
    const result = toolResponse
      .map(item => extractClaudeToolResponse(item))
      .filter(Boolean)
      .join('\n');
    return result || undefined;
  }

  if (typeof toolResponse.text === 'string') return toolResponse.text;
  if (typeof toolResponse.content === 'string') return toolResponse.content;
  if (toolResponse.file?.content) return toolResponse.file.content;
  if (Array.isArray(toolResponse.content)) return extractClaudeToolResponse(toolResponse.content);
  if (toolResponse.content && typeof toolResponse.content === 'object') return extractClaudeToolResponse(toolResponse.content);
  if (Array.isArray(toolResponse.filenames)) return toolResponse.filenames.join('\n') || undefined;

  return undefined;
}

/**
 * Extract file path from a Claude tool update.
 */
export function extractFilePath(update, resolvePath) {
  const title = (update.title || '').toLowerCase();

  // Noise filtering: skip generic commands that don't target a specific file for editing/viewing
  if (title.startsWith('listing') || title.startsWith('running:')) return undefined;

  // 1. Check content array for explicit paths (Standard in latest Claude Code ACP)
  if (update.content && Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item.filePath) return resolvePath(item.filePath);
      if (item.path) return resolvePath(item.path);
    }
  }

  const toolResponseFilePath = update._meta?.claudeCode?.toolResponse?.file?.filePath;
  if (typeof toolResponseFilePath === 'string') return resolvePath(toolResponseFilePath);

  // 2. Check locations array (Standard ACP feature)
  if (update.locations && Array.isArray(update.locations)) {
    for (const loc of update.locations) {
      if (loc.path) return resolvePath(loc.path);
    }
  }

  // 3. Check tool arguments (Common in many tool implementations)
  let args = update.arguments || update.params || update.rawInput;
  if (typeof args === 'string') {
    // Attempt regex extraction from streaming JSON string
    // Handles "path", "file_path", "filePath", "target" keys with various spacing
    const pathMatch = args.match(/"(?:file_)?path|target"\s*:\s*"([^"]*)"/i);
    if (pathMatch && pathMatch[1]) {
      return resolvePath(pathMatch[1]);
    }
  } else if (args) {
    const p = args.path || args.file_path || args.filePath || args.target;
    if (p && typeof p === 'string') return resolvePath(p);
  }

  return undefined;
}

/**
 * Extract diff content from a Claude tool_call.
 */
export function extractDiffFromToolCall(update, Diff) {
  let toolOutput = undefined;

  if (update.content && Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item.type === 'code' || (item.type === 'text' && item.text?.includes('---'))) {
        if (item.text) {
          toolOutput = item.text;
          break;
        }
      }
    }
  }

  return toolOutput;
}

/**
 * Normalize a tool call event: extract toolName from MCP ID and produce a readable title.
 */
export function normalizeTool(event, update) {
  const { config } = getProvider();
  
  let toolName = update?.kind || update?._meta?.claudeCode?.toolName || '';
  
  // The MCP tool name sometimes comes through in the title, not the id
  const targetString = event.title || '';
  const mcpPrefix = `mcp__${config.mcpName}__`;
  
  if (targetString.toLowerCase().startsWith(mcpPrefix.toLowerCase())) {
    toolName = targetString.slice(mcpPrefix.length);
  }

  // Fallback if neither kind nor title had the toolName
  if (!toolName && event.id) {
    if (event.id.includes('read')) toolName = 'read';
    else if (event.id.includes('edit')) toolName = 'edit';
    else if (event.id.includes('write')) toolName = 'write';
    else if (event.id.includes('glob')) toolName = 'glob';
  }
  
  if (toolName === 'read') toolName = 'read_file';
  if (toolName === 'write') toolName = 'write_file';
  if (toolName === 'edit') toolName = 'edit_file';

  let title = event.title || '';
  if (title) {
    title = title.replace(/\r?\n/g, ' ').trim();
  }

  if (toolName) {
    toolName = toolName.toLowerCase();
    
    // If the title is missing or just the MCP prefix name, make it human-readable
    if (!title || targetString.toLowerCase().startsWith(mcpPrefix.toLowerCase())) {
      const UX_TOOL_TITLES = { ux_invoke_shell: 'Invoke Shell', ux_invoke_subagents: 'Invoke Subagents', ux_invoke_counsel: 'Invoke Counsel' };
      title = UX_TOOL_TITLES[toolName] || toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  }

  // Attempt to extract arguments to append to the title for better visibility
  let argsStr = '';
  let argsObj = update?.rawInput || update?.arguments || update?.params;
  if (typeof argsObj === 'string') {
    // Attempt regex extraction from streaming JSON string
    const pathMatch = argsObj.match(/"(?:file_)?path"\s*:\s*"([^"]+)"/);
    if (pathMatch && pathMatch[1]) {
      argsStr = path.basename(pathMatch[1]);
    } else {
      try {
        argsObj = JSON.parse(argsObj);
      } catch {
        argsObj = null;
      }
    }
  }
  
  if (argsObj && typeof argsObj === 'object') {
    if (argsObj.file_path) argsStr = path.basename(argsObj.file_path);
    else if (argsObj.path) argsStr = path.basename(argsObj.path);
    else if (argsObj.pattern) argsStr = argsObj.pattern;
  }

  // Ensure filePath or argsStr is visible in the title
  if (argsStr && title && !title.toLowerCase().includes(argsStr.toLowerCase())) {
    title += `: ${argsStr}`;
  } else if (event.filePath && title && !title.toLowerCase().includes(path.basename(event.filePath).toLowerCase())) {
    title += `: ${path.basename(event.filePath)}`;
  }

  return { ...event, toolName, title };
}

/**
 * Categorize a provider-specific tool.
 */
export function categorizeToolCall(event) {
  // console.log('categorizeToolCall called', event);
  const { config } = getProvider();
  const toolName = event.toolName;
  if (!toolName) return null;

  const metadata = (config.toolCategories || {})[toolName];
  if (!metadata) {
    // console.log('categorizeToolCall: no metadata found', { toolName });
    return null;
  }

  const result = {
    toolCategory: metadata.category,
    isFileOperation: metadata.isFileOperation || false,
  };
  // console.log('categorizeToolCall successful', result);
  return result;
}

// --- Extension Protocol ---

export function parseExtension(method, params) {
  // console.log('parseExtension called', { method, params });
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
    case 'compaction/status':
      result = { type: 'compaction', sessionId: params.sessionId, status: params.status, summary: params.summary };
      break;
    case 'provider/status':
      result = { type: 'provider_status', status: params.status };
      break;
    case 'config_options':
      result = { type: 'config_options', sessionId: params.sessionId, options: params.options };
      break;
    default:
      result = { type: 'unknown', method, params };
  }
  // console.log('parseExtension result', result);
  return result;
}

export async function prepareAcpEnvironment(env, context = {}) {
  if (env.CLAUDE_QUOTA_PROXY === 'false' || env.CLAUDE_QUOTA_PROXY_ENABLED === 'false') {
    return env;
  }

  const { config } = getProvider();
  let proxy;
  try {
    proxy = await startClaudeQuotaProxy({
      env,
      log: context.writeLog || (() => {}),
      onQuota: quotaData => {
        context.emitProviderExtension?.(`${config.protocolPrefix}provider/status`, {
          status: buildClaudeProviderStatus(quotaData)
        });
      }
    });
  } catch (err) {
    context.writeLog?.(`[CLAUDE QUOTA] Proxy startup failed, continuing without quota capture: ${err?.message || String(err)}`);
    return env;
  }

  context.writeLog?.(`[CLAUDE QUOTA] Injecting ANTHROPIC_BASE_URL=${proxy.baseUrl} for Claude ACP`);

  const nextEnv = {
    ...env,
    ANTHROPIC_BASE_URL: proxy.baseUrl
  };
  return nextEnv;
}

export function getQuotaState() {
  return getLatestClaudeQuota();
}

export function buildClaudeProviderStatus(quotaData) {
  const fiveHourItem = buildQuotaItem('five-hour', '5h', quotaData['5h_utilization'], quotaData['5h_status'], quotaData['5h_resets_at']);
  const sevenDayItem = buildQuotaItem('seven-day', '7d', quotaData['7d_utilization'], quotaData['7d_status'], quotaData['7d_resets_at']);
  const overageItem = buildQuotaItem('overage', 'Overage', quotaData.overage_utilization, quotaData.overage_status, quotaData.overage_resets_at);
  const limitItems = [fiveHourItem, sevenDayItem, overageItem].filter(Boolean);
  const summaryItems = [
    fiveHourItem ? withResetSummaryDetail(fiveHourItem, quotaData['5h_resets_at']) : null,
    sevenDayItem ? withResetSummaryDetail(sevenDayItem, quotaData['7d_resets_at']) : null,
    shouldShowSummaryOverage(quotaData.overage_utilization) && overageItem ? withResetSummaryDetail(overageItem, quotaData.overage_resets_at) : null
  ].filter(Boolean);

  const details = [];
  if (quotaData.unified_status) {
    details.push({
      id: 'unified-status',
      label: 'Unified status',
      value: capitalizeWords(String(quotaData.unified_status).replace(/_/g, ' ')),
      tone: quotaData.unified_status === 'allowed' ? 'success' : 'warning'
    });
  }
  if (quotaData.representative_claim) {
    details.push({
      id: 'representative-claim',
      label: 'Current limit window',
      value: formatClaim(quotaData.representative_claim),
      tone: quotaData.unified_status === 'allowed' ? 'success' : 'warning'
    });
  }
  if (typeof quotaData.fallback_percentage === 'number') {
    details.push({
      id: 'fallback',
      label: 'Fallback threshold',
      value: formatPercent(quotaData.fallback_percentage),
      tone: 'neutral'
    });
  }

  const requestItems = [
    quotaData.status !== undefined ? { id: 'http-status', label: 'HTTP status', value: String(quotaData.status) } : null,
    quotaData.url ? { id: 'url', label: 'Endpoint', value: String(quotaData.url) } : null,
    quotaData.source ? { id: 'source', label: 'Source', value: String(quotaData.source) } : null
  ].filter(Boolean);

  const rawItems = Object.entries(quotaData.raw || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      id: `raw-${key}`,
      label: key.replace(/^anthropic-ratelimit-unified-/, ''),
      value: String(value)
    }));

  return {
    providerId: 'claude',
    title: 'Claude',
    updatedAt: quotaData.captured_at,
    summary: {
      title: 'Usage',
      items: summaryItems
    },
    sections: [
      { id: 'limits', title: 'Usage Windows', items: limitItems },
      ...(details.length > 0 ? [{ id: 'details', title: 'Details', items: details }] : []),
      ...(requestItems.length > 0 ? [{ id: 'request', title: 'Capture', items: requestItems }] : []),
      ...(rawItems.length > 0 ? [{ id: 'raw', title: 'Raw Headers', items: rawItems }] : [])
    ]
  };
}

function buildQuotaItem(id, label, utilization, status, resetsAt) {
  if (typeof utilization !== 'number' && !status && !resetsAt) return null;
  const normalizedUtilization = typeof utilization === 'number' ? utilization : null;
  const tone = quotaTone(normalizedUtilization, status);
  const statusText = status ? capitalizeWords(String(status).replace(/_/g, ' ')) : null;
  const resetText = resetsAt ? `Resets ${formatReset(resetsAt)}` : null;

  return {
    id,
    label,
    value: normalizedUtilization !== null ? formatPercent(normalizedUtilization) : statusText || undefined,
    detail: [statusText, resetText].filter(Boolean).join(' - ') || undefined,
    tone,
    ...(normalizedUtilization !== null ? { progress: { value: normalizedUtilization } } : {})
  };
}

function withResetSummaryDetail(item, resetsAt) {
  const summaryItem = { ...item };
  if (resetsAt) {
    summaryItem.detail = `Resets ${formatReset(resetsAt)}`;
  } else {
    delete summaryItem.detail;
  }
  return summaryItem;
}

function shouldShowSummaryOverage(value) {
  return typeof value === 'number' && value > 0;
}

function quotaTone(utilization, status) {
  if (status && status !== 'allowed') return 'danger';
  if (typeof utilization !== 'number') return 'neutral';
  if (utilization >= 0.86) return 'danger';
  if (utilization >= 0.6) return 'warning';
  return 'info';
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '';
  const pct = value * 100;
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

function formatReset(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatClaim(value) {
  return capitalizeWords(String(value).replace(/_/g, ' '));
}

function capitalizeWords(value) {
  return value.replace(/\b\w/g, char => char.toUpperCase());
}

export async function setConfigOption(acpClient, sessionId, optionId, value) {
  // Verified against Claude ACP:
  // - Mode: session/set_mode { sessionId, modeId }
  // - Model: session/set_model { sessionId, modelId } (normally handled by AcpUI's first-class model flow)
  // - Other (Effort): session/set_config_option { sessionId, configId, value }

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

  // Effort and other dynamic options use set_config_option
  const result = await acpClient.transport.sendRequest('session/set_config_option', {
    sessionId,
    configId: optionId,
    value: value
  });
  return normalizeClaudeConfigResult(result);
}

function normalizeClaudeConfigResult(result) {
  if (!Array.isArray(result?.configOptions)) return result;

  return {
    ...result,
    configOptions: result.configOptions
      .filter(option => option?.id !== 'model')
      .map(option => option.id === 'effort' ? { ...option, kind: 'reasoning_effort' } : option)
  };
}

// --- Session File Operations ---

/**
 * Claude Code stores sessions in project-scoped subdirectories:
 *   <sessionsRoot>/<project-encoded-cwd>/<sessionId>.jsonl
 *
 * This function locates the actual directory containing a given session's JSONL
 * by scanning the sessions root for a subdirectory that holds `{acpId}.jsonl`.
 * Falls back to the root itself for flat-layout providers.
 */
function findSessionDir(sessionsRoot, acpId) {
  // Fast path: flat layout (file sits directly in root)
  if (fs.existsSync(path.join(sessionsRoot, `${acpId}.jsonl`))) {
    return sessionsRoot;
  }
  // Slow path: scan project subdirectories
  try {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(sessionsRoot, entry.name, `${acpId}.jsonl`))) {
        return path.join(sessionsRoot, entry.name);
      }
    }
  } catch (err) {
    // console.log('findSessionDir: scan error', { error: err.message });
  }
  return sessionsRoot; // fallback — clone will just be a no-op if source doesn't exist
}

export function getSessionPaths(acpId) {
  const { config } = getProvider();
  const dir = findSessionDir(config.paths.sessions, acpId);
  return {
    jsonl: path.join(dir, `${acpId}.jsonl`),
    json: path.join(dir, `${acpId}.json`),
    tasksDir: path.join(dir, acpId),
  };
}

export function cloneSession(oldAcpId, newAcpId, pruneAtTurn) {
  // console.log('cloneSession called', { oldAcpId, newAcpId, pruneAtTurn });
  const { config } = getProvider();
  const sessionsRoot = config.paths.sessions;

  // Both sessions belong to the same project (same cwd), so cloning into the
  // same subdirectory that holds the source is correct.
  const sessionDir = findSessionDir(sessionsRoot, oldAcpId);

  const oldJsonl   = path.join(sessionDir, `${oldAcpId}.jsonl`);
  const newJsonl   = path.join(sessionDir, `${newAcpId}.jsonl`);
  const oldJson    = path.join(sessionDir, `${oldAcpId}.json`);
  const newJson    = path.join(sessionDir, `${newAcpId}.json`);
  const oldTasksDir = path.join(sessionDir, oldAcpId);
  const newTasksDir = path.join(sessionDir, newAcpId);

  if (fs.existsSync(oldJsonl)) {
    const lines = fs.readFileSync(oldJsonl, 'utf-8').split('\n').filter(l => l.trim());
    if (pruneAtTurn != null) {
      let userTurnCount = 0;
      let pruneAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'user') {
            let isInternal = entry.isMeta === true;
            if (typeof entry.message?.content === 'string') {
              const content = entry.message.content;
              if (content.includes('<local-command-caveat>') ||
                  content.includes('<command-name>') ||
                  content.includes('<local-command-')) {
                isInternal = true;
              }
            }
            if (!isInternal) {
              userTurnCount++;
            }
          }
          if (userTurnCount > pruneAtTurn) {
            pruneAt = i;
            break;
          }
        } catch {}
      }
      fs.writeFileSync(newJsonl, lines.slice(0, pruneAt).map(l => l.replaceAll(oldAcpId, newAcpId)).join('\n') + '\n', 'utf-8');
    } else {
      const content = fs.readFileSync(oldJsonl, 'utf-8');
      fs.writeFileSync(newJsonl, content.replaceAll(oldAcpId, newAcpId), 'utf-8');
    }
  }

  if (fs.existsSync(oldJson)) {
    let json = fs.readFileSync(oldJson, 'utf-8');
    json = json.replaceAll(oldAcpId, newAcpId);
    fs.writeFileSync(newJson, json, 'utf-8');
  }

  if (fs.existsSync(oldTasksDir)) {
    fs.cpSync(oldTasksDir, newTasksDir, { recursive: true });
  }
  // console.log('cloneSession completed', { sessionDir, newJsonl });
}

export function deleteSessionFiles(acpId) {
  const paths = getSessionPaths(acpId);
  if (paths.jsonl && fs.existsSync(paths.jsonl)) fs.unlinkSync(paths.jsonl);
  if (paths.json && fs.existsSync(paths.json)) fs.unlinkSync(paths.json);
  if (paths.tasksDir && fs.existsSync(paths.tasksDir)) fs.rmSync(paths.tasksDir, { recursive: true, force: true });
}

export function archiveSessionFiles(acpId, archiveDir) {
  const { config } = getProvider();
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
  // Save the exact directory where the session lived so restore puts it back in the right place.
  // Claude Code stores sessions under <sessionsRoot>/<encoded-cwd>/ — not flat at root.
  const sessionDir = path.dirname(paths.jsonl);
  fs.writeFileSync(
    path.join(archiveDir, 'restore_meta.json'),
    JSON.stringify({ sessionDir }, null, 2)
  );
}

/**
 * Parse Claude's JSONL session file and reconstruct UI messages.
 */
export async function parseSessionHistory(filePath, Diff) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => JSON.parse(l));

    const messages = [];
    let currentAssistant = null;

    for (const entry of entries) {
      if (entry.type === 'user') {
        let isInternal = entry.isMeta === true;
        let textContent = '';
        let toolResults = [];

        if (typeof entry.message?.content === 'string') {
          const content = entry.message.content;
          if (content.includes('<local-command-caveat>') ||
              content.includes('<command-name>') ||
              content.includes('<local-command-')) {
            isInternal = true;
          } else {
            textContent = content;
          }
        } else if (Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'text') {
              textContent += block.text + '\n';
            } else if (block.type === 'tool_result') {
              toolResults.push(block);
            }
          }
          if (textContent.includes('<local-command-caveat>') || textContent.includes('<command-name>')) {
             isInternal = true;
          }
        }

        if (toolResults.length > 0 && currentAssistant) {
          for (const res of toolResults) {
            const toolStep = currentAssistant.timeline.find(t => t.type === 'tool' && t.event.id === res.tool_use_id);
            if (toolStep) {
              toolStep.event.status = res.is_error ? 'failed' : 'completed';
              let outputText = '';
              if (typeof res.content === 'string') {
                outputText = res.content;
              } else if (Array.isArray(res.content)) {
                outputText = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
              }
              toolStep.event.output = outputText || undefined;
            }
          }
        }

        if (!isInternal && textContent.trim()) {
          if (currentAssistant) {
            messages.push(currentAssistant);
            currentAssistant = null;
          }
          messages.push({ role: 'user', content: textContent.trim(), id: entry.uuid || entry.message?.id || Date.now().toString() });
        }
      } else if (entry.type === 'assistant') {
        if (!currentAssistant) {
          currentAssistant = {
            role: 'assistant',
            content: '',
            id: entry.uuid || entry.message?.id || Date.now().toString(),
            isStreaming: false,
            timeline: []
          };
        }

        for (const block of entry.message?.content || []) {
          if (block.type === 'text') {
            if (currentAssistant.content) currentAssistant.content += '\n\n';
            currentAssistant.content += block.text;
          } else if (block.type === 'thinking') {
            currentAssistant.timeline.push({ type: 'thought', content: block.thinking });
          } else if (block.type === 'tool_use') {
            const inp = block.input || {};
            const titleArg = inp.path || inp.filePath || inp.file_path || inp.command || inp.pattern || inp.query || '';
            const title = titleArg ? `Running ${block.name}: ${titleArg}` : `Running ${block.name}`;

            // For write/edit tools, generate a diff as fallback output
            let fallbackOutput = null;
            const isWrite = ['write', 'write_file', 'strReplace', 'str_replace', 'edit'].includes(block.name);
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
                id: block.id,
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
    throw new Error(`Failed to parse ${filePath}: ${err.stack}`);
  }
}

export function restoreSessionFiles(savedAcpId, archiveDir) {
  const { config } = getProvider();
  const sessionsRoot = config.paths.sessions;

  // Determine the exact directory where the session files belong.
  // Claude Code stores sessions under <sessionsRoot>/<encoded-cwd>/ — not flat at root.
  // We store the absolute path during archive so we can restore exactly.
  let targetDir = sessionsRoot;
  const metaPath = path.join(archiveDir, 'restore_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.sessionDir) {
        targetDir = meta.sessionDir; // absolute path stored at archive time
      }
    } catch { /* fall through to root */ }
  }

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const jsonlSrc = path.join(archiveDir, `${savedAcpId}.jsonl`);
  const jsonSrc = path.join(archiveDir, `${savedAcpId}.json`);
  const tasksSrc = path.join(archiveDir, 'tasks');

  if (fs.existsSync(jsonlSrc)) {
    fs.copyFileSync(jsonlSrc, path.join(targetDir, `${savedAcpId}.jsonl`));
  }
  if (fs.existsSync(jsonSrc)) {
    fs.copyFileSync(jsonSrc, path.join(targetDir, `${savedAcpId}.json`));
  }
  if (fs.existsSync(tasksSrc)) {
    fs.cpSync(tasksSrc, path.join(targetDir, savedAcpId), { recursive: true });
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

const CLAUDE_HOOK_MAP = {
  session_start: 'SessionStart',
  pre_tool: 'PreToolUse',
  post_tool: 'PostToolUse',
  stop: 'Stop',
};

export async function getHooksForAgent(_agentName, hookType) {
  const nativeKey = CLAUDE_HOOK_MAP[hookType];
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
  // Agent is applied at subprocess spawn time via buildSessionMeta — nothing to do post-creation.
  return;
}

export function buildSessionParams(agent) {
  const options = { disallowedTools: ['Bash', 'PowerShell', 'Agent'] };
  if (agent) options.agent = agent;
  return { _meta: { claudeCode: { options } } };
}

export async function performHandshake(acpClient) {
  const { config } = getProvider();
  await acpClient.transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: config.clientInfo || { name: 'ACP-UI', version: '1.0.0' }
  });
}
