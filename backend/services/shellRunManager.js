import { randomUUID } from 'crypto';
import * as childProcess from 'child_process';
import pty from 'node-pty';
import { writeLog } from './logger.js';

const DEFAULT_MAX_SHELL_RESULT_LINES = 1000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INTERRUPT_GRACE_MS = 1500;
const DEFAULT_COMPLETED_RETENTION_MS = 5 * 60 * 1000;

// eslint-disable-next-line no-control-regex
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[?]?[0-9;]*[a-zA-Z]/g, '');
// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const POWERSHELL_SESSION_MODE_SEQUENCE = /\x1b\[\?(?:25|1004|9001)[hl]/g;
// eslint-disable-next-line no-control-regex
const STARTUP_SCREEN_CONTROL_SEQUENCE = /\x1b\[(?:[0-9;]*[HfJX]|m)/g;
const LEADING_BLANK_ROWS = /^(?:[ \t]*\r?\n)+/;

/**
 * Returns true if PowerShell 7+ (pwsh) is available on this machine.
 * pwsh supports the && pipeline-chain operator that most AI models assume,
 * whereas Windows PowerShell 5 (powershell.exe) does not.
 * Detection is synchronous and fast: spawnSync returns immediately with ENOENT
 * when pwsh is not installed, and pwsh --version exits in <100 ms when it is.
 */
export function detectPwsh(platform = process.platform, spawnSyncFn = null) {
  if (platform !== 'win32') return false;
  try {
    const runner = typeof spawnSyncFn === 'function'
      ? spawnSyncFn
      : (typeof childProcess.spawnSync === 'function' ? childProcess.spawnSync : null);
    if (!runner) return false;
    const result = runner('pwsh', ['--version'], {
      timeout: 3000,
      stdio: 'ignore',
      windowsHide: true
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

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

export function sanitizeShellOutputChunk(chunk, { stripStartupControls = false } = {}) {
  if (!chunk) return chunk;

  let sanitized = String(chunk)
    .replace(OSC_SEQUENCE, '')
    .replace(POWERSHELL_SESSION_MODE_SEQUENCE, '');

  if (stripStartupControls) {
    sanitized = sanitized
      .replace(STARTUP_SCREEN_CONTROL_SEQUENCE, '')
      .replace(LEADING_BLANK_ROWS, '');
  }

  return sanitized;
}

function hasVisibleShellOutput(chunk) {
  return stripAnsi(chunk || '').trim().length > 0;
}

function createRunId() {
  return `shell-run-${randomUUID()}`;
}

function buildShellInvocation(command, platform = process.platform, usePwsh = false) {
  if (platform === 'win32') {
    // Use pwsh (PowerShell 7+) when available — it supports the && pipeline-chain
    // operator that AI models commonly generate. Fall back to powershell.exe (5.x)
    // which does not support &&.
    const shell = usePwsh ? 'pwsh.exe' : 'powershell.exe';
    return {
      shell,
      // Prevent PowerShell from printing the Encoding object to stdout.
      args: ['-NoProfile', '-Command', `$null = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`]
    };
  }
  return { shell: 'bash', args: ['-c', command] };
}

function normalizeCwd(cwd) {
  return cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
}

function normalizeDescription(description) {
  return typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
}

function isSameMcpRequestId(a, b) {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
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
    platform = process.platform,
    // Pass true/false to override detection (useful in tests). null triggers
    // auto-detection via detectPwsh() at construction time.
    pwshAvailable = null
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
    this.pwshAvailable = pwshAvailable !== null ? pwshAvailable : detectPwsh(platform);
    this.runs = new Map();
  }

  setIo(io) {
    this.io = io;
  }

  prepareRun({ providerId, sessionId, toolCallId = null, mcpRequestId = null, description = '', command = '', cwd = null, maxLines = getMaxShellResultLines() }) {
    if (!providerId) throw new Error('providerId is required to prepare a shell run');
    if (!sessionId) throw new Error('sessionId is required to prepare a shell run');

    const run = {
      runId: createRunId(),
      providerId,
      sessionId,
      toolCallId,
      mcpRequestId,
      description: normalizeDescription(description),
      command,
      cwd: cwd,
      maxLines,
      status: 'pending',
      rawOutput: '',
      transcript: '',
      stripStartupControls: this.platform === 'win32',
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
    description = '',
    command,
    cwd = null,
    maxLines = getMaxShellResultLines()
  }) {
    const resolvedSessionId = sessionId || acpSessionId;
    let run = this.findPreparedRun({ providerId, sessionId: resolvedSessionId, toolCallId, mcpRequestId, command, cwd });
    if (!run) {
      const prepared = this.prepareRun({ providerId, sessionId: resolvedSessionId, toolCallId, mcpRequestId, description, command, cwd, maxLines });
      run = this.runs.get(prepared.runId);
    }

    run.description = normalizeDescription(description) || run.description;
    run.command = run.command || command;
    run.cwd = normalizeCwd(cwd || run.cwd);
    run.maxLines = maxLines || run.maxLines;
    run.mcpRequestId = mcpRequestId ?? run.mcpRequestId;

    return this.startRun(run);
  }

  findRun({ providerId, sessionId, toolCallId = null, mcpRequestId = null, command = null, cwd = null, statuses = null, allowToolCallIdMismatch = false }) {
    const normalizedCwd = cwd ? normalizeCwd(cwd) : null;
    const allowedStatuses = Array.isArray(statuses) && statuses.length > 0
      ? new Set(statuses)
      : null;
    const candidates = [...this.runs.values()]
      .filter(run =>
        (!allowedStatuses || allowedStatuses.has(run.status)) &&
        run.providerId === providerId &&
        run.sessionId === sessionId
      )
      .sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));

    if (toolCallId) {
      const byToolCall = candidates.find(run => run.toolCallId === toolCallId);
      if (byToolCall) return byToolCall;
    }

    if (mcpRequestId !== undefined && mcpRequestId !== null) {
      const byRequest = candidates.find(run => isSameMcpRequestId(run.mcpRequestId, mcpRequestId));
      if (byRequest) return byRequest;
    }

    if (command) {
      const byCommand = candidates.filter(run =>
        run.command === command &&
        (!normalizedCwd || !run.cwd || normalizeCwd(run.cwd) === normalizedCwd) &&
        (allowToolCallIdMismatch || !toolCallId || !run.toolCallId || run.toolCallId === toolCallId)
      );
      if (byCommand.length === 1) return byCommand[0];
    }

    return null;
  }

  findPreparedRun(args) {
    // Do not claim an arbitrary pending run here. Late ACP tool-start events can
    // leave stale pending runs behind, and starting one would return the previous
    // command's output for the current MCP invocation.
    return this.findRun({ ...args, statuses: ['pending'] });
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
        const { shell, args } = buildShellInvocation(run.command, this.platform, this.pwshAvailable);
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
    let outputChunk = chunk;
    if (includeInRaw) {
      outputChunk = sanitizeShellOutputChunk(outputChunk, {
        stripStartupControls: Boolean(run.stripStartupControls)
      });
      if (run.stripStartupControls && hasVisibleShellOutput(outputChunk)) {
        run.stripStartupControls = false;
      }
    }
    if (!outputChunk) return;
    if (includeInRaw) run.rawOutput += outputChunk;
    run.transcript = trimShellOutputLines(`${run.transcript}${outputChunk}`, run.maxLines);
    this.emit(run, 'shell_run_output', {
      providerId: run.providerId,
      sessionId: run.sessionId,
      runId: run.runId,
      chunk: outputChunk,
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
    try {
      run.pty.resize(cols, rows);
    } catch {
      // node-pty on Windows defers the resize internally; the PTY may exit between
      // the status check above and the deferred WindowsPtyAgent.resize() call,
      // causing it to throw "Cannot resize a pty that has already exited".
      return false;
    }
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
      description: run.description,
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
