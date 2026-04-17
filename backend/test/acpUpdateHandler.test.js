import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdate } from '../services/acpUpdateHandler.js';

// Hoist Mocks
const { mockProviderModule } = vi.hoisted(() => ({
    mockProviderModule: {
        intercept: vi.fn(p => p),
        normalizeUpdate: vi.fn(u => u),
        extractToolOutput: vi.fn(),
        extractFilePath: vi.fn(),
        extractDiffFromToolCall: vi.fn(),
        normalizeTool: vi.fn(e => e),
        categorizeToolCall: vi.fn(),
        parseExtension: vi.fn()
    }
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));
vi.mock('../services/sessionManager.js', () => ({ autoSaveTurn: vi.fn() }));
vi.mock('../database.js', () => ({
  saveConfigOptions: vi.fn().mockResolvedValue({})
}));
vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({ config: { paths: {}, protocolPrefix: 'test/' } }),
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule),
  getProviderModuleSync: () => mockProviderModule
}));
vi.mock('../services/hookRunner.js', () => ({ runHooks: vi.fn() }));
vi.mock('diff', () => ({ createPatch: vi.fn().mockReturnValue('diff-output') }));
vi.mock('fs', () => ({ default: { existsSync: vi.fn().mockReturnValue(true), realpathSync: vi.fn(p => p) } }));

function makeClient() {
  const mockEmit = vi.fn();
  const io = { 
      emit: mockEmit, 
      to: vi.fn().mockImplementation(() => io) 
  };
  return {
    io,
    sessionMetadata: new Map(),
    statsCaptures: new Map(),
    drainingSessions: new Map(),
    _lastPeriodicSave: new Map(),
    generateTitle: vi.fn().mockResolvedValue(),
  };
}

describe('acpUpdateHandler', () => {
  let client;
  const sid = 's1';

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeClient();
    client.sessionMetadata.set(sid, { toolCalls: 0, usedTokens: 0 });
    mockProviderModule.normalizeUpdate.mockImplementation(u => u);
    mockProviderModule.normalizeTool.mockImplementation(e => e);
  });

  it('delegates normalization to provider', async () => {
    mockProviderModule.normalizeUpdate.mockImplementation(u => ({ ...u, sessionUpdate: 'normalized' }));
    await handleUpdate(client, sid, { type: 'raw' });
    expect(mockProviderModule.normalizeUpdate).toHaveBeenCalled();
  });

  it('caches and re-injects metadata (Sticky Metadata)', async () => {
    mockProviderModule.extractFilePath.mockReturnValue('/path/to/file.js');
    // First chunk: tool_call_update
    await handleUpdate(client, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Detailed Title' });

    // Second chunk: completed
    mockProviderModule.extractFilePath.mockReturnValue(undefined);
    
    await handleUpdate(client, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });

    // Find the 'system_event' emit
    const systemEvents = client.io.emit.mock.calls.filter(c => c[0] === 'system_event');
    const lastEmit = systemEvents.at(-1)[1];
    expect(lastEmit.filePath).toBe('/path/to/file.js');
    expect(lastEmit.title).toBe('Detailed Title');
  });

  it('handles agent_thought_chunk', async () => {
    await handleUpdate(client, sid, { sessionUpdate: 'agent_thought_chunk', content: { text: 'Thinking' } });
    expect(client.io.emit).toHaveBeenCalledWith('thought', expect.any(Object));
  });

  it('handles usage_update and emits stats_push', async () => {
      await handleUpdate(client, sid, { sessionUpdate: 'usage_update', used: 50, size: 100 });
      expect(client.io.emit).toHaveBeenCalledWith('stats_push', expect.objectContaining({ usedTokens: 50 }));
  });

  it('handles tool_call start', async () => {
      await handleUpdate(client, sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Running' });
      expect(client.io.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({ type: 'tool_start' }));
  });

  it('handles config_option_update and emits provider_extension', async () => {
    const configUpdate = {
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'effort', currentValue: 'high' }]
    };
    await handleUpdate(client, sid, configUpdate);
    
    expect(client.io.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
      method: 'test/config_options',
      params: expect.objectContaining({ sessionId: sid })
    }));
  });

  it('handles available_commands_update and emits provider_extension', async () => {
    const cmdUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: '/compact' }]
    };
    await handleUpdate(client, sid, cmdUpdate);

    expect(client.io.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
      method: 'test/commands/available',
      params: expect.objectContaining({ commands: expect.any(Array) })
    }));
  });
});
