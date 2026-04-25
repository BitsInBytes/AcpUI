import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    realpathSync: vi.fn((p) => p),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  realpathSync: vi.fn((p) => p),
}));

vi.mock('../database.js', () => ({
  saveCanvasArtifact: vi.fn(),
  getCanvasArtifactsForSession: vi.fn(),
  deleteCanvasArtifact: vi.fn(),
}));

import registerCanvasHandlers from '../sockets/canvasHandlers.js';
import fs from 'fs';
import * as db from '../database.js';

describe('canvasHandlers', () => {
  let mockIo, mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = new EventEmitter();
    mockSocket = new EventEmitter();
    mockSocket.id = 'test-socket';
    registerCanvasHandlers(mockIo, mockSocket);
  });

  it('canvas_save saves artifact to DB', async () => {
    db.saveCanvasArtifact.mockResolvedValue();
    const callback = vi.fn();
    const artifact = { id: 'art-1', sessionId: 'sess-1', content: 'hello' };

    await mockSocket.listeners('canvas_save')[0](artifact, callback);

    expect(db.saveCanvasArtifact).toHaveBeenCalledWith(artifact);
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it('canvas_load returns artifacts', async () => {
    const arts = [{ id: 'a1' }, { id: 'a2' }];
    db.getCanvasArtifactsForSession.mockResolvedValue(arts);
    const callback = vi.fn();

    await mockSocket.listeners('canvas_load')[0]({ sessionId: 's1' }, callback);

    expect(callback).toHaveBeenCalledWith({ artifacts: arts });
  });

  it('canvas_delete removes artifact', async () => {
    db.deleteCanvasArtifact.mockResolvedValue();
    const callback = vi.fn();

    await mockSocket.listeners('canvas_delete')[0]({ artifactId: 'a1' }, callback);

    expect(db.deleteCanvasArtifact).toHaveBeenCalledWith('a1');
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it('canvas_read_file returns file content', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('file content');
    const callback = vi.fn();

    await mockSocket.listeners('canvas_read_file')[0]({ filePath: '/tmp/test.js' }, callback);

    expect(callback).toHaveBeenCalledWith({
      artifact: expect.objectContaining({ content: 'file content', language: 'js', title: 'test.js' }),
    });
  });

  it('canvas_apply_to_file writes content', async () => {
    const callback = vi.fn();

    await mockSocket.listeners('canvas_apply_to_file')[0]({ filePath: '/tmp/out.js', content: 'new code' }, callback);

    expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/out.js', 'new code', 'utf8');
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it('canvas_read_file errors on missing path', async () => {
    const callback = vi.fn();

    await mockSocket.listeners('canvas_read_file')[0]({ filePath: '' }, callback);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('canvas_apply_to_file errors on missing filePath', async () => {
    const callback = vi.fn();

    await mockSocket.listeners('canvas_apply_to_file')[0]({ filePath: '', content: 'x' }, callback);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('canvas_read_file uses resolvedPath when file does not exist on disk', async () => {
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue('ghost content');
    const callback = vi.fn();

    await mockSocket.listeners('canvas_read_file')[0]({ filePath: '/tmp/ghost.js' }, callback);

    expect(fs.realpathSync).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      artifact: expect.objectContaining({ content: 'ghost content' }),
    }));
  });

  it('canvas_read_file falls back to "text" language when file has no extension', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('raw content');
    const callback = vi.fn();

    await mockSocket.listeners('canvas_read_file')[0]({ filePath: '/tmp/Makefile' }, callback);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      artifact: expect.objectContaining({ language: 'text', title: 'Makefile' }),
    }));
  });

  it('canvas_save calls callback with error when DB fails', async () => {
    db.saveCanvasArtifact.mockRejectedValue(new Error('DB write failed'));
    const callback = vi.fn();

    await mockSocket.listeners('canvas_save')[0]({ id: 'a1', sessionId: 's1' }, callback);

    expect(callback).toHaveBeenCalledWith({ error: 'DB write failed' });
  });

  it('canvas_load calls callback with error when DB fails', async () => {
    db.getCanvasArtifactsForSession.mockRejectedValue(new Error('DB read failed'));
    const callback = vi.fn();

    await mockSocket.listeners('canvas_load')[0]({ sessionId: 's1' }, callback);

    expect(callback).toHaveBeenCalledWith({ error: 'DB read failed' });
  });

  it('canvas_delete calls callback with error when DB fails', async () => {
    db.deleteCanvasArtifact.mockRejectedValue(new Error('delete failed'));
    const callback = vi.fn();

    await mockSocket.listeners('canvas_delete')[0]({ artifactId: 'a1' }, callback);

    expect(callback).toHaveBeenCalledWith({ error: 'delete failed' });
  });

  it('handlers do not throw when called without a callback', async () => {
    db.saveCanvasArtifact.mockResolvedValue();
    db.getCanvasArtifactsForSession.mockResolvedValue([]);
    db.deleteCanvasArtifact.mockResolvedValue();
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('content');

    await expect(mockSocket.listeners('canvas_save')[0]({ id: 'a1', sessionId: 's1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_load')[0]({ sessionId: 's1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_delete')[0]({ artifactId: 'a1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_apply_to_file')[0]({ filePath: '/tmp/f.js', content: 'x' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_read_file')[0]({ filePath: '/tmp/f.js' })).resolves.not.toThrow();
  });

  it('error branches do not throw when called without a callback', async () => {
    db.saveCanvasArtifact.mockRejectedValue(new Error('fail'));
    db.getCanvasArtifactsForSession.mockRejectedValue(new Error('fail'));
    db.deleteCanvasArtifact.mockRejectedValue(new Error('fail'));
    fs.readFileSync.mockImplementation(() => { throw new Error('fail'); });

    await expect(mockSocket.listeners('canvas_save')[0]({ id: 'a1', sessionId: 's1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_load')[0]({ sessionId: 's1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_delete')[0]({ artifactId: 'a1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_apply_to_file')[0]({ filePath: '', content: '' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_read_file')[0]({ filePath: '' })).resolves.not.toThrow();
  });
});
