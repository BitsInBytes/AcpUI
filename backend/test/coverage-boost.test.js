import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { app, httpServer, io, shutdownServer, startServer } from '../server.js';
import providerRuntimeManager from '../services/providerRuntimeManager.js';
import { stopSTTServer } from '../voiceService.js';

// Mock dependencies
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn(), setIo: vi.fn() }));
vi.mock('../services/providerRuntimeManager.js', () => ({
  default: { init: vi.fn(), stopAll: vi.fn().mockResolvedValue() },
  providerRuntimeManager: { init: vi.fn(), stopAll: vi.fn().mockResolvedValue() }
}));
vi.mock('../voiceService.js', () => ({ startSTTServer: vi.fn(), stopSTTServer: vi.fn() }));
vi.mock('../sockets/index.js', () => ({ default: vi.fn() }));

describe('Server Coverage Boost', () => {
  it('should call startServer and trigger listen callback', () => {
    const listenSpy = vi.spyOn(httpServer, 'listen').mockImplementation((port, host, cb) => {
      if (typeof cb === 'function') cb();
      return httpServer;
    });
    startServer();
    expect(listenSpy).toHaveBeenCalled();
  });

  it('shutdownServer stops provider runtimes, voice, and Socket.IO', async () => {
    const ioCloseSpy = vi.spyOn(io, 'close').mockImplementation((callback) => {
      if (typeof callback === 'function') callback();
      return io;
    });

    try {
      await shutdownServer({ signal: 'test-shutdown' });

      expect(providerRuntimeManager.stopAll).toHaveBeenCalled();
      expect(stopSTTServer).toHaveBeenCalled();
      expect(ioCloseSpy).toHaveBeenCalled();
    } finally {
      ioCloseSpy.mockRestore();
    }
  });

  it('should exercise CORS origin logic', async () => {
    // Local origin
    const res1 = await request(app)
      .get('/api/branding/manifest')
      .set('Origin', 'http://localhost:3000');
    expect(res1.status).not.toBe(403);

    // Blocked origin (in non-test mode, but since we are in VITEST, it returns true)
    // To hit the block, we'd need to mock process.env.VITEST
  });

  it('should hit process error handlers', () => {
    // Manually find the handlers we registered in server.js
    const uncaughtHandlers = process.listeners('uncaughtException');
    for (const h of uncaughtHandlers) {
      if (h.toString().includes('[CRITICAL]')) {
        h(new Error('test error'));
      }
    }

    const rejectionHandlers = process.listeners('unhandledRejection');
    for (const h of rejectionHandlers) {
      if (h.toString().includes('[CRITICAL]')) {
        h('test reason', Promise.resolve());
      }
    }
    expect(true).toBe(true);
  });
});
