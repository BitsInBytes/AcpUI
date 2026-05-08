// In-memory registry tracking sub-agent lifecycle (running/completed/failed).
// Used by cancel_prompt to find and kill active sub-agents, and by the parent
// to correlate sub-agent ACP sessions back to the spawning context.
// Key: sub-agent ACP session ID → { parentSessionId, prompt, agent, status }

const registry = new Map();

export function registerSubAgent(providerId, subAgentAcpId, {
  parentAcpSessionId,
  parentUiId,
  invocationId,
  uiId,
  name,
  index,
  prompt,
  agent,
  model
}) {
  registry.set(subAgentAcpId, {
    providerId,
    parentAcpSessionId,
    parentUiId,
    invocationId,
    uiId,
    name,
    index,
    prompt,
    agent,
    model,
    status: 'spawning'
  });
}

export function setSpawningSubAgent(subAgentAcpId) {
  const entry = registry.get(subAgentAcpId);
  if (entry) entry.status = 'spawning';
}

export function setPromptingSubAgent(subAgentAcpId) {
  const entry = registry.get(subAgentAcpId);
  if (entry) entry.status = 'prompting';
}

export function cancelSubAgent(subAgentAcpId) {
  const entry = registry.get(subAgentAcpId);
  if (entry) entry.status = 'cancelled';
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

export function getSubAgentsForParent(parentAcpSessionId, providerId = null) {
  const result = [];
  for (const [acpId, entry] of registry) {
    if (entry.parentAcpSessionId === parentAcpSessionId && (!providerId || entry.providerId === providerId)) {
      result.push({ acpId, ...entry });
    }
  }
  return result;
}

export function getAllRunning(providerId = null) {
  const result = [];
  for (const [acpId, entry] of registry) {
    if (['spawning', 'prompting', 'running'].includes(entry.status) && (!providerId || entry.providerId === providerId)) result.push({ acpId, ...entry });
  }
  return result;
}

export function removeSubAgentsForParent(parentAcpSessionId, providerId = null) {
  if (parentAcpSessionId === null) {
    for (const [acpId, entry] of registry) {
      if (!providerId || entry.providerId === providerId) registry.delete(acpId);
    }
    return;
  }
  for (const [acpId, entry] of registry) {
    if (entry.parentAcpSessionId === parentAcpSessionId && (!providerId || entry.providerId === providerId)) registry.delete(acpId);
  }
}
