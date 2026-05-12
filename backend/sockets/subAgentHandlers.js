import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';
import { writeLog } from '../services/logger.js';
import providerRuntimeManager from '../services/providerRuntimeManager.js';

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

export function emitSubAgentSnapshotsForSession(socket, { sessionId, providerId = null }) {
  if (!sessionId) return;
  const running = subAgentInvocationManager.getSnapshotsForParent(sessionId).filter(s => !providerId || s.providerId === providerId);
  for (const entry of running) {
    socket.emit('sub_agent_snapshot', {
      providerId: entry.providerId,
      acpSessionId: entry.acpId,
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
    });
  }
}
