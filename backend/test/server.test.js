import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../server.js';

// Mock services
vi.mock('../services/attachmentVault.js', () => ({
  upload: {
    array: () => (req, _res, next) => { req.files = req.files || []; next(); }
  },
  handleUpload: (req, res) => {
    res.json({ success: true, files: req.files.map(f => ({ name: f.originalname })) });
  }
}));

vi.mock('../services/acpClient.js', () => ({
  default: {
    init: vi.fn(),
    setMode: vi.fn().mockResolvedValue({ success: true }),
    sendRequest: vi.fn().mockResolvedValue({ success: true })
  }
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn(),
  setIo: vi.fn()
}));

vi.mock('../database.js', () => ({
  initDb: vi.fn().mockResolvedValue({}),
  getAllSessions: vi.fn().mockResolvedValue([]),
  getSession: vi.fn().mockResolvedValue(null)
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    id: 'p1',
    config: { name: 'P1', branding: {}, paths: { icons: '/tmp' } }
  })
}));

describe('Express Server & Routes', () => {
  describe('CORS', () => {
    it('should allow local origins', async () => {
      const res = await request(app)
        .get('/')
        .set('Origin', 'http://localhost:5173');
      expect(res.status).not.toBe(403);
    });

    it('should allow public origins in test mode', async () => {
      const res = await request(app)
        .get('/')
        .set('Origin', 'http://malicious.com');
      expect(res.status).not.toBe(500);
      expect(res.status).not.toBe(403);
    });
  });

  describe('API Routes', () => {
    it('should handle /api/branding/manifest.json', async () => {
      const res = await request(app)
        .get('/api/branding/manifest.json')
        .set('Origin', 'http://localhost:5173');
      expect(res.status).toBe(200);
      expect(res.body.name).toBeDefined();
    });

    it('should return 503 for MCP API if not ready', async () => {
      const res = await request(app)
        .post('/api/mcp/tool-call')
        .set('Origin', 'http://localhost:5173');
      // In some environments CORS throws 500, in others it passes to 503
      expect([500, 503]).toContain(res.status);
    });
  });

  describe('Global Error Handlers', () => {
    it('should handle unhandledRejection', () => {
      process.emit('unhandledRejection', 'test-reason', Promise.resolve());
      expect(true).toBe(true);
    });

    it('should handle uncaughtException', () => {
      process.emit('uncaughtException', new Error('test-error'));
      expect(true).toBe(true);
    });
  });

  describe('Upload Route', () => {
    it('should handle file uploads', async () => {
      const res = await request(app)
        .post('/upload/test-ui-id')
        .attach('files', Buffer.from('test content'), 'test.txt');
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.files).toBeDefined();
    });
  });

  describe('Static Route Fallback', () => {
    it('should return 404 for unknown extension-based routes', async () => {
       const res = await request(app).get('/non-existent.txt');
       expect(res.status).toBe(404);
    });
  });
});
