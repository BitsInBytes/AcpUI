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

interface ShellToolTerminalProps {
  event: SystemEvent;
}

const ansiConverter = new AnsiToHtml({ fg: '#d6dde6', bg: '#0b0f14', newline: false, escapeXML: true });

const stripAnsi = (value: string) => value
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\][^\x07]*\x07/g, '')
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[[?]?[0-9;]*[a-zA-Z]/g, '');

const stripTerminalNoise = (value: string) => value
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\][^\x07]*\x07/g, '')
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[[0-9;]*[A-HJ-T]/g, '');

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

function getReadOnlyTerminalHtml(run: ShellRunSnapshot | null, event: SystemEvent) {
  const transcript = run?.transcript || '';
  const finalOutput = event.output || '';
  const source = run?.status === 'exited' && transcriptHasCommandOutput(transcript, run.command || event.command)
    ? appendExitSummary(transcript, run, finalOutput)
    : finalOutput || transcript || '';
  return ansiConverter.toHtml(stripTerminalNoise(source || '(no output)'));
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const readOnlyRef = useRef<HTMLPreElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef('');
  const isRunning = run?.status === 'running';
  const isInteractiveTerminal = Boolean(run && run.status !== 'exited');
  const canStop = Boolean(run && run.status !== 'exited');
  const runRef = useRef<ShellRunSnapshot | null>(run);
  const isRunningRef = useRef(isRunning);
  const readOnlyHtml = useMemo(
    () => getReadOnlyTerminalHtml(run, event),
    [event, run]
  );

  useEffect(() => {
    runRef.current = run;
    isRunningRef.current = isRunning;
  }, [run, isRunning]);

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
    };
  }, [emitResize, socket, isInteractiveTerminal]);

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
    if (transcript.startsWith(written)) {
      const next = transcript.slice(written.length);
      if (next) term.write(next);
    } else {
      term.reset();
      if (transcript) term.write(transcript);
    }
    writtenRef.current = transcript;
  }, [run?.transcript]);

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
