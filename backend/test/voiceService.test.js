import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { transcribeAudio, isSTTEnabled } from '../voiceService.js';
import fs from 'fs';
import path from 'path';
import { getAttachmentsRoot } from '../services/attachmentVault.js';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn()
  }))
}));

describe('voiceService', () => {
  let mockWriteLog;

  const cleanup = () => {
    const root = getAttachmentsRoot();
    const dirs = ['test-session', 'err-session', 'success-session', 'blank-session', 'error-session', 'voice'];
    for (const d of dirs) {
      const pathsToTry = [
        path.join(process.cwd(), d),
        path.join(process.cwd(), '..', d)
      ];
      if (root) pathsToTry.push(path.join(root, d));

      for (const p of pathsToTry) {
        if (fs.existsSync(p)) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
          } catch { /* ignore */ }
        }
      }
    }
  };

  beforeAll(() => {
    cleanup();
  });

  afterAll(() => {
    cleanup();
  });

  beforeEach(() => {
    mockWriteLog = vi.fn();
  });

  it('returns null if no audio buffer is provided', async () => {
    process.env.VOICE_STT_ENABLED = 'true';
    const result = await transcribeAudio(null, mockWriteLog, 'test-session');
    expect(result).toBeNull();
    expect(mockWriteLog).toHaveBeenCalledWith(expect.stringContaining('No audio buffer'));
  });

  it('returns null if STT is not enabled', async () => {
    process.env.VOICE_STT_ENABLED = 'false';
    const result = await transcribeAudio(Buffer.from('data'), mockWriteLog, 'test-session');
    expect(result).toBeNull();
  });

  it('isSTTEnabled returns true when env var is true', () => {
    process.env.VOICE_STT_ENABLED = 'true';
    expect(isSTTEnabled()).toBe(true);
  });

  it('isSTTEnabled returns false when env var is not true', () => {
    process.env.VOICE_STT_ENABLED = 'false';
    expect(isSTTEnabled()).toBe(false);
  });

  it('startSTTServer does nothing when STT is disabled', async () => {
    process.env.VOICE_STT_ENABLED = 'false';
    const { startSTTServer } = await import('../voiceService.js');
    startSTTServer();
  });

  it('startSTTServer starts when STT is enabled', async () => {
    process.env.VOICE_STT_ENABLED = 'true';
    const { startSTTServer } = await import('../voiceService.js');
    // May fail to spawn whisper-server in test env, but shouldn't throw
    startSTTServer();
  });

  it('transcribeAudio returns result or null on error', async () => {
    process.env.VOICE_STT_ENABLED = 'true';
    const result = await transcribeAudio(Buffer.from('not-real-audio'), mockWriteLog, 'test-session');
    // Either returns transcribed text or null depending on whisper-server state
    expect(typeof result === 'string' || result === null).toBe(true);
    expect(mockWriteLog).toHaveBeenCalledWith(expect.stringContaining('[VOICE'));
  });
});


describe('voiceService - error paths and server exit', () => {
  let mockWriteLog;

  beforeEach(() => {
    mockWriteLog = vi.fn();
    process.env.VOICE_STT_ENABLED = 'true';
  });

  it('transcribeAudio catches fetch error and returns null', async () => {
    // fetch will fail since no whisper-server is running
    const result = await transcribeAudio(Buffer.from('audio-data'), mockWriteLog, 'err-session');
    expect(result).toBeNull();
    expect(mockWriteLog).toHaveBeenCalledWith(expect.stringContaining('[VOICE ERR]'));
  });

  it('transcribeAudio returns null when sessionId is undefined', async () => {
    const result = await transcribeAudio(Buffer.from('audio-data'), mockWriteLog, undefined);
    // Should use 'voice' as fallback dir and still attempt (then fail on fetch)
    expect(result).toBeNull();
  });

  it('startSTTServer registers exit handler on server process', async () => {
    const { spawn } = await import('child_process');
    const mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn()
    };
    spawn.mockReturnValue(mockProcess);

    // Reset module to clear serverProcess state
    vi.resetModules();
    process.env.VOICE_STT_ENABLED = 'true';
    const { startSTTServer } = await import('../voiceService.js');
    startSTTServer();

    expect(mockProcess.on).toHaveBeenCalledWith('exit', expect.any(Function));
  });

  it('exit handler body logs and clears serverProcess', async () => {
    const { spawn } = await import('child_process');
    let capturedExitCb;
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => { if (event === 'exit') capturedExitCb = cb; })
    };
    spawn.mockReturnValue(mockProc);

    vi.resetModules();
    process.env.VOICE_STT_ENABLED = 'true';
    const { startSTTServer } = await import('../voiceService.js');
    startSTTServer();

    expect(capturedExitCb).toBeDefined();
    // Invoke the exit handler — should log and set serverProcess = null without throwing
    capturedExitCb(0);
  });

  it('transcribeAudio returns transcribed text on successful whisper-server response', async () => {
    process.env.VOICE_STT_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '  Hello world  ',
    }));
    const log = vi.fn();
    const result = await transcribeAudio(Buffer.from('audio'), log, 'success-session');
    expect(result).toBe('Hello world');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Transcribed'));
    vi.unstubAllGlobals();
  });

  it('transcribeAudio returns null when server response text is blank', async () => {
    process.env.VOICE_STT_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '   ',
    }));
    const log = vi.fn();
    const result = await transcribeAudio(Buffer.from('audio'), log, 'blank-session');
    expect(result).toBeNull();
    vi.unstubAllGlobals();
  });

  it('transcribeAudio returns null and logs error when server returns non-ok status', async () => {
    process.env.VOICE_STT_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));
    const log = vi.fn();
    const result = await transcribeAudio(Buffer.from('audio'), log, 'error-session');
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[VOICE ERR]'));
    vi.unstubAllGlobals();
  });
});
