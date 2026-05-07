import { describe, it, expect, beforeEach } from 'vitest';
import {
  bindMcpProxy,
  clearMcpProxyRegistry,
  createMcpProxyBinding,
  expireMcpProxyBindings,
  getMcpProxyIdFromServers,
  resolveMcpProxy
} from '../mcp/mcpProxyRegistry.js';

describe('mcpProxyRegistry', () => {
  beforeEach(() => {
    clearMcpProxyRegistry();
  });

  it('creates and resolves a pending proxy binding', () => {
    const proxyId = createMcpProxyBinding({ providerId: 'provider-a', now: 1000 });

    expect(proxyId).toMatch(/^mcp-proxy-/);
    expect(resolveMcpProxy(proxyId, 1001)).toEqual(expect.objectContaining({
      proxyId,
      providerId: 'provider-a',
      acpSessionId: null,
      createdAt: 1000,
      lastSeenAt: 1001
    }));
  });

  it('creates pre-bound proxy bindings for known sessions', () => {
    const proxyId = createMcpProxyBinding({
      providerId: 'provider-a',
      acpSessionId: 'acp-1',
      now: 1000
    });

    expect(resolveMcpProxy(proxyId)).toEqual(expect.objectContaining({
      providerId: 'provider-a',
      acpSessionId: 'acp-1',
      boundAt: 1000
    }));
  });

  it('binds pending proxy bindings after session creation', () => {
    const proxyId = createMcpProxyBinding({ providerId: 'provider-a', now: 1000 });
    const bound = bindMcpProxy(proxyId, {
      providerId: 'provider-a',
      acpSessionId: 'acp-2',
      now: 1200
    });

    expect(bound).toEqual(expect.objectContaining({
      proxyId,
      providerId: 'provider-a',
      acpSessionId: 'acp-2',
      boundAt: 1200
    }));
  });

  it('rejects provider mismatches when binding', () => {
    const proxyId = createMcpProxyBinding({ providerId: 'provider-a' });

    expect(() => bindMcpProxy(proxyId, {
      providerId: 'provider-b',
      acpSessionId: 'acp-3'
    })).toThrow('expected provider-a');
  });

  it('expires only unbound proxy bindings', () => {
    const pending = createMcpProxyBinding({ providerId: 'provider-a', now: 1000 });
    const bound = createMcpProxyBinding({ providerId: 'provider-a', acpSessionId: 'acp-1', now: 1000 });

    expect(expireMcpProxyBindings(2000, 500)).toBe(1);
    expect(resolveMcpProxy(pending)).toBeNull();
    expect(resolveMcpProxy(bound)).toEqual(expect.objectContaining({ acpSessionId: 'acp-1' }));
  });

  it('extracts proxy id from MCP server env', () => {
    expect(getMcpProxyIdFromServers([
      {
        env: [
          { name: 'ACP_SESSION_PROVIDER_ID', value: 'provider-a' },
          { name: 'ACP_UI_MCP_PROXY_ID', value: 'mcp-proxy-test' }
        ]
      }
    ])).toBe('mcp-proxy-test');
  });
});
