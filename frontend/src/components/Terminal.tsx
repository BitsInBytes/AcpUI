import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { Socket } from 'socket.io-client';
import { addSpawnedTerminal, hasSpawnedTerminal, clearSpawnedTerminal } from '../utils/terminalState';

interface TerminalProps {
  socket: Socket | null;
  cwd: string;
  terminalId: string;
  visible: boolean;
  onExit?: () => void;
}

const Terminal: React.FC<TerminalProps> = ({ socket, cwd, terminalId, visible, onExit }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef(terminalId);
  const socketRef = useRef<Socket | null>(socket);

  useEffect(() => {
    terminalIdRef.current = terminalId;
  }, [terminalId]);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  const handleOutput = useCallback((msg: { terminalId: string; data: string }) => {
    if (msg.terminalId === terminalIdRef.current) xtermRef.current?.write(msg.data);
  }, []);

  const handleExit = useCallback((msg: { terminalId: string }) => {
    if (msg.terminalId === terminalIdRef.current) {
      xtermRef.current?.writeln('\r\n\x1b[90m[Terminal exited]\x1b[0m');
      clearSpawnedTerminal(terminalIdRef.current);
      onExit?.();
    }
  }, [onExit]);

  // Initialize xterm once on mount.
  useEffect(() => {
    if (!containerRef.current || xtermRef.current) return;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: '#264f78' },
      cursorBlink: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    xtermRef.current = term;
    fitRef.current = fit;

    let isPasting = false;
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') {
        isPasting = true;
        navigator.clipboard.readText().then(text => {
          if (text) {
            socketRef.current?.emit('terminal_input', { terminalId: terminalIdRef.current, data: text });
          }
          isPasting = false;
        });
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (!isPasting) {
        socketRef.current?.emit('terminal_input', { terminalId: terminalIdRef.current, data });
      }
    });

    return () => {
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Keep socket listeners current so reconnect/replacement sockets still receive terminal events.
  useEffect(() => {
    if (!socket) return;
    socket.on('terminal_output', handleOutput);
    socket.on('terminal_exit', handleExit);
    return () => {
      socket.off('terminal_output', handleOutput);
      socket.off('terminal_exit', handleExit);
    };
  }, [socket, handleOutput, handleExit]);

  // Spawn when dependencies are ready; this also supports late socket/cwd availability.
  useEffect(() => {
    if (!socket || !cwd || !xtermRef.current) return;
    if (hasSpawnedTerminal(terminalId)) return;

    addSpawnedTerminal(terminalId);
    const timer = window.setTimeout(() => {
      socket.emit('terminal_spawn', { cwd, terminalId }, (res: { error?: string }) => {
        if (res?.error) {
          xtermRef.current?.writeln(`\x1b[31mFailed to start terminal: ${res.error}\x1b[0m`);
          clearSpawnedTerminal(terminalId);
        }
      });
    }, 100);

    return () => {
      window.clearTimeout(timer);
    };
  }, [socket, cwd, terminalId]);

  // Fit when becoming visible.
  useEffect(() => {
    if (!visible || !fitRef.current) return;

    const timer = window.setTimeout(() => {
      fitRef.current?.fit();
      const term = xtermRef.current;
      const currentSocket = socketRef.current;
      if (term && currentSocket) {
        currentSocket.emit('terminal_resize', { terminalId: terminalIdRef.current, cols: term.cols, rows: term.rows });
      }
    }, 50);

    return () => {
      window.clearTimeout(timer);
    };
  }, [visible]);

  return <div ref={containerRef} className="git-terminal" style={{ display: visible ? 'block' : 'none', height: '100%' }} />;
};

export default Terminal;
