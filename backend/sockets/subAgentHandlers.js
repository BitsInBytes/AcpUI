import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';

export function emitSubAgentSnapshotsForSession(socket, { sessionId, providerId = null }) {
  if (!sessionId) return;
  const running = subAgentInvocationManager.getSnapshotsForParent(sessionId).filter(s => !providerId || s.providerId === providerId);
  for (const entry of running) {
    socket.emit('sub_agent_snapshot', {
      providerId: entry.providerId,
      acpSessionId: entry.acpId,
      uiId: entry.uiId,
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