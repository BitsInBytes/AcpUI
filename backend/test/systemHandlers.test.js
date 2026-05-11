import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerSystemHandlers from '../sockets/systemHandlers.js';
import EventEmitter from 'events';

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn()
  }
}));

const { mockAcpClient } = vi.hoisted(() => ({
  mockAcpClient: {
    sessionMetadata: new Map(),
    providerId: 'provider-a',
    getProviderId: vi.fn(() => 'provider-a')
  }
}));

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    getSessionByAcpId: vi.fn(),
    getSession: vi.fn()
  }
}));

const { mockProviderRuntimeManager } = vi.hoisted(() => ({
  mockProviderRuntimeManager: {
    getClient: vi.fn()
  }
}));

const { mockGetLogFilePath } = vi.hoisted(() => ({
  mockGetLogFilePath: vi.fn(() => 'test.log')
}));

vi.mock('fs', () => ({ default: mockFs }));

vi.mock('../services/acpClient.js', () => ({
  default: mockAcpClient
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn(),
  getLogFilePath: mockGetLogFilePath
}));

vi.mock('../database.js', () => ({
  getSessionByAcpId: mockDb.getSessionByAcpId,
  getSession: mockDb.getSession
}));

vi.mock('../services/providerRuntimeManager.js', () => ({
  default: mockProviderRuntimeManager
}));

describe('System Handlers', () => {
  let mockIo;
  let mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockEmit = vi.fn();
    mockIo = { emit: mockEmit, to: () => ({ emit: mockEmit }) };
    mockSocket = new EventEmitter();
    registerSystemHandlers(mockIo, mockSocket);
    mockAcpClient.sessionMetadata.clear();
    mockAcpClient.providerId = 'provider-a';
    mockAcpClient.getProviderId.mockReturnValue('provider-a');
    mockProviderRuntimeManager.getClient.mockReturnValue(mockAcpClient);
    mockDb.getSessionByAcpId.mockResolvedValue(null);
    mockDb.getSession.mockResolvedValue(null);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('');
    mockGetLogFilePath.mockReturnValue('test.log');
  });

  describe('get_stats', () => {
    it('should return stats for a valid session', async () => {
      const sessionId = 'sess-123';
      const startTime = Date.now() - 10000;
      mockAcpClient.sessionMetadata.set(sessionId, {
        model: 'flagship-model-id',
        toolCalls: 5,
        successTools: 4,
        startTime,
        usedTokens: 500,
        totalTokens: 2000000
      });

      const callback = vi.fn();
      const handler = mockSocket.listeners('get_stats')[0];
      await handler({ sessionId }, callback);

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({
          sessionId,
          model: 'flagship-model-id',
          toolCalls: 5,
          successTools: 4,
          usedTokens: 500,
          totalTokens: 2000000,
          sessionPath: 'Relative'
        })
      }));
    });

    it('returns persisted stats when session metadata is not loaded', async () => {
      const sessionId = 'persisted-acp';
      mockDb.getSessionByAcpId.mockResolvedValueOnce({
        model: 'stored-model-label',
        currentModelId: 'stored-model-id',
        stats: {
          usedTokens: 750,
          totalTokens: 2000
        }
      });

      const callback = vi.fn();
      const handler = mockSocket.listeners('get_stats')[0];
      await handler({ sessionId }, callback);

      expect(mockDb.getSessionByAcpId).toHaveBeenCalledWith(sessionId);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({
          providerId: 'provider-a',
          sessionId,
          model: 'stored-model-id',
          usedTokens: 750,
          totalTokens: 2000
        })
      }));
    });

    it('keeps total tokens at zero when persisted stats do not include a total', async () => {
      const sessionId = 'zero-total-acp';
      mockDb.getSessionByAcpId.mockResolvedValueOnce({
        model: 'stored-model-label',
        stats: {
          usedTokens: 12,
          totalTokens: 0
        }
      });

      const callback = vi.fn();
      const handler = mockSocket.listeners('get_stats')[0];
      await handler({ sessionId }, callback);

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({
          model: 'stored-model-label',
          usedTokens: 12,
          totalTokens: 0
        })
      }));
    });

    it('falls back to default stats when persisted lookup fails', async () => {
      const sessionId = 'missing-acp';
      mockDb.getSessionByAcpId.mockRejectedValueOnce(new Error('database unavailable'));

      const callback = vi.fn();
      const handler = mockSocket.listeners('get_stats')[0];
      await handler({ sessionId }, callback);

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({
          sessionId,
          model: 'Unknown',
          usedTokens: 0,
          totalTokens: 0
        })
      }));
    });

    it('backfills persisted stats when loaded metadata has zero token counts', async () => {
      const sessionId = 'hot-session-zero-tokens';
      mockAcpClient.sessionMetadata.set(sessionId, {
        model: 'runtime-model',
        toolCalls: 3,
        successTools: 2,
        startTime: Date.now() - 5000,
        usedTokens: 0,
        totalTokens: 0
      });
      mockDb.getSessionByAcpId.mockResolvedValueOnce({
        model: 'stored-model',
        currentModelId: 'stored-model-id',
        stats: {
          usedTokens: 900,
          totalTokens: 3000
        }
      });

      const callback = vi.fn();
      const handler = mockSocket.listeners('get_stats')[0];
      await handler({ sessionId }, callback);

      expect(mockDb.getSessionByAcpId).toHaveBeenCalledWith(sessionId);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({
          model: 'stored-model-id',
          usedTokens: 900,
          totalTokens: 3000
        })
      }));
    });

    it('backfills only missing token fields and preserves non-zero in-memory values', async () => {
      const sessionId = 'partial-backfill-acp';
      mockAcpClient.sessionMetadata.set(sessionId, {
        model: 'runtime-model',
        toolCalls: 1,
        successTools: 1,
        startTime: Date.now() - 2000,
        usedTokens: 111,
        totalTokens: 0
      });
      mockDb.getSessionByAcpId.mockResolvedValueOnce({
        model: 'stored-model',
        currentModelId: 'stored-model-id',
        stats: {
          usedTokens: 999,
          totalTokens: 5000
        }
      });

      const callback = vi.fn();
      const handler = mockSocket.listeners('get_stats')[0];
      await handler({ sessionId }, callback);

      expect(mockDb.getSessionByAcpId).toHaveBeenCalledWith(sessionId);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({
          model: 'stored-model-id',
          usedTokens: 111,
          totalTokens: 5000
        })
      }));
    });

    it('uses provider-scoped runtime metadata when providerId is provided', async () => {
      const sessionId = 'provider-b-session';
      const providerBClient = {
        sessionMetadata: new Map([[
          sessionId,
          {
            model: 'provider-b-model',
            toolCalls: 9,
            successTools: 8,
            startTime: Date.now() - 1500,
            usedTokens: 333,
            totalTokens: 999
          }
        ]]),
        getProviderId: vi.fn(() => 'provider-b'),
        providerId: 'provider-b'
      };
      mockProviderRuntimeManager.getClient.mockImplementation((pid) => pid === 'provider-b' ? providerBClient : mockAcpClient);

      const callback = vi.fn();
      const handler = mockSocket.listeners('get_stats')[0];
      await handler({ sessionId, providerId: 'provider-b' }, callback);

      expect(mockProviderRuntimeManager.getClient).toHaveBeenCalledWith('provider-b');
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        stats: expect.objectContaining({
          providerId: 'provider-b',
          model: 'provider-b-model',
          usedTokens: 333,
          totalTokens: 999,
          toolCalls: 9,
          successTools: 8
        })
      }));
    });
  });

  describe('get_logs', () => {
    it('emits log history when the log file exists', () => {
      mockGetLogFilePath.mockReturnValue('backend.log');
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('log text');

      const emitSpy = vi.spyOn(mockSocket, 'emit');
      mockSocket.emit('get_logs');

      expect(mockFs.existsSync).toHaveBeenCalledWith('backend.log');
      expect(mockFs.readFileSync).toHaveBeenCalledWith('backend.log', 'utf8');
      expect(emitSpy).toHaveBeenCalledWith('log_history', 'log text');
    });
  });
});
