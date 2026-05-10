import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Square } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import AnsiToHtml from 'ansi-to-html';
import '@xterm/xterm/css/xterm.css';
import type { SystemEvent } from '../types';
import { useSystemStore } from '../store/useSystemStore';
import { useShellRunStore, type ShellRunSnapshot } from '../store/useShellRunStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';

interface ShellToolTerminalProps {
  event: SystemEvent;
}

const ansiConverter = new AnsiToHtml({ fg: '#d6dde6', bg: '#0b0f14', newline: false, escapeXML: true });

const stripAnsi = (value: string) => value
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[[?]?[0-9;]*[a-zA-Z]/g, '');

const stripTerminalNoise = (value: string) => value
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[[0-9;]*[A-HJ-TX]/g, '');

// eslint-disable-next-line no-control-regex
const SCREEN_CONTROL_SEQUENCE = /\x1b\[[0-9;]*[HfJ]/;
// eslint-disable-next-line no-control-regex
const LEADING_ANSI_RESETS_AND_BLANK_ROWS = /^((?:\x1b\[[0-9;]*m)*)(?:[ \t]*\r?\n)+/;
// eslint-disable-next-line no-control-regex
const PROMPT_ANSI_RESETS_AND_BLANK_ROWS = /^(\$ [^\n]*\n)((?:\x1b\[[0-9;]*m)*)(?:[ \t]*\r?\n)+/;

const XTERM_WRITE_CHUNK_SIZE = 64 * 1024;
const TRANSCRIPT_OVERLAP_SCAN_LIMIT = 64 * 1024;
const MIN_TRIM_OVERLAP = 32;

function getSuffixPrefixOverlap(previous: string, next: string) {
  if (!previous || !next) return 0;

  const nextHead = next.slice(0, TRANSCRIPT_OVERLAP_SCAN_LIMIT);
  const previousTail = previous.slice(-TRANSCRIPT_OVERLAP_SCAN_LIMIT);
  const marker = '\u0000';
  const value = `${nextHead}${marker}${previousTail}`;
  const prefix = new Array(value.length).fill(0);

  for (let index = 1; index < value.length; index += 1) {
    let length = prefix[index - 1];
    while (length > 0 && value[index] !== value[length]) {
      length = prefix[length - 1];
    }
    if (value[index] === value[length]) {
      length += 1;
    }
    prefix[index] = length;
  }

  return Math.min(prefix[value.length - 1] || 0, next.length);
}

function getTranscriptWritePlan(previous: string, next: string) {
  if (!next) return { reset: false, data: '' };
  if (!previous) return { reset: false, data: next };
  if (next.startsWith(previous)) {
    return { reset: false, data: next.slice(previous.length) };
  }

  const overlap = getSuffixPrefixOverlap(previous, next);
  const requiredOverlap = Math.min(MIN_TRIM_OVERLAP, Math.ceil(next.length / 2));
  if (overlap >= requiredOverlap) {
    return { reset: false, data: next.slice(overlap) };
  }

  return { reset: true, data: next };
}

function transcriptHasCommandOutput(transcript?: string, command?: string) {
  const plain = stripAnsi(transcript || '').replace(/\r\n/g, '\n');
  const lines = plain.split('\n');
  const firstLine = lines[0]?.trim();
  if (firstLine === `$ ${command || ''}`.trim() || firstLine?.startsWith('$ ')) {
    lines.shift();
  }
  return lines.join('\n').trim().length > 0;
}

function appendExitSummary(source: string, run: ShellRunSnapshot | null, finalOutput?: string) {
  const plainSource = stripAnsi(source);
  if (run?.reason === 'user_terminated' && !plainSource.includes('Command terminated by user')) {
    return `${source.trimEnd()}\n\nCommand terminated by user`;
  }
  if (run?.reason === 'timeout' && !plainSource.includes('Command timed out')) {
    return `${source.trimEnd()}\n\nCommand timed out after 30 minutes without output`;
  }
  if (run?.reason === 'failed' && run.exitCode !== null && run.exitCode !== undefined && !plainSource.includes('Exit Code:')) {
    return `${source.trimEnd()}\n\nExit Code: ${run.exitCode}`;
  }
  return source || finalOutput || '';
}

function trimStartupBlankRows(source: string, command?: string) {
  const prompt = command ? `$ ${command}\n` : '';
  if (prompt && source.startsWith(prompt)) {
    return `${prompt}${source.slice(prompt.length).replace(LEADING_ANSI_RESETS_AND_BLANK_ROWS, '$1')}`;
  }
  return source.replace(PROMPT_ANSI_RESETS_AND_BLANK_ROWS, '$1$2');
}

function getReadOnlyTerminalHtml(run: ShellRunSnapshot | null, event: SystemEvent) {
  const transcript = run?.transcript || '';
  const finalOutput = event.output || '';
  const source = run?.status === 'exited' && transcriptHasCommandOutput(transcript, run.command || event.command)
    ? appendExitSummary(transcript, run, finalOutput)
    : finalOutput || transcript || '';
  const cleaned = stripTerminalNoise(source || '(no output)');
  const displaySource = SCREEN_CONTROL_SEQUENCE.test(source)
    ? trimStartupBlankRows(cleaned, run?.command || event.command)
    : cleaned;
  return ansiConverter.toHtml(displaySource);
}

function fallbackRunFromEvent(event: SystemEvent): ShellRunSnapshot | null {
  if (!event.shellRunId) return null;
  return {
    providerId: event.providerId || '',
    sessionId: event.sessionId || '',
    runId: event.shellRunId,
    status: event.shellState || (event.status === 'in_progress' ? 'pending' : 'exited'),
    command: event.command,
    cwd: event.cwd,
    transcript: ''
  };
}

const ShellToolTerminal: React.FC<ShellToolTerminalProps> = ({ event }) => {
  const socket = useSystemStore(state => state.socket);
  const storedRun = useShellRunStore(state => event.shellRunId ? state.runs[event.shellRunId] : undefined);
  const fallbackRun = useMemo(() => fallbackRunFromEvent(event), [event]);
  const run = storedRun || fallbackRun;

  const isActiveSession = useSessionLifecycleStore(state => {
    if (!state.activeSessionId) return false;
    const activeSession = state.sessions.find(s => s.id === state.activeSessionId);
    return activeSession?.acpSessionId === event.sessionId;
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const readOnlyRef = useRef<HTMLPreElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef('');
  const writeQueueRef = useRef<string[]>([]);
  const writeInFlightRef = useRef(false);
  const writeGenerationRef = useRef(0);
  const drainWriteQueueRef = useRef<() => void>(() => undefined);
  const isRunning = run?.status === 'running';
  const isInteractiveTerminal = Boolean(run && run.status !== 'exited');
  const canStop = Boolean(run && run.status !== 'exited');
  const runRef = useRef<ShellRunSnapshot | null>(run);
  const isRunningRef = useRef(isRunning);
  const readOnlyHtml = useMemo(
    () => getReadOnlyTerminalHtml(run, event),
    [event, run]
  );

  const [isTerminalReady, setIsTerminalReady] = React.useState(false);

  useEffect(() => {
    runRef.current = run;
    isRunningRef.current = isRunning;
  }, [run, isRunning]);

  useEffect(() => {
    if (isActiveSession && isRunning && isTerminalReady && xtermRef.current) {
      const timer = setTimeout(() => {
        xtermRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActiveSession, isRunning, isTerminalReady]);

  const drainWriteQueue = useCallback(() => {
    const term = xtermRef.current;
    if (!term || writeInFlightRef.current) return;

    const next = writeQueueRef.current.shift();
    if (!next) return;

    const generation = writeGenerationRef.current;
    writeInFlightRef.current = true;
    try {
      term.write(next, () => {
        if (writeGenerationRef.current !== generation) return;
        writeInFlightRef.current = false;
        drainWriteQueueRef.current();
      });
    } catch {
      if (writeGenerationRef.current !== generation) return;
      writeInFlightRef.current = false;
      drainWriteQueueRef.current();
    }
  }, []);

  useEffect(() => {
    drainWriteQueueRef.current = drainWriteQueue;
  }, [drainWriteQueue]);

  const enqueueTerminalWrite = useCallback((data: string) => {
    if (!data || !xtermRef.current) return;
    for (let index = 0; index < data.length; index += XTERM_WRITE_CHUNK_SIZE) {
      writeQueueRef.current.push(data.slice(index, index + XTERM_WRITE_CHUNK_SIZE));
    }
    drainWriteQueue();
  }, [drainWriteQueue]);

  const resetQueuedWrites = useCallback(() => {
    writeGenerationRef.current += 1;
    writeQueueRef.current = [];
    writeInFlightRef.current = false;
  }, []);

  const emitResize = useCallback(() => {
    const term = xtermRef.current;
    const currentRun = runRef.current;
    if (!term || !currentRun?.runId || !currentRun.providerId || !currentRun.sessionId) return;
    fitRef.current?.fit();
    socket?.emit('shell_run_resize', {
      providerId: currentRun.providerId,
      sessionId: currentRun.sessionId,
      runId: currentRun.runId,
      cols: term.cols,
      rows: term.rows
    });
  }, [socket]);

  useEffect(() => {
    if (!isInteractiveTerminal) return;
    if (!containerRef.current || xtermRef.current) return;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      theme: { background: '#0b0f14', foreground: '#d6dde6', cursor: '#6cb6ff', selectionBackground: '#31475f' },
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    xtermRef.current = term;
    fitRef.current = fit;
    setIsTerminalReady(true);

    let isPasting = false;
    term.attachCustomKeyEventHandler((keyboardEvent) => {
      if (keyboardEvent.type === 'keydown' && keyboardEvent.ctrlKey && keyboardEvent.key.toLowerCase() === 'v') {
        if (!isRunningRef.current) return false;
        isPasting = true;
        const clipboardText = navigator.clipboard?.readText?.();
        if (!clipboardText) {
          isPasting = false;
          return false;
        }
        clipboardText.then(text => {
          const currentRun = runRef.current;
          if (text && currentRun?.runId) {
            socket?.emit('shell_run_input', {
              providerId: currentRun.providerId,
              sessionId: currentRun.sessionId,
              runId: currentRun.runId,
              data: text
            });
          }
          isPasting = false;
        }).catch(() => {
          isPasting = false;
        });
        return false;
      }
      return true;
    });

    const dataDisposable = term.onData((data) => {
      const currentRun = runRef.current;
      if (!isRunningRef.current || isPasting || !currentRun?.runId) return;
      socket?.emit('shell_run_input', {
        providerId: currentRun.providerId,
        sessionId: currentRun.sessionId,
        runId: currentRun.runId,
        data
      });
    });

    const resizeTimer = setTimeout(emitResize, 50);
    window.addEventListener('resize', emitResize);

    return () => {
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', emitResize);
      dataDisposable?.dispose?.();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      writtenRef.current = '';
      resetQueuedWrites();
    };
  }, [emitResize, socket, isInteractiveTerminal, resetQueuedWrites]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.cursorBlink = isRunning;
  }, [isRunning]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const transcript = run?.transcript || '';
    const written = writtenRef.current;
    const plan = getTranscriptWritePlan(written, transcript);
    if (plan.reset) {
      resetQueuedWrites();
      term.reset();
    }
    enqueueTerminalWrite(plan.data);
    writtenRef.current = transcript;
  }, [enqueueTerminalWrite, resetQueuedWrites, run?.transcript]);

  useLayoutEffect(() => {
    if (isInteractiveTerminal) return;
    const readOnly = readOnlyRef.current;
    if (!readOnly) return;
    readOnly.scrollTop = readOnly.scrollHeight;
  }, [isInteractiveTerminal, readOnlyHtml]);

  const stopRun = () => {
    if (!run?.runId || !run.providerId || !run.sessionId) return;
    socket?.emit('shell_run_kill', {
      providerId: run.providerId,
      sessionId: run.sessionId,
      runId: run.runId
    });
  };

  return (
    <div className="shell-tool-terminal">
      <div className="shell-tool-terminal-toolbar">
        <span className="shell-tool-terminal-title">{run?.command || event.command || event.title}</span>
        <button
          type="button"
          className="shell-tool-terminal-stop"
          onClick={stopRun}
          disabled={!canStop}
          title="Stop command"
        >
          <Square size={13} fill="currentColor" />
        </button>
      </div>
      {isInteractiveTerminal ? (
        <div ref={containerRef} className="shell-tool-terminal-surface" />
      ) : (
        <pre ref={readOnlyRef} className="shell-tool-terminal-readonly" dangerouslySetInnerHTML={{ __html: readOnlyHtml }} />
      )}
    </div>
  );
};

export default ShellToolTerminal;
