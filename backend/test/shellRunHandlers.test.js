import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';
import registerShellRunHandlers, { emitShellRunSnapshotsForSession } from '../sockets/shellRunHandlers.js';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

function makeSnapshot(overrides = {}) {
  return {
    providerId: 'provider-a',
    sessionId: 'acp-1',
    runId: 'shell-run-1',
    status: 'running',
    ...overrides
  };
}

function makeManager(snapshot = makeSnapshot()) {
  return {
    setIo: vi.fn(),
    snapshot: vi.fn(() => snapshot),
    writeInput: vi.fn(() => true),
    resizeRun: vi.fn(() => true),
    killRun: vi.fn(() => true),
    getSnapshotsForSession: vi.fn(() => [])
  };
}

function makeSocket({ watching = true } = {}) {
  const socket = new EventEmitter();
  socket.id = 'sock-1';
  socket.rooms = new Set(['sock-1']);
  if (watching) socket.rooms.add('session:acp-1');
  socket.emit = vi.fn();
  return socket;
}

function payload(overrides = {}) {
  return {
    providerId: 'provider-a',
    sessionId: 'acp-1',
    runId: 'shell-run-1',
    ...overrides
  };
}

describe('shellRunHandlers', () => {
  let io;
  let socket;
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    io = {};
    socket = makeSocket();
    manager = makeManager();
    registerShellRunHandlers(io, socket, manager);
  });

  it('registers io on the shell run manager', () => {
    expect(manager.setIo).toHaveBeenCalledWith(io);
  });

  it('accepts input for a watched matching shell run', () => {
    const cb = vi.fn();
    socket.listeners('shell_run_input')[0](payload({ data: 'hello' }), cb);

    expect(manager.writeInput).toHaveBeenCalledWith('shell-run-1', 'hello');
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('rejects input when the socket is not watching the run session', () => {
    const unwatchedSocket = makeSocket({ watching: false });
    registerShellRunHandlers(io, unwatchedSocket, manager);

    const cb = vi.fn();
    unwatchedSocket.listeners('shell_run_input')[0](payload({ data: 'hello' }), cb);

    expect(manager.writeInput).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('rejects input for provider or session mismatches', () => {
    const cb = vi.fn();
    socket.listeners('shell_run_input')[0](payload({ providerId: 'other', data: 'hello' }), cb);
    socket.listeners('shell_run_input')[0](payload({ sessionId: 'other', data: 'hello' }), cb);

    expect(manager.writeInput).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('rejects non-string input data', () => {
    const cb = vi.fn();
    socket.listeners('shell_run_input')[0](payload({ data: 123 }), cb);

    expect(manager.writeInput).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('resizes valid dimensions and rejects invalid dimensions', () => {
    const cb = vi.fn();
    socket.listeners('shell_run_resize')[0](payload({ cols: 100, rows: 40 }), cb);
    socket.listeners('shell_run_resize')[0](payload({ cols: 0, rows: 40 }), cb);
    socket.listeners('shell_run_resize')[0](payload({ cols: 100, rows: -1 }), cb);

    expect(manager.resizeRun).toHaveBeenCalledTimes(1);
    expect(manager.resizeRun).toHaveBeenCalledWith('shell-run-1', 100, 40);
    expect(cb).toHaveBeenNthCalledWith(1, { success: true });
    expect(cb).toHaveBeenNthCalledWith(2, expect.objectContaining({ success: false }));
    expect(cb).toHaveBeenNthCalledWith(3, expect.objectContaining({ success: false }));
  });

  it('kills a watched matching shell run', () => {
    const cb = vi.fn();
    socket.listeners('shell_run_kill')[0](payload(), cb);

    expect(manager.killRun).toHaveBeenCalledWith('shell-run-1');
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('ignores kill for missing runs', () => {
    manager.snapshot.mockReturnValueOnce(null);
    const cb = vi.fn();
    socket.listeners('shell_run_kill')[0](payload(), cb);

    expect(manager.killRun).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('emits active snapshots for a watched session', () => {
    const pending = makeSnapshot({ runId: 'pending', status: 'pending' });
    const exited = makeSnapshot({ runId: 'exited', status: 'exited' });
    manager.getSnapshotsForSession.mockReturnValue([pending, exited]);

    emitShellRunSnapshotsForSession(socket, { providerId: 'provider-a', sessionId: 'acp-1' }, manager);

    expect(manager.getSnapshotsForSession).toHaveBeenCalledWith('provider-a', 'acp-1');
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('shell_run_snapshot', pending);
  });
});
