import { acpUiToolTitle, subAgentCheckToolTitle } from './acpUiToolTitles.js';
import {
  ACP_UX_TOOL_NAMES,
  acpUxIoToolConfig,
  isAcpUxToolName
} from './acpUxTools.js';
import { toolCallState } from './toolCallState.js';
import { getProvider } from '../providerLoader.js';

const DEFAULT_MCP_SERVER_NAME = 'AcpUI';
const RECENT_EXECUTION_TTL_MS = 60_000;
const MAX_RECORDS = 500;

const INTERNAL_INPUT_KEYS = new Set([
  'providerId',
  'acpSessionId',
  'sessionId',
  'mcpProxyId',
  'mcpRequestId',
  'requestMeta',
  'abortSignal',
  'skipToolState',
  'idempotencyToolName'
]);

function nowMs() {
  return Date.now();
}

function normalizeToolName(value) {
  return String(value || '').trim().toLowerCase();
}

function cacheKey(...parts) {
  return parts.map(part => String(part ?? '')).join('::');
}

function compactObject(obj = {}) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

function configuredMcpServerName(providerId) {
  try {
    return getProvider(providerId).config.mcpName || DEFAULT_MCP_SERVER_NAME;
  } catch {
    return DEFAULT_MCP_SERVER_NAME;
  }
}

export function toolCallIdFromMcpContext({ requestMeta, mcpRequestId, toolName } = {}) {
  const metaId = requestMeta?.toolCallId || requestMeta?.tool_call_id || requestMeta?.callId;
  if (metaId) return String(metaId);

  if (typeof mcpRequestId !== 'string' || !mcpRequestId.trim()) return null;
  const normalizedRequestId = mcpRequestId.trim();
  const normalizedToolName = normalizeToolName(toolName);
  if (normalizedToolName && normalizedRequestId.toLowerCase().includes(normalizedToolName)) {
    return normalizedRequestId;
  }
  if (/^mcp[_/]|^mcp__/i.test(normalizedRequestId)) {
    return normalizedRequestId;
  }
  return null;
}

export function publicMcpToolInput(toolName, args = {}) {
  const input = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (!INTERNAL_INPUT_KEYS.has(key) && value !== undefined) input[key] = value;
  }

  if (toolName === ACP_UX_TOOL_NAMES.invokeShell) {
    return {
      description: input.description,
      command: input.command,
      cwd: input.cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd()
    };
  }

  return input;
}

function filePathFor(toolName, input = {}) {
  if (!acpUxIoToolConfig(toolName)?.usesFilePath) return undefined;
  return input.file_path || input.filePath || input.path || undefined;
}

function categoryFor(toolName) {
  if (toolName === ACP_UX_TOOL_NAMES.invokeShell) {
    return { toolCategory: 'shell', isShellCommand: true, isFileOperation: false };
  }
  if (
    toolName === ACP_UX_TOOL_NAMES.invokeSubagents ||
    toolName === ACP_UX_TOOL_NAMES.invokeCounsel ||
    toolName === ACP_UX_TOOL_NAMES.checkSubagents ||
    toolName === ACP_UX_TOOL_NAMES.abortSubagents
  ) {
    return { toolCategory: 'sub_agent', isFileOperation: false };
  }
  return acpUxIoToolConfig(toolName)?.category || {};
}

export function describeAcpUxToolExecution(toolName, input = {}, options = {}) {
  const canonicalName = normalizeToolName(toolName);
  const filePath = options.filePath || filePathFor(canonicalName, input);
  let title;

  if (canonicalName === ACP_UX_TOOL_NAMES.invokeShell) {
    title = input.description ? `Invoke Shell: ${String(input.description).trim()}` : 'Invoke Shell';
  } else if (canonicalName === ACP_UX_TOOL_NAMES.invokeSubagents) {
    title = 'Invoke Subagents';
  } else if (canonicalName === ACP_UX_TOOL_NAMES.invokeCounsel) {
    title = 'Invoke Counsel';
  } else if (canonicalName === ACP_UX_TOOL_NAMES.checkSubagents) {
    title = subAgentCheckToolTitle(input);
  } else if (canonicalName === ACP_UX_TOOL_NAMES.abortSubagents) {
    title = 'Abort Subagents';
  } else {
    title = acpUiToolTitle(canonicalName, input, { filePath }) || '';
  }

  return compactObject({
    title,
    titleSource: title ? 'mcp_handler' : undefined,
    filePath,
    category: categoryFor(canonicalName)
  });
}

function outputFromMcpResult(result) {
  if (!result) return undefined;
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    const text = result.content
      .map(item => typeof item?.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

function buildIdentity(record) {
  return compactObject({
    kind: 'acpui_mcp',
    canonicalName: record.toolName,
    rawName: record.toolName,
    mcpServer: record.mcpServer || configuredMcpServerName(record.providerId),
    mcpToolName: record.toolName
  });
}

export function invocationFromMcpExecution(record) {
  if (!record) return null;
  const descriptor = record.descriptor || describeAcpUxToolExecution(record.toolName, record.input || {});
  return {
    toolCallId: record.toolCallId,
    identity: buildIdentity(record),
    input: record.input || {},
    display: compactObject({
      title: descriptor.title,
      titleSource: descriptor.titleSource
    }),
    category: descriptor.category || {},
    filePath: descriptor.filePath,
    output: record.output,
    execution: record
  };
}

function emitMcpToolUpdate(io, record) {
  const invocation = invocationFromMcpExecution(record);
  if (!io || !record.providerId || !record.sessionId || !record.toolCallId || !invocation?.display?.title) return;

  io.to?.(`session:${record.sessionId}`)?.emit?.('system_event', compactObject({
    providerId: record.providerId,
    sessionId: record.sessionId,
    type: 'tool_update',
    id: record.toolCallId,
    toolName: record.toolName,
    canonicalName: record.toolName,
    mcpServer: invocation.identity.mcpServer,
    mcpToolName: record.toolName,
    isAcpUxTool: true,
    title: invocation.display.title,
    titleSource: invocation.display.titleSource,
    filePath: invocation.filePath,
    ...invocation.category
  }));
}

export class McpExecutionRegistry {
  constructor() {
    this.records = new Map();
    this.byToolCallId = new Map();
    this.byMcpRequestId = new Map();
    this.bySessionTool = new Map();
    this.nextId = 1;
  }

  clear() {
    this.records.clear();
    this.byToolCallId.clear();
    this.byMcpRequestId.clear();
    this.bySessionTool.clear();
    this.nextId = 1;
  }

  makeExecutionId({ providerId, sessionId, mcpProxyId, mcpRequestId, toolCallId, toolName }) {
    if (providerId && sessionId && toolCallId) return cacheKey('tool', providerId, sessionId, toolCallId);
    if (providerId && (sessionId || mcpProxyId) && mcpRequestId !== undefined && mcpRequestId !== null) {
      return cacheKey('request', providerId, sessionId || mcpProxyId, mcpRequestId);
    }
    return cacheKey('local', toolName, this.nextId++);
  }

  index(record) {
    if (record.providerId && record.sessionId && record.toolCallId) {
      this.byToolCallId.set(cacheKey(record.providerId, record.sessionId, record.toolCallId), record.executionId);
    }
    if (record.providerId && (record.sessionId || record.mcpProxyId) && record.mcpRequestId !== undefined && record.mcpRequestId !== null) {
      this.byMcpRequestId.set(cacheKey(record.providerId, record.sessionId || record.mcpProxyId, record.mcpRequestId), record.executionId);
    }
    if (record.providerId && record.sessionId && record.toolName) {
      const key = cacheKey(record.providerId, record.sessionId, record.toolName);
      const existing = this.bySessionTool.get(key) || [];
      this.bySessionTool.set(key, [record.executionId, ...existing.filter(id => id !== record.executionId)].slice(0, 20));
    }
  }

  project(record, { emitUpdate = false } = {}) {
    if (record.providerId && record.sessionId && record.toolCallId) {
      const invocation = invocationFromMcpExecution(record);
      toolCallState.upsert({
        providerId: record.providerId,
        sessionId: record.sessionId,
        toolCallId: record.toolCallId,
        identity: invocation.identity,
        input: invocation.input,
        display: invocation.display,
        category: invocation.category,
        filePath: invocation.filePath,
        output: invocation.output,
        raw: { mcpExecutionId: record.executionId }
      });
    }
    if (emitUpdate) emitMcpToolUpdate(record.io, record);
  }

  begin({
    io,
    providerId,
    sessionId,
    acpSessionId,
    mcpProxyId,
    mcpRequestId,
    requestMeta,
    toolName,
    input
  } = {}) {
    const canonicalName = normalizeToolName(toolName);
    if (!isAcpUxToolName(canonicalName)) return null;

    const resolvedSessionId = sessionId || acpSessionId || null;
    const toolCallId = toolCallIdFromMcpContext({ requestMeta, mcpRequestId, toolName: canonicalName });
    const descriptor = describeAcpUxToolExecution(canonicalName, input || {});
    const executionId = this.makeExecutionId({
      providerId,
      sessionId: resolvedSessionId,
      mcpProxyId,
      mcpRequestId,
      toolCallId,
      toolName: canonicalName
    });

    const existing = this.records.get(executionId) || {};
    const record = {
      ...existing,
      executionId,
      providerId: providerId || existing.providerId || null,
      sessionId: resolvedSessionId || existing.sessionId || null,
      mcpProxyId: mcpProxyId || existing.mcpProxyId || null,
      mcpRequestId: mcpRequestId ?? existing.mcpRequestId ?? null,
      requestMeta: requestMeta || existing.requestMeta || null,
      toolCallId: toolCallId || existing.toolCallId || null,
      toolName: canonicalName,
      input: { ...(existing.input || {}), ...(input || {}) },
      descriptor,
      mcpServer: providerId ? configuredMcpServerName(providerId) : DEFAULT_MCP_SERVER_NAME,
      status: 'in_progress',
      startedAt: existing.startedAt || nowMs(),
      updatedAt: nowMs(),
      io
    };

    this.records.set(executionId, record);
    this.index(record);
    this.project(record, { emitUpdate: true });
    this.prune();
    return record;
  }

  complete(recordOrId, result) {
    const record = this.resolveRecord(recordOrId);
    if (!record) return null;
    record.status = 'completed';
    record.result = result;
    record.output = outputFromMcpResult(result);
    record.completedAt = nowMs();
    record.updatedAt = nowMs();
    this.records.set(record.executionId, record);
    this.project(record);
    return record;
  }

  fail(recordOrId, error) {
    const record = this.resolveRecord(recordOrId);
    if (!record) return null;
    record.status = 'failed';
    record.error = error?.message || String(error || 'Unknown MCP tool error');
    record.completedAt = nowMs();
    record.updatedAt = nowMs();
    this.records.set(record.executionId, record);
    this.project(record);
    return record;
  }

  resolveRecord(recordOrId) {
    if (!recordOrId) return null;
    if (typeof recordOrId === 'string') return this.records.get(recordOrId) || null;
    if (recordOrId.executionId) return this.records.get(recordOrId.executionId) || recordOrId;
    return null;
  }

  claimToolCallId(record, toolCallId) {
    if (!record || !toolCallId || record.toolCallId === toolCallId) return record;
    record.toolCallId = toolCallId;
    record.updatedAt = nowMs();
    this.records.set(record.executionId, record);
    this.index(record);
    this.project(record);
    return record;
  }

  find({ providerId, sessionId, mcpProxyId, mcpRequestId, toolCallId, toolName } = {}) {
    if (providerId && sessionId && toolCallId) {
      const id = this.byToolCallId.get(cacheKey(providerId, sessionId, toolCallId));
      if (id) return this.records.get(id) || null;
    }

    if (providerId && (sessionId || mcpProxyId) && mcpRequestId !== undefined && mcpRequestId !== null) {
      const id = this.byMcpRequestId.get(cacheKey(providerId, sessionId || mcpProxyId, mcpRequestId));
      if (id) {
        const record = this.records.get(id) || null;
        return toolCallId ? this.claimToolCallId(record, toolCallId) : record;
      }
    }

    const canonicalName = normalizeToolName(toolName);
    if (!providerId || !sessionId || !canonicalName) return null;
    const ids = this.bySessionTool.get(cacheKey(providerId, sessionId, canonicalName)) || [];
    const cutoff = nowMs() - RECENT_EXECUTION_TTL_MS;
    const recentMatches = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || record.updatedAt < cutoff) continue;
      if (record.toolCallId && toolCallId && record.toolCallId !== toolCallId) continue;
      recentMatches.push(record);
    }

    if (recentMatches.length !== 1) return null;
    const record = recentMatches[0];
    return toolCallId ? this.claimToolCallId(record, toolCallId) : record;
  }

  prune() {
    if (this.records.size <= MAX_RECORDS) return;
    const sorted = [...this.records.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const record of sorted.slice(0, this.records.size - MAX_RECORDS)) {
      this.records.delete(record.executionId);
    }
    this.rebuildIndexes();
  }

  rebuildIndexes() {
    this.byToolCallId.clear();
    this.byMcpRequestId.clear();
    this.bySessionTool.clear();
    for (const record of this.records.values()) this.index(record);
  }
}

export const mcpExecutionRegistry = new McpExecutionRegistry();
