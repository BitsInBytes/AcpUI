import { randomUUID } from 'crypto';
import pty from 'node-pty';
import { writeLog } from './logger.js';

const DEFAULT_MAX_SHELL_RESULT_LINES = 1000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INTERRUPT_GRACE_MS = 1500;
const DEFAULT_COMPLETED_RETENTION_MS = 5 * 60 * 1000;

// eslint-disable-next-line no-control-regex
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[?]?[0-9;]*[a-zA-Z]/g, '');

export function getMaxShellResultLines(env = process.env) {
  const parsed = Number.parseInt(env.MAX_SHELL_RESULT_LINES || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SHELL_RESULT_LINES;
}

export function isShellV2Enabled(env = process.env) {
  return String(env.SHELL_V2_ENABLED || '').toLowerCase() === 'true';
}

export function trimShellOutputLines(output, maxLines) {
  if (!output || !Number.isInteger(maxLines) || maxLines <= 0) return output;
  const lines = output.split(/\r?\n/);
  const hasTrailingNewline = /\r?\n$/.test(output);
  const lineCount = hasTrailingNewline ? lines.length - 1 : lines.length;
  if (lineCount <= maxLines) return output;
  const start = lineCount - maxLines;
  const tail = lines.slice(start, hasTrailingNewline ? -1 : undefined).join('\n');
  return hasTrailingNewline ? `${tail}\n` : tail;
}

function createRunId() {
  return `shell-run-${randomUUID()}`;
}

function buildShellInvocation(command, platform = process.platform) {
  if (platform === 'win32') {
    return {
      shell: 'powershell.exe',
      // Prevent PowerShell from printing the Encoding object to stdout.
      args: ['-NoProfile', '-Command', `$null = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`]
    };
  }
  return { shell: 'bash', args: ['-c', command] };
}

function normalizeCwd(cwd) {
  return cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
}

export class ShellRunManager {
  constructor({
    io = null,
    ptyModule = pty,
    log = writeLog,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
    interruptGraceMs = DEFAULT_INTERRUPT_GRACE_MS,
    completedRetentionMs = DEFAULT_COMPLETED_RETENTION_MS,
    platform = process.platform
  } = {}) {
    this.io = io;
    this.pty = ptyModule;
    this.log = log;
    this.now = now;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.interruptGraceMs = interruptGraceMs;
    this.completedRetentionMs = completedRetentionMs;
    this.platform = platform;
    this.runs = new Map();
  }

  setIo(io) {
    this.io = io;
  }

  prepareRun({ providerId, sessionId, toolCallId = null, command = '', cwd = null, maxLines = getMaxShellResultLines() }) {
    if (!providerId) throw new Error('providerId is required to prepare a shell run');
    if (!sessionId) throw new Error('sessionId is required to prepare a shell run');

    const run = {
      runId: createRunId(),
      providerId,
      sessionId,
      toolCallId,
      mcpRequestId: null,
      command,
      cwd: cwd,
      maxLines,
      status: 'pending',
      rawOutput: '',
      transcript: '',
      exitCode: null,
      reason: null,
      pty: null,
      resolve: null,
      reject: null,
      inactivityTimer: null,
      cleanupTimer: null,
      interruptRequestedAt: null,
      terminationReason: null,
      createdAt: this.now(),
      startedAt: null,
      exitedAt: null
    };
    this.runs.set(run.runId, run);
    this.emit(run, 'shell_run_prepared', this.snapshot(run));
    return this.snapshot(run);
  }

  async startPreparedRun({
    providerId,
    sessionId,
    acpSessionId,
    toolCallId = null,
    mcpRequestId = null,
    command,
    cwd = null,
    maxLines = getMaxShellResultLines()
  }) {
    const resolvedSessionId = sessionId || acpSessionId;
    let run = this.findPreparedRun({ providerId, sessionId: resolvedSessionId, toolCallId, command, cwd });
    if (!run) {
      const prepared = this.prepareRun({ providerId, sessionId: resolvedSessionId, toolCallId, command, cwd, maxLines });
      run = this.runs.get(prepared.runId);
    }

    run.command = run.command || command;
    run.cwd = normalizeCwd(cwd || run.cwd);
    run.maxLines = maxLines || run.maxLines;
    run.mcpRequestId = mcpRequestId ?? run.mcpRequestId;

    return this.startRun(run);
  }

  findPreparedRun({ providerId, sessionId, toolCallId = null, command = null, cwd = null }) {
    const normalizedCwd = cwd ? normalizeCwd(cwd) : null;
    const candidates = [...this.runs.values()].filter(run =>
      run.status === 'pending' &&
      run.providerId === providerId &&
      run.sessionId === sessionId
    );

    if (toolCallId) {
      const byToolCall = candidates.find(run => run.toolCallId === toolCallId);
      if (byToolCall) return byToolCall;
    }

    if (command) {
      const byCommand = candidates.find(run =>
        run.command === command &&
        (!normalizedCwd || !run.cwd || normalizeCwd(run.cwd) === normalizedCwd)
      );
      if (byCommand) return byCommand;
    }

    return candidates[0] || null;
  }

  startRun(run) {
    if (run.status !== 'pending') {
      throw new Error(`Shell run ${run.runId} cannot start from status ${run.status}`);
    }

    run.status = 'starting';
    run.startedAt = this.now();
    this.emit(run, 'shell_run_started', {
      ...this.snapshot(run),
      cols: 120,
      rows: 30
    });

    return new Promise((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;

      try {
        const { shell, args } = buildShellInvocation(run.command, this.platform);
        run.pty = this.pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: run.cwd,
          env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', PYTHONIOENCODING: 'utf-8' }
        });

        run.status = 'running';
        this.appendOutput(run, `$ ${run.command}\n`, { includeInRaw: false });
        this.resetInactivityTimer(run);

        run.pty.onData((data) => {
          this.appendOutput(run, data);
          this.resetInactivityTimer(run);
        });

        run.pty.onExit(({ exitCode }) => {
          this.finalizeRun(run, exitCode);
        });
      } catch (err) {
        this.finalizeRun(run, null, 'error', err);
      }
    });
  }

  appendOutput(run, chunk, { includeInRaw = true } = {}) {
    if (!chunk) return;
    if (includeInRaw) run.rawOutput += chunk;
    run.transcript = trimShellOutputLines(`${run.transcript}${chunk}`, run.maxLines);
    this.emit(run, 'shell_run_output', {
      providerId: run.providerId,
      sessionId: run.sessionId,
      runId: run.runId,
      chunk,
      maxLines: run.maxLines
    });
  }

  writeInput(runId, data) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running' || !run.pty) return false;
    if (data === '\x03' || String(data).includes('\x03')) {
      run.interruptRequestedAt = this.now();
    }
    run.pty.write(data);
    return true;
  }

  resizeRun(runId, cols, rows) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running' || !run.pty || cols <= 0 || rows <= 0) return false;
    run.pty.resize(cols, rows);
    return true;
  }

  killRun(runId) {
    const run = this.runs.get(runId);
    if (!run || run.status === 'exited') return false;
    run.terminationReason = 'user_terminated';
    run.status = 'exiting';
    if (run.pty) {
      run.pty.kill();
    } else {
      this.finalizeRun(run, null, 'user_terminated');
    }
    return true;
  }

  resetInactivityTimer(run) {
    if (run.inactivityTimer) this.clearTimeout(run.inactivityTimer);
    run.inactivityTimer = this.setTimeout(() => {
      run.terminationReason = 'timeout';
      run.status = 'exiting';
      run.pty?.kill();
    }, this.inactivityTimeoutMs);
  }

  finalizeRun(run, exitCode, forcedReason = null, err = null) {
    if (run.status === 'exited') return;
    if (run.inactivityTimer) {
      this.clearTimeout(run.inactivityTimer);
      run.inactivityTimer = null;
    }

    const now = this.now();
    let reason = forcedReason || run.terminationReason;
    if (!reason && run.interruptRequestedAt && now - run.interruptRequestedAt <= this.interruptGraceMs) {
      reason = 'user_terminated';
    }
    if (!reason) reason = exitCode === 0 ? 'completed' : 'failed';

    run.status = 'exited';
    run.exitCode = exitCode;
    run.reason = reason;
    run.exitedAt = now;
    run.pty = null;

    const finalText = this.formatFinalText(run, reason, exitCode, err);
    this.emit(run, 'shell_run_exit', {
      providerId: run.providerId,
      sessionId: run.sessionId,
      runId: run.runId,
      exitCode,
      reason,
      finalText
    });

    if (err) {
      this.log(`[SHELL RUN] ${run.runId} error: ${err.message}`);
    } else {
      this.log(`[SHELL RUN] ${run.runId} exited (${reason}; code ${exitCode})`);
    }

    this.scheduleCompletedCleanup(run);
    run.resolve?.({ content: [{ type: 'text', text: finalText }] });
  }

  scheduleCompletedCleanup(run) {
    if (!Number.isFinite(this.completedRetentionMs) || this.completedRetentionMs < 0) return;
    if (run.cleanupTimer) this.clearTimeout(run.cleanupTimer);
    run.cleanupTimer = this.setTimeout(() => {
      const current = this.runs.get(run.runId);
      if (current === run && run.status === 'exited') {
        this.runs.delete(run.runId);
      }
    }, this.completedRetentionMs);
  }

  formatFinalText(run, reason, exitCode, err = null) {
    if (err) return `Error: ${err.message}`;
    if (reason === 'user_terminated') {
      const plain = stripAnsi(run.transcript).trim() || '(no output)';
      return `${plain}\n\nCommand terminated by user`;
    }
    if (reason === 'timeout') {
      const plain = stripAnsi(run.transcript).trim() || '(no output)';
      return `${plain}\n\nCommand timed out after 30 minutes without output`;
    }

    const plainOutput = stripAnsi(run.rawOutput).trim() || '(no output)';
    if (reason === 'failed') return `${plainOutput}\n\nExit Code: ${exitCode}`;
    return plainOutput;
  }

  snapshot(runOrId) {
    const run = typeof runOrId === 'string' ? this.runs.get(runOrId) : runOrId;
    if (!run) return null;
    return {
      providerId: run.providerId,
      sessionId: run.sessionId,
      runId: run.runId,
      toolCallId: run.toolCallId,
      mcpRequestId: run.mcpRequestId,
      status: run.status,
      command: run.command,
      cwd: run.cwd,
      transcript: run.transcript,
      exitCode: run.exitCode,
      reason: run.reason,
      maxLines: run.maxLines
    };
  }

  getSnapshotsForSession(providerId, sessionId) {
    return [...this.runs.values()]
      .filter(run => (!providerId || run.providerId === providerId) && run.sessionId === sessionId)
      .map(run => this.snapshot(run));
  }

  emit(run, event, payload) {
    if (!this.io) return;
    const room = `session:${run.sessionId}`;
    const target = typeof this.io.to === 'function' ? this.io.to(room) : null;
    if (target && typeof target.emit === 'function') {
      target.emit(event, payload);
    } else if (typeof this.io.emit === 'function') {
      this.io.emit(event, payload);
    }
  }

  clear() {
    for (const run of this.runs.values()) {
      if (run.inactivityTimer) this.clearTimeout(run.inactivityTimer);
      if (run.cleanupTimer) this.clearTimeout(run.cleanupTimer);
      run.pty?.kill();
    }
    this.runs.clear();
  }
}

export const shellRunManager = new ShellRunManager();
