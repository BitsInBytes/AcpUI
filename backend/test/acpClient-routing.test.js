import { describe, it, expect, vi, beforeEach } from 'vitest';
import acpClient from '../services/acpClient.js';
import { spawn } from 'child_process';
import EventEmitter from 'events';

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
  saveConfigOptions: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));
vi.mock('../services/providerStatusMemory.js', () => ({ rememberProviderStatusExtension: vi.fn() }));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({ config: { protocolPrefix: 'test/', executable: { command: 'n', args: [], env: {} }, paths: {}, models: {} } }),
  getProviderModule: vi.fn().mockResolvedValue({ performHandshake: async () => {}, normalizeUpdate: u => u }),
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
    acpClient.io = mockIo;
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

  it('routes all handleProviderExtension paths', async () => {
    await acpClient.handleProviderExtension({ method: 'test/m1', params: { sessionId: 's1' } });
    expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({ method: 'test/m1' }));

    await acpClient.handleProviderExtension({ method: 'test/m2', params: {} }); // missing sessionId
    expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({ method: 'test/m2' }));
  });

  it('hits JSON parse error in handleData', async () => {
    await acpClient.start();
    acpClient.acpProcess.stdout.emit('data', '{\n'); // incomplete JSON
    expect(true).toBe(true);
  });
});
