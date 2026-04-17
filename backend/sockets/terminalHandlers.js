import * as pty from 'node-pty';
import { writeLog } from '../services/logger.js';

const terminals = new Map(); // `${socketId}:${terminalId}` → { pty, cwd }

function key(socketId, terminalId) { return `${socketId}:${terminalId}`; }

export default function registerTerminalHandlers(io, socket) {
  socket.on('terminal_spawn', ({ cwd, terminalId }, callback) => {
    try {
      const k = key(socket.id, terminalId);
      const existing = terminals.get(k);
      if (existing) { existing.pty.kill(); terminals.delete(k); }

      const shell = process.env.COMSPEC || 'powershell.exe';
      const term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 24,
        cwd: cwd || process.cwd(),
        env: process.env,
      });

      term.onData((data) => socket.emit('terminal_output', { terminalId, data }));
      term.onExit(({ exitCode }) => {
        writeLog(`[TERM] Shell ${terminalId} exited (code ${exitCode})`);
        terminals.delete(k);
        socket.emit('terminal_exit', { terminalId, exitCode });
      });

      terminals.set(k, { pty: term, cwd });
      writeLog(`[TERM] Spawned ${terminalId} for ${socket.id} in ${cwd}`);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[TERM ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('terminal_input', ({ terminalId, data }) => {
    terminals.get(key(socket.id, terminalId))?.pty.write(data);
  });

  socket.on('terminal_resize', ({ terminalId, cols, rows }) => {
    const t = terminals.get(key(socket.id, terminalId));
    if (t && cols > 0 && rows > 0) t.pty.resize(cols, rows);
  });

  socket.on('terminal_kill', ({ terminalId }) => {
    const k = key(socket.id, terminalId);
    const t = terminals.get(k);
    if (t) { t.pty.kill(); terminals.delete(k); }
  });

  socket.on('disconnect', () => {
    for (const [k, t] of terminals) {
      if (k.startsWith(socket.id + ':')) { t.pty.kill(); terminals.delete(k); }
    }
  });
}
