import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

let mockTerm;

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockTerm)
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

// Fresh import each suite to reset module-level terminals Map
const { default: registerTerminalHandlers } = await import('../sockets/terminalHandlers.js');

function createMockTerm() {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
}

describe('Terminal Handlers', () => {
  let socket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTerm = createMockTerm();
    socket = new EventEmitter();
    socket.id = 'sock-1';
    socket.emit = vi.fn();
    registerTerminalHandlers({}, socket);
  });

  async function spawnTerminal(opts = {}) {
    const cb = vi.fn();
    const handler = socket.listeners('terminal_spawn')[0];
    await handler({ cwd: opts.cwd || '/tmp', terminalId: opts.terminalId || 'term-1' }, cb);
    return cb;
  }

  describe('terminal_spawn', () => {
    it('creates a PTY and calls callback with success', async () => {
      const cb = await spawnTerminal();
      const pty = (await import('node-pty'));
      expect(pty.spawn).toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith({ success: true });
    });

    it('kills existing terminal before creating new one with same id', async () => {
      const firstTerm = mockTerm;
      await spawnTerminal();
      mockTerm = createMockTerm();
      await spawnTerminal();
      expect(firstTerm.kill).toHaveBeenCalled();
    });

    it('handles spawn errors gracefully', async () => {
      const pty = (await import('node-pty'));
      pty.spawn.mockImplementationOnce(() => { throw new Error('spawn failed'); });
      const cb = await spawnTerminal();
      expect(cb).toHaveBeenCalledWith({ error: 'spawn failed' });
    });
  });

  describe('terminal_input', () => {
    it('writes data to the PTY', async () => {
      await spawnTerminal();
      socket.listeners('terminal_input')[0]({ terminalId: 'term-1', data: 'hello' });
      expect(mockTerm.write).toHaveBeenCalledWith('hello');
    });

    it('does nothing if no terminal exists', () => {
      socket.listeners('terminal_input')[0]({ terminalId: 'term-1', data: 'hello' });
      expect(mockTerm.write).not.toHaveBeenCalled();
    });
  });

  describe('terminal_resize', () => {
    it('resizes the PTY', async () => {
      await spawnTerminal();
      socket.listeners('terminal_resize')[0]({ terminalId: 'term-1', cols: 80, rows: 40 });
      expect(mockTerm.resize).toHaveBeenCalledWith(80, 40);
    });

    it('ignores invalid dimensions (0 or negative)', async () => {
      await spawnTerminal();
      socket.listeners('terminal_resize')[0]({ terminalId: 'term-1', cols: 0, rows: 24 });
      socket.listeners('terminal_resize')[0]({ terminalId: 'term-1', cols: 80, rows: -1 });
      expect(mockTerm.resize).not.toHaveBeenCalled();
    });
  });

  describe('terminal_kill', () => {
    it('kills the PTY and removes from map', async () => {
      await spawnTerminal();
      socket.listeners('terminal_kill')[0]({ terminalId: 'term-1' });
      expect(mockTerm.kill).toHaveBeenCalled();
      // Verify removed: input should no longer write
      mockTerm.write.mockClear();
      socket.listeners('terminal_input')[0]({ terminalId: 'term-1', data: 'test' });
      expect(mockTerm.write).not.toHaveBeenCalled();
    });

    it('does nothing if no terminal exists', () => {
      socket.listeners('terminal_kill')[0]({ terminalId: 'term-1' });
      expect(mockTerm.kill).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('cleans up the PTY', async () => {
      await spawnTerminal();
      socket.listeners('disconnect')[0]();
      expect(mockTerm.kill).toHaveBeenCalled();
    });
  });

  describe('multi-terminal', () => {
    it('multiple terminals can coexist for the same socket', async () => {
      const term1 = mockTerm;
      await spawnTerminal({ terminalId: 'term-1' });
      const term2 = mockTerm = createMockTerm();
      await spawnTerminal({ terminalId: 'term-2' });

      socket.listeners('terminal_input')[0]({ terminalId: 'term-1', data: 'a' });
      socket.listeners('terminal_input')[0]({ terminalId: 'term-2', data: 'b' });

      expect(term1.write).toHaveBeenCalledWith('a');
      expect(term2.write).toHaveBeenCalledWith('b');
    });

    it('killing one terminal does not affect another', async () => {
      const term1 = mockTerm;
      await spawnTerminal({ terminalId: 'term-1' });
      const term2 = mockTerm = createMockTerm();
      await spawnTerminal({ terminalId: 'term-2' });

      socket.listeners('terminal_kill')[0]({ terminalId: 'term-1' });
      expect(term1.kill).toHaveBeenCalled();

      // term-2 still works
      socket.listeners('terminal_input')[0]({ terminalId: 'term-2', data: 'still here' });
      expect(term2.write).toHaveBeenCalledWith('still here');
    });

    it('disconnect cleans up all terminals for that socket', async () => {
      const term1 = mockTerm;
      await spawnTerminal({ terminalId: 'term-1' });
      const term2 = mockTerm = createMockTerm();
      await spawnTerminal({ terminalId: 'term-2' });

      socket.listeners('disconnect')[0]();

      expect(term1.kill).toHaveBeenCalled();
      expect(term2.kill).toHaveBeenCalled();
    });
  });
});
