import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * routes/static.js runs an fs.existsSync check at module load time to decide
 * whether to register routes. We use vi.resetModules() + vi.doMock() + dynamic
 * import to test both branches (dist present / dist absent) in isolation.
 */

async function importStaticRouter(distExists) {
  vi.resetModules();
  vi.doMock('fs', () => ({
    default: {
      existsSync: vi.fn().mockReturnValue(distExists),
    },
    existsSync: vi.fn().mockReturnValue(distExists),
  }));
  const mod = await import('../routes/static.js');
  return mod.default;
}

// ─── When frontend/dist does NOT exist ───────────────────────────────────────

describe('routes/static.js — dist absent', () => {
  let app;

  beforeAll(async () => {
    const router = await importStaticRouter(false);
    app = express();
    app.use('/', router);
    // Fallback so we can distinguish "no route matched" from errors
    app.use((_req, res) => res.status(404).json({ reached: 'fallback' }));
  });

  afterAll(() => vi.resetModules());

  it('passes every request to the next handler (no routes registered)', async () => {
    const res = await request(app).get('/anything');
    expect(res.status).toBe(404);
    expect(res.body.reached).toBe('fallback');
  });

  it('does not serve index.html for SPA-style routes', async () => {
    const res = await request(app).get('/chat/session/123');
    expect(res.status).toBe(404);
    expect(res.body.reached).toBe('fallback');
  });
});

// ─── When frontend/dist exists ───────────────────────────────────────────────

describe('routes/static.js — dist present', () => {
  let app;
  let capturedSendFilePath;

  beforeAll(async () => {
    const router = await importStaticRouter(true);
    capturedSendFilePath = null;

    app = express();
    // Intercept res.sendFile before the router so the test doesn't need a
    // real index.html file on disk but can still verify what path was used.
    app.use((_req, res, next) => {
      res.sendFile = (filePath) => {
        capturedSendFilePath = filePath;
        res.status(200).send('index.html content');
      };
      next();
    });
    app.use('/', router);
    app.use((_req, res) => res.status(404).json({ reached: 'fallback' }));
  });

  afterAll(() => vi.resetModules());

  beforeEach(() => {
    capturedSendFilePath = null;
  });

  it('serves index.html for a route with no file extension', async () => {
    const res = await request(app).get('/chat/session');
    expect(res.status).toBe(200);
    expect(capturedSendFilePath).toMatch(/index\.html$/);
  });

  it('serves content for the root path', async () => {
    // The root path may be handled by express.static (serving the real index.html)
    // or by the SPA fallback — either way the response must not be a 404.
    const res = await request(app).get('/');
    expect(res.status).not.toBe(404);
  });

  it('serves index.html for a deeply nested route', async () => {
    await request(app).get('/workspace/project/chat');
    expect(capturedSendFilePath).toMatch(/index\.html$/);
  });

  it('passes paths with a file extension through to the next handler (not sendFile)', async () => {
    // express.static tries the real frontend/dist dir (likely absent in test env),
    // calls next(), then the SPA handler detects the extension and also calls next().
    // Either way, sendFile must NOT be called.
    await request(app).get('/assets/app.js');
    expect(capturedSendFilePath).toBeNull();
  });

  it('passes .css file requests through (not sendFile)', async () => {
    await request(app).get('/assets/main.css');
    expect(capturedSendFilePath).toBeNull();
  });

  it('passes .ico file requests through (not sendFile)', async () => {
    await request(app).get('/favicon.ico');
    expect(capturedSendFilePath).toBeNull();
  });
});
