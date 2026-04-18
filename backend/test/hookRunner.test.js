import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHooks } from '../services/hookRunner.js';
import { exec } from 'child_process';

vi.mock('child_process');
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

const { mockProviderModule } = vi.hoisted(() => ({
  mockProviderModule: {
    getHooksForAgent: vi.fn().mockResolvedValue([]),
  }
}));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { cliManagedHooks: [] }
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({ config: mockConfig }),
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule),
}));

describe('hookRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderModule.getHooksForAgent.mockResolvedValue([]);
  });

  describe('runHooks', () => {
    it('runs hooks and captures stdout', async () => {
      mockProviderModule.getHooksForAgent.mockResolvedValue([{ command: 'echo hello' }]);
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      exec.mockImplementation((cmd, opts, cb) => {
        setTimeout(() => cb(null, 'hook output', ''), 0);
        return { stdin: mockStdin };
      });

      const results = await runHooks('agent1', 'session_start');
      expect(results).toEqual(['hook output']);
    });

    it('returns empty array when provider returns no hooks', async () => {
      mockProviderModule.getHooksForAgent.mockResolvedValue([]);
      const res = await runHooks('agent-empty', 'session_start');
      expect(res).toEqual([]);
    });

    it('skips hooks listed in cliManagedHooks', async () => {
      mockConfig.cliManagedHooks = ['stop'];
      mockProviderModule.getHooksForAgent.mockResolvedValue([{ command: 'echo stop' }]);
      const res = await runHooks('agent1', 'stop');
      expect(res).toEqual([]);
      expect(mockProviderModule.getHooksForAgent).not.toHaveBeenCalled();
      mockConfig.cliManagedHooks = [];
    });

    it('filters hooks by matcher (fs_write → editing)', async () => {
      mockProviderModule.getHooksForAgent.mockResolvedValue([
        { command: 'ls', matcher: 'fs_write' },
        { command: 'cat', matcher: 'fs_read' },
      ]);
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      exec.mockImplementation((cmd, opts, cb) => {
        setTimeout(() => cb(null, 'ok', ''), 0);
        return { stdin: mockStdin };
      });

      const res = await runHooks('agent3', 'post_tool', {}, { matcher: 'Editing file.js' });
      expect(res).toHaveLength(1);
      expect(exec).toHaveBeenCalledWith('ls', expect.any(Object), expect.any(Function));
    });

    it('handles script errors gracefully', async () => {
      mockProviderModule.getHooksForAgent.mockResolvedValue([{ command: 'bad' }]);
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      exec.mockImplementation((cmd, opts, cb) => {
        setTimeout(() => cb(new Error('fail'), 'partial', 'some error'), 0);
        return { stdin: mockStdin };
      });
      const res = await runHooks('agent4', 'stop');
      expect(res).toEqual(['partial']);
    });

    it('rejects on timeout', async () => {
      mockProviderModule.getHooksForAgent.mockResolvedValue([{ command: 'slow' }]);
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      exec.mockImplementation((cmd, opts, cb) => {
        const err = new Error('timed out');
        err.killed = true;
        setTimeout(() => cb(err, '', ''), 0);
        return { stdin: mockStdin };
      });
      const res = await runHooks('agent5', 'stop');
      expect(res).toEqual([]);
    });

    it('emits hooks_status when running stop hooks with io and sessionId', async () => {
      vi.useFakeTimers();
      mockProviderModule.getHooksForAgent.mockResolvedValue([{ command: 'echo done' }]);
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      exec.mockImplementation((cmd, opts, cb) => {
        setTimeout(() => cb(null, 'done', ''), 0);
        return { stdin: mockStdin };
      });
      const mockIo = { to: vi.fn().mockReturnThis(), emit: vi.fn() };

      const resultPromise = runHooks('agent-stop-io', 'stop', {}, { io: mockIo, sessionId: 'sess-1' });
      await vi.advanceTimersByTimeAsync(200);
      const result = await resultPromise;

      expect(mockIo.to).toHaveBeenCalledWith('session:sess-1');
      expect(result).toEqual(['done']);
      vi.useRealTimers();
    });

    it('filters by shell/bash matcher for running commands', async () => {
      mockProviderModule.getHooksForAgent.mockResolvedValue([
        { command: 'echo bash', matcher: 'bash' },
        { command: 'echo other', matcher: 'other_tool' },
      ]);
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      exec.mockImplementation((cmd, opts, cb) => {
        setTimeout(() => cb(null, 'bash out', ''), 0);
        return { stdin: mockStdin };
      });
      const res = await runHooks('agent-bash', 'post_tool', {}, { matcher: 'Running bash script' });
      expect(res).toHaveLength(1);
      expect(exec).toHaveBeenCalledWith('echo bash', expect.any(Object), expect.any(Function));
    });

    it('matches by generic substring matcher', async () => {
      mockProviderModule.getHooksForAgent.mockResolvedValue([
        { command: 'echo generic', matcher: 'search_files' },
      ]);
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      exec.mockImplementation((cmd, opts, cb) => {
        setTimeout(() => cb(null, 'matched', ''), 0);
        return { stdin: mockStdin };
      });
      const res = await runHooks('agent-generic', 'post_tool', {}, { matcher: 'search_files' });
      expect(res).toHaveLength(1);
    });

    it('writes stdinData to child stdin when context has keys', async () => {
      mockProviderModule.getHooksForAgent.mockResolvedValue([{ command: 'cat' }]);
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      exec.mockImplementation((cmd, opts, cb) => {
        setTimeout(() => cb(null, 'stdin read', ''), 0);
        return { stdin: mockStdin };
      });
      await runHooks('agent-stdin', 'session_start', { cwd: '/project', sessionId: 'sess-1' });
      expect(mockStdin.write).toHaveBeenCalledWith(expect.stringContaining('"cwd"'));
    });

    it('passes agentName and hookType to getHooksForAgent', async () => {
      await runHooks('my-agent', 'post_tool');
      expect(mockProviderModule.getHooksForAgent).toHaveBeenCalledWith('my-agent', 'post_tool');
    });
  });
});
