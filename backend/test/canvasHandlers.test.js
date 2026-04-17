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
});
