import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as sessionManager from '../services/sessionManager.js';
import * as db from '../database.js';

vi.mock('../database.js', () => ({
  getSessionByAcpId: vi.fn(),
  saveSession: vi.fn()
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

describe('Session Manager Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('findSessionFiles should return an empty array when no files match', () => {
    const result = sessionManager.findSessionFiles('some-id');
    expect(result).toEqual([]);
  });

  describe('autoSaveTurn', () => {
    it('should complete a streaming message and save the session', async () => {
      vi.useFakeTimers();
      const sessionId = 'acp-123';
      const mockSession = {
        id: 'ui-123',
        acpSessionId: sessionId,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi', isStreaming: true }
        ]
      };

      db.getSessionByAcpId.mockResolvedValue(mockSession);

      const promise = sessionManager.autoSaveTurn(sessionId);
      await vi.advanceTimersByTimeAsync(5100);
      await promise;

      expect(mockSession.messages[1].isStreaming).toBe(false);
      expect(db.saveSession).toHaveBeenCalledWith(mockSession);
      vi.useRealTimers();
    });

    it('should not save if the assistant message is empty', async () => {
      vi.useFakeTimers();
      const sessionId = 'acp-empty';
      const mockSession = {
        messages: [{ role: 'assistant', content: '', isStreaming: true }]
      };

      db.getSessionByAcpId.mockResolvedValue(mockSession);

      const promise = sessionManager.autoSaveTurn(sessionId);
      await vi.advanceTimersByTimeAsync(5100);
      await promise;

      expect(db.saveSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('autoSaveTurn permission-aware skip', () => {
    it('should skip save when permission request is pending', async () => {
      vi.useFakeTimers();
      const sessionId = 'acp-perm';
      const mockAcpClient = {
        pendingPermissions: new Map([['acp-perm', true]])
      };

      const promise = sessionManager.autoSaveTurn(sessionId, mockAcpClient);
      await vi.advanceTimersByTimeAsync(5100);
      await promise;

      expect(db.getSessionByAcpId).not.toHaveBeenCalled();
      expect(db.saveSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('autoSaveTurn disconnected UI auto-complete', () => {
    it('should save when assistant message has timeline but no content', async () => {
      vi.useFakeTimers();
      const mockSession = {
        messages: [{ role: 'assistant', content: '', timeline: [{ type: 'thought' }], isStreaming: true }]
      };
      db.getSessionByAcpId.mockResolvedValue(mockSession);

      const promise = sessionManager.autoSaveTurn('acp-timeline');
      await vi.advanceTimersByTimeAsync(5100);
      await promise;

      expect(mockSession.messages[0].isStreaming).toBe(false);
      expect(db.saveSession).toHaveBeenCalledWith(mockSession);
      vi.useRealTimers();
    });

    it('should not save when last message is not assistant', async () => {
      vi.useFakeTimers();
      const mockSession = { messages: [{ role: 'user', content: 'hello' }] };
      db.getSessionByAcpId.mockResolvedValue(mockSession);

      const promise = sessionManager.autoSaveTurn('acp-user');
      await vi.advanceTimersByTimeAsync(5100);
      await promise;

      expect(db.saveSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should not save when assistant message is not streaming', async () => {
      vi.useFakeTimers();
      const mockSession = { messages: [{ role: 'assistant', content: 'done', isStreaming: false }] };
      db.getSessionByAcpId.mockResolvedValue(mockSession);

      const promise = sessionManager.autoSaveTurn('acp-done');
      await vi.advanceTimersByTimeAsync(5100);
      await promise;

      expect(db.saveSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should handle null session gracefully', async () => {
      vi.useFakeTimers();
      db.getSessionByAcpId.mockResolvedValue(null);

      const promise = sessionManager.autoSaveTurn('acp-null');
      await vi.advanceTimersByTimeAsync(5100);
      await promise;

      expect(db.saveSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should handle db error gracefully', async () => {
      vi.useFakeTimers();
      db.getSessionByAcpId.mockRejectedValue(new Error('db down'));

      const promise = sessionManager.autoSaveTurn('acp-err');
      await vi.advanceTimersByTimeAsync(5100);
      await promise;

      expect(db.saveSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
