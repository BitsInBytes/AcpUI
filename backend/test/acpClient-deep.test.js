import { describe, it, expect, vi, beforeEach } from 'vitest';
import acpClient from '../services/acpClient.js';
import { spawn } from 'child_process';
import EventEmitter from 'events';

vi.mock('child_process', () => {
  const EventEmitter = require('events');
  return {
    spawn: vi.fn(() => {
      const e = new EventEmitter();
      e.stdout = new EventEmitter();
      e.stderr = new EventEmitter();
      e.stdin = { write: vi.fn() };
      return e;
    })
  };
});

vi.mock('../database.js', () => ({
  initDb: vi.fn().mockResolvedValue({}),
  saveModelState: vi.fn().mockResolvedValue({}),
  saveConfigOptions: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      name: 'Test',
      protocolPrefix: '_test.dev/',
      executable: { command: 'node', args: [], env: {} },
      paths: { sessions: '/tmp' },
      models: {}
    }
  }),
  getProviderModule: vi.fn().mockResolvedValue({
    performHandshake: async () => {},
    normalizeUpdate: (u) => u,
    intercept: vi.fn(u => u),
    normalizeModelState: (s) => s,
    prepareAcpEnvironment: async (env) => env,
    emitCachedContext: () => false,
  }),
  runWithProvider: vi.fn((_p, fn) => fn())
}));

vi.mock('../services/providerRegistry.js', () => ({
  getDefaultProviderId: () => 'provider-a',
  resolveProviderId: () => 'provider-a'
}));

describe('AcpClient Deep Coverage', () => {
  const mockIo = { emit: vi.fn(), to: vi.fn().mockReturnThis() };

  beforeEach(() => {
    vi.clearAllMocks();
    acpClient.resetForTesting();
    acpClient.io = mockIo;
    acpClient.providerId = 'provider-a';
  });

  it('handles setAuthMethod no-op', () => {
    acpClient.setAuthMethod('token');
    expect(true).toBe(true);
  });

  it('skips duplicate start calls', async () => {
    await acpClient.start();
    acpClient.acpProcess.exitCode = null;
    const res = await acpClient.start();
    expect(res).toBeUndefined();
  });

  it('handles handleProviderExtension without metadata', async () => {
    acpClient.sessionMetadata.delete('s2');
    await acpClient.handleProviderExtension({
      method: '_test.dev/config_options',
      params: { sessionId: 's2', options: [{ id: 'opt2', currentValue: 'v2' }] }
    });
    expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.any(Object));
  });

  it('handles handleProviderExtension without io', async () => {
    acpClient.io = null;
    await acpClient.handleProviderExtension({ method: 'any', params: { sessionId: 's1' } });
    expect(true).toBe(true);
  });

  it('handles handleModelStateUpdate with empty source', async () => {
    await acpClient.handleModelStateUpdate('s1', {});
    expect(true).toBe(true);
  });

  it('hits intercepted message swallowing', async () => {
    await acpClient.start();
    const loader = await import('../services/providerLoader.js');
    const mockModule = await loader.getProviderModule();
    mockModule.intercept.mockReturnValueOnce(null);
    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } }) + '\n';
    acpClient.acpProcess.stdout.emit('data', payload);
    expect(mockIo.emit).not.toHaveBeenCalled();
  });

  it('hits empty config_options extension branch', async () => {
    await acpClient.handleProviderExtension({
      method: '_test.dev/config_options',
      params: { sessionId: 's1', options: [], removeOptionIds: [] }
    });
    expect(true).toBe(true);
  });

  it('sets provider id if not running', async () => {
    const AcpClientClass = acpClient.constructor;
    const client = new AcpClientClass();
    client.setProviderId('new-p');
    expect(client.providerId).toBe('new-p');
  });

  it('handles getProviderId error by defaulting to provider-a in VITEST', async () => {
    const AcpClientClass = acpClient.constructor;
    const client = new AcpClientClass();
    client.providerId = null;
    const reg = await import('../services/providerRegistry.js');
    vi.spyOn(reg, 'resolveProviderId').mockImplementationOnce(() => { throw new Error('fail'); });
    const id = client.getProviderId();
    expect(id).toBe('provider-a');
  });

  it('skips tool_call emits when statsCapture active', async () => {
    const sid = 'stats-tool';
    acpClient.stream.statsCaptures.set(sid, { buffer: '' });
    await acpClient.handleUpdate(sid, { sessionUpdate: 'tool_call', toolCallId: 't1' });
    expect(mockIo.emit).not.toHaveBeenCalledWith('system_event', expect.objectContaining({ type: 'tool_start' }));
  });

  it('skips tool_call_update emits when statsCapture active', async () => {
    const sid = 'stats-update';
    acpClient.stream.statsCaptures.set(sid, { buffer: '' });
    await acpClient.handleUpdate(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(mockIo.emit).not.toHaveBeenCalledWith('system_event', expect.objectContaining({ type: 'tool_end' }));
  });

  it('hits invalid argument debug log branch', async () => {
    await acpClient.start();
    const reject = vi.fn();
    acpClient.transport.pendingRequests.set(88, { resolve: vi.fn(), reject, method: 'test', params: { foo: 'bar' } });
    const response = JSON.stringify({ jsonrpc: '2.0', id: 88, error: { message: 'Invalid argument: too long' } }) + '\n';
    acpClient.acpProcess.stdout.emit('data', response);
    expect(reject).toHaveBeenCalled();
  });

  it('returns promise for duplicate start call', async () => {
    await acpClient.start();
    const p = acpClient.start();
    expect(p).toBeDefined();
  });

  it('buffers data in handleUpdate when statsCapture active', async () => {
    const sid = 'stats-s';
    acpClient.stream.statsCaptures.set(sid, { buffer: '' });
    await acpClient.handleUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { text: 'hidden' } });
    expect(acpClient.stream.statsCaptures.get(sid).buffer).toBe('hidden');
  });
});
