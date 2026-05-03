import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerSessionHandlers from '../sockets/sessionHandlers.js';
import { providerRuntimeManager } from '../services/providerRuntimeManager.js';
import EventEmitter from 'events';
import fs from 'fs';

// 1. Hoist Mocks
const { mockFs, mockDb, mockAcpClient, mockProviderModule } = vi.hoisted(() => ({
    mockFs: {
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue('{}'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        cpSync: vi.fn(),
        rmSync: vi.fn(),
        copyFileSync: vi.fn(),
        readdirSync: vi.fn().mockReturnValue([]),
        statSync: vi.fn().mockReturnValue({ isDirectory: () => true })
    },
    mockDb: {
        saveSession: vi.fn().mockResolvedValue(undefined),
        getSession: vi.fn().mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', name: 'Test', model: 'test-flagship', messages: [], provider: 'provider-a' }),
        getSessionByAcpId: vi.fn().mockResolvedValue(null),
        getAllSessions: vi.fn().mockResolvedValue([]),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue(undefined),
        saveConfigOptions: vi.fn().mockResolvedValue(undefined),
        saveModelState: vi.fn().mockResolvedValue(undefined),
        getNotes: vi.fn().mockResolvedValue('some notes'),
        saveNotes: vi.fn().mockResolvedValue(undefined)
    },
    mockAcpClient: {
        isHandshakeComplete: true,
        sessionMetadata: new Map(),
        transport: {
            sendRequest: vi.fn(),
            sendNotification: vi.fn(),
            pendingRequests: new Map()
        },
        stream: {
            beginDraining: vi.fn(),
            waitForDrainToFinish: vi.fn().mockResolvedValue(),
            statsCaptures: new Map(),
            onChunk: vi.fn()
        },
        permissions: {
            respond: vi.fn(),
            pendingPermissions: new Map()
        },
        setConfigOption: vi.fn().mockResolvedValue({}),
        handleUpdate: vi.fn().mockResolvedValue(),
    },
    mockProviderModule: {
        intercept: (p) => p,
        normalizeUpdate: (u) => u,
        extractToolOutput: vi.fn(),
        extractFilePath: vi.fn(),
        extractDiffFromToolCall: vi.fn(),
        normalizeTool: (e) => e,
        categorizeToolCall: vi.fn(),
        normalizeModelState: vi.fn((state) => state),
        normalizeConfigOptions: vi.fn((options) => Array.isArray(options) ? options : []),
        parseExtension: vi.fn(),
        emitCachedContext: vi.fn(),
        performHandshake: async () => {},
        setInitialAgent: async () => {},
        setConfigOption: vi.fn().mockResolvedValue({}),
        getSessionPaths: vi.fn((acpId) => ({
            jsonl: `/tmp/sessions/${acpId}.jsonl`,
            json: `/tmp/sessions/${acpId}.json`,
            tasksDir: `/tmp/sessions/${acpId}`
        })),
        cloneSession: vi.fn(),
        archiveSessionFiles: vi.fn(),
        restoreSessionFiles: vi.fn(),
        deleteSessionFiles: vi.fn(),
        getAgentsDir: vi.fn().mockReturnValue('/tmp/test-agents'),
        getAttachmentsDir: vi.fn().mockReturnValue('/tmp/test-attachments'),
        getSessionDir: vi.fn().mockReturnValue('/tmp/test-sessions'),
        getHooksForAgent: vi.fn().mockResolvedValue([]),
        buildSessionParams: vi.fn().mockReturnValue(undefined)
    }
}));

// 2. Apply Mocks
vi.mock('fs', () => ({ default: mockFs, existsSync: (...args) => mockFs.existsSync(...args), readFileSync: (...args) => mockFs.readFileSync(...args), writeFileSync: (...args) => mockFs.writeFileSync(...args), mkdirSync: (...args) => mockFs.mkdirSync(...args), cpSync: (...args) => mockFs.cpSync(...args), rmSync: (...args) => mockFs.rmSync(...args), copyFileSync: (...args) => mockFs.copyFileSync(...args), readdirSync: (...args) => mockFs.readdirSync(...args) }));
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn(), setIo: vi.fn() }));
vi.mock('../database.js', () => mockDb);
vi.mock('../services/acpClient.js', () => ({ default: mockAcpClient, toUnixPath: (p) => p }));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: (id) => ({
    id: id || 'provider-a',
    config: {
      name: 'Test',
      mcpName: 'TestUI',
      paths: { sessions: '/tmp/test-sessions', agents: '/tmp/test-agents' },
      models: {
        default: 'test-balanced',
        quickAccess: [
          { id: 'test-flagship', displayName: 'Flagship' },
          { id: 'test-balanced', displayName: 'Balanced' },
          { id: 'test-fast', displayName: 'Fast' }
        ]
      }
    }
  }),
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule),
  getProviderModuleSync: vi.fn().mockReturnValue(mockProviderModule)
}));

vi.mock('../services/providerRuntimeManager.js', () => ({
  providerRuntimeManager: {
    getRuntime: vi.fn((id) => ({
      client: mockAcpClient,
      providerId: id || 'provider-a',
      provider: { id: id || 'provider-a', config: { branding: {}, models: { default: 'test-balanced', flagship: 'test-flagship' } } }
    })),
    getClient: vi.fn().mockReturnValue(mockAcpClient)
  }
}));

vi.mock('../services/workspaceConfig.js', () => ({ getMcpServers: vi.fn().mockReturnValue([]) }));
vi.mock('../services/attachmentVault.js', () => ({ getAttachmentsRoot: () => '/tmp/test-attachments' }));
vi.mock('../mcp/acpCleanup.js', () => ({ cleanupAcpSession: vi.fn() }));
vi.mock('../services/jsonlParser.js', () => ({ parseJsonlSession: vi.fn() }));
vi.mock('crypto', () => ({ randomUUID: () => 'mock-uuid' }));
vi.mock('child_process', () => ({ exec: vi.fn((cmd, cb) => cb?.(null)) }));

describe('Session Handlers', () => {
  let mockIo, mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderModule.normalizeModelState.mockImplementation((state) => state);
    mockAcpClient.sessionMetadata.clear();
    mockIo = new EventEmitter();
    mockIo.emit = vi.fn();
    mockIo.to = vi.fn().mockReturnThis();

    mockSocket = new EventEmitter();
    mockSocket.id = 'test-socket';
    mockSocket.join = vi.fn();

    registerSessionHandlers(mockIo, mockSocket);
  });

  it('handles get_notes', async () => {
    const callback = vi.fn();
    const handler = mockSocket.listeners('get_notes')[0];
    await handler({ sessionId: 's1' }, callback);
    expect(mockDb.getNotes).toHaveBeenCalledWith('s1');
  });

  it('handles load_sessions with cleanup', async () => {
    const callback = vi.fn();
    mockDb.getAllSessions.mockResolvedValue([
        { id: '1', name: 'New Chat', messages: [], provider: 'provider-a' },
        { id: '2', name: 'New Chat', messages: [], provider: 'provider-a' }
    ]);
    const handler = mockSocket.listeners('load_sessions')[0];
    await handler(callback);
    expect(mockDb.deleteSession).toHaveBeenCalledWith('2');
  });

  it('handles get_session_history', async () => {
    const callback = vi.fn();
    const session = { id: 'ui-1', acpSessionId: 'acp-1', messages: [], provider: 'provider-a' };
    mockDb.getSession.mockResolvedValue(session);
    const handler = mockSocket.listeners('get_session_history')[0];
    await handler({ uiId: 'ui-1' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ session }));
  });

  it('handles rehydrate_session', async () => {
    const callback = vi.fn();
    mockDb.getSession.mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', provider: 'provider-a' });
    const { parseJsonlSession } = await import('../services/jsonlParser.js');
    parseJsonlSession.mockResolvedValue([{ role: 'user', content: 'hi' }]);
    const handler = mockSocket.listeners('rehydrate_session')[0];
    await handler({ uiId: 'ui-1' }, callback);
    expect(mockDb.saveSession).toHaveBeenCalled();
  });

  it('handles delete_session', async () => {
    mockDb.getAllSessions.mockResolvedValue([{ id: '1', provider: 'provider-a' }]);
    const handler = mockSocket.listeners('delete_session')[0];
    await handler({ uiId: '1' });
    expect(mockDb.deleteSession).toHaveBeenCalledWith('1');
  });

  it('handles fork_session', async () => {
    const callback = vi.fn();
    mockDb.getSession.mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', model: 'test-flagship', provider: 'provider-a' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-fork' });
    const handler = mockSocket.listeners('fork_session')[0];
    await handler({ uiId: 'ui-1', messageIndex: 0 }, callback);
    expect(mockProviderModule.cloneSession).toHaveBeenCalled();
  });

  it('handles create_session', async () => {
    const callback = vi.fn();
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-new' });
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship' }, callback);
    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/new', expect.any(Object));
  });

  it('captures normalized config options returned by session/new', async () => {
    const callback = vi.fn();
    mockProviderModule.normalizeConfigOptions.mockImplementationOnce((options) =>
      options.filter(option => option.id !== 'model').map(option =>
        option.id === 'reasoning_effort' ? { ...option, kind: 'reasoning_effort' } : option
      )
    );
    mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') {
        return {
          sessionId: 'acp-new',
          configOptions: [
            { id: 'model', currentValue: 'test-balanced' },
            { id: 'reasoning_effort', currentValue: 'medium' }
          ]
        };
      }
      return {};
    });

    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship' }, callback);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      configOptions: [expect.objectContaining({ id: 'reasoning_effort', kind: 'reasoning_effort' })]
    }));
    expect(mockDb.saveConfigOptions).toHaveBeenCalledWith('provider-a', 'acp-new', [
      expect.objectContaining({ id: 'reasoning_effort', currentValue: 'medium' })
    ]);
  });

  it('uses provider model-state normalization when creating a session', async () => {
    const callback = vi.fn();
    mockProviderModule.normalizeModelState.mockImplementationOnce((state) => ({
      ...state,
      currentModelId: 'base-model',
      modelOptions: [{ id: 'base-model', name: 'Base Model' }]
    }));
    mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') {
        return {
          sessionId: 'acp-new',
          models: {
            currentModelId: 'base-model/high',
            availableModels: [{ id: 'base-model/high', name: 'Base Model High' }]
          }
        };
      }
      return {};
    });

    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship' }, callback);

    expect(mockProviderModule.normalizeModelState).toHaveBeenCalledWith(
      expect.objectContaining({ currentModelId: 'base-model/high' }),
      expect.objectContaining({ sessionId: 'acp-new' })
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      modelOptions: expect.arrayContaining([expect.objectContaining({ id: 'base-model' })])
    }));
  });

  it('replaces stale model options when provider requests replacement', async () => {
    const callback = vi.fn();
    mockProviderModule.normalizeModelState.mockImplementationOnce((state) => ({
      ...state,
      currentModelId: 'base-model',
      modelOptions: [{ id: 'base-model', name: 'Base Model' }],
      replaceModelOptions: true
    }));
    mockAcpClient.sessionMetadata.set('pending-new', {
      model: 'base-model/high',
      currentModelId: 'base-model/high',
      modelOptions: [{ id: 'base-model/high', name: 'Base Model High' }],
      toolCalls: 0,
      successTools: 0,
      startTime: Date.now(),
      usedTokens: 0,
      totalTokens: 0,
      promptCount: 0,
      lastResponseBuffer: '',
      lastThoughtBuffer: '',
      provider: 'provider-a'
    });
    mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') {
        return {
          sessionId: 'acp-new',
          models: {
            currentModelId: 'base-model/high',
            availableModels: [{ id: 'base-model/high', name: 'Base Model High' }]
          }
        };
      }
      return {};
    });

    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'base-model/high' }, callback);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      modelOptions: expect.arrayContaining([expect.objectContaining({ id: 'base-model' })])
    }));
    const modelOptions = callback.mock.calls[0][0].modelOptions;
    expect(modelOptions.some(option => option.id === 'base-model/high')).toBe(false);
  });

  it('handles merge_fork', async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    mockDb.getSession.mockImplementation(id => {
        if (id === 'f1') return { id: 'f1', acpSessionId: 'acp-f1', forkedFrom: 'p1', provider: 'provider-a' };
        if (id === 'p1') return { id: 'p1', acpSessionId: 'acp-p1', provider: 'provider-a' };
    });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ usage: {} });
    const handler = mockSocket.listeners('merge_fork')[0];
    await handler({ uiId: 'f1' }, callback);
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', expect.anything());
    vi.useRealTimers();
  });

  it('merge_fork returns error when parent session not found', async () => {
    const callback = vi.fn();
    mockDb.getSession.mockImplementation(id => {
      if (id === 'f1') return { id: 'f1', acpSessionId: 'acp-f1', forkedFrom: 'p1', provider: 'provider-a' };
      return null; // parent not found
    });
    const handler = mockSocket.listeners('merge_fork')[0];
    await handler({ uiId: 'f1' }, callback);
    expect(callback).toHaveBeenCalledWith({ error: 'Parent session not found' });
    expect(mockAcpClient.transport.sendRequest).not.toHaveBeenCalled();
  });

  it('handles save_notes success', async () => {
    const callback = vi.fn();
    const handler = mockSocket.listeners('save_notes')[0];
    await handler({ sessionId: 's1', notes: 'My notes' }, callback);
    expect(mockDb.saveNotes).toHaveBeenCalledWith('s1', 'My notes');
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it('handles save_notes error', async () => {
    const callback = vi.fn();
    mockDb.saveNotes.mockRejectedValueOnce(new Error('DB write error'));
    const handler = mockSocket.listeners('save_notes')[0];
    await handler({ sessionId: 's1', notes: 'Notes' }, callback);
    expect(callback).toHaveBeenCalledWith({ error: 'DB write error' });
  });

  it('handles save_snapshot', async () => {
    const session = { id: 'ui-1', name: 'Snapshot', messages: [], provider: 'provider-a' };
    const handler = mockSocket.listeners('save_snapshot')[0];
    await handler(session);
    expect(mockDb.saveSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'ui-1' }));
  });

  it('handles open_in_editor with filePath', async () => {
    const { exec } = await import('child_process');
    const handler = mockSocket.listeners('open_in_editor')[0];
    handler({ filePath: '/some/file.js' });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('/some/file.js'), expect.any(Function));
  });

  it('handles open_in_editor without filePath (no-op)', async () => {
    const { exec } = await import('child_process');
    const handler = mockSocket.listeners('open_in_editor')[0];
    handler({ filePath: null });
    expect(exec).not.toHaveBeenCalled();
  });

  it('handles export_session successfully', async () => {
    const callback = vi.fn();
    mockDb.getSession.mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', name: 'Test Export', model: 'test-flagship', messages: [], provider: 'provider-a' });
    const handler = mockSocket.listeners('export_session')[0];
    await handler({ uiId: 'ui-1', exportPath: '/tmp/exports' }, callback);
    expect(mockFs.mkdirSync).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('handles export_session when session not found', async () => {
    const callback = vi.fn();
    mockDb.getSession.mockResolvedValue(null);
    const handler = mockSocket.listeners('export_session')[0];
    await handler({ uiId: 'missing', exportPath: '/tmp/exports' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('handles create_session with existingAcpId (resume)', async () => {
    const callback = vi.fn();
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-resume' });
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-balanced', existingAcpId: 'acp-resume' }, callback);
    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/load', expect.any(Object));
    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'acp-resume',
      modelId: 'test-balanced'
    });
    expect(mockAcpClient.transport.sendRequest).not.toHaveBeenCalledWith('session/prompt', expect.objectContaining({
      prompt: [{ type: 'text', text: '/context' }]
    }));
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('reapplies saved config options on resume when the provider still advertises them', async () => {
    const callback = vi.fn();
    mockDb.getSessionByAcpId.mockResolvedValueOnce({
      id: 'ui-resume',
      acpSessionId: 'acp-resume',
      model: 'test-balanced',
      provider: 'provider-a',
      configOptions: [
        { id: 'effort', currentValue: 'low' },
        { id: 'missing', currentValue: 'ignored' }
      ]
    });
    mockAcpClient.transport.sendRequest.mockImplementationOnce(async () => {
      const meta = mockAcpClient.sessionMetadata.get('acp-resume');
      meta.configOptions = [
        {
          id: 'effort',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }]
        }
      ];
      return { sessionId: 'acp-resume' };
    });

    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-balanced', existingAcpId: 'acp-resume' }, callback);

    expect(mockProviderModule.setConfigOption).toHaveBeenCalledTimes(1);
    expect(mockProviderModule.setConfigOption).toHaveBeenCalledWith(mockAcpClient, 'acp-resume', 'effort', 'low');
    expect(mockDb.saveConfigOptions).toHaveBeenCalledWith('acp-resume', [{ id: 'effort', currentValue: 'low' }]);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      configOptions: expect.arrayContaining([expect.objectContaining({ id: 'effort', currentValue: 'low' })])
    }));
  });

  it('does not reapply saved config options that are no longer advertised on resume', async () => {
    const callback = vi.fn();
    mockDb.getSessionByAcpId.mockResolvedValueOnce({
      id: 'ui-resume',
      acpSessionId: 'acp-resume',
      model: 'test-fast',
      provider: 'provider-a',
      configOptions: [{ id: 'effort', currentValue: 'low' }]
    });
    mockAcpClient.transport.sendRequest.mockImplementationOnce(async () => {
      const meta = mockAcpClient.sessionMetadata.get('acp-resume');
      meta.configOptions = [{ id: 'mode', type: 'select', currentValue: 'acceptEdits', options: [] }];
      return { sessionId: 'acp-resume' };
    });

    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-fast', existingAcpId: 'acp-resume' }, callback);

    expect(mockProviderModule.setConfigOption).not.toHaveBeenCalled();
    expect(mockDb.saveConfigOptions).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      configOptions: [expect.objectContaining({ id: 'mode' })]
    }));
  });

  it('handles create_session when daemon is not ready', async () => {
    mockAcpClient.isHandshakeComplete = false;
    const callback = vi.fn();
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship' }, callback);
    expect(callback).toHaveBeenCalledWith({ error: 'Daemon not ready' });
    mockAcpClient.isHandshakeComplete = true;
  });

  it('handles create_session with requestAgent', async () => {
    const callback = vi.fn();
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-agent' });
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship', agent: 'my-agent' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('calls buildSessionParams with agent and spreads result into session/new', async () => {
    const callback = vi.fn();
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-new' });
    mockProviderModule.buildSessionParams.mockReturnValue({ _meta: { 'agent-meta': { options: { agent: 'my-agent' } } } });
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship', agent: 'my-agent' }, callback);
    expect(mockProviderModule.buildSessionParams).toHaveBeenCalledWith('my-agent');
    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/new', expect.objectContaining({
      _meta: { 'agent-meta': { options: { agent: 'my-agent' } } }
    }));
  });

  it('spreads no extra keys into session/new when buildSessionParams returns undefined', async () => {
    const callback = vi.fn();
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-new' });
    mockProviderModule.buildSessionParams.mockReturnValue(undefined);
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship' }, callback);
    expect(mockProviderModule.buildSessionParams).toHaveBeenCalledWith(undefined);
    const call = mockAcpClient.transport.sendRequest.mock.calls.find(([m]) => m === 'session/new');
    expect(call[1]).not.toHaveProperty('_meta');
  });

  it('calls buildSessionParams with agent and spreads result into session/load', async () => {
    const callback = vi.fn();
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-resume' });
    mockProviderModule.buildSessionParams.mockReturnValue({ _meta: { 'agent-meta': { options: { agent: 'my-agent' } } } });
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship', existingAcpId: 'acp-resume', agent: 'my-agent' }, callback);
    expect(mockProviderModule.buildSessionParams).toHaveBeenCalledWith('my-agent');
    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/load', expect.objectContaining({
      _meta: { 'agent-meta': { options: { agent: 'my-agent' } } }
    }));
  });

  it('spreads no extra keys into session/load when buildSessionParams returns undefined', async () => {
    const callback = vi.fn();
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: 'acp-resume' });
    mockProviderModule.buildSessionParams.mockReturnValue(undefined);
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-flagship', existingAcpId: 'acp-resume' }, callback);
    expect(mockProviderModule.buildSessionParams).toHaveBeenCalledWith(undefined);
    const call = mockAcpClient.transport.sendRequest.mock.calls.find(([m]) => m === 'session/load');
    expect(call[1]).not.toHaveProperty('_meta');
  });

  it('handles rehydrate_session when no acpSessionId', async () => {
    const callback = vi.fn();
    mockDb.getSession.mockResolvedValue({ id: 'ui-1', provider: 'provider-a' });
    const handler = mockSocket.listeners('rehydrate_session')[0];
    await handler({ uiId: 'ui-1' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('handles rehydrate_session when JSONL not found', async () => {
    const callback = vi.fn();
    mockDb.getSession.mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', provider: 'provider-a' });
    const { parseJsonlSession } = await import('../services/jsonlParser.js');
    parseJsonlSession.mockResolvedValue(null);
    const handler = mockSocket.listeners('rehydrate_session')[0];
    await handler({ uiId: 'ui-1' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('handles get_session_history with JSONL having more messages than DB', async () => {
    const callback = vi.fn();
    const session = { id: 'ui-1', acpSessionId: 'acp-1', messages: [{ role: 'user' }], provider: 'provider-a' };
    mockDb.getSession.mockResolvedValue(session);
    const { parseJsonlSession } = await import('../services/jsonlParser.js');
    parseJsonlSession.mockResolvedValue([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]);
    const handler = mockSocket.listeners('get_session_history')[0];
    await handler({ uiId: 'ui-1' }, callback);
    expect(mockDb.saveSession).toHaveBeenCalled();
  });

  it('handles delete_session with cascading child sessions', async () => {
    const parent = { id: 'parent', acpSessionId: 'acp-parent', provider: 'provider-a' };
    const child = { id: 'child', acpSessionId: 'acp-child', forkedFrom: 'parent', provider: 'provider-a' };
    mockDb.getSession.mockResolvedValue(parent);
    mockDb.getAllSessions.mockResolvedValue([parent, child]);
    const handler = mockSocket.listeners('delete_session')[0];
    await handler({ uiId: 'parent' });
    expect(mockDb.deleteSession).toHaveBeenCalledWith('parent');
    expect(mockDb.deleteSession).toHaveBeenCalledWith('child');
  });

  it('handles merge_fork when not a valid fork', async () => {
    const callback = vi.fn();
    mockDb.getSession.mockResolvedValue({ id: 'not-fork', acpSessionId: 'acp-1', provider: 'provider-a' });
    const handler = mockSocket.listeners('merge_fork')[0];
    await handler({ uiId: 'not-fork' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('handles load_sessions when all sessions succeed', async () => {
    const callback = vi.fn();
    mockDb.getAllSessions.mockResolvedValue([{ id: '1', name: 'Session A', provider: 'provider-a' }]);
    const handler = mockSocket.listeners('load_sessions')[0];
    await handler(callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ sessions: expect.any(Array) }));
  });

  it('handles get_notes error', async () => {
    const callback = vi.fn();
    mockDb.getNotes.mockRejectedValueOnce(new Error('notes read error'));
    const handler = mockSocket.listeners('get_notes')[0];
    await handler({ sessionId: 's1' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: 'notes read error' }));
  });

  it('handles set_session_model', async () => {
    const session = { id: 'ui-1', acpSessionId: 'acp-1', model: 'test-fast', provider: 'provider-a' };
    mockDb.getSession.mockResolvedValue(session);
    mockAcpClient.sessionMetadata.set('acp-1', { model: 'test-fast' });
    const handler = mockSocket.listeners('set_session_model')[0];
    await handler({ uiId: 'ui-1', model: 'test-balanced' });

    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'acp-1',
      modelId: 'test-balanced'
    });
    expect(mockDb.saveSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ui-1',
      model: 'test-balanced'
    }));
  });

  it('handles set_session_option', async () => {
    const session = { id: 'ui-1', acpSessionId: 'acp-1', configOptions: [], provider: 'provider-a' };
    mockDb.getAllSessions.mockResolvedValue([session]);
    mockAcpClient.sessionMetadata.set('acp-1', { configOptions: [] });
    const handler = mockSocket.listeners('set_session_option')[0];
    await handler({ uiId: 'ui-1', optionId: 'effort', value: 'high' });

    expect(mockProviderModule.setConfigOption).toHaveBeenCalledWith(mockAcpClient, 'acp-1', 'effort', 'high');
    expect(mockDb.saveConfigOptions).toHaveBeenCalledWith('acp-1', expect.arrayContaining([
      expect.objectContaining({ id: 'effort', currentValue: 'high' })
    ]));
  });

  it('set_session_option merges configOptions returned by provider', async () => {
    const session = { id: 'ui-1', acpSessionId: 'acp-1', configOptions: [{ id: 'mode', currentValue: 'default' }], provider: 'provider-a' };
    const returnedOptions = [
      { id: 'mode', currentValue: 'acceptEdits' },
      { id: 'effort', currentValue: 'max', kind: 'reasoning_effort' }
    ];
    mockDb.getAllSessions.mockResolvedValue([session]);
    mockAcpClient.sessionMetadata.set('acp-1', { configOptions: session.configOptions });
    mockProviderModule.setConfigOption.mockResolvedValueOnce({ configOptions: returnedOptions });

    const handler = mockSocket.listeners('set_session_option')[0];
    await handler({ uiId: 'ui-1', optionId: 'effort', value: 'max' });

    expect(mockDb.saveConfigOptions).toHaveBeenCalledWith('acp-1', returnedOptions);
    expect(mockAcpClient.sessionMetadata.get('acp-1').configOptions).toEqual(returnedOptions);
  });

  it('set_session_option returns early when session not found', async () => {
    mockDb.getAllSessions.mockResolvedValue([]);
    const handler = mockSocket.listeners('set_session_option')[0];
    await handler({ uiId: 'missing-ui', optionId: 'effort', value: 'high' });

    expect(mockProviderModule.setConfigOption).not.toHaveBeenCalled();
    expect(mockAcpClient.setConfigOption).not.toHaveBeenCalled();
  });

  it('set_session_option routes through provider contract setConfigOption', async () => {
    const session = { id: 'ui-1', acpSessionId: 'acp-1', configOptions: [], provider: 'provider-a' };
    mockDb.getAllSessions.mockResolvedValue([session]);
    mockAcpClient.sessionMetadata.set('acp-1', { configOptions: [] });

    const handler = mockSocket.listeners('set_session_option')[0];
    await handler({ uiId: 'ui-1', optionId: 'effort', value: 'low' });

    expect(mockProviderModule.setConfigOption).toHaveBeenCalledWith(mockAcpClient, 'acp-1', 'effort', 'low');
    expect(mockAcpClient.setConfigOption).not.toHaveBeenCalled();
  });

  it('set_session_option updates sessionMetadata when meta exists', async () => {
    const session = { id: 'ui-1', acpSessionId: 'acp-1', configOptions: [], provider: 'provider-a' };
    mockDb.getAllSessions.mockResolvedValue([session]);
    mockAcpClient.sessionMetadata.set('acp-1', { configOptions: [] });

    const handler = mockSocket.listeners('set_session_option')[0];
    await handler({ uiId: 'ui-1', optionId: 'effort', value: 'high' });

    const meta = mockAcpClient.sessionMetadata.get('acp-1');
    expect(meta.configOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'effort', currentValue: 'high' })
    ]));
  });

  it('set_session_option logs error when setConfigOption throws', async () => {
    const { writeLog } = await import('../services/logger.js');
    const session = { id: 'ui-1', acpSessionId: 'acp-1', configOptions: [], provider: 'provider-a' };
    mockDb.getAllSessions.mockResolvedValue([session]);
    mockAcpClient.sessionMetadata.set('acp-1', { configOptions: [] });
    mockProviderModule.setConfigOption.mockRejectedValueOnce(new Error('option failed'));

    const handler = mockSocket.listeners('set_session_option')[0];
    await handler({ uiId: 'ui-1', optionId: 'effort', value: 'high' });

    expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('option failed'));
  });

  it('set_session_model updates metadata when meta exists', async () => {
    const session = { id: 'ui-1', acpSessionId: 'acp-1', model: 'test-fast', provider: 'provider-a' };
    mockDb.getSession.mockResolvedValue(session);
    mockAcpClient.sessionMetadata.set('acp-1', { model: 'test-fast' });
    mockAcpClient.transport.sendRequest.mockResolvedValue({});

    const handler = mockSocket.listeners('set_session_model')[0];
    await handler({ uiId: 'ui-1', model: 'test-balanced' });

    const meta = mockAcpClient.sessionMetadata.get('acp-1');
    expect(meta.model).toBe('test-balanced');
  });

  it('set_session_model logs error when sendRequest throws', async () => {
    const { writeLog } = await import('../services/logger.js');
    const session = { id: 'ui-1', acpSessionId: 'acp-1', model: 'test-fast', provider: 'provider-a' };
    mockDb.getSession.mockResolvedValue(session);
    mockAcpClient.sessionMetadata.set('acp-1', { model: 'test-fast' });
    mockAcpClient.transport.sendRequest.mockRejectedValueOnce(new Error('model switch failed'));

    const handler = mockSocket.listeners('set_session_model')[0];
    await handler({ uiId: 'ui-1', model: 'test-balanced' });

    expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('model switch failed'));
  });

  it('handles create_session skipping load for hot sessions', async () => {
    const callback = vi.fn();
    const existingAcpId = 'acp-hot';
    mockAcpClient.sessionMetadata.set(existingAcpId, {
      model: 'test-balanced',
      currentModelId: 'test-balanced',
      modelOptions: [],
      configOptions: []
    });
    
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-balanced', existingAcpId }, callback);
    
    expect(mockAcpClient.transport.sendRequest).not.toHaveBeenCalledWith('session/load', expect.anything());
    expect(mockProviderModule.emitCachedContext).toHaveBeenCalledWith(existingAcpId);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ 
      success: true,
      sessionId: existingAcpId 
    }));
  });

  it('handles create_session performing load for cold sessions with dbSession', async () => {
    const callback = vi.fn();
    const existingAcpId = 'acp-cold';
    mockDb.getSessionByAcpId.mockResolvedValueOnce({
      id: 'ui-cold',
      acpSessionId: existingAcpId,
      model: 'test-balanced',
      provider: 'provider-a',
      configOptions: []
    });
    mockAcpClient.transport.sendRequest.mockResolvedValue({ sessionId: existingAcpId });
    
    const handler = mockSocket.listeners('create_session')[0];
    await handler({ providerId: 'provider-a', model: 'test-balanced', existingAcpId }, callback);
    
    expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/load', expect.anything());
    expect(mockProviderModule.emitCachedContext).toHaveBeenCalledWith(existingAcpId);
    expect(mockAcpClient.sessionMetadata.has(existingAcpId)).toBe(true);
  });
});
