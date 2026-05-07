import { randomUUID } from 'crypto';

const DEFAULT_UNBOUND_PROXY_TTL_MS = 30 * 60 * 1000;
const proxies = new Map();

function cloneProxy(proxy) {
  return proxy ? { ...proxy } : null;
}

export function createMcpProxyBinding({ providerId, acpSessionId = null, now = Date.now() } = {}) {
  if (!providerId) {
    throw new Error('providerId is required to create an MCP proxy binding');
  }

  expireMcpProxyBindings(now);
  const proxyId = `mcp-proxy-${randomUUID()}`;
  proxies.set(proxyId, {
    proxyId,
    providerId,
    acpSessionId,
    createdAt: now,
    boundAt: acpSessionId ? now : null,
    lastSeenAt: now
  });
  return proxyId;
}

export function bindMcpProxy(proxyId, { providerId, acpSessionId, now = Date.now() } = {}) {
  if (!proxyId || !acpSessionId) return null;
  const existing = proxies.get(proxyId);
  if (!existing) return null;

  if (providerId && existing.providerId !== providerId) {
    throw new Error(`Cannot bind MCP proxy ${proxyId} for provider ${providerId}; expected ${existing.providerId}`);
  }

  const updated = {
    ...existing,
    acpSessionId,
    boundAt: existing.boundAt || now,
    lastSeenAt: now
  };
  proxies.set(proxyId, updated);
  return cloneProxy(updated);
}

export function resolveMcpProxy(proxyId, now = Date.now()) {
  if (!proxyId) return null;
  expireMcpProxyBindings(now);
  const existing = proxies.get(proxyId);
  if (!existing) return null;
  existing.lastSeenAt = now;
  return cloneProxy(existing);
}

export function expireMcpProxyBindings(now = Date.now(), ttlMs = DEFAULT_UNBOUND_PROXY_TTL_MS) {
  let removed = 0;
  for (const [proxyId, proxy] of proxies.entries()) {
    if (!proxy.acpSessionId && now - proxy.createdAt > ttlMs) {
      proxies.delete(proxyId);
      removed++;
    }
  }
  return removed;
}

export function getMcpProxyIdFromServers(mcpServers = []) {
  for (const server of mcpServers || []) {
    const env = Array.isArray(server?.env) ? server.env : [];
    const proxyEntry = env.find(entry => entry?.name === 'ACP_UI_MCP_PROXY_ID');
    if (proxyEntry?.value) return String(proxyEntry.value);
  }
  return null;
}

export function clearMcpProxyRegistry() {
  proxies.clear();
}
