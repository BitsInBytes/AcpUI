import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';
import { writeLog } from '../services/logger.js';
import providerRuntimeManager from '../services/providerRuntimeManager.js';
import * as db from '../database.js';

const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export default function registerSubAgentHandlers(_io, socket) {
  socket.on('cancel_subagents', async ({ providerId, invocationId }) => {
    if (!invocationId) return;
    try {
      const runtime = providerRuntimeManager.getRuntime(providerId);
      await subAgentInvocationManager.cancelInvocation(runtime.providerId, invocationId);
    } catch (err) {
      writeLog(`[SUB-AGENT CANCEL ERR] ${err.message}`);
    }
  });
}

function emitSubAgentInvocationSnapshot(socket, snapshot, { parentAcpSessionId, parentUiId, providerId }) {
  if (!snapshot?.invocationId) return;
  socket.emit('sub_agent_invocation_status', {
    invocationId: snapshot.invocationId,
    providerId: snapshot.provider || providerId,
    parentAcpSessionId: snapshot.parentAcpSessionId || parentAcpSessionId,
    parentUiId: snapshot.parentUiId || parentUiId,
    status: snapshot.status,
    totalCount: snapshot.totalCount,
    completedCount: snapshot.completedCount,
    statusToolName: snapshot.statusToolName,
  });
}

function emitSubAgentSnapshot(socket, entry, emittedKeys) {
  const acpSessionId = entry.acpId || entry.acpSessionId;
  const key = `${entry.invocationId || ''}\u0000${acpSessionId || ''}`;
  if (emittedKeys.has(key)) return;
  emittedKeys.add(key);

  if (acpSessionId && !TERMINAL_AGENT_STATUSES.has(entry.status) && typeof socket.join === 'function') {
    socket.join(`session:${acpSessionId}`);
  }
  socket.emit('sub_agent_snapshot', {
    providerId: entry.providerId || entry.provider,
    acpSessionId,
    uiId: entry.uiId,
    parentAcpSessionId: entry.parentAcpSessionId,
    parentUiId: entry.parentUiId,
    invocationId: entry.invocationId,
    index: entry.index,
    name: entry.name,
    prompt: entry.prompt,
    agent: entry.agent,
    model: entry.model,
    status: entry.status,
    invocationStatus: entry.invocationStatus,
    totalCount: entry.totalCount,
    completedCount: entry.completedCount,
    statusToolName: entry.statusToolName,
  });
}

async function emitDbBackedSubAgentSnapshots(socket, { sessionId, providerId, emittedKeys }) {
  if (typeof db.getSubAgentInvocationsForParent !== 'function') return;
  const parentSession = typeof db.getSessionByAcpId === 'function'
    ? (providerId ? await db.getSessionByAcpId(providerId, sessionId) : await db.getSessionByAcpId(sessionId))
    : null;
  const resolvedProviderId = providerId || parentSession?.provider || null;
  if (!resolvedProviderId) return;

  const parentUiId = parentSession?.id || null;
  const invocations = await db.getSubAgentInvocationsForParent(resolvedProviderId, parentUiId, sessionId);
  for (const invocation of invocations || []) {
    const snapshot = typeof db.getSubAgentInvocationWithAgents === 'function'
      ? await db.getSubAgentInvocationWithAgents(resolvedProviderId, invocation.invocationId)
      : null;
    if (!snapshot) continue;
    emitSubAgentInvocationSnapshot(socket, snapshot, {
      parentAcpSessionId: sessionId,
      parentUiId,
      providerId: resolvedProviderId
    });
    const agents = snapshot.agents || [];
    for (const agentRecord of agents) {
      emitSubAgentSnapshot(socket, {
        providerId: snapshot.provider || resolvedProviderId,
        acpSessionId: agentRecord.acpSessionId,
        uiId: agentRecord.uiId,
        parentAcpSessionId: snapshot.parentAcpSessionId || sessionId,
        parentUiId: snapshot.parentUiId || parentUiId,
        invocationId: snapshot.invocationId,
        index: agentRecord.index,
        name: agentRecord.name,
        prompt: agentRecord.prompt,
        agent: agentRecord.agent,
        model: agentRecord.model,
        status: agentRecord.status,
        invocationStatus: snapshot.status,
        totalCount: snapshot.totalCount,
        completedCount: snapshot.completedCount,
        statusToolName: snapshot.statusToolName,
      }, emittedKeys);
    }
  }
}

export async function emitSubAgentSnapshotsForSession(socket, { sessionId, providerId = null }) {
  if (!sessionId) return;
  const emittedKeys = new Set();
  const running = subAgentInvocationManager.getSnapshotsForParent(sessionId).filter(s => !providerId || s.providerId === providerId);
  for (const entry of running) emitSubAgentSnapshot(socket, entry, emittedKeys);

  try {
    await emitDbBackedSubAgentSnapshots(socket, { sessionId, providerId, emittedKeys });
  } catch (err) {
    writeLog(`[SUB-AGENT SNAPSHOT ERR] ${err.message}`);
  }
}
