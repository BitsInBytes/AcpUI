// In-memory registry tracking sub-agent lifecycle (running/completed/failed).
// Used by cancel_prompt to find and kill active sub-agents, and by the parent
// to correlate sub-agent ACP sessions back to the spawning context.
// Key: sub-agent ACP session ID → { parentSessionId, prompt, agent, status }

const registry = new Map();

export function registerSubAgent(subAgentAcpId, parentAcpSessionId, prompt, agent) {
  registry.set(subAgentAcpId, { parentAcpSessionId, prompt, agent, status: 'running' });
}

export function completeSubAgent(subAgentAcpId) {
  const entry = registry.get(subAgentAcpId);
  if (entry) entry.status = 'completed';
}

export function failSubAgent(subAgentAcpId) {
  const entry = registry.get(subAgentAcpId);
  if (entry) entry.status = 'failed';
}

export function getSubAgent(subAgentAcpId) {
  return registry.get(subAgentAcpId);
}

export function getSubAgentsForParent(parentAcpSessionId) {
  const result = [];
  for (const [acpId, entry] of registry) {
    if (entry.parentAcpSessionId === parentAcpSessionId) {
      result.push({ acpId, ...entry });
    }
  }
  return result;
}

export function getAllRunning() {
  const result = [];
  for (const [acpId, entry] of registry) {
    if (entry.status === 'running') result.push({ acpId, ...entry });
  }
  return result;
}

export function removeSubAgentsForParent(parentAcpSessionId) {
  if (parentAcpSessionId === null) { registry.clear(); return; }
  for (const [acpId, entry] of registry) {
    if (entry.parentAcpSessionId === parentAcpSessionId) registry.delete(acpId);
  }
}
