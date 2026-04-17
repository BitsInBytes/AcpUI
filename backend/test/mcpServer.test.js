import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMcpServers, createToolHandlers } from '../mcp/mcpServer.js';
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
        setInitialAgent: vi.fn().mockResolvedValue()
    }
}));

vi.mock('node-pty', () => ({ default: mockPty }));
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn(), setIo: vi.fn() }));
vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      mcpName: 'TestUI',
      defaultSubAgentName: 'dev',
      defaultSystemAgentName: 'auto',
      paths: {},
      models: { flagship: { id: 'p' }, balanced: { id: 'f' }, subAgent: 's' }
    }
  }),
  getProviderModule: vi.fn().mockResolvedValue(mockProviderModule),
  getProviderModuleSync: vi.fn().mockReturnValue(mockProviderModule)
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

describe('mcpServer', () => {
  let mockIo, mockAcpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = new EventEmitter();
    mockIo.emit = vi.fn();
    mockIo.fetchSockets = vi.fn().mockResolvedValue([]);
    
    mockAcpClient = {
        sendRequest: vi.fn(),
        sessionMetadata: new Map(),
        beginDraining: vi.fn(),
        waitForDrainToFinish: vi.fn().mockResolvedValue()
    };
  });

  it('getMcpServers returns server config', () => {
    const servers = getMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('TestUI');
  });

  describe('run_shell_command', () => {
    it('executes a command via node-pty', async () => {
      const handlers = createToolHandlers(mockIo, mockAcpClient);
      const mockProc = {
          onData: vi.fn(),
          onExit: vi.fn(),
          kill: vi.fn()
      };
      mockPty.spawn.mockReturnValue(mockProc);

      const promise = handlers.run_shell_command({ command: 'ls' });
      
      const onDataCb = mockProc.onData.mock.calls[0][0];
      const onExitCb = mockProc.onExit.mock.calls[0][0];
      
      onDataCb('file.txt');
      onExitCb({ exitCode: 0 });

      const result = await promise;
      expect(result.content[0].text).toBe('file.txt');
    });

    it('handles shell command error', async () => {
        const handlers = createToolHandlers(mockIo, mockAcpClient);
        const mockProc = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
        mockPty.spawn.mockReturnValue(mockProc);
        const promise = handlers.run_shell_command({ command: 'bad' });
        mockProc.onExit.mock.calls[0][0]({ exitCode: 1 });
        const result = await promise;
        expect(result.content[0].text).toContain('Exit Code: 1');
    });
  });

  describe('invoke_sub_agents', () => {
    it('spawns sub-agents and aggregates summaries', async () => {
      vi.useFakeTimers();
      const handlers = createToolHandlers(mockIo, mockAcpClient);
      const subId = 'unique-sub-acp';
      
      mockAcpClient.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') {
            const meta = mockAcpClient.sessionMetadata.get(subId);
            if (meta) meta.lastResponseBuffer = 'Sub response';
            return {};
        }
        return {};
      });

      const promise = handlers.invoke_sub_agents({ 
        requests: [{ name: 'Agent 1', prompt: 'Do thing', agent: 'dev' }] 
      });

      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.content[0].text).toContain('Sub response');
      vi.useRealTimers();
    });
  });

  describe('counsel', () => {
      it('runs counsel with specialized agents', async () => {
          const handlers = createToolHandlers(mockIo, mockAcpClient);
          vi.spyOn(handlers, 'invoke_sub_agents').mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
          
          await handlers.counsel({ question: 'help', specialized: true });
          expect(handlers.invoke_sub_agents).toHaveBeenCalled();
      });
  });
});
