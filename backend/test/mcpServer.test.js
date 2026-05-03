import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMcpServers, createToolHandlers, getMaxShellResultLines } from '../mcp/mcpServer.js';
import { loadCounselConfig } from '../services/counselConfig.js';
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
vi.mock('../mcp/subAgentRegistry.js', () => ({
    registerSubAgent: vi.fn(),
    completeSubAgent: vi.fn(),
    failSubAgent: vi.fn()
}));
vi.mock('../mcp/acpCleanup.js', () => ({ cleanupAcpSession: vi.fn() }));
vi.mock('../services/counselConfig.js', () => ({
    loadCounselConfig: vi.fn(() => ({ core: [{ name: 'A', prompt: 'p' }], specialized: [{ name: 'B', prompt: 'p2' }] }))
}));

/** Default provider config used by most tests. Uses the new quickAccess[] format. */
const DEFAULT_PROVIDER_CONFIG = {
  id: 'provider-a',
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
    const servers = getMcpServers('provider-a');
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('TestUI');
    expect(servers[0].env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ACP_SESSION_PROVIDER_ID', value: 'provider-a' })
    ]));
  });

  it('getMcpServers handles null providerId by using default provider', () => {
    mockGetProvider.mockImplementation((id) => {
      if (!id) return DEFAULT_PROVIDER_CONFIG;
      return null;
    });
    const servers = getMcpServers(null);
    expect(servers).toHaveLength(1);
    expect(servers[0].env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ACP_SESSION_PROVIDER_ID', value: 'provider-a' })
    ]));
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
        // All tool_output_stream events for this invocation carry the same shellId
        expect(mockIo.emit).toHaveBeenCalledWith('tool_output_stream', expect.objectContaining({ chunk: '$ many-lines\n', maxLines: 2 }));
        expect(mockIo.emit).toHaveBeenCalledWith('tool_output_stream', expect.objectContaining({ chunk: 'one\ntwo\nthree\n', maxLines: 2 }));
        // Verify shellId is present and consistent across all emits for this invocation
        const shellEmits = mockIo.emit.mock.calls.filter(c => c[0] === 'tool_output_stream');
        const shellIds = shellEmits.map(c => c[1].shellId);
        expect(shellIds.every(id => typeof id === 'string' && id.startsWith('shell-'))).toBe(true);
        expect(new Set(shellIds).size).toBe(1); // all same shellId within one invocation
      } finally {
        if (previous === undefined) delete process.env.MAX_SHELL_RESULT_LINES;
        else process.env.MAX_SHELL_RESULT_LINES = previous;
      }
    });

    it('uses distinct shellIds for concurrent shell invocations', async () => {
      const handlers = createToolHandlers(mockIo);
      const mockProc1 = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
      const mockProc2 = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
      mockPty.spawn.mockReturnValueOnce(mockProc1).mockReturnValueOnce(mockProc2);

      // Start both shells concurrently (don't await)
      const p1 = handlers.ux_invoke_shell({ command: 'shell-a' });
      const p2 = handlers.ux_invoke_shell({ command: 'shell-b' });

      mockProc1.onData.mock.calls[0][0]('output-a');
      mockProc2.onData.mock.calls[0][0]('output-b');
      mockProc1.onExit.mock.calls[0][0]({ exitCode: 0 });
      mockProc2.onExit.mock.calls[0][0]({ exitCode: 0 });
      await Promise.all([p1, p2]);

      const shellEmits = mockIo.emit.mock.calls.filter(c => c[0] === 'tool_output_stream');
      const shellIds = [...new Set(shellEmits.map(c => c[1].shellId))];
      // Two separate invocations must produce two distinct shellIds
      expect(shellIds).toHaveLength(2);
      expect(shellIds[0]).toMatch(/^shell-/);
      expect(shellIds[1]).toMatch(/^shell-/);
      expect(shellIds[0]).not.toBe(shellIds[1]);
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

    it('emits sub_agents_starting immediately with invocationId before stagger', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'starting-event-sub';
      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      vi.useFakeTimers();
      const promise = handlers.ux_invoke_subagents({
        requests: [{ name: 'Agent A', prompt: 'Work', agent: 'dev' }, { name: 'Agent B', prompt: 'Work too', agent: 'dev' }]
      });

      // sub_agents_starting must be emitted synchronously / before any timers fire
      expect(mockIo.emit).toHaveBeenCalledWith('sub_agents_starting', expect.objectContaining({
        invocationId: expect.stringMatching(/^inv-/),
        providerId: 'provider-a',
        count: 2,
      }));

      await vi.runAllTimersAsync();
      await promise;
      vi.useRealTimers();
    });

    it('includes invocationId in sub_agent_started events', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'inv-id-sub';
      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent 1', prompt: 'Do thing', agent: 'dev' }]
      });

      const startingCall = mockIo.emit.mock.calls.find(c => c[0] === 'sub_agents_starting');
      const startedCall = mockIo.emit.mock.calls.find(c => c[0] === 'sub_agent_started');
      expect(startingCall).toBeDefined();
      expect(startedCall).toBeDefined();
      // invocationId must match between sub_agents_starting and sub_agent_started
      expect(startedCall[1].invocationId).toBe(startingCall[1].invocationId);
      expect(startedCall[1].invocationId).toMatch(/^inv-/);
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
        id: 'provider-a',
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
        id: 'provider-a',
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
        id: 'provider-a',
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

    it('passes resolvedProviderId to sub-agent registration and database', async () => {
      const { saveSession } = await import('../database.js');
      const { registerSubAgent } = await import('../mcp/subAgentRegistry.js');
      const handlers = createToolHandlers(mockIo);
      const subId = 'multi-provider-sub';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }]
      });

      expect(registerSubAgent).toHaveBeenCalledWith(
        'provider-a',
        subId,
        null,
        'Do thing',
        'dev'
      );
      expect(saveSession).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'provider-a' })
      );
      });

      it('returns error if io is missing', async () => {
      const handlers = createToolHandlers(null);
      const result = await handlers.ux_invoke_subagents({ requests: [] });
      expect(result.content[0].text).toContain('Error: Sub-agent system not available');
      });

      it('resolves parentUiId if lastSubAgentParentAcpId is set', async () => {
      const { getSessionByAcpId } = await import('../database.js');
      vi.mocked(getSessionByAcpId).mockResolvedValueOnce({ id: 'parent-ui-123' });
      mockAcpClient.lastSubAgentParentAcpId = 'parent-acp-456';

      const handlers = createToolHandlers(mockIo);
      await handlers.ux_invoke_subagents({ requests: [{ prompt: 'hi' }], providerId: 'provider-a' });

      expect(getSessionByAcpId).toHaveBeenCalledWith('provider-a', 'parent-acp-456');
      expect(mockIo.emit).toHaveBeenCalledWith('sub_agents_starting', expect.objectContaining({
        parentUiId: 'parent-ui-123'
      }));
      });
      });

      describe('ux_invoke_counsel', () => {
      it('returns error if no counsel agents are configured', async () => {
      vi.mocked(loadCounselConfig).mockReturnValueOnce({ core: [], specialized: [] });
      const handlers = createToolHandlers(mockIo);
      const result = await handlers.ux_invoke_counsel({ question: 'What to do?' });
      expect(result.content[0].text).toContain('Error: No counsel agents configured');
      });

      it('runs counsel with specialized agents', async () => {

          const handlers = createToolHandlers(mockIo);
          vi.spyOn(handlers, 'ux_invoke_subagents').mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

          await handlers.ux_invoke_counsel({ question: 'help', specialized: true });
          expect(handlers.ux_invoke_subagents).toHaveBeenCalled();
      });
  });
});
