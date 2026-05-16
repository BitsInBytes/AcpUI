import { randomUUID } from 'crypto';
import * as db from '../database.js';
import { writeLog } from './logger.js';

const THINKING_PLACEHOLDER = '_Thinking..._';
const STREAM_FLUSH_INTERVAL_MS = 1000;
const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function getProviderId(acpClient) {
  return acpClient?.getProviderId?.() || acpClient?.providerId || null;
}

function getPersistenceDb(acpClient) {
  return acpClient?._sessionStreamPersistenceDb || db;
}

function isUnavailableSessionLookupError(err) {
  return /No "getSessionByAcpId" export|Cannot read properties of null/.test(err?.message || '');
}

async function loadSession(database, providerId, acpSessionId) {
  let getSessionByAcpId;
  try {
    getSessionByAcpId = database?.getSessionByAcpId;
  } catch (err) {
    if (isUnavailableSessionLookupError(err)) return null;
    throw err;
  }
  if (typeof getSessionByAcpId !== 'function') return null;
  try {
    return await (providerId
      ? getSessionByAcpId.call(database, providerId, acpSessionId)
      : getSessionByAcpId.call(database, acpSessionId));
  } catch (err) {
    if (isUnavailableSessionLookupError(err)) return null;
    throw err;
  }
}

function getPersistenceMap(acpClient) {
  if (!acpClient) return null;
  if (!acpClient._sessionStreamPersistence) acpClient._sessionStreamPersistence = new Map();
  return acpClient._sessionStreamPersistence;
}

function persistenceKey(providerId, acpSessionId) {
  return `${providerId || ''}\u0000${acpSessionId}`;
}

function getPersistenceEntry(acpClient, providerId, acpSessionId) {
  const map = getPersistenceMap(acpClient);
  if (!map) return null;
  const key = persistenceKey(providerId, acpSessionId);
  if (!map.has(key)) {
    map.set(key, { session: null, dirty: false, lastFlushAt: 0, chain: Promise.resolve() });
  }
  return map.get(key);
}

function removeSyntheticThinking(timeline = []) {
  return timeline.filter(step => !(step?.type === 'thought' && step.content === THINKING_PLACEHOLDER));
}

function collapseForNewStep(step) {
  if (step?.type === 'tool' || step?.type === 'thought') return { ...step, isCollapsed: true };
  return step;
}

function latestAssistantIndex(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return i;
  }
  return -1;
}

function latestStreamingAssistantIndex(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant' && messages[i]?.isStreaming) return i;
  }
  return -1;
}

function getExplicitActiveAssistantId(meta = null) {
  const activeAssistantMessageId = meta?.activeAssistantMessageId;
  if (typeof activeAssistantMessageId !== 'string') return null;
  const trimmed = activeAssistantMessageId.trim();
  return trimmed || null;
}

function findAssistantIndexById(messages = [], messageId = null) {
  if (!messageId) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant' && messages[i]?.id === messageId) return i;
  }
  return -1;
}

function resolveTurnStartTime(meta = null) {
  const parsedTurnStartTime = Number(meta?.turnStartTime);
  return Number.isFinite(parsedTurnStartTime) ? parsedTurnStartTime : Date.now();
}

function createStreamingAssistant({ id = null, turnStartTime = Date.now() } = {}) {
  return {
    id: id || `assistant-${randomUUID()}`,
    role: 'assistant',
    content: '',
    timeline: [],
    isStreaming: true,
    turnStartTime
  };
}

function ensureActiveAssistant(session, meta = null, { allowCompletedAssistantFallback = false } = {}) {
  if (!Array.isArray(session.messages)) session.messages = [];

  const explicitAssistantId = getExplicitActiveAssistantId(meta);
  const turnStartTime = resolveTurnStartTime(meta);

  let idx = explicitAssistantId
    ? findAssistantIndexById(session.messages, explicitAssistantId)
    : latestStreamingAssistantIndex(session.messages);
  let usedCompletedAssistantFallback = false;

  if (idx === -1 && !explicitAssistantId && allowCompletedAssistantFallback) {
    idx = latestAssistantIndex(session.messages);
    usedCompletedAssistantFallback = idx !== -1;
  }

  if (idx === -1) {
    session.messages.push(createStreamingAssistant({ id: explicitAssistantId, turnStartTime }));
    idx = session.messages.length - 1;
  }

  const msg = session.messages[idx];
  if (!Array.isArray(msg.timeline)) msg.timeline = [];
  if (typeof msg.content !== 'string') msg.content = msg.content ? String(msg.content) : '';
  if (!usedCompletedAssistantFallback) {
    msg.isStreaming = true;
    if (!msg.turnStartTime) msg.turnStartTime = turnStartTime;
  }
  return msg;
}

function getActiveAssistantForSnapshot(session, meta = null) {
  const messages = session?.messages || [];
  const explicitAssistantId = getExplicitActiveAssistantId(meta);
  if (explicitAssistantId) {
    const explicitIdx = findAssistantIndexById(messages, explicitAssistantId);
    if (explicitIdx !== -1) return messages[explicitIdx];
  }
  const streamingIdx = latestStreamingAssistantIndex(messages);
  if (streamingIdx !== -1) return messages[streamingIdx];
  return null;
}

function getAssistantForFinalization(session, meta = null) {
  const messages = session?.messages || [];
  const explicitAssistantId = getExplicitActiveAssistantId(meta);
  if (explicitAssistantId) return ensureActiveAssistant(session, meta);
  const streamingIdx = latestStreamingAssistantIndex(messages);
  if (streamingIdx === -1) return null;
  return messages[streamingIdx];
}

function usefulTextLength(value) {
  if (typeof value === 'string') return value.trim() === THINKING_PLACEHOLDER ? 0 : value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + usefulTextLength(item?.text || item?.content || ''), 0);
  return 0;
}

export function messageQualityScore(message) {
  if (!message || message.role !== 'assistant') return 0;
  let score = usefulTextLength(message.content);
  for (const step of message.timeline || []) {
    if (step?.type === 'text') score += usefulTextLength(step.content);
    else if (step?.type === 'thought') score += usefulTextLength(step.content);
    else if (step?.type === 'permission') score += 25;
    else if (step?.type === 'tool') {
      score += 50;
      score += usefulTextLength(step.event?.output || step.event?._fallbackOutput || '');
      if (step.event?.status && step.event.status !== 'in_progress') score += 10;
    }
  }
  return score;
}

export function isLowQualityAssistantMessage(message) {
  if (!message || message.role !== 'assistant') return false;
  const timeline = message.timeline || [];
  const hasOnlySyntheticThinking = timeline.length > 0 && timeline.every(step => step?.type === 'thought' && step.content === THINKING_PLACEHOLDER);
  return usefulTextLength(message.content) === 0 && (timeline.length === 0 || hasOnlySyntheticThinking);
}

function hasTerminalToolOutput(message) {
  return Boolean(message?.timeline?.some(step =>
    step?.type === 'tool'
    && TERMINAL_TOOL_STATUSES.has(step.event?.status)
    && usefulTextLength(step.event?.output || step.event?._fallbackOutput || '') > 0
  ));
}

function appendText(session, text, meta = null) {
  if (!text) return;
  const msg = ensureActiveAssistant(session, meta);
  const timeline = removeSyntheticThinking(msg.timeline);
  const last = timeline[timeline.length - 1];
  msg.content = `${msg.content || ''}${text}`;
  if (last?.type === 'text') {
    timeline[timeline.length - 1] = { ...last, content: `${last.content || ''}${text}` };
  } else {
    for (let i = 0; i < timeline.length; i++) timeline[i] = collapseForNewStep(timeline[i]);
    timeline.push({ type: 'text', content: text });
  }
  msg.timeline = timeline;
}

function appendThought(session, text, meta = null) {
  if (!text) return;
  const msg = ensureActiveAssistant(session, meta);
  const timeline = removeSyntheticThinking(msg.timeline);
  const last = timeline[timeline.length - 1];
  if (last?.type === 'thought' && !last.isCollapsed) {
    timeline[timeline.length - 1] = { ...last, content: `${last.content || ''}${text}` };
  } else {
    for (let i = 0; i < timeline.length; i++) timeline[i] = collapseForNewStep(timeline[i]);
    timeline.push({ type: 'thought', content: text, isCollapsed: false });
  }
  msg.timeline = timeline;
}

function eventStatus(event) {
  if (event.type === 'tool_start') return TERMINAL_TOOL_STATUSES.has(event.status) ? event.status : 'in_progress';
  return event.status;
}

function mergeToolOutput(existingEvent, incoming, incomingStatus) {
  if (incoming.output === undefined) return existingEvent.output;
  const isShellTool = Boolean(
    existingEvent.shellRunId || incoming.shellRunId ||
    existingEvent.isShellCommand || incoming.isShellCommand ||
    existingEvent.toolCategory === 'shell' || incoming.toolCategory === 'shell'
  );
  if (!isShellTool) return incoming.output ?? existingEvent.output;
  if ((incoming.output === '' || incoming.output === null) && existingEvent.output) return existingEvent.output;
  if (TERMINAL_TOOL_STATUSES.has(incomingStatus) || !existingEvent.output) return incoming.output;
  return existingEvent.output;
}

function mergeToolEvent(existingEvent = {}, incoming = {}) {
  const incomingStatus = eventStatus(incoming);
  const isShellTool = Boolean(
    existingEvent.shellRunId || incoming.shellRunId ||
    existingEvent.isShellCommand || incoming.isShellCommand ||
    existingEvent.toolCategory === 'shell' || incoming.toolCategory === 'shell'
  );
  const terminalShellState = isShellTool && TERMINAL_TOOL_STATUSES.has(incomingStatus) ? 'exited' : undefined;
  const next = {
    ...existingEvent,
    ...incoming,
    status: incomingStatus || existingEvent.status,
    output: mergeToolOutput(existingEvent, incoming, incomingStatus),
    filePath: incoming.filePath || existingEvent.filePath,
    title: incoming.title || existingEvent.title,
    titleSource: incoming.titleSource || existingEvent.titleSource,
    toolName: incoming.toolName || existingEvent.toolName,
    canonicalName: incoming.canonicalName || existingEvent.canonicalName,
    mcpServer: incoming.mcpServer || existingEvent.mcpServer,
    mcpToolName: incoming.mcpToolName || existingEvent.mcpToolName,
    isAcpUxTool: incoming.isAcpUxTool ?? existingEvent.isAcpUxTool,
    toolCategory: incoming.toolCategory || existingEvent.toolCategory,
    isShellCommand: incoming.isShellCommand ?? existingEvent.isShellCommand,
    isFileOperation: incoming.isFileOperation ?? existingEvent.isFileOperation,
    shellRunId: incoming.shellRunId || existingEvent.shellRunId,
    invocationId: incoming.invocationId || existingEvent.invocationId,
    command: incoming.command || existingEvent.command,
    cwd: incoming.cwd || existingEvent.cwd,
    shellState: incoming.shellState || terminalShellState || existingEvent.shellState,
    shellNeedsInput: incoming.shellNeedsInput ?? (terminalShellState ? false : existingEvent.shellNeedsInput),
    shellInteractive: incoming.shellInteractive ?? existingEvent.shellInteractive,
    startTime: existingEvent.startTime || incoming.startTime || Date.now(),
    endTime: incoming.endTime || existingEvent.endTime
  };
  if (!next._fallbackOutput && incoming.type === 'tool_update' && incoming.output) next._fallbackOutput = incoming.output;
  if (TERMINAL_TOOL_STATUSES.has(next.status) && !next.endTime) next.endTime = Date.now();
  delete next.type;
  delete next.providerId;
  delete next.sessionId;
  return next;
}

function matchingToolIndex(timeline, event) {
  return timeline.findLastIndex(step => step.type === 'tool' && (
    (event.id && step.event?.id === event.id) ||
    (event.shellRunId && step.event?.shellRunId === event.shellRunId)
  ));
}

function applyToolEvent(session, event, meta = null, options = {}) {
  const msg = ensureActiveAssistant(session, meta, {
    allowCompletedAssistantFallback: options.allowCompletedAssistantFallback === true
  });
  const timeline = removeSyntheticThinking(msg.timeline);
  const idx = matchingToolIndex(timeline, event);

  if (event.type === 'tool_start') {
    if (idx !== -1) {
      const existing = timeline[idx];
      timeline[idx] = {
        ...existing,
        event: mergeToolEvent(existing.event, event),
        isCollapsed: TERMINAL_TOOL_STATUSES.has(event.status) ? existing.isCollapsed : false
      };
    } else {
      for (let i = 0; i < timeline.length; i++) timeline[i] = collapseForNewStep(timeline[i]);
      timeline.push({ type: 'tool', event: mergeToolEvent({}, event), isCollapsed: false });
    }
  } else if (event.type === 'tool_update' || event.type === 'tool_end') {
    if (idx !== -1) {
      const existing = timeline[idx];
      timeline[idx] = { ...existing, event: mergeToolEvent(existing.event, event), isCollapsed: false };
    } else {
      for (let i = 0; i < timeline.length; i++) timeline[i] = collapseForNewStep(timeline[i]);
      timeline.push({ type: 'tool', event: mergeToolEvent({}, event), isCollapsed: false });
    }
  }

  msg.timeline = timeline;
}

function applyPermissionEvent(session, event, meta = null) {
  const msg = ensureActiveAssistant(session, meta);
  const timeline = removeSyntheticThinking(msg.timeline);
  if (!timeline.some(step => step.type === 'permission' && step.request?.id === event.id)) {
    timeline.push({ type: 'permission', request: event, isCollapsed: false });
  }
  msg.timeline = timeline;
}

function applyStreamEvent(session, event, meta = null, options = {}) {
  if (!event) return;
  if (event.type === 'token') appendText(session, event.text || '', meta);
  else if (event.type === 'thought') appendThought(session, event.text || '', meta);
  else if (event.type === 'permission_request') applyPermissionEvent(session, event, meta);
  else if (event.type === 'tool_start' || event.type === 'tool_update' || event.type === 'tool_end') applyToolEvent(session, event, meta, options);
}

export function applyRuntimeMetadataToSession(session, acpSessionId, meta) {
  if (!session || !meta) return false;
  let changed = false;
  if (meta.configOptions) {
    session.configOptions = meta.configOptions;
    changed = true;
  }
  if (meta.currentModelId) {
    session.currentModelId = meta.currentModelId;
    changed = true;
  }
  if (meta.modelOptions) {
    session.modelOptions = meta.modelOptions;
    changed = true;
  }

  const prevUsed = Number(session.stats?.usedTokens || 0);
  const prevTotal = Number(session.stats?.totalTokens || 0);
  const nextUsed = Number(meta.usedTokens || 0);
  const nextTotal = Number(meta.totalTokens || 0);
  if (prevUsed !== nextUsed || prevTotal !== nextTotal || meta.toolCalls || meta.successTools) {
    session.stats = {
      sessionId: acpSessionId,
      sessionPath: session.stats?.sessionPath || 'Relative',
      model: meta.currentModelId || meta.model || session.model || session.stats?.model || 'Unknown',
      toolCalls: Number(meta.toolCalls || session.stats?.toolCalls || 0),
      successTools: Number(meta.successTools || session.stats?.successTools || 0),
      durationMs: Number((Date.now() - Number(meta.startTime || Date.now())) || 0),
      usedTokens: nextUsed,
      totalTokens: nextTotal,
      sessionSizeMb: Number(((nextUsed * 4) / (1024 * 1024)).toFixed(2))
    };
    changed = true;
  }
  return changed;
}

async function mutatePersistedSession(acpClient, acpSessionId, mutator, { force = false } = {}) {
  const providerId = getProviderId(acpClient);
  const database = getPersistenceDb(acpClient);
  const entry = getPersistenceEntry(acpClient, providerId, acpSessionId);
  if (!entry) return null;

  entry.chain = entry.chain.then(async () => {
    if (!entry.session) entry.session = await loadSession(database, providerId, acpSessionId);
    if (!entry.session) return null;

    const meta = acpClient?.sessionMetadata?.get(acpSessionId);
    const didMutate = await mutator(entry.session, meta);
    const metadataChanged = applyRuntimeMetadataToSession(entry.session, acpSessionId, meta);
    entry.dirty = entry.dirty || didMutate || metadataChanged;

    const now = Date.now();
    if (entry.dirty && (force || !entry.lastFlushAt || now - entry.lastFlushAt >= STREAM_FLUSH_INTERVAL_MS)) {
      await database.saveSession(entry.session);
      entry.lastFlushAt = now;
      entry.dirty = false;
    }
    return entry.session;
  });

  return entry.chain.catch(err => {
    writeLog(`[DB ERR] Stream persistence failed for ${acpSessionId}: ${err.message}`);
    throw err;
  });
}

export function persistStreamEvent(acpClient, acpSessionId, event, options = {}) {
  if (!acpSessionId || !event) return Promise.resolve(null);
  return mutatePersistedSession(acpClient, acpSessionId, (session, meta) => {
    applyStreamEvent(session, event, meta, options);
    return true;
  }, options);
}

export function flushStreamPersistence(acpClient, acpSessionId) {
  if (!acpSessionId) return Promise.resolve(null);
  return mutatePersistedSession(acpClient, acpSessionId, () => false, { force: true });
}

export async function getStreamResumeSnapshot(acpClient, acpSessionId) {
  if (!acpSessionId) return null;
  const providerId = getProviderId(acpClient);
  const database = getPersistenceDb(acpClient);
  const session = await flushStreamPersistence(acpClient, acpSessionId)
    || await loadSession(database, providerId, acpSessionId);
  const meta = acpClient?.sessionMetadata?.get(acpSessionId) || null;
  const msg = getActiveAssistantForSnapshot(session, meta);
  if (!msg) return null;
  return {
    providerId: session.provider || providerId,
    sessionId: acpSessionId,
    uiId: session.id,
    message: clone(msg)
  };
}

export async function finalizeStreamPersistence(acpClient, acpSessionId, { errorText = null } = {}) {
  if (errorText) {
    await persistStreamEvent(acpClient, acpSessionId, { type: 'token', text: errorText }, { force: true });
  }

  const session = await mutatePersistedSession(acpClient, acpSessionId, (workingSession, meta) => {
    const msg = getAssistantForFinalization(workingSession, meta);
    if (!msg) return false;
    msg.timeline = removeSyntheticThinking(msg.timeline || []);
    msg.isStreaming = false;
    msg.turnEndTime = Date.now();
    msg.timeline = (msg.timeline || []).map(step => {
      if (step.type !== 'tool' || step.event?.status !== 'in_progress') return step;
      return { ...step, event: { ...step.event, status: 'failed', output: step.event.output || 'Aborted', endTime: Date.now() } };
    });
    return true;
  }, { force: true });

  const providerId = getProviderId(acpClient);
  const map = getPersistenceMap(acpClient);
  if (map) map.delete(persistenceKey(providerId, acpSessionId));
  return session;
}

function latestAssistantMessage(messages = []) {
  const idx = latestAssistantIndex(messages);
  return idx === -1 ? null : messages[idx];
}

export function shouldUseJsonlMessages(dbMessages = [], jsonlMessages = []) {
  if (!Array.isArray(jsonlMessages) || jsonlMessages.length === 0) return false;
  if (!Array.isArray(dbMessages)) return true;
  if (jsonlMessages.length > dbMessages.length) return true;
  if (jsonlMessages.length !== dbMessages.length) return false;

  const dbLatest = latestAssistantMessage(dbMessages);
  const jsonlLatest = latestAssistantMessage(jsonlMessages);
  if (!dbLatest || !jsonlLatest) return false;

  const dbScore = messageQualityScore(dbLatest);
  const jsonlScore = messageQualityScore(jsonlLatest);
  if (isLowQualityAssistantMessage(dbLatest) && jsonlScore > 0) return true;
  if (hasTerminalToolOutput(dbLatest) && !hasTerminalToolOutput(jsonlLatest)) return false;
  return jsonlScore > dbScore + 100;
}

const STICKY_TOOL_EVENT_FIELDS = [
  'invocationId',
  'shellRunId',
  'toolName',
  'canonicalName',
  'mcpToolName',
  'mcpServer',
  'isAcpUxTool',
  'toolCategory',
  'isShellCommand',
  'isFileOperation',
  'titleSource',
  'shellState',
  'shellNeedsInput',
  'shellInteractive',
  'command',
  'cwd'
];

function mergeStickyToolEventFields(existingEvent = {}, incomingEvent = {}) {
  const next = { ...incomingEvent };
  for (const field of STICKY_TOOL_EVENT_FIELDS) {
    if (next[field] === undefined && existingEvent[field] !== undefined) next[field] = existingEvent[field];
  }
  return next;
}

function mergeStickyTimelineMetadata(existingTimeline = [], incomingTimeline = []) {
  if (!Array.isArray(incomingTimeline) || incomingTimeline.length === 0) return incomingTimeline;
  const existingToolsById = new Map();
  for (const step of existingTimeline || []) {
    if (step?.type === 'tool' && step.event?.id) existingToolsById.set(step.event.id, step);
  }

  return incomingTimeline.map((step, index) => {
    if (step?.type !== 'tool') return step;
    const existing = (step.event?.id && existingToolsById.get(step.event.id))
      || (existingTimeline?.[index]?.type === 'tool' ? existingTimeline[index] : null);
    if (!existing?.event) return step;
    return { ...step, event: mergeStickyToolEventFields(existing.event, step.event) };
  });
}

export function mergeJsonlMessagesPreservingIds(dbMessages = [], jsonlMessages = []) {
  if (!Array.isArray(jsonlMessages)) return [];
  if (!Array.isArray(dbMessages) || dbMessages.length === 0) return clone(jsonlMessages);
  return jsonlMessages.map((message, index) => {
    const existing = dbMessages[index];
    if (existing?.id && existing.role === message.role) {
      return {
        ...message,
        id: existing.id,
        ...(Array.isArray(message.timeline) ? { timeline: mergeStickyTimelineMetadata(existing.timeline, message.timeline) } : {})
      };
    }
    return message;
  });
}

function mergeAssistantMessage(existing, incoming) {
  const existingScore = messageQualityScore(existing);
  const incomingScore = messageQualityScore(incoming);
  if (existingScore <= incomingScore) return incoming;
  return {
    ...incoming,
    content: existing.content,
    timeline: existing.timeline,
    isStreaming: incoming.isStreaming === false ? false : existing.isStreaming,
    turnStartTime: existing.turnStartTime || incoming.turnStartTime,
    turnEndTime: incoming.isStreaming === false ? (incoming.turnEndTime || Date.now()) : existing.turnEndTime
  };
}

export function mergeSnapshotWithPersisted(existingSession, incomingSession) {
  if (!existingSession?.messages?.length || !incomingSession?.messages?.length) return incomingSession;
  const existingMessages = existingSession.messages;
  const incomingMessages = incomingSession.messages;
  const existingIdx = latestAssistantIndex(existingMessages);
  const incomingIdx = latestAssistantIndex(incomingMessages);
  if (existingIdx === -1 || incomingIdx === -1) return incomingSession;

  const existingLatest = existingMessages[existingIdx];
  const incomingLatest = incomingMessages[incomingIdx];
  const sameMessage = existingLatest.id && incomingLatest.id && existingLatest.id === incomingLatest.id;
  if (!sameMessage) return incomingSession;

  const next = { ...incomingSession, messages: [...incomingMessages] };
  next.messages[incomingIdx] = mergeAssistantMessage(existingLatest, incomingLatest);
  return next;
}
