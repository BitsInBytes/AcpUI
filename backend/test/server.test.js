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

describe('Express Server & Routes', () => {
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
