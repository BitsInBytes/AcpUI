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
    getSessionByAcpId: vi.fn()
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
  getSessionByAcpId: mockDb.getSessionByAcpId
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
    mockDb.getSessionByAcpId.mockResolvedValue(null);
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

      expect(mockDb.getSessionByAcpId).toHaveBeenCalledWith('provider-a', sessionId);
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

    it('uses default total tokens when persisted stats do not include a total', async () => {
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
          totalTokens: 1000000
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
          totalTokens: 1000000
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
