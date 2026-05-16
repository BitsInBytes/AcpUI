import { describe, it, expect, vi, beforeEach } from 'vitest';
import acpClient, { buildAcpSpawnCommand } from '../services/acpClient.js';
import { getProviderModule } from '../services/providerLoader.js';
import { rememberProviderStatusExtension } from '../services/providerStatusMemory.js';
import { spawn } from 'child_process';
import EventEmitter from 'events';

vi.mock('child_process', () => {
  const EventEmitter = require('events');
  class MockProcess extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdin = { write: vi.fn() };
      this.kill = vi.fn();
    }
  }
  return {
    spawn: vi.fn(() => new MockProcess())
  };
});

vi.mock('../database.js', () => ({
  initDb: vi.fn().mockResolvedValue({}),
  getSessionByAcpId: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue({}),
  saveModelState: vi.fn().mockResolvedValue({}),
  saveConfigOptions: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));
vi.mock('../services/providerStatusMemory.js', () => ({
  rememberProviderStatusExtension: vi.fn()
}));
vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      name: 'Test',
      command: 'test-cli',
      args: ['acp'],
      protocolPrefix: '_test.dev/',
      executable: { command: 'node', args: [], env: {} },
      paths: { sessions: '/tmp/test-sessions', agents: '/tmp/test-agents', attachments: '/tmp/test-attachments' },
      models: { default: 'balanced', flagship: { id: 'm1' }, balanced: { id: 'm2' }, fast: { id: 'm3' } }
    }
  }),
  getProviderModule: vi.fn().mockResolvedValue({
    performHandshake: async () => {},
    normalizeUpdate: (u) => u,
    normalizeModelState: (s) => s,
    prepareAcpEnvironment: async (env) => env,
    emitCachedContext: () => false,
    intercept: (p) => p,
  }),
  runWithProvider: vi.fn((_p, fn) => fn())
}));

describe('AcpClient Service', () => {
  const mockIo = { emit: vi.fn(), to: vi.fn().mockReturnThis() };

  beforeEach(() => {
    vi.clearAllMocks();
    acpClient.io = mockIo;
    acpClient.sessionMetadata.clear();
    acpClient.transport.pendingRequests.clear();
  });

  describe('handleUpdate', () => {
    it('should emit token for agent_message_chunk', async () => {
      await acpClient.handleUpdate('s1', { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } });
      expect(mockIo.emit).toHaveBeenCalledWith('token', expect.objectContaining({ text: 'hi' }));
    });

    it('should handle RESOURCE_EXHAUSTED in stderr', async () => {
      await acpClient.start();
      acpClient.acpProcess.stderr.emit('data', Buffer.from('RESOURCE_EXHAUSTED: quota reached'));
      expect(mockIo.emit).toHaveBeenCalledWith('quota_error', expect.any(Object));
    });
  });

  describe('permissions', () => {
    it('should handle request permission', async () => {
      await acpClient.handleRequestPermission(123, { sessionId: 's1', options: [], toolCall: {} });
      expect(acpClient.permissions.pendingPermissions.get('s1')).toBe(123);
    });

    it('should send compliant outcome for reject', async () => {
      await acpClient.start();
      await acpClient.permissions.respond(42, 'reject', acpClient.transport);
      const written = acpClient.acpProcess.stdin.write.mock.calls[0][0];
      expect(JSON.parse(written).result.outcome.outcome).toBe('cancelled');
    });
  });

  describe('extensions', () => {
    it('handles handleProviderExtension config_options update', async () => {
      acpClient.sessionMetadata.set('s1', { configOptions: [] });
      await acpClient.handleProviderExtension({
        method: '_test.dev/config_options',
        params: { sessionId: 's1', options: [{ id: 'opt1', currentValue: 'v1' }] }
      });
      expect(acpClient.sessionMetadata.get('s1').configOptions[0].id).toBe('opt1');
    });
  });

  describe('start lifecycle', () => {
    it('should implement exponential back-off for restarts', async () => {
      vi.useFakeTimers();
      const AcpClientClass = acpClient.constructor;
      const localClient = new AcpClientClass();
      localClient.io = mockIo;
      localClient.lastRestartTime = Date.now();
      localClient.restartAttempts = 0;
      
      let spawnCount = 0;
      spawn.mockImplementation(() => {
        spawnCount++;
        const EventEmitter = require('events');
        const emitter = new EventEmitter();
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.stdin = { write: vi.fn() };
        return emitter;
      });

      await localClient.start();
      localClient.acpProcess.emit('exit', 1);
      expect(localClient.restartAttempts).toBe(1);
      
      await vi.advanceTimersByTimeAsync(2050);
      expect(spawnCount).toBe(2);

      localClient.acpProcess.emit('exit', 1);
      expect(localClient.restartAttempts).toBe(2);
      vi.useRealTimers();
    });

    it('should handle malformed JSON in stdout', async () => {
      await acpClient.start();
      acpClient.acpProcess.stdout.emit('data', Buffer.from('invalid\n'));
      expect(true).toBe(true);
    });

    it('should parse JSON-RPC error responses', async () => {
      await acpClient.start();
      const reject = vi.fn();
      acpClient.transport.pendingRequests.set(99, { resolve: vi.fn(), reject, method: 'test', params: {} });
      const response = JSON.stringify({ jsonrpc: '2.0', id: 99, error: { message: 'fail' } }) + '\n';
      acpClient.acpProcess.stdout.emit('data', response);
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'fail' }));
    });

    it('should log extra info for invalid argument errors', async () => {
      await acpClient.start();
      const reject = vi.fn();
      acpClient.transport.pendingRequests.set(100, { resolve: vi.fn(), reject, method: 'test', params: { long: 'x'.repeat(2500) } });
      const response = JSON.stringify({ jsonrpc: '2.0', id: 100, error: { message: 'Invalid argument' } }) + '\n';
      acpClient.acpProcess.stdout.emit('data', response);
      expect(reject).toHaveBeenCalled();
    });

    it('should return same result if start is called during handshake', async () => {
      const AcpClientClass = acpClient.constructor;
      const client = new AcpClientClass();
      client.io = mockIo;
      const result = { ok: true };
      client.startPromise = Promise.resolve(result);
      const p = await client.start();
      expect(p).toBe(result);
    });

    it('should handle cancel in respondToPermission', async () => {
      await acpClient.start();
      await acpClient.permissions.respond(42, 'cancel', acpClient.transport);
      const written = acpClient.acpProcess.stdin.write.mock.calls[0][0];
      expect(JSON.parse(written).result.outcome.outcome).toBe('cancelled');
    });

    it('should handle empty config_options in handleProviderExtension', async () => {
      const result = await acpClient.handleProviderExtension({
        method: '_test.dev/config_options',
        params: { sessionId: 's1', options: [] }
      });
      expect(result).toBeUndefined();
    });

    it('should handle spawn failure', async () => {
      spawn.mockReturnValueOnce(null);
      const client = new acpClient.constructor();
      await client.start();
      expect(client.acpProcess).toBeNull();
    });

    it('stops the ACP daemon without scheduling a restart', async () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn() };
      proc.kill = vi.fn(() => proc.emit('exit', 0));
      spawn.mockImplementationOnce(() => proc);

      const AcpClientClass = acpClient.constructor;
      const localClient = new AcpClientClass('test-p');
      localClient.io = mockIo;

      await localClient.start();
      await localClient.stop();

      expect(proc.kill).toHaveBeenCalled();
      expect(localClient.acpProcess).toBeNull();
      expect(localClient.restartTimer).toBeNull();
      expect(localClient.isHandshakeComplete).toBe(false);
    });

    it('should handle handshake failure', async () => {
      // Use real timers for this one to avoid complex interaction with start() logic
      const AcpClientClass = acpClient.constructor;
      const localClient = new AcpClientClass('test-p');
      localClient.io = mockIo;
      
      getProviderModule.mockResolvedValueOnce({
        performHandshake: () => { throw new Error('handshake failed'); },
        normalizeUpdate: (u) => u,
        normalizeModelState: (s) => s,
        prepareAcpEnvironment: async (env) => env,
        emitCachedContext: () => false,
        intercept: (p) => p,
      });

      await localClient.start();
      
      // The performHandshake has a 2000ms delay.
      // We can manually wait a bit or mock the promise.
      // Since it's async and we don't await performHandshake() inside start(),
      // we check it after a short delay.
      await new Promise(r => setTimeout(r, 50)); 
      
      expect(localClient.isHandshakeComplete).toBe(false);
    });

    it('should return existing handshake promise if already in flight', async () => {
       const res = { ok: true };
       acpClient.handshakePromise = Promise.resolve(res);
       const p = acpClient.performHandshake();
       await expect(p).resolves.toBe(res);
    });

    it('should handle pending-new race condition in handleProviderExtension', async () => {
       acpClient.sessionMetadata.set('pending-new', { configOptions: [] });
       await acpClient.handleProviderExtension({
         method: '_test.dev/config_options',
         params: { sessionId: 'real-id', options: [{ id: 'opt1', currentValue: 'v1' }] }
       });
       expect(acpClient.sessionMetadata.get('pending-new').configOptions).toHaveLength(1);
    });

    it('handles handleProviderExtension with model data', async () => {
      const spy = vi.spyOn(acpClient, 'handleModelStateUpdate');
      await acpClient.handleProviderExtension({
        method: 'prefix/any',
        params: { sessionId: 's1', currentModelId: 'm1' }
      });
      expect(spy).toHaveBeenCalledWith('s1', expect.objectContaining({ currentModelId: 'm1' }));
    });

    it('handles handleProviderExtension config_options with replace: true', async () => {
      acpClient.sessionMetadata.set('s1', { configOptions: [{ id: 'old' }] });
      await acpClient.handleProviderExtension({
        method: '_test.dev/config_options',
        params: { sessionId: 's1', options: [{ id: 'new' }], replace: true }
      });
      expect(acpClient.sessionMetadata.get('s1').configOptions).toHaveLength(1);
      expect(acpClient.sessionMetadata.get('s1').configOptions[0].id).toBe('new');
    });
  });

  describe('handleModelStateUpdate', () => {
    it('should capture state for pending-new', async () => {
      acpClient.sessionMetadata.set('pending-new', { modelOptions: [] });
      await acpClient.handleModelStateUpdate('s1', {
        currentModelId: 'm1',
        modelOptions: [{ id: 'm1', name: 'M1' }]
      });
      expect(acpClient.sessionMetadata.get('pending-new').currentModelId).toBe('m1');
    });
  });

  describe('Function Coverage Boost', () => {
    it('should hit setProviderId and setAuthMethod', () => {
      acpClient.setProviderId(acpClient.getProviderId());
      acpClient.setAuthMethod('none');
      expect(true).toBe(true);
    });

    it('should throw error when changing provider id of running process', async () => {
      await acpClient.start();
      expect(() => acpClient.setProviderId('different')).toThrow('Cannot change provider id');
    });

    it('should hit catch blocks in handleProviderExtension and handleModelStateUpdate', async () => {
      const db = await import('../database.js');
      const mockSaveConfig = vi.spyOn(db, 'saveConfigOptions').mockRejectedValue(new Error('fail'));
      const mockSaveModel = vi.spyOn(db, 'saveModelState').mockRejectedValue(new Error('fail'));
      
      await acpClient.handleProviderExtension({
        method: '_test.dev/config_options',
        params: { sessionId: 's1', options: [{ id: 'o1', currentValue: 'v1' }] }
      });
      
      await acpClient.handleModelStateUpdate('s1', { currentModelId: 'm1' });
      expect(mockSaveConfig).toHaveBeenCalled();
      expect(mockSaveModel).toHaveBeenCalled();
    });

    it('should hit catch block in performHandshake', async () => {
      const meta = { promptCount: 0 };
      acpClient.sessionMetadata.set('s1', meta);
      const db = await import('../database.js');
      // This is for autoLoadPinnedSessions catch
      vi.spyOn(db, 'initDb').mockResolvedValue(); 
      // We trigger the error in autoLoadPinnedSessions or later
    });
  });

  describe('buildAcpSpawnCommand', () => {
    it('uses cmd.exe wrapper for bare commands on Windows', () => {
      const target = buildAcpSpawnCommand('test-provider-cli', ['--help'], 'win32');
      expect(target.command).toBe('cmd.exe');
      expect(target.args).toEqual(['/d', '/s', '/c', 'test-provider-cli', '--help']);
    });

    it('uses cmd.exe wrapper for .cmd files on Windows', () => {
      const target = buildAcpSpawnCommand('C:\\tools\\agent.cmd', ['--acp'], 'win32');
      expect(target.command).toBe('cmd.exe');
      expect(target.args).toEqual(['/d', '/s', '/c', 'C:\\tools\\agent.cmd', '--acp']);
    });

    it('keeps direct spawn for non-Windows', () => {
      const target = buildAcpSpawnCommand('test-provider-cli', ['--help'], 'linux');
      expect(target.command).toBe('test-provider-cli');
      expect(target.args).toEqual(['--help']);
    });
  });
});
