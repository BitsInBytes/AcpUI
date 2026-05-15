import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn()
  },
  readFileSync: vi.fn(),
  writeFileSync: vi.fn()
}));

vi.mock('../database.js', () => ({
  saveCanvasArtifact: vi.fn(),
  getCanvasArtifactsForSession: vi.fn(),
  deleteCanvasArtifact: vi.fn()
}));

vi.mock('../services/ioMcp/filesystem.js', () => ({
  resolveAllowedPath: vi.fn((value) => value)
}));

import registerCanvasHandlers from '../sockets/canvasHandlers.js';
import fs from 'fs';
import * as db from '../database.js';
import { resolveAllowedPath } from '../services/ioMcp/filesystem.js';

describe('canvasHandlers', () => {
  let mockIo;
  let mockSocket;

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

  it('canvas_load returns artifacts for the requested UI session', async () => {
    const artifacts = [{ id: 'a1' }, { id: 'a2' }];
    db.getCanvasArtifactsForSession.mockResolvedValue(artifacts);
    const callback = vi.fn();

    await mockSocket.listeners('canvas_load')[0]({ sessionId: 's1' }, callback);

    expect(db.getCanvasArtifactsForSession).toHaveBeenCalledWith('s1');
    expect(callback).toHaveBeenCalledWith({ artifacts });
  });

  it('canvas_delete removes artifact', async () => {
    db.deleteCanvasArtifact.mockResolvedValue();
    const callback = vi.fn();

    await mockSocket.listeners('canvas_delete')[0]({ artifactId: 'a1' }, callback);

    expect(db.deleteCanvasArtifact).toHaveBeenCalledWith('a1');
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it('canvas_read_file returns file content with scoped sessionId after allowed-root validation', async () => {
    resolveAllowedPath.mockReturnValue('/workspace/test.js');
    fs.readFileSync.mockReturnValue('file content');
    const callback = vi.fn();

    await mockSocket.listeners('canvas_read_file')[0]({ filePath: '/workspace/test.js', sessionId: 'ui-s1' }, callback);

    expect(resolveAllowedPath).toHaveBeenCalledWith('/workspace/test.js', 'file_path');
    expect(callback).toHaveBeenCalledWith({
      artifact: expect.objectContaining({
        sessionId: 'ui-s1',
        content: 'file content',
        language: 'js',
        title: 'test.js',
        filePath: '/workspace/test.js'
      })
    });
  });

  it('canvas_apply_to_file writes content after allowed-root validation', async () => {
    resolveAllowedPath.mockReturnValue('/workspace/out.js');
    const callback = vi.fn();

    await mockSocket.listeners('canvas_apply_to_file')[0]({ filePath: '/workspace/out.js', content: 'new code' }, callback);

    expect(resolveAllowedPath).toHaveBeenCalledWith('/workspace/out.js', 'file_path');
    expect(fs.writeFileSync).toHaveBeenCalledWith('/workspace/out.js', 'new code', 'utf8');
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it('canvas_read_file falls back to "text" language when file has no extension', async () => {
    resolveAllowedPath.mockReturnValue('/workspace/Makefile');
    fs.readFileSync.mockReturnValue('raw content');
    const callback = vi.fn();

    await mockSocket.listeners('canvas_read_file')[0]({ filePath: '/workspace/Makefile', sessionId: 'ui-s1' }, callback);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      artifact: expect.objectContaining({ language: 'text', title: 'Makefile' })
    }));
  });

  it('returns an error when path validation rejects traversal/outside-root access', async () => {
    resolveAllowedPath.mockImplementationOnce(() => {
      throw new Error('file_path is outside the configured MCP IO allowed roots: /etc/passwd');
    });
    const callback = vi.fn();

    await mockSocket.listeners('canvas_read_file')[0]({ filePath: '/etc/passwd', sessionId: 'ui-s1' }, callback);

    expect(callback).toHaveBeenCalledWith({
      error: expect.stringContaining('outside the configured MCP IO allowed roots')
    });
  });

  it('canvas_read_file rejects requests without a sessionId', async () => {
    const callback = vi.fn();

    await mockSocket.listeners('canvas_read_file')[0]({ filePath: '/workspace/test.js' }, callback);

    expect(callback).toHaveBeenCalledWith({
      error: 'sessionId is required for canvas_read_file'
    });
    expect(resolveAllowedPath).not.toHaveBeenCalled();
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
    resolveAllowedPath.mockReturnValue('/workspace/f.js');
    fs.readFileSync.mockReturnValue('content');

    await expect(mockSocket.listeners('canvas_save')[0]({ id: 'a1', sessionId: 's1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_load')[0]({ sessionId: 's1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_delete')[0]({ artifactId: 'a1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_apply_to_file')[0]({ filePath: '/workspace/f.js', content: 'x' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_read_file')[0]({ filePath: '/workspace/f.js', sessionId: 's1' })).resolves.not.toThrow();
  });

  it('error branches do not throw when called without a callback', async () => {
    db.saveCanvasArtifact.mockRejectedValue(new Error('fail'));
    db.getCanvasArtifactsForSession.mockRejectedValue(new Error('fail'));
    db.deleteCanvasArtifact.mockRejectedValue(new Error('fail'));
    resolveAllowedPath.mockImplementation(() => {
      throw new Error('fail');
    });

    await expect(mockSocket.listeners('canvas_save')[0]({ id: 'a1', sessionId: 's1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_load')[0]({ sessionId: 's1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_delete')[0]({ artifactId: 'a1' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_apply_to_file')[0]({ filePath: '', content: '' })).resolves.not.toThrow();
    await expect(mockSocket.listeners('canvas_read_file')[0]({ filePath: '', sessionId: 's1' })).resolves.not.toThrow();
  });
});
