import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useSystemStore } from '../store/useSystemStore';
import { useShellRunStore } from '../store/useShellRunStore';
import type { SystemEvent } from '../types';

const terminals: any[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn((handler) => { this.keyHandler = handler; });
    onData = vi.fn((handler) => { this.dataHandler = handler; return { dispose: vi.fn() }; });
    write = vi.fn();
    writeln = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
    cols = 80;
    rows = 24;
    options: any;
    keyHandler?: (event: KeyboardEvent) => boolean;
    dataHandler?: (data: string) => void;

    constructor(options: any) {
      this.options = options;
      terminals.push(this);
    }
  }
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit = vi.fn(); dispose = vi.fn(); }
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class { dispose = vi.fn(); }
}));

import ShellToolTerminal from '../components/ShellToolTerminal';

const baseEvent = (overrides: Partial<SystemEvent> = {}): SystemEvent => ({
  id: 'tool-1',
  title: 'Run shell',
  status: 'in_progress',
  providerId: 'provider-a',
  sessionId: 'acp-1',
  toolName: 'ux_invoke_shell',
  shellRunId: 'shell-run-1',
  shellState: 'running',
  ...overrides
});

describe('ShellToolTerminal', () => {
  let socket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    terminals.length = 0;
    socket = { emit: vi.fn() };
    useSystemStore.setState({ socket });
    useShellRunStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays transcript into xterm without spawning a terminal', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      status: 'running',
      command: 'npm test',
      transcript: '$ npm test\nPASS\n'
    });

    render(<ShellToolTerminal event={baseEvent()} />);

    expect(terminals[0].write).toHaveBeenCalledWith('$ npm test\nPASS\n');
    expect(socket.emit).not.toHaveBeenCalledWith('terminal_spawn', expect.anything(), expect.anything());
  });

  it('renders completed runs as read-only text without creating xterm', () => {
    const { container } = render(<ShellToolTerminal event={baseEvent({
      status: 'completed',
      shellState: 'exited',
      output: '\x1b[32mPASS\x1b[0m'
    })} />);

    expect(terminals).toHaveLength(0);
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(container.querySelector('.shell-tool-terminal-readonly')?.innerHTML).toContain('color');
  });

  it('prefers colored stored transcript over plain final output after exit', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      status: 'exited',
      command: 'npm test',
      transcript: '$ npm test\n\x1b[32mPASS\x1b[0m\n'
    });

    const { container } = render(<ShellToolTerminal event={baseEvent({
      status: 'completed',
      shellState: 'exited',
      output: 'PASS'
    })} />);

    const readonly = container.querySelector('.shell-tool-terminal-readonly');
    expect(readonly?.textContent).toContain('$ npm test');
    expect(readonly?.textContent).toContain('PASS');
    expect(readonly?.innerHTML).toContain('color');
  });

  it('prefers final output over prompt-only stored transcript after exit', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      status: 'exited',
      command: 'npm run build',
      transcript: '$ npm run build\n'
    });

    render(<ShellToolTerminal event={baseEvent({
      status: 'completed',
      shellState: 'exited',
      output: 'dist/assets/index.js\nbuilt in 1.2s'
    })} />);

    expect(screen.getByText(/built in 1\.2s/)).toBeInTheDocument();
    expect(screen.queryByText('$ npm run build')).not.toBeInTheDocument();
  });

  it('scrolls read-only output to the bottom after exit', () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, value: 900 });

    try {
      render(<ShellToolTerminal event={baseEvent({
        status: 'completed',
        shellState: 'exited',
        output: Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')
      })} />);

      const readonly = document.querySelector('.shell-tool-terminal-readonly') as HTMLPreElement;
      expect(readonly.scrollTop).toBe(900);
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      } else {
        delete (HTMLElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
      }
    }
  });

  it('sends input only while running', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      status: 'running',
      transcript: ''
    });
    const { rerender } = render(<ShellToolTerminal event={baseEvent()} />);

    terminals[0].dataHandler?.('a');
    expect(socket.emit).toHaveBeenCalledWith('shell_run_input', {
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      data: 'a'
    });
    terminals[0].dataHandler?.('\x03');
    expect(socket.emit).toHaveBeenCalledWith('shell_run_input', {
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      data: '\x03'
    });

    useShellRunStore.getState().markExited({ providerId: 'provider-a', sessionId: 'acp-1', runId: 'shell-run-1' });
    rerender(<ShellToolTerminal event={baseEvent({ shellState: 'exited', status: 'completed' })} />);
    socket.emit.mockClear();
    terminals[0].dataHandler?.('b');
    expect(socket.emit).not.toHaveBeenCalledWith('shell_run_input', expect.anything());
  });

  it('sends clipboard paste through shell_run_input', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue('clip text') }
    });
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      status: 'running',
      transcript: ''
    });
    render(<ShellToolTerminal event={baseEvent()} />);

    terminals[0].keyHandler?.({ type: 'keydown', ctrlKey: true, key: 'v' } as KeyboardEvent);
    await vi.runAllTimersAsync();

    expect(socket.emit).toHaveBeenCalledWith('shell_run_input', expect.objectContaining({
      runId: 'shell-run-1',
      data: 'clip text'
    }));
  });

  it('emits resize from fitted xterm dimensions', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      status: 'running',
      transcript: ''
    });
    render(<ShellToolTerminal event={baseEvent()} />);
    vi.advanceTimersByTime(60);

    expect(socket.emit).toHaveBeenCalledWith('shell_run_resize', {
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      cols: 80,
      rows: 24
    });
  });

  it('sends stop command and disables stop after exit', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1',
      status: 'running',
      transcript: ''
    });
    const { rerender } = render(<ShellToolTerminal event={baseEvent()} />);

    fireEvent.click(screen.getByTitle('Stop command'));
    expect(socket.emit).toHaveBeenCalledWith('shell_run_kill', {
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'shell-run-1'
    });

    useShellRunStore.getState().markExited({ providerId: 'provider-a', sessionId: 'acp-1', runId: 'shell-run-1' });
    rerender(<ShellToolTerminal event={baseEvent({ shellState: 'exited', status: 'completed' })} />);
    expect(terminals[0].dispose).toHaveBeenCalled();
    expect(screen.getByTitle('Stop command')).toBeDisabled();
  });
});
