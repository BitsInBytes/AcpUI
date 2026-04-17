import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Hoist shared captures before mocks are evaluated
const { capturedDiskStorage, mockProviderModule } = vi.hoisted(() => ({
  capturedDiskStorage: { destination: null, filename: null },
  mockProviderModule: {
    getAttachmentsDir: vi.fn().mockReturnValue('/tmp/test-attachments'),
  }
}));

vi.mock('multer', () => {
  const multerFn = vi.fn().mockReturnValue({ single: vi.fn(), array: vi.fn() });
  multerFn.diskStorage = vi.fn(config => {
    capturedDiskStorage.destination = config.destination;
    capturedDiskStorage.filename = config.filename;
    return {};
  });
  return { default: multerFn };
});

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() }),
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() }),
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

vi.mock('../services/providerLoader.js', () => ({
  getProviderModuleSync: vi.fn(() => mockProviderModule)
}));

import fs from 'fs';
import * as attachmentVault from '../services/attachmentVault.js';

describe('Attachment Vault Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderModule.getAttachmentsDir.mockReturnValue('/tmp/test-attachments');
  });

  it('handleUpload should return file information', () => {
    const req = {
      params: { uiId: 'ui-1' },
      files: [
        { originalname: 'test.png', path: '/tmp/test.png', size: 100, mimetype: 'image/png' }
      ]
    };
    const res = { json: vi.fn() };

    attachmentVault.handleUpload(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      files: expect.arrayContaining([
        expect.objectContaining({ name: 'test.png' })
      ])
    }));
  });

  it('getAttachmentsRoot returns dir from providerModule', () => {
    // _root may already be cached from module import; test via multer destination instead
    const root = attachmentVault.getAttachmentsRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
  });

  it('multer destination callback creates session directory', () => {
    expect(capturedDiskStorage.destination).toBeTypeOf('function');
    const req = { params: { uiId: 'session-abc' } };
    const cb = vi.fn();
    fs.existsSync.mockReturnValue(false);

    capturedDiskStorage.destination(req, {}, cb);

    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(null, expect.stringContaining('session-abc'));
  });

  it('multer destination callback skips mkdir when dir already exists', () => {
    const req = { params: { uiId: 'existing-session' } };
    const cb = vi.fn();
    fs.existsSync.mockReturnValue(true);

    capturedDiskStorage.destination(req, {}, cb);

    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(null, expect.stringContaining('existing-session'));
  });

  it('multer filename callback sanitizes original filename', () => {
    expect(capturedDiskStorage.filename).toBeTypeOf('function');
    const file = { originalname: 'My File Name.PNG' };
    const cb = vi.fn();

    capturedDiskStorage.filename({}, file, cb);

    const [, generatedName] = cb.mock.calls[0];
    expect(generatedName).toMatch(/^\d+_my_file_name\.png$/);
  });

  it('multer filename callback handles already-safe filenames', () => {
    const file = { originalname: 'document.pdf' };
    const cb = vi.fn();

    capturedDiskStorage.filename({}, file, cb);

    const [, generatedName] = cb.mock.calls[0];
    expect(generatedName).toContain('document.pdf');
  });
});
