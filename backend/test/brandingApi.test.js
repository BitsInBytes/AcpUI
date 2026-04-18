import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
  },
  existsSync: vi.fn(),
}));

import { getProvider } from '../services/providerLoader.js';
vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn().mockReturnValue({ 
    id: 'test',
    config: {
      title: 'My ACP App',
      branding: { assistantName: 'Assistant' },
    }
  })
}));

import fs from 'fs';
import brandingRouter from '../routes/brandingApi.js';

function makeApp() {
  const app = express();
  app.use('/api/branding', brandingRouter);
  return app;
}

describe('brandingApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/branding/icons/:filename', () => {
    it('returns 404 when icon file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const res = await request(makeApp()).get('/api/branding/icons/favicon.ico');
      expect(res.status).toBe(404);
    });

    it('attempts to serve file when it exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const res = await request(makeApp()).get('/api/branding/icons/favicon-16x16.png');
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
        id: 'test',
        config: { branding: { assistantName: 'FallbackBot' } }
      });
      const res = await request(makeApp()).get('/api/branding/manifest.json');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('FallbackBot');
      expect(res.body.short_name).toBe('FallbackBot');
    });

    it('falls back to "ACP UI" when neither title nor assistantName exist', async () => {
      vi.mocked(getProvider).mockReturnValue({ id: 'test', config: {} });
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
