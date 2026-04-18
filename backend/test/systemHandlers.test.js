import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerSystemHandlers from '../sockets/systemHandlers.js';
import EventEmitter from 'events';

const { mockAcpClient } = vi.hoisted(() => ({
  mockAcpClient: {
    sessionMetadata: new Map()
  }
}));

vi.mock('../services/acpClient.js', () => ({
  default: mockAcpClient
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
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
  });
});
