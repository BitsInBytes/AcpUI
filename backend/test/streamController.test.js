import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamController } from '../services/streamController.js';

describe('StreamController', () => {
  let controller;

  beforeEach(() => {
    controller = new StreamController();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Draining (Silence Heuristic)', () => {
    it('should stay in draining state as long as chunks arrive', async () => {
      const sessionId = 'sess-1';
      controller.beginDraining(sessionId);
      
      let resolved = false;
      const promise = controller.waitForDrainToFinish(sessionId, 1000).then(() => {
        resolved = true;
      });

      // At 500ms, chunk arrives
      vi.advanceTimersByTime(500);
      controller.onChunk(sessionId);
      expect(resolved).toBe(false);

      // At 1200ms (700ms after last chunk), another chunk arrives
      vi.advanceTimersByTime(700);
      controller.onChunk(sessionId);
      expect(resolved).toBe(false);

      // At 2100ms (900ms after last chunk), still draining
      vi.advanceTimersByTime(900);
      expect(resolved).toBe(false);

      // Finally at 2300ms (1100ms after last chunk), it should have resolved
      vi.advanceTimersByTime(200);
      await Promise.resolve(); // microtick
      expect(resolved).toBe(true);
    });

    it('should track chunk counts accurately during drain', () => {
      const sessionId = 'sess-1';
      controller.beginDraining(sessionId);
      
      controller.onChunk(sessionId);
      controller.onChunk(sessionId);
      controller.onChunk(sessionId);

      const state = controller.drainingSessions.get(sessionId);
      expect(state.chunkCount).toBe(3);
    });

    it('should support multiple concurrent draining sessions with independent timers', async () => {
      let resolved1 = false;
      let resolved2 = false;

      controller.beginDraining('s1');
      controller.beginDraining('s2');

      controller.waitForDrainToFinish('s1', 1000).then(() => resolved1 = true);
      controller.waitForDrainToFinish('s2', 2000).then(() => resolved2 = true);

      vi.advanceTimersByTime(1100);
      await Promise.resolve();
      expect(resolved1).toBe(true);
      expect(resolved2).toBe(false);

      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(resolved2).toBe(true);
    });
  });

  describe('Stats Capture', () => {
    it('should isolate stats capture buffers between sessions', () => {
      controller.statsCaptures.set('s1', { buffer: 'hello' });
      controller.statsCaptures.set('s2', { buffer: 'world' });

      expect(controller.statsCaptures.get('s1').buffer).toBe('hello');
      expect(controller.statsCaptures.get('s2').buffer).toBe('world');
    });
  });

  describe('Lifecycle', () => {
    it('should clear all state on reset', () => {
      controller.beginDraining('s1');
      controller.statsCaptures.set('s1', { buffer: '...' });
      
      controller.reset();
      
      expect(controller.drainingSessions.size).toBe(0);
      expect(controller.statsCaptures.size).toBe(0);
    });

    it('should resolve pending waitForDrain promises on reset', async () => {
      controller.beginDraining('s1');
      let resolved = false;
      controller.waitForDrainToFinish('s1', 10000).then(() => resolved = true);

      controller.reset();
      await Promise.resolve();
      
      expect(resolved).toBe(true);
    });
  });
});
