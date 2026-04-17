import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
  },
  existsSync: vi.fn(),
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn(() => ({
    config: {
      title: 'My ACP App',
      branding: { assistantName: 'Assistant' },
    }
  }))
}));

import fs from 'fs';
import { getProvider } from '../services/providerLoader.js';
import brandingRouter from '../routes/brandingApi.js';

function makeApp() {
  const app = express();
  app.use('/api/branding', brandingRouter);
  return app;
}

describe('brandingApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ACP_PROVIDER = 'providers/test';
  });

  describe('GET /api/branding/icons/:filename', () => {
    it('returns 404 when icon file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);
      const res = await request(makeApp()).get('/api/branding/icons/favicon.ico');
      expect(res.status).toBe(404);
    });

    it('attempts to serve file when it exists', async () => {
      fs.existsSync.mockReturnValue(true);
      // sendFile would fail without a real file path in test, but we can verify
      // existsSync was called with a path containing the filename
      const app = makeApp();
      // Override sendFile to avoid filesystem access
      const res = await request(app).get('/api/branding/icons/favicon-16x16.png');
      expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining('favicon-16x16.png'));
    });
  });

  describe('GET /api/branding/manifest.json', () => {
    it('returns manifest with provider title as name', async () => {
      const res = await request(makeApp()).get('/api/branding/manifest.json');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('My ACP App');
      expect(res.body.short_name).toBe('Assistant');
      expect(res.body.display).toBe('standalone');
      expect(res.body.start_url).toBe('/');
    });

    it('falls back to branding.assistantName when title is absent', async () => {
      vi.mocked(getProvider).mockReturnValue({
        config: { branding: { assistantName: 'FallbackBot' } }
      });
      const res = await request(makeApp()).get('/api/branding/manifest.json');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('FallbackBot');
      expect(res.body.short_name).toBe('FallbackBot');
    });

    it('falls back to "ACP UI" when neither title nor assistantName exist', async () => {
      vi.mocked(getProvider).mockReturnValue({ config: {} });
      const res = await request(makeApp()).get('/api/branding/manifest.json');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('ACP UI');
    });

    it('includes both icon sizes in manifest', async () => {
      const res = await request(makeApp()).get('/api/branding/manifest.json');
      expect(res.body.icons).toHaveLength(2);
      expect(res.body.icons[0].sizes).toBe('192x192');
      expect(res.body.icons[1].sizes).toBe('512x512');
    });
  });
});
