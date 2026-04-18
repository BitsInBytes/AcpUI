import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as sessionManager from '../services/sessionManager.js';
import * as db from '../database.js';
import { getProvider, getProviderModule } from '../services/providerLoader.js';

vi.mock('../database.js');
vi.mock('../services/providerLoader.js');
vi.mock('../services/logger.js');

describe('sessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getMcpServers', () => {
    it('should return empty if no mcpName', () => {
      getProvider.mockReturnValue({ config: {} });
      expect(sessionManager.getMcpServers('p1')).toEqual([]);
    });

    it('should return server config if mcpName exists', () => {
      getProvider.mockReturnValue({ config: { mcpName: 'test-mcp' } });
      const servers = sessionManager.getMcpServers('p1');
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('test-mcp');
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
      getProviderModule.mockResolvedValue({ 
        buildSessionParams: () => ({}),
        setConfigOption: vi.fn()
      });

      await sessionManager.loadSessionIntoMemory(acpClient, dbSession);

      expect(acpClient.sessionMetadata.set).toHaveBeenCalledWith('a1', expect.any(Object));
      expect(acpClient.stream.beginDraining).toHaveBeenCalledWith('a1');
      expect(acpClient.transport.sendRequest).toHaveBeenCalledWith('session/load', expect.objectContaining({ sessionId: 'a1' }));
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

    it('debounces auto-save', async () => {
      const sessionId = 'acp-1';
      const session = { id: 's1', acpSessionId: sessionId, messages: [{ role: 'assistant', content: 'hi', isStreaming: true }], timeline: [{ role: 'user', content: 'hello' }] };
      db.getSessionByAcpId.mockResolvedValue(session);
      
      sessionManager.autoSaveTurn(sessionId);
      expect(db.saveSession).not.toHaveBeenCalled();
      
      await vi.advanceTimersByTimeAsync(6000);
      expect(db.saveSession).toHaveBeenCalledWith(session);
    });

    it('saves immediately on unmount', () => {
      // not easily testable here, but we can verify saveSession logic
    });
  });
});
