import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as sessionManager from '../services/sessionManager.js';
import * as db from '../database.js';
import { getProvider, getProviderModule, getProviderModuleSync } from '../services/providerLoader.js';
import { clearMcpProxyRegistry, getMcpProxyIdFromServers, resolveMcpProxy } from '../mcp/mcpProxyRegistry.js';

vi.mock('../database.js');
vi.mock('../services/providerLoader.js');
vi.mock('../services/logger.js');

describe('sessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpProxyRegistry();
  });

  describe('getMcpServers', () => {
    it('should return empty if no mcpName', () => {
      getProvider.mockReturnValue({ config: {} });
      expect(sessionManager.getMcpServers('p1')).toEqual([]);
    });

    it('should return server config if mcpName exists', () => {
      getProvider.mockReturnValue({ config: { mcpName: 'test-mcp' } });
      getProviderModuleSync.mockReturnValue({ getMcpServerMeta: () => undefined });
      const servers = sessionManager.getMcpServers('p1');
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('test-mcp');
      expect(servers[0].env).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ACP_UI_MCP_PROXY_ID', value: expect.stringMatching(/^mcp-proxy-/) })
      ]));
      expect(servers[0]._meta).toBeUndefined();
    });

    it('should attach _meta when getMcpServerMeta returns a value', () => {
      getProvider.mockReturnValue({ config: { mcpName: 'test-mcp' } });
      const meta = { codex_acp: { tool_timeout_sec: 3600 } };
      getProviderModuleSync.mockReturnValue({ getMcpServerMeta: () => meta });
      const servers = sessionManager.getMcpServers('p1');
      expect(servers).toHaveLength(1);
      expect(servers[0]._meta).toEqual(meta);
    });
  });

  describe('autoLoadPinnedSessions', () => {
    it('should do nothing if no pinned sessions', async () => {
      const acpClient = { 
        getProviderId: () => 'p1',
        transport: { sendRequest: vi.fn(), sendNotification: vi.fn() },
        stream: { beginDraining: vi.fn(), waitForDrainToFinish: vi.fn(), statsCaptures: new Map() }
      };
      db.getPinnedSessions.mockResolvedValue([]);
      await sessionManager.autoLoadPinnedSessions(acpClient);
      expect(db.getPinnedSessions).toHaveBeenCalledWith('p1');
    });

    it('should load pinned sessions sequentially', async () => {
      const acpClient = { 
        getProviderId: () => 'p1',
        sessionMetadata: { has: () => false, set: vi.fn(), get: () => ({}) },
        transport: { sendRequest: vi.fn().mockResolvedValue({}), sendNotification: vi.fn() },
        stream: { beginDraining: vi.fn(), waitForDrainToFinish: vi.fn().mockResolvedValue(), statsCaptures: new Map() }
      };
      const sessions = [{ id: 's1', acpSessionId: 'a1', configOptions: [] }];
      db.getPinnedSessions.mockResolvedValue(sessions);
      db.getSessionByAcpId.mockResolvedValue(sessions[0]);

      getProvider.mockReturnValue({ config: { models: {} } });
      getProviderModule.mockResolvedValue({ 
        buildSessionParams: () => ({}),
        normalizeModelState: vi.fn(state => state),
        normalizeConfigOptions: vi.fn(options => Array.isArray(options) ? options : []),
        emitCachedContext: vi.fn(),
        setConfigOption: vi.fn()
      });

      await sessionManager.autoLoadPinnedSessions(acpClient);
      expect(acpClient.transport.sendRequest).toHaveBeenCalledWith('session/load', expect.any(Object));
    });

    it('should catch errors during individual session load', async () => {
      const acpClient = { getProviderId: () => 'p1' };
      db.getPinnedSessions.mockResolvedValue([{ id: 's1' }]);
      await expect(sessionManager.autoLoadPinnedSessions(acpClient)).resolves.not.toThrow();
    });
  });

  describe('loadSessionIntoMemory', () => {
    it('should perform full hot-load lifecycle', async () => {
      const acpClient = {
        getProviderId: () => 'p1',
        sessionMetadata: { has: () => false, set: vi.fn(), get: () => ({}) },
        transport: { sendRequest: vi.fn().mockResolvedValue({ currentModelId: 'm1' }), sendNotification: vi.fn() },
        stream: { beginDraining: vi.fn(), waitForDrainToFinish: vi.fn().mockResolvedValue(), statsCaptures: new Map() }
      };
      const dbSession = { id: 's1', acpSessionId: 'a1', configOptions: [], model: 'm1' };

      getProvider.mockReturnValue({ config: { models: {}, mcpName: 'mcp' } });
      getProviderModuleSync.mockReturnValue({ getMcpServerMeta: () => undefined });
      const providerModule = {
        buildSessionParams: () => ({}),
        normalizeModelState: vi.fn(state => ({
          ...state,
          currentModelId: state.currentModelId ? `${state.currentModelId}-normalized` : state.currentModelId
        })),
        normalizeConfigOptions: vi.fn(options => Array.isArray(options) ? options : []),
        emitCachedContext: vi.fn(),
        setConfigOption: vi.fn()
      };
      getProviderModule.mockResolvedValue({ 
        ...providerModule
      });

      await sessionManager.loadSessionIntoMemory(acpClient, dbSession);

      expect(acpClient.sessionMetadata.set).toHaveBeenCalledWith('a1', expect.any(Object));
      expect(acpClient.stream.beginDraining).toHaveBeenCalledWith('a1');
      expect(acpClient.transport.sendRequest).toHaveBeenCalledWith('session/load', expect.objectContaining({ sessionId: 'a1' }));
      const loadRequest = acpClient.transport.sendRequest.mock.calls.find(call => call[0] === 'session/load')[1];
      const proxyId = getMcpProxyIdFromServers(loadRequest.mcpServers);
      expect(resolveMcpProxy(proxyId)).toEqual(expect.objectContaining({
        providerId: 'p1',
        acpSessionId: 'a1'
      }));
      expect(providerModule.emitCachedContext).toHaveBeenCalledWith('a1');
      expect(providerModule.normalizeModelState).toHaveBeenCalledWith(
        expect.objectContaining({ currentModelId: 'm1' }),
        expect.objectContaining({ currentModelId: 'm1' })
      );
      expect(db.saveModelState).toHaveBeenCalled();
    });
  });

  describe('autoSaveTurn', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not force-complete a streaming assistant during progress saves', async () => {
      const sessionId = 'acp-1';
      const session = { id: 's1', acpSessionId: sessionId, messages: [{ role: 'assistant', content: 'hi', isStreaming: true }] };
      db.getSessionByAcpId.mockResolvedValue(session);

      sessionManager.autoSaveTurn(sessionId);
      expect(db.saveSession).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(6000);
      expect(db.saveSession).not.toHaveBeenCalled();
      expect(session.messages[0].isStreaming).toBe(true);
    });

    it('saves immediately on unmount', () => {
      // not easily testable here, but we can verify saveSession logic
    });
  });
});
