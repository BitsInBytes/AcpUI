import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * routes/upload.js is a thin wiring layer: it delegates multipart parsing and
 * storage to attachmentVault. The actual vault logic is tested separately in
 * attachmentVault.test.js. These tests verify that the route exists, uses
 * upload.array('files'), and forwards control to handleUpload.
 *
 * NOTE: upload.array('files') is called at module-load time when the router is
 * constructed, so it must return a function BEFORE the static import runs.
 * Both mocks are combined in a single vi.hoisted() call for this reason.
 */

const { mockHandleUpload, mockUploadMiddleware, mockUpload } = vi.hoisted(() => {
  const mockUploadMiddleware = vi.fn((req, res, next) => next());
  return {
    mockHandleUpload: vi.fn((req, res) => res.status(200).json({ success: true, uiId: req.params.uiId })),
    mockUploadMiddleware,
    mockUpload: { array: vi.fn().mockReturnValue(mockUploadMiddleware) },
  };
});

vi.mock('../services/attachmentVault.js', () => ({
  upload: mockUpload,
  handleUpload: mockHandleUpload,
}));

import uploadRouter from '../routes/upload.js';

function makeApp() {
  const app = express();
  app.use('/upload', uploadRouter);
  return app;
}

describe('routes/upload.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set the return value after clearAllMocks so the middleware mock
    // still behaves correctly when tests re-configure its implementation.
    mockUpload.array.mockReturnValue(mockUploadMiddleware);
  });

  it('registers POST /:uiId and responds via handleUpload', async () => {
    const res = await request(makeApp()).post('/upload/session-abc');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('passes the uiId route param to the handler', async () => {
    const res = await request(makeApp()).post('/upload/my-session-123');
    expect(res.body.uiId).toBe('my-session-123');
  });

  it('runs the upload middleware before handleUpload', async () => {
    const callOrder = [];
    mockUploadMiddleware.mockImplementation((req, res, next) => {
      callOrder.push('middleware');
      next();
    });
    mockHandleUpload.mockImplementation((req, res) => {
      callOrder.push('handler');
      res.json({ success: true });
    });

    await request(makeApp()).post('/upload/order-test');
    expect(callOrder).toEqual(['middleware', 'handler']);
  });

  it('does not register a GET route', async () => {
    const res = await request(makeApp()).get('/upload/session-abc');
    expect(res.status).toBe(404);
  });

  it('does not handle requests to routes other than /upload', async () => {
    const app = express();
    app.use('/upload', uploadRouter);
    const res = await request(app).post('/other/session-abc');
    expect(res.status).toBe(404);
  });
});
