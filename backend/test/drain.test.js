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
  }),
  runWithProvider: vi.fn((_providerId, fn) => fn())
}));

describe('AcpClient Drain Logic', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockEmit = vi.fn();
    mockIo = { emit: mockEmit, to: () => ({ emit: mockEmit }) };
    acpClient.resetForTesting();
    acpClient.io = mockIo;
    acpClient.providerId = 'provider-a';
    acpClient.sessionMetadata.set('test-session', { usedTokens: 0 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize drain state correctly with beginDraining', () => {
    const sessionId = 'test-session';
    acpClient.stream.beginDraining(sessionId);
    
    expect(acpClient.stream.drainingSessions.has(sessionId)).toBe(true);
    const state = acpClient.stream.drainingSessions.get(sessionId);
    expect(state.chunkCount).toBe(0);
    expect(state.timer).toBeUndefined();
  });

  it('should resolve waitForDrainToFinish after silence period', async () => {
    const sessionId = 'test-session';
    acpClient.stream.beginDraining(sessionId);
    
    const drainPromise = acpClient.stream.waitForDrainToFinish(sessionId, 1000);
    
    // Fast forward time
    vi.advanceTimersByTime(1000);
    
    await drainPromise;
    
    // Drain state should be cleaned up
    expect(acpClient.stream.drainingSessions.has(sessionId)).toBe(false);
  });

  it('should drop chunks and reset timer while draining', async () => {
    const sessionId = 'test-session';
    acpClient.stream.beginDraining(sessionId);
    
    let resolved = false;
    acpClient.stream.waitForDrainToFinish(sessionId, 1000).then(() => resolved = true);
    
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
    const state = acpClient.stream.drainingSessions.get(sessionId);
    expect(state.chunkCount).toBe(1);
    
    // Advance another 900ms (Total 1400ms, but timer reset at 500ms so it needs 1500ms total)
    vi.advanceTimersByTime(900);
    expect(resolved).toBe(false); // Should not be resolved yet
    
    // Advance past the reset point (needs 100ms more)
    vi.advanceTimersByTime(100);
    
    // We need to await a microtick for the promise to fully resolve in vitest
    await Promise.resolve();
    
    expect(resolved).toBe(true);
    expect(acpClient.stream.drainingSessions.has(sessionId)).toBe(false);
  });

  it('should process chunks normally when not draining', async () => {
    const sessionId = 'test-session';

    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'Real message' }
    };

    await acpClient.handleUpdate(sessionId, update);

    expect(mockIo.emit).toHaveBeenCalledWith('token', expect.objectContaining({ providerId: 'provider-a', sessionId, text: 'Real message' }));
  });

  it('should allow metadata to pass through during drain while swallowing messages', async () => {
    const sessionId = 'test-session';
    acpClient.stream.beginDraining(sessionId);
    
    // 1. Message chunk should be swallowed
    const messageUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'Swallow me' }
    };
    await acpClient.handleUpdate(sessionId, messageUpdate);
    expect(mockIo.emit).not.toHaveBeenCalledWith('token', expect.any(Object));

    // 2. Usage update (metadata) should NOT be swallowed
    const usageUpdate = {
      sessionUpdate: 'usage_update',
      used: 123,
      size: 1000
    };
    await acpClient.handleUpdate(sessionId, usageUpdate);
    expect(mockIo.emit).toHaveBeenCalledWith('stats_push', expect.objectContaining({ usedTokens: 123 }));
  });

  it('should clear existing timer when beginDraining is called again for same session', () => {
    const sessionId = 'test-session';

    acpClient.stream.beginDraining(sessionId);
    acpClient.stream.waitForDrainToFinish(sessionId, 1000); // starts a timer

    const stateBefore = acpClient.stream.drainingSessions.get(sessionId);
    expect(stateBefore.timer).not.toBeUndefined();

    acpClient.stream.beginDraining(sessionId); // should clearTimeout the existing timer

    const stateAfter = acpClient.stream.drainingSessions.get(sessionId);
    expect(stateAfter.chunkCount).toBe(0);
    expect(stateAfter.timer).toBeUndefined();
  });

  it('should resolve immediately when session is not draining', async () => {
    const sessionId = 'not-draining-session';

    const promise = acpClient.stream.waitForDrainToFinish(sessionId);
    await promise; // must resolve without timer advancement

    expect(acpClient.stream.drainingSessions.has(sessionId)).toBe(false);
  });
});
