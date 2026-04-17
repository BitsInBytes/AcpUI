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
vi.mock('../utils/terminalState', () => ({
  addSpawnedTerminal: vi.fn(),
  hasSpawnedTerminal: vi.fn(() => false),
  clearSpawnedTerminal: vi.fn(),
}));

import Terminal from '../components/Terminal';

describe('Terminal', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
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
});
