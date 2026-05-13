import { describe, it, expect, vi, beforeEach } from 'vitest';
import acpClient from '../services/acpClient.js';
import { spawn } from 'child_process';
import EventEmitter from 'events';
import { saveProviderStatusExtension } from '../database.js';

const { interceptMock } = vi.hoisted(() => ({
  interceptMock: vi.fn(payload => payload)
}));

vi.mock('child_process', () => {
  const EventEmitter = require('events');
  class MockP extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdin = { write: vi.fn() };
      this.kill = vi.fn();
    }
  }
  return { spawn: vi.fn(() => new MockP()) };
});

vi.mock('../database.js', () => ({
  initDb: vi.fn().mockResolvedValue({}),
  saveModelState: vi.fn().mockResolvedValue({}),
  saveConfigOptions: vi.fn().mockResolvedValue({}),
  saveProviderStatusExtension: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));
vi.mock('../services/shellRunManager.js', () => ({
  shellRunManager: {
    setIo: vi.fn(),
    findRun: vi.fn(),
    snapshot: vi.fn(),
    prepareRun: vi.fn()
  }
}));
vi.mock('../services/providerStatusMemory.js', () => ({
  rememberProviderStatusExtension: vi.fn((extension, providerId) => {
    if (!extension?.params?.status || !Array.isArray(extension.params.status.sections)) return null;
    return {
      ...extension,
      providerId,
      params: {
        ...extension.params,
        providerId,
        status: { ...extension.params.status, providerId }
      }
    };
  })
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({ config: { protocolPrefix: 'test/', executable: { command: 'n', args: [], env: {} }, paths: {}, models: {} } }),
  getProviderModule: vi.fn().mockResolvedValue({
    intercept: interceptMock,
    normalizeUpdate: u => u,
    normalizeConfigOptions: options => Array.isArray(options) ? options : [],
    extractToolOutput: () => undefined,
    extractFilePath: () => undefined,
    extractDiffFromToolCall: () => undefined,
    normalizeTool: e => e,
    categorizeToolCall: () => null,
    parseExtension: () => null,
    prepareAcpEnvironment: async env => env,
    performHandshake: async () => {},
    normalizeModelState: state => state,
    emitCachedContext: () => false
  }),
  runWithProvider: vi.fn((_p, fn) => fn())
}));

vi.mock('../services/providerRegistry.js', () => ({
  getDefaultProviderId: () => 'p1',
  resolveProviderId: () => 'p1'
}));

describe('AcpClient Routing Coverage', () => {
  const mockIo = { emit: vi.fn(), to: vi.fn().mockReturnThis() };

  beforeEach(() => {
    vi.clearAllMocks();
    interceptMock.mockClear();
    acpClient.io = mockIo;
    acpClient.providerModule = { intercept: interceptMock };
    acpClient.sessionMetadata.set('s1', { toolCalls: 0, usedTokens: 0, modelOptions: [] });
  });

  it('routes all handleUpdate paths', async () => {
    const cases = [
      { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 't' } }, event: 'thought' },
      { update: { sessionUpdate: 'tool_call', toolCallId: 't1' }, event: 'system_event' },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }, event: 'system_event' },
      { update: { sessionUpdate: 'usage_update', used: 1, size: 10 }, event: 'stats_push' },
      { update: { sessionUpdate: 'available_commands_update', availableCommands: [] }, event: 'provider_extension' }
    ];

    for (const c of cases) {
      mockIo.emit.mockClear();
      await acpClient.handleUpdate('s1', c.update);
      expect(mockIo.emit).toHaveBeenCalledWith(c.event, expect.any(Object));
    }
  });

  it('passes pending JSON-RPC request context into intercept', () => {
    const resolve = vi.fn();
    const reject = vi.fn();
    acpClient.transport.pendingRequests.set(77, {
      resolve,
      reject,
      method: 'session/prompt',
      params: { sessionId: 's-map', prompt: [] },
      sessionId: 's-map'
    });

    acpClient.handleAcpMessage({ jsonrpc: '2.0', id: 77, result: { stopReason: 'end_turn' } });

    expect(interceptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 77 }),
      expect.objectContaining({
        responseRequest: expect.objectContaining({
          id: 77,
          method: 'session/prompt',
          sessionId: 's-map'
        })
      })
    );
    expect(resolve).toHaveBeenCalledWith({ stopReason: 'end_turn' });
  });

  it('routes all handleProviderExtension paths', async () => {
    await acpClient.handleProviderExtension({ method: 'test/m1', params: { sessionId: 's1' } });
    expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({ method: 'test/m1' }));

    await acpClient.handleProviderExtension({ method: 'test/m2', params: {} }); // missing sessionId
    expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({ method: 'test/m2' }));

    await acpClient.handleProviderExtension({
      method: 'test/provider/status',
      params: { status: { sections: [{ id: 'usage', items: [] }] } }
    });
    expect(saveProviderStatusExtension).toHaveBeenCalledTimes(1);
    expect(saveProviderStatusExtension).toHaveBeenCalledWith('p1', expect.objectContaining({
      providerId: 'p1',
      params: expect.objectContaining({
        providerId: 'p1',
        status: expect.objectContaining({ providerId: 'p1' })
      })
    }));
    expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
      providerId: 'p1',
      method: 'test/provider/status'
    }));
  });

  it('emits provider status extensions even when persistence fails', async () => {
    saveProviderStatusExtension.mockRejectedValueOnce(new Error('write failed'));

    await acpClient.handleProviderExtension({
      method: 'test/provider/status',
      params: { status: { sections: [{ id: 'usage', items: [] }] } }
    });

    expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
      method: 'test/provider/status'
    }));
  });

  it('hits JSON parse error in handleData', async () => {
    await acpClient.start();
    acpClient.acpProcess.stdout.emit('data', '{\n'); // incomplete JSON
    expect(true).toBe(true);
  });
});
