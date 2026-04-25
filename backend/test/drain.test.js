import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import acpClient from '../services/acpClient.js';

vi.mock('../database.js', () => ({
  initDb: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({ config: { paths: { sessions: '/tmp' } } }),
  getProviderModule: vi.fn().mockResolvedValue({
    normalizeUpdate: (u) => u,
    extractFilePath: () => undefined,
    extractDiffFromToolCall: () => undefined,
    normalizeTool: (e) => e,
    categorizeToolCall: () => null,
    parseExtension: () => null,
  })
}));

describe('AcpClient Drain Logic', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockEmit = vi.fn();
    mockIo = { emit: mockEmit, to: () => ({ emit: mockEmit }) };
    acpClient.io = mockIo;
    acpClient.drainingSessions.clear();
    acpClient.sessionMetadata.clear();
    acpClient.sessionMetadata.set('test-session', { usedTokens: 0 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize drain state correctly with beginDraining', () => {
    const sessionId = 'test-session';
    acpClient.beginDraining(sessionId);
    
    expect(acpClient.drainingSessions.has(sessionId)).toBe(true);
    const state = acpClient.drainingSessions.get(sessionId);
    expect(state.chunkCount).toBe(0);
    expect(state.timer).toBeNull();
  });

  it('should resolve waitForDrainToFinish after silence period', async () => {
    const sessionId = 'test-session';
    acpClient.beginDraining(sessionId);
    
    const drainPromise = acpClient.waitForDrainToFinish(sessionId, 1000);
    
    // Fast forward time
    vi.advanceTimersByTime(1000);
    
    await drainPromise;
    
    // Drain state should be cleaned up
    expect(acpClient.drainingSessions.has(sessionId)).toBe(false);
  });

  it('should drop chunks and reset timer while draining', async () => {
    const sessionId = 'test-session';
    acpClient.beginDraining(sessionId);
    
    let resolved = false;
    acpClient.waitForDrainToFinish(sessionId, 1000).then(() => resolved = true);
    
    // Advance time slightly
    vi.advanceTimersByTime(500);
    
    // Simulate chunk arriving
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'Ghost History' }
    };
    await acpClient.handleUpdate(sessionId, update);
    
    // The chunk should be dropped (not emitted)
    expect(mockIo.emit).not.toHaveBeenCalledWith('token', expect.any(Object));
    
    // The counter should increment
    const state = acpClient.drainingSessions.get(sessionId);
    expect(state.chunkCount).toBe(1);
    
    // Advance another 900ms (Total 1400ms, but timer reset at 500ms so it needs 1500ms total)
    vi.advanceTimersByTime(900);
    expect(resolved).toBe(false); // Should not be resolved yet
    
    // Advance past the reset point (needs 100ms more)
    vi.advanceTimersByTime(100);
    
    // We need to await a microtick for the promise to fully resolve in vitest
    await Promise.resolve();
    
    expect(resolved).toBe(true);
    expect(acpClient.drainingSessions.has(sessionId)).toBe(false);
  });

  it('should process chunks normally when not draining', async () => {
    const sessionId = 'test-session';

    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'Real message' }
    };

    await acpClient.handleUpdate(sessionId, update);

    expect(mockIo.emit).toHaveBeenCalledWith('token', { sessionId, text: 'Real message' });
  });

  it('should clear existing timer when beginDraining is called again for same session', () => {
    const sessionId = 'test-session';

    acpClient.beginDraining(sessionId);
    acpClient.waitForDrainToFinish(sessionId, 1000); // starts a timer

    const stateBefore = acpClient.drainingSessions.get(sessionId);
    expect(stateBefore.timer).not.toBeNull();

    acpClient.beginDraining(sessionId); // should clearTimeout the existing timer

    const stateAfter = acpClient.drainingSessions.get(sessionId);
    expect(stateAfter.chunkCount).toBe(0);
    expect(stateAfter.timer).toBeNull();
  });

  it('should resolve immediately when session is not draining', async () => {
    const sessionId = 'not-draining-session';

    const promise = acpClient.waitForDrainToFinish(sessionId);
    await promise; // must resolve without timer advancement

    expect(acpClient.drainingSessions.has(sessionId)).toBe(false);
  });
});