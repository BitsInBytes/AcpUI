import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMcpServers, createToolHandlers, getMaxShellResultLines } from '../mcp/mcpServer.js';
import { clearMcpProxyRegistry, getMcpProxyIdFromServers, resolveMcpProxy } from '../mcp/mcpProxyRegistry.js';
import { loadCounselConfig } from '../services/counselConfig.js';
import { toolCallState } from '../services/tools/index.js';
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
        buildSessionParams: vi.fn(),
        getMcpServerMeta: vi.fn().mockReturnValue(undefined)
    }
}));

const { mockGetProvider } = vi.hoisted(() => ({
    mockGetProvider: vi.fn()
}));

const { mockShellRunManager } = vi.hoisted(() => ({
    mockShellRunManager: {
        setIo: vi.fn(),
        startPreparedRun: vi.fn()
    }
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
vi.mock('../services/shellRunManager.js', () => ({
  shellRunManager: mockShellRunManager
}));
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
    failSubAgent: vi.fn(),
    setPromptingSubAgent: vi.fn()
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
    toolCallState.clear();
    clearMcpProxyRegistry();
    mockShellRunManager.startPreparedRun.mockResolvedValue({ content: [{ type: 'text', text: 'shell done' }] });
    
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
      expect.objectContaining({ name: 'ACP_SESSION_PROVIDER_ID', value: 'provider-a' }),
      expect.objectContaining({ name: 'ACP_UI_MCP_PROXY_ID', value: expect.stringMatching(/^mcp-proxy-/) })
    ]));
  });

  it('getMcpServers attaches _meta when getMcpServerMeta returns a value', () => {
    const meta = { codex_acp: { tool_timeout_sec: 3600 } };
    mockProviderModule.getMcpServerMeta.mockReturnValueOnce(meta);
    const servers = getMcpServers('provider-a');
    expect(servers).toHaveLength(1);
    expect(servers[0]._meta).toEqual(meta);
  });

  it('getMcpServers omits _meta when getMcpServerMeta returns undefined', () => {
    mockProviderModule.getMcpServerMeta.mockReturnValueOnce(undefined);
    const servers = getMcpServers('provider-a');
    expect(servers).toHaveLength(1);
    expect(servers[0]._meta).toBeUndefined();
  });

  it('getMcpServers handles null providerId by using default provider', () => {
    mockGetProvider.mockImplementation((id) => {
      if (!id) return DEFAULT_PROVIDER_CONFIG;
      return null;
    });
    const servers = getMcpServers(null);
    expect(servers).toHaveLength(1);
    expect(servers[0].env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ACP_SESSION_PROVIDER_ID', value: 'provider-a' }),
      expect.objectContaining({ name: 'ACP_UI_MCP_PROXY_ID', value: expect.stringMatching(/^mcp-proxy-/) })
    ]));
  });

  describe('ux_invoke_shell', () => {
    it('defaults MAX_SHELL_RESULT_LINES to 1000 when env is not a positive integer', () => {
      expect(getMaxShellResultLines({})).toBe(1000);
      expect(getMaxShellResultLines({ MAX_SHELL_RESULT_LINES: 'bad' })).toBe(1000);
      expect(getMaxShellResultLines({ MAX_SHELL_RESULT_LINES: '25' })).toBe(25);
    });

    it('delegates to shellRunManager with session context', async () => {
      const handlers = createToolHandlers(mockIo);

      const result = await handlers.ux_invoke_shell({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        mcpRequestId: 42,
        requestMeta: { toolCallId: 'tool-1' },
        description: 'Run test suite',
        command: 'npm test',
        cwd: 'D:/repo'
      });

      expect(mockShellRunManager.setIo).toHaveBeenCalledWith(mockIo);
      expect(mockShellRunManager.startPreparedRun).toHaveBeenCalledWith({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        toolCallId: 'tool-1',
        mcpRequestId: 42,
        description: 'Run test suite',
        command: 'npm test',
        cwd: 'D:/repo',
        maxLines: getMaxShellResultLines()
      });
      expect(mockPty.spawn).not.toHaveBeenCalled();
      expect(result.content[0].text).toBe('shell done');
      expect(mockIo.to).toHaveBeenCalledWith('session:acp-1');
      expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        type: 'tool_update',
        id: 'tool-1',
        canonicalName: 'ux_invoke_shell',
        title: 'Invoke Shell: Run test suite'
      }));
      expect(toolCallState.get('provider-a', 'acp-1', 'tool-1')).toEqual(expect.objectContaining({
        identity: expect.objectContaining({ canonicalName: 'ux_invoke_shell', mcpServer: 'TestUI' }),
        input: expect.objectContaining({ description: 'Run test suite', command: 'npm test', cwd: 'D:/repo' }),
        display: expect.objectContaining({ title: 'Invoke Shell: Run test suite', titleSource: 'mcp_handler' })
      }));
    });

    it('keeps the MCP tool call pending until shell completion', async () => {
      let resolveRun;
      mockShellRunManager.startPreparedRun.mockReturnValue(new Promise(resolve => {
        resolveRun = resolve;
      }));
      const handlers = createToolHandlers(mockIo);

      let completed = false;
      const promise = handlers.ux_invoke_shell({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        command: 'interactive'
      }).then(result => {
        completed = true;
        return result;
      });

      await Promise.resolve();
      expect(completed).toBe(false);

      resolveRun({ content: [{ type: 'text', text: 'after input' }] });
      await expect(promise).resolves.toEqual({ content: [{ type: 'text', text: 'after input' }] });
      expect(completed).toBe(true);
    });

    it('aborts when lacking session context', async () => {
      const handlers = createToolHandlers(mockIo);
      const result = await handlers.ux_invoke_shell({ providerId: 'provider-a', command: 'ls' });
      expect(result.content[0].text).toContain('Error: Shell execution context unavailable');
      expect(mockShellRunManager.startPreparedRun).not.toHaveBeenCalled();
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

    it('binds the MCP proxy id to the sub-agent ACP session after session/new', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'proxy-bound-sub';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') return {};
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }]
      });

      const sessionNewCall = mockAcpClient.transport.sendRequest.mock.calls.find(call => call[0] === 'session/new');
      const proxyId = getMcpProxyIdFromServers(sessionNewCall[1].mcpServers);
      expect(resolveMcpProxy(proxyId)).toEqual(expect.objectContaining({
        providerId: 'provider-a',
        acpSessionId: subId
      }));
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

    it('only joins sockets to sub-agent room if they are watching the parent session', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'filtered-socket-sub';
      mockAcpClient.lastSubAgentParentAcpId = 'parent-acp-123';
      
      const socket1 = { join: vi.fn(), rooms: new Set(['session:parent-acp-123']) };
      const socket2 = { join: vi.fn(), rooms: new Set(['session:other-acp']) };
      mockIo.fetchSockets.mockResolvedValue([socket1, socket2]);

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }]
      });

      expect(socket1.join).toHaveBeenCalledWith(`session:${subId}`);
      expect(socket2.join).not.toHaveBeenCalled();
    });

    it('joins all sockets to sub-agent room if parent session is unknown (fallback)', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'fallback-socket-sub';
      mockAcpClient.lastSubAgentParentAcpId = null;
      
      const socket1 = { join: vi.fn(), rooms: new Set() };
      const socket2 = { join: vi.fn(), rooms: new Set() };
      mockIo.fetchSockets.mockResolvedValue([socket1, socket2]);

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        return {};
      });

      await runInvokeSubAgents(handlers, {
        requests: [{ name: 'Agent', prompt: 'Do thing', agent: 'dev' }]
      });

      expect(socket1.join).toHaveBeenCalledWith(`session:${subId}`);
      expect(socket2.join).toHaveBeenCalledWith(`session:${subId}`);
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
