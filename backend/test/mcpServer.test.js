import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMcpServers, createToolHandlers, getMaxShellResultLines } from '../mcp/mcpServer.js';
import EventEmitter from 'events';

// Hoist Mocks
const { mockPty } = vi.hoisted(() => ({
    mockPty: {
        spawn: vi.fn().mockReturnValue({
            onData: vi.fn(),
            onExit: vi.fn(),
            kill: vi.fn()
        })
    }
}));

const { mockProviderModule } = vi.hoisted(() => ({
    mockProviderModule: {
        getAgentsDir: vi.fn().mockReturnValue('/tmp/test-agents'),
        getAttachmentsDir: vi.fn().mockReturnValue('/tmp/test-attachments'),
        getSessionPaths: vi.fn().mockReturnValue({ jsonl: '', json: '', tasksDir: '' }),
        deleteSessionFiles: vi.fn(),
        extractToolOutput: vi.fn(),
        setInitialAgent: vi.fn().mockResolvedValue(),
        buildSessionParams: vi.fn()
    }
}));

const { mockGetProvider } = vi.hoisted(() => ({
    mockGetProvider: vi.fn()
}));

const { mockAcpClient } = vi.hoisted(() => ({
    mockAcpClient: {
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
        sessionMetadata: new Map(),
        isHandshakeComplete: true,
        io: { to: vi.fn().mockReturnThis(), emit: vi.fn() }
    }
}));

vi.mock('node-pty', () => ({ default: mockPty }));
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn(), setIo: vi.fn() }));
vi.mock('../services/providerLoader.js', () => ({
  getProvider: mockGetProvider,
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule),
  getProviderModuleSync: vi.fn().mockReturnValue(mockProviderModule)
}));

vi.mock('../services/providerRuntimeManager.js', () => ({
  providerRuntimeManager: {
    getClient: vi.fn().mockReturnValue(mockAcpClient),
    getRuntime: vi.fn((id) => ({
      client: mockAcpClient,
      providerId: id || 'provider-a',
      provider: { config: { branding: {}, models: { default: 'f', flagship: 'p', subAgent: 's' } } }
    }))
  }
}));

vi.mock('../database.js', () => ({
    getSessionByAcpId: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(),
    deleteSession: vi.fn().mockResolvedValue()
}));
vi.mock('./subAgentRegistry.js', () => ({
    registerSubAgent: vi.fn(),
    completeSubAgent: vi.fn(),
    failSubAgent: vi.fn()
}));
vi.mock('./acpCleanup.js', () => ({ cleanupAcpSession: vi.fn() }));
vi.mock('../services/counselConfig.js', () => ({
    loadCounselConfig: () => ({ core: [{ name: 'A', prompt: 'p' }], specialized: [{ name: 'B', prompt: 'p2' }] })
}));

/** Default provider config used by most tests. Uses the new quickAccess[] format. */
const DEFAULT_PROVIDER_CONFIG = {
  config: {
    mcpName: 'TestUI',
    defaultSubAgentName: 'dev',
    defaultSystemAgentName: 'auto',
    paths: {},
    models: {
      default: 'f',
      quickAccess: [
        { id: 'p', name: 'Flagship' },
        { id: 'f', name: 'Balanced' },
      ],
      subAgent: 's'
    }
  }
};

describe('mcpServer', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProvider.mockReturnValue(DEFAULT_PROVIDER_CONFIG);
    mockIo = new EventEmitter();
    mockIo.emit = vi.fn();
    mockIo.to = vi.fn().mockReturnThis();
    mockIo.fetchSockets = vi.fn().mockResolvedValue([]);

    mockAcpClient.sessionMetadata.clear();
    mockAcpClient.stream.statsCaptures.clear();
    mockAcpClient.transport.pendingRequests.clear();
    
    mockProviderModule.buildSessionParams.mockImplementation((agent) => agent
      ? { _meta: { 'agent-meta': { options: { agent } } } }
      : undefined
    );
  });

  it('getMcpServers returns server config', () => {
    const servers = getMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('TestUI');
  });

  describe('ux_invoke_shell', () => {
    it('defaults MAX_SHELL_RESULT_LINES to 1000 when env is not a positive integer', () => {
      expect(getMaxShellResultLines({})).toBe(1000);
      expect(getMaxShellResultLines({ MAX_SHELL_RESULT_LINES: 'bad' })).toBe(1000);
      expect(getMaxShellResultLines({ MAX_SHELL_RESULT_LINES: '25' })).toBe(25);
    });

    it('executes a command via node-pty', async () => {
      const handlers = createToolHandlers(mockIo);
      const mockProc = {
          onData: vi.fn(),
          onExit: vi.fn(),
          kill: vi.fn()
      };
      mockPty.spawn.mockReturnValue(mockProc);

      const promise = handlers.ux_invoke_shell({ command: 'ls' });

      const onDataCb = mockProc.onData.mock.calls[0][0];
      const onExitCb = mockProc.onExit.mock.calls[0][0];

      onDataCb('file.txt');
      onExitCb({ exitCode: 0 });

      const result = await promise;
      expect(result.content[0].text).toBe('file.txt');
    });

    it('sends MAX_SHELL_RESULT_LINES to the UI stream while returning the full shell result', async () => {
      const previous = process.env.MAX_SHELL_RESULT_LINES;
      process.env.MAX_SHELL_RESULT_LINES = '2';
      try {
        const handlers = createToolHandlers(mockIo);
        const mockProc = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
        mockPty.spawn.mockReturnValue(mockProc);

        const promise = handlers.ux_invoke_shell({ command: 'many-lines' });
        mockProc.onData.mock.calls[0][0]('one\ntwo\nthree\n');
        mockProc.onExit.mock.calls[0][0]({ exitCode: 0 });

        const result = await promise;
        expect(result.content[0].text).toBe('one\ntwo\nthree');
        expect(mockIo.emit).toHaveBeenCalledWith('tool_output_stream', { chunk: '$ many-lines\n', maxLines: 2 });
        expect(mockIo.emit).toHaveBeenCalledWith('tool_output_stream', { chunk: 'one\ntwo\nthree\n', maxLines: 2 });
      } finally {
        if (previous === undefined) delete process.env.MAX_SHELL_RESULT_LINES;
        else process.env.MAX_SHELL_RESULT_LINES = previous;
      }
    });

    it('handles shell command error', async () => {
        const handlers = createToolHandlers(mockIo);
        const mockProc = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
        mockPty.spawn.mockReturnValue(mockProc);
        const promise = handlers.ux_invoke_shell({ command: 'bad' });
        mockProc.onExit.mock.calls[0][0]({ exitCode: 1 });
        const result = await promise;
        expect(result.content[0].text).toContain('Exit Code: 1');
    });
  });

  describe('ux_invoke_subagents', () => {
    /** Helper: run ux_invoke_subagents to completion and return the result. */
    async function runInvokeSubAgents(handlers, args) {
      vi.useFakeTimers();
      const promise = handlers.ux_invoke_subagents(args);
      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();
      return result;
    }

    it('spawns sub-agents and aggregates summaries', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'unique-sub-acp';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') {
            const meta = mockAcpClient.sessionMetadata.get(subId);
            if (meta) meta.lastResponseBuffer = 'Sub response';
            return {};
        }
        return {};
      });

      const result = await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent 1', prompt: 'Do thing', agent: 'dev' }]
      });

      expect(result.content[0].text).toContain('Sub response');
    });

    it('handles creation errors and aborts', async () => {
      const handlers = createToolHandlers(mockIo);
      mockAcpClient.transport.sendRequest.mockRejectedValueOnce(new Error('creation failed'));
      
      const result = await runInvokeSubAgents(handlers, {
        requests: [{ prompt: 'Do thing' }]
      });
      expect(result.content[0].text).toContain('Error: creation failed');
    });

    it('handles prompt timeouts and aborts', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'timeout-sub';
      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') throw new Error('Aborted');
        return {};
      });

      const result = await runInvokeSubAgents(handlers, {
        requests: [{ prompt: 'Do thing' }]
      });
      expect(result.content[0].text).toContain('Error: Aborted');
    });

    it('passes defaultSubAgentName into session/new when request omits agent', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'default-agent-sub-acp';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent 1', prompt: 'Do thing' }]
      });

      expect(mockProviderModule.buildSessionParams).toHaveBeenCalledWith('dev');
      expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith('session/new', expect.objectContaining({
        _meta: { 'agent-meta': { options: { agent: 'dev' } } }
      }));
      expect(mockProviderModule.setInitialAgent).toHaveBeenCalledWith(mockAcpClient, subId, 'dev');
    });

    it('uses models.subAgent when no explicit model arg is provided', async () => {
      const { saveSession } = await import('../database.js');
      const handlers = createToolHandlers(mockIo);
      const subId = 'subagent-model-sub';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      // No model arg â€” should fall back to models.subAgent = 's'
      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }]
      });

      expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith(
        'session/set_model',
        expect.objectContaining({ modelId: 's' })
      );
      // Metadata is cleaned up after completion; verify via saveSession instead
      expect(saveSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 's', currentModelId: 's' })
      );
    });

    it('uses models.default when no explicit model and no subAgent configured', async () => {
      // Override provider to have no subAgent field
      mockGetProvider.mockReturnValueOnce({
        config: {
          mcpName: 'TestUI',
          defaultSubAgentName: 'dev',
          defaultSystemAgentName: 'auto',
          models: { default: 'f', quickAccess: [{ id: 'p', name: 'Flagship' }, { id: 'f', name: 'Balanced' }] }
        }
      });

      const handlers = createToolHandlers(mockIo);
      const subId = 'default-model-sub';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }]
      });

      // models.default = 'f', so resolveModelSelection falls back to 'f'
      expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith(
        'session/set_model',
        expect.objectContaining({ modelId: 'f' })
      );
    });

    it('stores null (not empty string) for model when no model can be resolved', async () => {
      // Override provider to have completely empty models
      mockGetProvider.mockReturnValueOnce({
        config: {
          mcpName: 'TestUI',
          defaultSubAgentName: 'dev',
          defaultSystemAgentName: 'auto',
          models: {}
        }
      });

      const handlers = createToolHandlers(mockIo);
      const subId = 'no-model-sub';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }]
      });

      // session/set_model should NOT be called when no model resolves
      const setModelCalls = mockAcpClient.transport.sendRequest.mock.calls.filter(c => c[0] === 'session/set_model');
      expect(setModelCalls).toHaveLength(0);
    });

    it('stores null in db.saveSession.model when no model resolves', async () => {
      const { saveSession } = await import('../database.js');
      mockGetProvider.mockReturnValueOnce({
        config: {
          mcpName: 'TestUI',
          defaultSubAgentName: 'dev',
          defaultSystemAgentName: 'auto',
          models: {}
        }
      });

      const handlers = createToolHandlers(mockIo);
      const subId = 'no-model-db-sub';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }]
      });

      expect(saveSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: null, currentModelId: null })
      );
    });

    it('uses the explicit model arg when provided', async () => {
      const { saveSession } = await import('../database.js');
      const handlers = createToolHandlers(mockIo);
      const subId = 'explicit-model-sub';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }],
        model: 'explicit-model-id'
      });

      expect(mockAcpClient.transport.sendRequest).toHaveBeenCalledWith(
        'session/set_model',
        expect.objectContaining({ modelId: 'explicit-model-id' })
      );
      // Metadata is cleaned up after completion; verify the resolved model via saveSession
      expect(saveSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'explicit-model-id', currentModelId: 'explicit-model-id' })
      );
    });
  });

  describe('ux_invoke_counsel', () => {
      it('runs counsel with specialized agents', async () => {
          const handlers = createToolHandlers(mockIo);
          vi.spyOn(handlers, 'ux_invoke_subagents').mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

          await handlers.ux_invoke_counsel({ question: 'help', specialized: true });
          expect(handlers.ux_invoke_subagents).toHaveBeenCalled();
      });
  });
});
