import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    open = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    dispose = vi.fn();
    cols = 80;
    rows = 24;
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit = vi.fn(); dispose = vi.fn(); },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class { dispose = vi.fn(); },
}));
vi.mock('../utils/terminalState', () => {
  const spawned = new Set<string>();
  return {
    addSpawnedTerminal: vi.fn((id: string) => { spawned.add(id); }),
    hasSpawnedTerminal: vi.fn((id: string) => spawned.has(id)),
    clearSpawnedTerminal: vi.fn((id: string) => { spawned.delete(id); }),
  };
});

import Terminal from '../components/Terminal';
import { addSpawnedTerminal, clearSpawnedTerminal } from '../utils/terminalState';

describe('Terminal', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearSpawnedTerminal('t1');
    mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders container div when visible', () => {
    const { container } = render(
      <Terminal socket={mockSocket} cwd="/test" terminalId="t1" visible={true} />
    );
    const termDiv = container.querySelector('.git-terminal');
    expect(termDiv).toBeInTheDocument();
    expect(termDiv).toHaveStyle({ display: 'block' });
  });

  it('hides container when not visible', () => {
    const { container } = render(
      <Terminal socket={mockSocket} cwd="/test" terminalId="t1" visible={false} />
    );
    const termDiv = container.querySelector('.git-terminal');
    expect(termDiv).toHaveStyle({ display: 'none' });
  });

  it('calls socket.emit terminal_spawn on mount', () => {
    render(
      <Terminal socket={mockSocket} cwd="/test" terminalId="t1" visible={true} />
    );
    vi.advanceTimersByTime(200);
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'terminal_spawn',
      { cwd: '/test', terminalId: 't1' },
      expect.any(Function)
    );
  });

  it('clears spawn guard on backend spawn failure so a later retry can occur', () => {
    const { rerender } = render(
      <Terminal socket={mockSocket} cwd="/test" terminalId="t1" visible={true} />
    );

    vi.advanceTimersByTime(200);
    const firstSpawnCall = mockSocket.emit.mock.calls.find((call: any[]) => call[0] === 'terminal_spawn');
    expect(firstSpawnCall).toBeDefined();
    expect(addSpawnedTerminal).toHaveBeenCalledWith('t1');

    const firstCallback = firstSpawnCall?.[2] as ((res: { error?: string }) => void);
    firstCallback({ error: 'spawn failed' });
    expect(clearSpawnedTerminal).toHaveBeenCalledWith('t1');

    rerender(<Terminal socket={mockSocket} cwd="/test-retry" terminalId="t1" visible={true} />);
    vi.advanceTimersByTime(200);

    const spawnCalls = mockSocket.emit.mock.calls.filter((call: any[]) => call[0] === 'terminal_spawn');
    expect(spawnCalls).toHaveLength(2);
  });

  it('spawns when socket/cwd become available after mount', () => {
    const { rerender } = render(
      <Terminal socket={null} cwd="" terminalId="t1" visible={true} />
    );

    vi.advanceTimersByTime(200);
    expect(mockSocket.emit).not.toHaveBeenCalledWith('terminal_spawn', expect.anything(), expect.any(Function));

    rerender(<Terminal socket={mockSocket} cwd="/late-cwd" terminalId="t1" visible={true} />);
    vi.advanceTimersByTime(200);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'terminal_spawn',
      { cwd: '/late-cwd', terminalId: 't1' },
      expect.any(Function)
    );
  });
});
