import { writeLog } from '../services/logger.js';
import { shellRunManager } from '../services/shellRunManager.js';

function isWatchingSession(socket, sessionId) {
  const room = `session:${sessionId}`;
  return typeof socket.rooms?.has === 'function' && socket.rooms.has(room);
}

function ack(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function validateRunAccess(manager, socket, payload = {}) {
  const { runId, providerId, sessionId } = payload;
  if (!runId) return { ok: false, error: 'runId is required' };

  const snapshot = manager.snapshot(runId);
  if (!snapshot) return { ok: false, error: 'shell run not found' };
  if (providerId && snapshot.providerId !== providerId) return { ok: false, error: 'provider mismatch' };
  if (sessionId && snapshot.sessionId !== sessionId) return { ok: false, error: 'session mismatch' };
  if (!isWatchingSession(socket, snapshot.sessionId)) return { ok: false, error: 'socket is not watching session' };

  return { ok: true, snapshot };
}

export function emitShellRunSnapshotsForSession(socket, { providerId = null, sessionId } = {}, manager = shellRunManager) {
  if (!sessionId) return;
  const snapshots = manager
    .getSnapshotsForSession(providerId, sessionId)
    .filter(snapshot => snapshot.status !== 'exited');

  for (const snapshot of snapshots) {
    socket.emit('shell_run_snapshot', snapshot);
  }
}

export default function registerShellRunHandlers(io, socket, manager = shellRunManager) {
  manager.setIo?.(io);

  socket.on('shell_run_input', (payload = {}, callback) => {
    const validation = validateRunAccess(manager, socket, payload);
    if (!validation.ok) {
      ack(callback, { success: false, error: validation.error });
      return;
    }

    if (typeof payload.data !== 'string') {
      ack(callback, { success: false, error: 'data must be a string' });
      return;
    }

    const accepted = manager.writeInput(payload.runId, payload.data);
    ack(callback, accepted ? { success: true } : { success: false, error: 'input rejected' });
  });

  socket.on('shell_run_resize', (payload = {}, callback) => {
    const validation = validateRunAccess(manager, socket, payload);
    if (!validation.ok) {
      ack(callback, { success: false, error: validation.error });
      return;
    }

    const { cols, rows } = payload;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      ack(callback, { success: false, error: 'invalid terminal dimensions' });
      return;
    }

    const accepted = manager.resizeRun(payload.runId, cols, rows);
    ack(callback, accepted ? { success: true } : { success: false, error: 'resize rejected' });
  });

  socket.on('shell_run_kill', (payload = {}, callback) => {
    const validation = validateRunAccess(manager, socket, payload);
    if (!validation.ok) {
      ack(callback, { success: false, error: validation.error });
      return;
    }

    const accepted = manager.killRun(payload.runId);
    if (accepted) writeLog(`[SHELL RUN] User requested termination of ${payload.runId}`);
    ack(callback, accepted ? { success: true } : { success: false, error: 'kill rejected' });
  });
}
