import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ShellRunManager,
  getMaxShellResultLines,
  isShellV2Enabled,
  sanitizeShellOutputChunk,
  trimShellOutputLines
} from '../services/shellRunManager.js';

function createPtyMock() {
  const proc = {
    onData: vi.fn((cb) => { proc.dataCb = cb; }),
    onExit: vi.fn((cb) => { proc.exitCb = cb; }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  };
  const ptyModule = {
    spawn: vi.fn(() => proc)
  };
  return { ptyModule, proc };
}

function createIoMock() {
  const room = { emit: vi.fn() };
  const io = { to: vi.fn(() => room), emit: vi.fn() };
  return { io, room };
}

describe('shellRunManager', () => {
  let now;
  let ptyMock;
  let ioMock;
  let timers;
  let manager;

  beforeEach(() => {
    now = 1000;
    timers = [];
    ptyMock = createPtyMock();
    ioMock = createIoMock();
    manager = new ShellRunManager({
      io: ioMock.io,
      ptyModule: ptyMock.ptyModule,
      log: vi.fn(),
      now: () => now,
      setTimeoutFn: vi.fn((cb) => {
        timers.push(cb);
        return `timer-${timers.length}`;
      }),
      clearTimeoutFn: vi.fn(),
      inactivityTimeoutMs: 100,
      platform: 'win32'
    });
  });

  it('reads max line config', () => {
    expect(getMaxShellResultLines({ MAX_SHELL_RESULT_LINES: '25' })).toBe(25);
    expect(getMaxShellResultLines({ MAX_SHELL_RESULT_LINES: 'bad' })).toBe(1000);
    expect(isShellV2Enabled({ SHELL_V2_ENABLED: 'true' })).toBe(true);
    expect(isShellV2Enabled({ SHELL_V2_ENABLED: 'false' })).toBe(false);
  });

  it('trims shell output to the last N lines', () => {
    expect(trimShellOutputLines('one\ntwo\nthree\n', 2)).toBe('two\nthree\n');
    expect(trimShellOutputLines('one\ntwo\nthree', 2)).toBe('two\nthree');
  });

  it('removes PowerShell startup screen controls while preserving real output', () => {
    const chunk = '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\r\n\r\n\x1b[32mPASS\x1b[0m\r\n\x1b]0;title\x07\x1b[?25h';

    expect(sanitizeShellOutputChunk(chunk, { stripStartupControls: true })).toBe('\x1b[32mPASS\x1b[0m\r\n');
  });

  it('prepares a run and emits a session-scoped prepared event', () => {
    const prepared = manager.prepareRun({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      toolCallId: 'tool-1',
      description: ' Run   test suite ',
      command: 'npm test',
      cwd: 'D:/repo',
      maxLines: 5
    });

    expect(prepared).toEqual(expect.objectContaining({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      toolCallId: 'tool-1',
      status: 'pending',
      description: 'Run test suite',
      command: 'npm test',
      cwd: 'D:/repo',
      maxLines: 5
    }));
    expect(ioMock.io.to).toHaveBeenCalledWith('session:acp-1');
    expect(ioMock.room.emit).toHaveBeenCalledWith('shell_run_prepared', expect.objectContaining({
      runId: prepared.runId
    }));
  });

  it('starts a prepared run and resolves normal command output on exit', async () => {
    const prepared = manager.prepareRun({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      toolCallId: 'tool-1',
      description: 'Initial description',
      command: 'npm test',
      cwd: 'D:/repo',
      maxLines: 10
    });

    const promise = manager.startPreparedRun({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      toolCallId: 'tool-1',
      mcpRequestId: 42,
      description: 'Run test suite',
      command: 'npm test',
      cwd: 'D:/repo'
    });

        expect(ptyMock.ptyModule.spawn).toHaveBeenCalledWith('powershell.exe', [
          '-NoProfile',
          '-Command',
          '$null = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; npm test'
        ], expect.objectContaining({
          cwd: 'D:/repo',
          name: 'xterm-256color',
      cols: 120,
      rows: 30
    }));
    expect(ioMock.room.emit).toHaveBeenCalledWith('shell_run_started', expect.objectContaining({
      runId: prepared.runId,
      description: 'Run test suite'
    }));
    expect(ioMock.room.emit).toHaveBeenCalledWith('shell_run_output', expect.objectContaining({
      runId: prepared.runId,
      chunk: '$ npm test\n'
    }));

    ptyMock.proc.dataCb('\x1b[32mPASS\x1b[0m\n');
    ptyMock.proc.exitCb({ exitCode: 0 });

    await expect(promise).resolves.toEqual({
      content: [{ type: 'text', text: 'PASS' }]
    });
    expect(ioMock.room.emit).toHaveBeenCalledWith('shell_run_exit', expect.objectContaining({
      runId: prepared.runId,
      exitCode: 0,
      reason: 'completed',
      finalText: 'PASS'
    }));
  });

  it('streams sanitized PowerShell startup output after the injected prompt', async () => {
    const prepared = manager.prepareRun({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      toolCallId: 'tool-1',
      command: 'node --version',
      cwd: 'D:/repo',
      maxLines: 10
    });

    const promise = manager.startPreparedRun({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      toolCallId: 'tool-1',
      command: 'node --version',
      cwd: 'D:/repo'
    });

    ioMock.room.emit.mockClear();
    ptyMock.proc.dataCb('\x1b[?9001h\x1b[?1004h');
    expect(ioMock.room.emit).not.toHaveBeenCalledWith('shell_run_output', expect.anything());

    ptyMock.proc.dataCb('\x1b[?25l\x1b[2J\x1b[m\x1b[H\r\n\r\nv24.14.0\r\n\x1b]0;powershell.exe\x07\x1b[?25h');
    expect(ioMock.room.emit).toHaveBeenCalledWith('shell_run_output', expect.objectContaining({
      runId: prepared.runId,
      chunk: 'v24.14.0\r\n'
    }));
    expect(manager.snapshot(prepared.runId).transcript).toBe('$ node --version\nv24.14.0\r\n');

    ptyMock.proc.exitCb({ exitCode: 0 });
    await expect(promise).resolves.toEqual({
      content: [{ type: 'text', text: 'v24.14.0' }]
    });
  });

  it('formats non-zero exits with exit code', async () => {
    manager.prepareRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'bad' });
    const promise = manager.startPreparedRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'bad' });

    ptyMock.proc.dataCb('failure\n');
    ptyMock.proc.exitCb({ exitCode: 1 });

    await expect(promise).resolves.toEqual({
      content: [{ type: 'text', text: 'failure\n\nExit Code: 1' }]
    });
  });

  it('writes input and resizes only while running', async () => {
    const prepared = manager.prepareRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'read' });
    const promise = manager.startPreparedRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'read' });

    expect(manager.writeInput(prepared.runId, 'hello\n')).toBe(true);
    expect(ptyMock.proc.write).toHaveBeenCalledWith('hello\n');
    expect(manager.resizeRun(prepared.runId, 100, 40)).toBe(true);
    expect(ptyMock.proc.resize).toHaveBeenCalledWith(100, 40);
    expect(manager.resizeRun(prepared.runId, 0, 40)).toBe(false);

    ptyMock.proc.exitCb({ exitCode: 0 });
    await promise;

    expect(manager.writeInput(prepared.runId, 'late')).toBe(false);
    expect(manager.resizeRun(prepared.runId, 100, 40)).toBe(false);
  });

  it('returns rendered transcript plus user termination message on hard kill', async () => {
    const prepared = manager.prepareRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'long' });
    const promise = manager.startPreparedRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'long' });

    ptyMock.proc.dataCb('partial output\n');
    expect(manager.killRun(prepared.runId)).toBe(true);
    expect(ptyMock.proc.kill).toHaveBeenCalled();
    ptyMock.proc.exitCb({ exitCode: null });

    await expect(promise).resolves.toEqual({
      content: [{ type: 'text', text: '$ long\npartial output\n\nCommand terminated by user' }]
    });
  });

  it('classifies Ctrl+C followed by exit as user termination', async () => {
    const prepared = manager.prepareRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'long' });
    const promise = manager.startPreparedRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'long' });

    expect(manager.writeInput(prepared.runId, '\x03')).toBe(true);
    now += 500;
    ptyMock.proc.exitCb({ exitCode: 130 });

    await expect(promise).resolves.toEqual({
      content: [{ type: 'text', text: '$ long\n\nCommand terminated by user' }]
    });
  });

  it('kills inactive runs on timeout and returns timeout text', async () => {
    manager.prepareRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'silent' });
    const promise = manager.startPreparedRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'silent' });

    timers.at(-1)();
    expect(ptyMock.proc.kill).toHaveBeenCalled();
    ptyMock.proc.exitCb({ exitCode: null });

    await expect(promise).resolves.toEqual({
      content: [{ type: 'text', text: '$ silent\n\nCommand timed out after 30 minutes without output' }]
    });
  });

  it('returns snapshots for reattach', async () => {
    const prepared = manager.prepareRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'watch' });
    const promise = manager.startPreparedRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'watch' });
    ptyMock.proc.dataCb('line\n');

    expect(manager.getSnapshotsForSession('provider-a', 'acp-1')).toEqual([
      expect.objectContaining({
        runId: prepared.runId,
        status: 'running',
        transcript: '$ watch\nline\n'
      })
    ]);

    ptyMock.proc.exitCb({ exitCode: 0 });
    await promise;
  });

  it('removes completed runs after the retention window', async () => {
    const prepared = manager.prepareRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'done' });
    const promise = manager.startPreparedRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'done' });

    ptyMock.proc.exitCb({ exitCode: 0 });
    await promise;
    expect(manager.snapshot(prepared.runId)).toEqual(expect.objectContaining({ status: 'exited' }));

    timers.at(-1)();
    expect(manager.snapshot(prepared.runId)).toBeNull();
  });

  it('returns session snapshots when provider id is omitted', () => {
    const prepared = manager.prepareRun({ providerId: 'provider-a', sessionId: 'acp-1', command: 'watch' });
    manager.prepareRun({ providerId: 'provider-b', sessionId: 'other-session', command: 'skip' });

    expect(manager.getSnapshotsForSession(null, 'acp-1')).toEqual([
      expect.objectContaining({ runId: prepared.runId })
    ]);
  });
});
