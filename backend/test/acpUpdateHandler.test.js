import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdate } from '../services/acpUpdateHandler.js';

// Hoist Mocks
const { mockProviderModule, mockShellRunManager } = vi.hoisted(() => ({
    mockProviderModule: {
        intercept: vi.fn(p => p),
        normalizeUpdate: vi.fn(u => u),
        extractToolOutput: vi.fn((u) => {
          const content = u.content?.[0]?.content;
          if (content?.type === 'json') return JSON.stringify(content.json);
          return content?.text;
        }),
        extractFilePath: vi.fn(),
        extractDiffFromToolCall: vi.fn(),
        normalizeTool: vi.fn(e => e),
        categorizeToolCall: vi.fn(),
        normalizeConfigOptions: vi.fn(options => Array.isArray(options) ? options : []),
        parseExtension: vi.fn()
    },
    mockShellRunManager: {
      setIo: vi.fn(),
      prepareRun: vi.fn()
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
vi.mock('../services/shellRunManager.js', () => ({
  shellRunManager: mockShellRunManager
}));
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
    transport: {
      sendRequest: vi.fn(),
      sendNotification: vi.fn(),
      pendingRequests: new Map()
    },
    stream: {
      statsCaptures: new Map(),
      drainingSessions: new Map(),
      onChunk: vi.fn()
    },
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
    mockProviderModule.categorizeToolCall.mockReturnValue(undefined);
    mockProviderModule.normalizeConfigOptions.mockImplementation(options => Array.isArray(options) ? options : []);
    mockShellRunManager.prepareRun.mockReturnValue({
      runId: 'shell-run-test',
      status: 'pending',
      command: 'npm test',
      cwd: 'D:/repo'
    });
  });

  it('delegates normalization to provider', async () => {
    mockProviderModule.normalizeUpdate.mockImplementation(u => ({ ...u, sessionUpdate: 'normalized' }));
    await handleUpdate(client, sid, { type: 'raw' });
    expect(mockProviderModule.normalizeUpdate).toHaveBeenCalled();
  });

  it('caches and re-injects metadata (Sticky Metadata)', async () => {
    mockProviderModule.extractFilePath.mockImplementation((u, resolve) => resolve('/path/to/file.js'));
    await handleUpdate(client, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Detailed Title' });

    mockProviderModule.extractFilePath.mockReturnValue(undefined);
    await handleUpdate(client, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });

    const systemEvents = client.io.emit.mock.calls.filter(c => c[0] === 'system_event');
    const lastEmit = systemEvents.at(-1)[1];
    expect(lastEmit.filePath).toBeDefined();
    expect(lastEmit.title).toBe('Detailed Title');
  });

  it('handles saveConfigOptions failure gracefully', async () => {
    const { saveConfigOptions } = await import('../database.js');
    saveConfigOptions.mockRejectedValueOnce(new Error('db fail'));
    const configUpdate = {
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'effort', currentValue: 'high' }]
    };
    await handleUpdate(client, sid, configUpdate);
    expect(saveConfigOptions).toHaveBeenCalled();
  });

  it('handles generateTitle failure gracefully', async () => {
    client.generateTitle.mockRejectedValueOnce(new Error('title fail'));
    const meta = client.sessionMetadata.get(sid);
    meta.promptCount = 1;
    meta.titleGenerated = false;
    const update = { sessionUpdate: 'agent_message_chunk', content: { text: 'First chunk' } };
    await handleUpdate(client, sid, update);
    expect(client.generateTitle).toHaveBeenCalled();
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

  it('prepares shell run metadata for ux_invoke_shell tool starts', async () => {
      client.providerId = 'test-provider';
      mockProviderModule.normalizeTool.mockImplementation(e => ({ ...e, toolName: 'ux_invoke_shell' }));
      mockProviderModule.categorizeToolCall.mockReturnValue({ category: 'shell', isShellCommand: true });

      await handleUpdate(client, sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Tool: AcpUI/ux_invoke_shell',
        rawInput: {
          invocation: {
            server: 'AcpUI',
            tool: 'ux_invoke_shell',
            arguments: { command: 'npm test', cwd: 'D:/repo' }
          }
        }
      });

      expect(mockShellRunManager.setIo).toHaveBeenCalledWith(client.io);
      expect(mockShellRunManager.prepareRun).toHaveBeenCalledWith({
        providerId: 'test-provider',
        sessionId: sid,
        toolCallId: 't1',
        command: 'npm test',
        cwd: 'D:/repo'
      });
      expect(client.io.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        type: 'tool_start',
        shellRunId: 'shell-run-test',
        shellInteractive: true,
        shellState: 'pending',
        command: 'npm test',
        cwd: 'D:/repo',
        title: 'Tool: AcpUI/ux_invoke_shell'
      }));
  });

  it('does not prepare shell metadata for non-shell tools that mention ux_invoke_shell', async () => {
      client.providerId = 'test-provider';
      mockProviderModule.normalizeTool.mockImplementation(e => ({
        ...e,
        toolName: 'edit',
        filePath: 'documents/[Feature Doc] - ux_invoke_shell.md'
      }));
      mockProviderModule.categorizeToolCall.mockReturnValue({ category: 'file_edit', isFileOperation: true });

      await handleUpdate(client, sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Running edit: documents/[Feature Doc] - ux_invoke_shell.md',
        rawInput: {
          filePath: 'documents/[Feature Doc] - ux_invoke_shell.md',
          oldText: 'before',
          newText: '{"tool":"ux_invoke_shell"}'
        }
      });

      expect(mockShellRunManager.prepareRun).not.toHaveBeenCalled();
      const systemEvent = client.io.emit.mock.calls.find(c => c[0] === 'system_event')[1];
      expect(systemEvent).toEqual(expect.objectContaining({
        type: 'tool_start',
        toolName: 'edit'
      }));
      expect(systemEvent).not.toHaveProperty('shellRunId');
  });

  it('handles config_option_update and emits provider_extension', async () => {
    const configUpdate = {
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'effort', currentValue: 'high' }]
    };
    await handleUpdate(client, sid, configUpdate);
    expect(client.io.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
      method: 'test/config_options'
    }));
  });

  it('handles available_commands_update and emits provider_extension', async () => {
    const cmdUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: '/compact' }]
    };
    await handleUpdate(client, sid, cmdUpdate);
    expect(client.io.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
      method: 'test/commands/available'
    }));
  });

  it('handles usage_update with zero size', async () => {
    const update = { sessionUpdate: 'usage_update', used: 100, size: 0 };
    await handleUpdate(client, sid, update);
    expect(client.io.emit).toHaveBeenCalledWith('stats_push', expect.any(Object));
    expect(client.io.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({ 
      method: 'test/metadata',
      params: expect.objectContaining({ contextUsagePercentage: 100 })
    }));
  });

  it('handles tool_call_update with Json output', async () => {
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'json', json: { ok: true } } }]
    };
    await handleUpdate(client, sid, update);
    expect(client.io.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({ 
        type: 'tool_end',
        output: expect.stringContaining('true')
    }));
  });

  it('ignores empty config_option_update', async () => {
    const update = {
      sessionUpdate: 'config_option_update',
      configOptions: [],
      replace: false
    };
    await handleUpdate(client, sid, update);
    expect(client.io.emit).not.toHaveBeenCalledWith('provider_extension', expect.any(Object));
  });

  it('performs periodic autoSaveTurn', async () => {
    const { autoSaveTurn } = await import('../services/sessionManager.js');
    client._lastPeriodicSave.set(sid, Date.now() - 5000);
    const update = { sessionUpdate: 'agent_message_chunk', content: { text: 'chunk' } };
    await handleUpdate(client, sid, update);
    expect(autoSaveTurn).toHaveBeenCalledWith(sid, client);
  });

  it('handles tool_call_update with completed status and runHooks', async () => {
    const { runHooks } = await import('../services/hookRunner.js');
    client.sessionMetadata.get(sid).agentName = 'test-agent';
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawInput: { cmd: 'test' },
      title: 'Run Test'
    };
    await handleUpdate(client, sid, update);
    expect(runHooks).toHaveBeenCalled();
  });

  it('falls back to standard ACP content for tool output', async () => {
    mockProviderModule.extractToolOutput.mockReturnValue(undefined);
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      content: [{ type: 'content', content: { type: 'text', text: 'ACP Output' } }]
    };
    await handleUpdate(client, sid, update);
    expect(client.io.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
      output: 'ACP Output'
    }));
  });

  it('buffers text in statsCaptures if present', async () => {
    const capture = { buffer: '' };
    client.stream.statsCaptures.set(sid, capture);
    const update = { sessionUpdate: 'agent_message_chunk', content: { text: 'Title chunk' } };
    await handleUpdate(client, sid, update);
    expect(capture.buffer).toBe('Title chunk');
    expect(client.io.emit).not.toHaveBeenCalledWith('token', expect.any(Object));
  });

  it('fires title generation on first message chunk', async () => {
    const meta = client.sessionMetadata.get(sid);
    meta.promptCount = 1;
    meta.titleGenerated = false;
    const update = { sessionUpdate: 'agent_message_chunk', content: { text: 'First chunk' } };
    await handleUpdate(client, sid, update);
    expect(client.generateTitle).toHaveBeenCalledWith(sid, meta);
    expect(meta.titleGenerated).toBe(true);
  });

  it('restores tool title from cache if missing in update', async () => {
    // 1. First update sets the title
    await handleUpdate(client, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Cached Title' });
    
    // 2. Second update has no title in the update object itself
    // We don't need normalizeTool to overwrite it here, we want to test L237: if (!titleToUse && tData.title) titleToUse = tData.title;
    await handleUpdate(client, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });

    const systemEvents = client.io.emit.mock.calls.filter(c => c[0] === 'system_event');
    const lastEmit = systemEvents.at(-1)[1];
    expect(lastEmit.title).toBe('Cached Title');
  });

  it('assigns lastSubAgentParentAcpId for sub-agent spawning tools', async () => {
    const update = { sessionUpdate: 'tool_call', title: 'ux_invoke_subagents', toolCallId: 't1' };
    await handleUpdate(client, sid, update);
    expect(client.lastSubAgentParentAcpId).toBe(sid);
  });

  it('ignores empty tool_call_update', async () => {
    const update = { sessionUpdate: 'tool_call_update', toolCallId: 't1' };
    await handleUpdate(client, sid, update);
    const systemEvents = client.io.emit.mock.calls.filter(c => c[0] === 'system_event');
    expect(systemEvents).toHaveLength(0);
  });

  it('handles diff fallback in tool_call_update', async () => {
    mockProviderModule.extractToolOutput.mockReturnValue(undefined);
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      content: [{ type: 'diff', oldText: 'a', newText: 'b' }]
    };
    await handleUpdate(client, sid, update);
    expect(client.io.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
      output: 'diff-output'
    }));
  });

  it('skips path resolution for paths with ellipses', async () => {
    mockProviderModule.extractFilePath.mockImplementation((u, resolve) => resolve('some/.../path'));
    await handleUpdate(client, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'test' });
    const systemEvents = client.io.emit.mock.calls.filter(c => c[0] === 'system_event');
    expect(systemEvents[0][1].filePath).toBeUndefined();
  });
});
