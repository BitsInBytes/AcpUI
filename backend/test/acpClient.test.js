import { describe, it, expect, vi, beforeEach } from 'vitest';
import acpClient from '../services/acpClient.js';
import { spawn } from 'child_process';
import EventEmitter from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

vi.mock('../database.js', () => ({
  initDb: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));
vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      name: 'Test',
      command: 'test-cli',
      args: ['acp'],
      protocolPrefix: '_test.dev/',
      paths: { sessions: '/tmp/test-sessions', agents: '/tmp/test-agents', attachments: '/tmp/test-attachments' },
      clientInfo: { name: 'TestUI', version: '1.0.0' },
      branding: { assistantName: 'Test' },
      }
  }),
  getProviderModule: vi.fn().mockResolvedValue({
    intercept: (p) => p,
    normalizeUpdate: (u) => {
      if (!u) return u;
      if (typeof u.content === 'string') u = { ...u, content: { text: u.content } };
      if (!u.sessionUpdate && u.type) {
        const toSnakeCase = (str) => str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
        u = { ...u, sessionUpdate: toSnakeCase(u.type) };
      }
      return u;
    },
    extractToolOutput: (u) => {
      if (u.rawOutput?.items) {
        return u.rawOutput.items.map(i => {
           if (i.Text) return i.Text;
           if (i.Json?.content) return i.Json.content.map(c => c.text || '').join('');
           if (i.Json) return JSON.stringify(i.Json, null, 2);
           return '';
        }).filter(Boolean).join('\n');
      }
      return undefined;
    },
    extractFilePath: (u, resolve) => {
      if (u.locations?.[0]?.path) return resolve(u.locations[0].path);
      const args = u.arguments || u.params || u.rawInput;
      if (args) {
        const p = args.path || args.file_path || args.filePath;
        if (p) return resolve(p);
      }
      return undefined;
    },
    extractDiffFromToolCall: () => undefined,
    normalizeTool: (e) => e,
    categorizeToolCall: () => null,
    parseExtension: () => null,
    performHandshake: async () => {},
    setInitialAgent: async () => {},
    getSessionPaths: (acpId) => ({ 
      jsonl: `/tmp/test-sessions/${acpId}.jsonl`, 
      json: `/tmp/test-sessions/${acpId}.json`, 
      tasksDir: `/tmp/test-sessions/${acpId}` 
    }),
    cloneSession: () => {},
    archiveSessionFiles: () => {},
    restoreSessionFiles: () => {},
    deleteSessionFiles: () => {},
  }),
  getProviderModuleSync: vi.fn().mockReturnValue({
    getAgentsDir: () => '/tmp/test-agents',
    getAttachmentsDir: () => '/tmp/test-attachments'
  })
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    realpathSync: vi.fn(p => p),
    readFileSync: vi.fn()
  }
}));

describe('AcpClient Service', () => {
  let mockProcess;
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: vi.fn() },
      on: vi.fn(),
      kill: vi.fn()
    };
    spawn.mockReturnValue(mockProcess);
    const mockEmit = vi.fn();
    mockIo = { emit: mockEmit, to: () => ({ emit: mockEmit }) };
    acpClient.io = mockIo;
    acpClient.acpProcess = mockProcess;
    acpClient.requestId = 1;
    acpClient.sessionMetadata.clear();
    acpClient.pendingRequests.clear();
    
    // Default auth to none
    acpClient.authMethod = 'none';
  });

  describe('Constructor (Auth Initialization)', () => {
    it('should default to none', () => {
      const AcpClientClass = acpClient.constructor;
      const instance = new AcpClientClass();
      expect(instance.authMethod).toBe('none');
    });
  });

  describe('handleUpdate', () => {
    it('should emit token for agent_message_chunk', async () => {
      const sessionId = 'test-session';
      const update = {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Hello' }
      };
      
      await acpClient.handleUpdate(sessionId, update);
      
      expect(mockIo.emit).toHaveBeenCalledWith('token', { sessionId, text: 'Hello' });
    });

    it('should emit thought for agent_thought_chunk', async () => {
        const sessionId = 'test-session';
        const update = {
          sessionUpdate: 'agent_thought_chunk',
          content: { text: 'I am thinking' }
        };
        
        await acpClient.handleUpdate(sessionId, update);
        
        expect(mockIo.emit).toHaveBeenCalledWith('thought', { sessionId, text: 'I am thinking' });
      });

    it('should emit system_event for tool_call', async () => {
      const sessionId = 'test-session';
      const update = {
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp_McpServer_search_memory',
        title: 'Searching'
      };
      
      await acpClient.handleUpdate(sessionId, update);
      
      expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        type: 'tool_start',
        id: 'mcp_McpServer_search_memory'
      }));
    });

    it('should emit system_event for tool_call_update', async () => {
        const sessionId = 'test-session';
        const update = {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'mcp_McpServer_search_memory',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Found result' } }]
        };
        
        await acpClient.handleUpdate(sessionId, update);
        
        expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
          type: 'tool_end',
          id: 'mcp_McpServer_search_memory',
          status: 'completed',
          output: 'Found result'
        }));
      });

    it('should extract file paths from tool call locations', async () => {
        const sessionId = 'test-session';
        const update = {
          sessionUpdate: 'tool_call',
          toolCallId: 'tooluse_abc123',
          title: 'Reading Sidebar.test.tsx',
          kind: 'read',
          locations: [{ path: 'C:\\repos\\MyAgentUI\\backend\\test\\Sidebar.test.tsx' }]
        };
        
        await acpClient.handleUpdate(sessionId, update);
        
        expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
          type: 'tool_start',
          filePath: 'C:\\repos\\MyAgentUI\\backend\\test\\Sidebar.test.tsx'
        }));
    });

    it('should extract rawOutput.items Text for tool_call_update', async () => {
        const sessionId = 'test-session';
        const update = {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tooluse_abc',
          kind: 'execute',
          status: 'completed',
          title: 'Running: echo hello',
          rawOutput: { items: [{ Text: 'hello\n' }] }
        };
        
        await acpClient.handleUpdate(sessionId, update);
        
        expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
          type: 'tool_end',
          output: 'hello\n'
        }));
    });

    it('should extract rawOutput.items Json for tool_call_update', async () => {
        const sessionId = 'test-session';
        const update = {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tooluse_abc',
          kind: 'other',
          status: 'completed',
          title: 'Running: @DevTools/search_in_files',
          rawOutput: { items: [{ Json: { content: [{ type: 'text', text: '{"result":"found"}' }] } }] }
        };
        
        await acpClient.handleUpdate(sessionId, update);
        
        expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
          type: 'tool_end',
          output: '{"result":"found"}'
        }));
    });

    it('should not emit token_done on turn_end (handled by prompt handler)', async () => {
        await acpClient.handleUpdate('test-session', { sessionUpdate: 'turn_end' });
        expect(mockIo.emit).not.toHaveBeenCalledWith('token_done', expect.anything());
    });

    it('should forward provider extensions to frontend', async () => {
      await acpClient.handleProviderExtension({
        method: '_test.dev/compaction/status',
        params: { sessionId: 'test', status: { type: 'started' } }
      });
      expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
        method: '_test.dev/compaction/status'
      }));
    });

    it('should forward commands/available to frontend', async () => {
      await acpClient.handleProviderExtension({
        method: '_test.dev/commands/available',
        params: { sessionId: 'test', commands: [{ name: '/compact' }] }
      });
      expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
        method: '_test.dev/commands/available',
        params: expect.objectContaining({ commands: expect.any(Array) })
      }));
    });

    it('should forward metadata with contextUsagePercentage', async () => {
      await acpClient.handleProviderExtension({
        method: '_test.dev/metadata',
        params: { sessionId: 'test', contextUsagePercentage: 5.5 }
      });
      expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
        params: expect.objectContaining({ contextUsagePercentage: 5.5 })
      }));
    });

    it('should emit permission_request for handleRequestPermission', async () => {
      const sessionId = 'perm-session';
      
      await acpClient.handleRequestPermission(42, {
        sessionId,
        options: [{ optionId: 'proceed_once', kind: 'allow', name: 'Allow' }],
        toolCall: { title: 'write file' }
      });
      
      expect(mockIo.emit).toHaveBeenCalledWith('permission_request', expect.objectContaining({
        id: 42,
        sessionId,
        options: expect.any(Array)
      }));
      expect(acpClient.pendingPermissions.get(sessionId)).toBe(42);
    });

    it('should send ACP-compliant selected outcome for allow', async () => {
      await acpClient.respondToPermission(42, 'allow_once');
      
      const written = mockProcess.stdin.write.mock.calls[0][0];
      const payload = JSON.parse(written.trim());
      expect(payload).toEqual({
        jsonrpc: '2.0',
        id: 42,
        result: {
          outcome: { outcome: 'selected', optionId: 'allow_once' }
        }
      });
    });

    it('should send ACP-compliant cancelled outcome for reject', async () => {
      await acpClient.respondToPermission(42, 'reject_once');
      
      const written = mockProcess.stdin.write.mock.calls[0][0];
      const payload = JSON.parse(written.trim());
      expect(payload).toEqual({
        jsonrpc: '2.0',
        id: 42,
        result: {
          outcome: { outcome: 'cancelled' }
        }
      });
    });

    it('should clear pendingPermissions on respondToPermission', async () => {
      await acpClient.handleRequestPermission('perm-1', {
        sessionId: 'sess-1',
        options: [],
        toolCall: { title: 'test' }
      });
      expect(acpClient.pendingPermissions.has('sess-1')).toBe(true);

      await acpClient.respondToPermission('perm-1', 'allow_once');
      expect(acpClient.pendingPermissions.has('sess-1')).toBe(false);
    });

    it('should emit provider_extension for handleProviderExtension', async () => {
      await acpClient.handleProviderExtension({
        method: '_test.dev/agent/switched',
        params: { agentName: 'agent-dev' }
      });
      
      expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
        method: '_test.dev/agent/switched'
      }));
    });

    it('should send notification without expecting response', async () => {
      await acpClient.sendNotification('session/cancel', { sessionId: 'test' });
      
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('session/cancel'));
      expect(acpClient.pendingRequests.size).toBe(0);
    });

    it('should handle flat string content in agent_message_chunk', async () => {
      await acpClient.handleUpdate('test-session', {
        sessionUpdate: 'agent_message_chunk',
        content: 'Hello flat string'
      });
      
      expect(mockIo.emit).toHaveBeenCalledWith('token', { sessionId: 'test-session', text: 'Hello flat string' });
    });

    it('should not emit during stats capture', async () => {
      acpClient.statsCaptures.set('test-session', { buffer: '' });
      
      await acpClient.handleUpdate('test-session', {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'captured' }
      });
      
      expect(mockIo.emit).not.toHaveBeenCalledWith('token', expect.anything());
      expect(acpClient.statsCaptures.get('test-session').buffer).toBe('captured');
      acpClient.statsCaptures.clear();
    });

    it('should handle flat string content in agent_thought_chunk', async () => {
      await acpClient.handleUpdate('test-session', {
        sessionUpdate: 'agent_thought_chunk',
        content: 'Thinking flat string'
      });
      expect(mockIo.emit).toHaveBeenCalledWith('thought', { sessionId: 'test-session', text: 'Thinking flat string' });
    });

    it('should strip [Thought: true] from chunks', async () => {
      await acpClient.handleUpdate('test-session', {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Hello [Thought: true] world' }
      });
      expect(mockIo.emit).toHaveBeenCalledWith('token', { sessionId: 'test-session', text: 'Hello  world' });
    });

    it('should track tool call count in metadata', async () => {
      acpClient.sessionMetadata.set('test-session', { toolCalls: 0, lastResponseBuffer: '' });
      await acpClient.handleUpdate('test-session', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tooluse_abc',
        title: 'Reading file.js',
        kind: 'read'
      });
      expect(acpClient.sessionMetadata.get('test-session').toolCalls).toBe(1);
    });

    it('should clear response buffer on tool call', async () => {
      acpClient.sessionMetadata.set('test-session', { toolCalls: 0, lastResponseBuffer: 'some text' });
      await acpClient.handleUpdate('test-session', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tooluse_abc',
        title: 'Editing file',
        kind: 'edit'
      });
      expect(acpClient.sessionMetadata.get('test-session').lastResponseBuffer).toBe('');
    });

    it('should handle tool_call_update with empty rawOutput', async () => {
      await acpClient.handleUpdate('test-session', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tooluse_abc',
        kind: 'edit',
        status: 'completed',
        title: 'Editing file',
        rawOutput: { items: [{ Text: '' }] }
      });
      expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        type: 'tool_end',
        status: 'completed'
      }));
    });

    it('should trigger title generation on first chunk of first prompt', async () => {
      const sessionId = 'title-test';
      acpClient.sessionMetadata.set(sessionId, { promptCount: 1, lastResponseBuffer: '', userPrompt: 'hello' });
      const spy = vi.spyOn(acpClient, 'generateTitle').mockResolvedValue();

      await acpClient.handleUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Hi there' }
      });

      expect(spy).toHaveBeenCalledWith(sessionId, expect.objectContaining({ userPrompt: 'hello' }));
      spy.mockRestore();
    });

    it('should not trigger title generation on second prompt', async () => {
      const sessionId = 'title-test-2';
      acpClient.sessionMetadata.set(sessionId, { promptCount: 2, lastResponseBuffer: '' });
      const spy = vi.spyOn(acpClient, 'generateTitle').mockResolvedValue();

      await acpClient.handleUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'response' }
      });

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should not re-trigger title generation if already generated', async () => {
      const sessionId = 'title-test-3';
      acpClient.sessionMetadata.set(sessionId, { promptCount: 1, titleGenerated: true, lastResponseBuffer: '' });
      const spy = vi.spyOn(acpClient, 'generateTitle').mockResolvedValue();

      await acpClient.handleUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'response' }
      });

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should emit stats_push for usage_update', async () => {
      const sessionId = 'test-session';
      acpClient.sessionMetadata.set(sessionId, { usedTokens: 0, totalTokens: 0 });
      const update = {
        sessionUpdate: 'usage_update',
        used: 100,
        size: 1000
      };
      
      await acpClient.handleUpdate(sessionId, update);
      
      expect(mockIo.emit).toHaveBeenCalledWith('stats_push', { 
          sessionId, 
          usedTokens: 100, 
          totalTokens: 1000 
      });
    });
  });

  describe('setMode', () => {
    it('should send session/set_mode request', async () => {
        const promise = acpClient.setMode('session-1', 'agent_planner');
        
        expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('session/set_mode'));
        expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('agent_planner'));

        const requestId = acpClient.requestId - 1;
        acpClient.pendingRequests.get(requestId).resolve({ success: true });

        const result = await promise;
        expect(result.success).toBe(true);
    });
  });

  describe('setConfigOption', () => {
    it('should send session/configure request', async () => {
      const promise = acpClient.setConfigOption('sess-1', 'effort', 'high');
      
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('session/configure'));
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"effort":"high"'));

      const requestId = acpClient.requestId - 1;
      acpClient.pendingRequests.get(requestId).resolve({ success: true });

      const result = await promise;
      expect(result.success).toBe(true);
    });
  });

  describe('performHandshake', () => {
    it('should initialize and NOT send authenticate', async () => {
      const handshakePromise = acpClient.performHandshake();      
      // Wait for initialize to be sent
      await new Promise(r => setTimeout(r, 2050));
      
      // initialize
      const requestId1 = acpClient.requestId - 1;
      const req1 = acpClient.pendingRequests.get(requestId1);
      if (req1) req1.resolve({});
      
      await handshakePromise;
      
      // Should only have been called once for 'initialize'
      expect(mockProcess.stdin.write).toHaveBeenCalledTimes(1);
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('initialize'));
      expect(acpClient.isHandshakeComplete).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle malformed JSON in stdout gracefully', async () => {
      const handshakeSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();
      // Should not throw
      mockProcess.stdout.emit('data', 'not json\n');
      handshakeSpy.mockRestore();
    });

    it('should handle empty lines in stdout', async () => {
      const handshakeSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();
      mockProcess.stdout.emit('data', '\n\n');
      handshakeSpy.mockRestore();
    });

    it('should handle request_permission from stdout', async () => {
      const handshakeSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();

      const notification = JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'session/request_permission',
        params: { sessionId: 'test', options: [], toolCall: { title: 'write' } }
      }) + '\n';
      mockProcess.stdout.emit('data', notification);

      expect(mockIo.emit).toHaveBeenCalledWith('permission_request', expect.any(Object));
      handshakeSpy.mockRestore();
    });

    it('should handle handshake failure', async () => {
      acpClient.isHandshakeComplete = false;
      vi.useFakeTimers();
      const sendSpy = vi.spyOn(acpClient, 'sendRequest').mockRejectedValue(new Error('fail'));
      const promise = acpClient.performHandshake();
      await vi.advanceTimersByTimeAsync(2100);
      await promise;
      expect(acpClient.isHandshakeComplete).toBe(false);
      sendSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should handle beginDraining when already draining', () => {
      acpClient.beginDraining('sess-1');
      acpClient.beginDraining('sess-1'); // should not throw
      expect(acpClient.drainingSessions.has('sess-1')).toBe(true);
      acpClient.drainingSessions.clear();
    });

    it('should skip tool_call during stats capture', async () => {
      acpClient.statsCaptures.set('test', { buffer: '' });
      await acpClient.handleUpdate('test', {
        sessionUpdate: 'tool_call',
        toolCallId: 'abc',
        title: 'Running test',
        kind: 'execute'
      });
      expect(mockIo.emit).not.toHaveBeenCalledWith('system_event', expect.anything());
      acpClient.statsCaptures.clear();
    });

    it('should skip tool_call_update during stats capture', async () => {
      acpClient.statsCaptures.set('test', { buffer: '' });
      await acpClient.handleUpdate('test', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'abc',
        status: 'completed'
      });
      expect(mockIo.emit).not.toHaveBeenCalledWith('system_event', expect.anything());
      acpClient.statsCaptures.clear();
    });

    it('should handle tool_call_update with Json rawOutput', async () => {
      await acpClient.handleUpdate('test', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'abc',
        kind: 'other',
        status: 'completed',
        title: 'Search',
        rawOutput: { items: [{ Json: { result: 'found' } }] }
      });
      expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        output: expect.stringContaining('found')
      }));
    });

    it('should handle path with ... in title', async () => {
      await acpClient.handleUpdate('test', {
        sessionUpdate: 'tool_call',
        toolCallId: 'abc',
        kind: 'read',
        title: 'Reading file',
        rawInput: { path: '/mnt/c/.../truncated' }
      });
      expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        filePath: undefined
      }));
    });

    it('should clear response buffer on tool call', async () => {
      acpClient.sessionMetadata.set('test', { toolCalls: 0, lastResponseBuffer: 'old text', usedTokens: 0 });
      await acpClient.handleUpdate('test', {
        sessionUpdate: 'tool_call',
        toolCallId: 'abc',
        title: 'Edit',
        kind: 'edit'
      });
      expect(acpClient.sessionMetadata.get('test').lastResponseBuffer).toBe('');
    });

    it('should clear thought buffer on new response chunk', async () => {
      acpClient.sessionMetadata.set('test', { lastThoughtBuffer: 'thinking', lastResponseBuffer: '', usedTokens: 0 });
      await acpClient.handleUpdate('test', {
        sessionUpdate: 'agent_thought_chunk',
        content: { text: 'more thinking' }
      });
      expect(acpClient.sessionMetadata.get('test').lastResponseBuffer).toBe('');
    });
  });

  describe('toSnakeCase (via handleUpdate)', () => {
    it('should normalize PascalCase update types to snake_case', async () => {
      // AgentMessageChunk → agent_message_chunk
      await acpClient.handleUpdate('test', { type: 'AgentMessageChunk', content: { text: 'hi' } });
      expect(mockIo.emit).toHaveBeenCalledWith('token', expect.any(Object));
    });
  });

  describe('generateTitle', () => {
    it('should not generate title if no userPrompt', async () => {
      const meta = { promptCount: 1 };
      await acpClient.generateTitle('test-sess', meta);
      // Should not throw, should not call sendRequest
      expect(mockProcess.stdin.write).not.toHaveBeenCalled();
    });
  });

  describe('start lifecycle', () => {
    it('should spawn process and set up handlers', async () => {
      const startSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();
      expect(spawn).toHaveBeenCalled();
      startSpy.mockRestore();
    });

    it('init should set io and serverBootId', () => {
      acpClient.init(mockIo, 'boot-123');
      expect(acpClient.io).toBe(mockIo);
      expect(acpClient.serverBootId).toBe('boot-123');
    });

    it('should parse JSON-RPC responses from stdout', async () => {
      const handshakeSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();

      const resolve = vi.fn();
      acpClient.pendingRequests.set(99, { resolve, reject: vi.fn(), method: 'test', params: {} });

      const response = JSON.stringify({ jsonrpc: '2.0', id: 99, result: { ok: true } }) + '\n';
      mockProcess.stdout.emit('data', response);

      expect(resolve).toHaveBeenCalledWith({ ok: true });
      handshakeSpy.mockRestore();
    });

    it('should parse session/update notifications from stdout', async () => {
      const sessionId = 'stdout-session';
      acpClient.sessionMetadata.set(sessionId, { usedTokens: 0 });
      const handshakeSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();

      const notification = JSON.stringify({ 
          jsonrpc: '2.0', 
          method: 'session/update', 
          params: { 
            sessionId, 
            update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } } 
          } 
      }) + '\n';
      mockProcess.stdout.emit('data', notification);

      await new Promise(r => setTimeout(r, 100)); // Increase timeout for async processing
      expect(mockIo.emit).toHaveBeenCalledWith('token', expect.objectContaining({ text: 'hello' }));

      handshakeSpy.mockRestore();
    });

    it('should parse provider extension notifications from stdout', async () => {
      const handshakeSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();

      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: '_test.dev/metadata',
        params: { sessionId: 'test', contextUsagePercentage: 5.5 }
      }) + '\n';
      mockProcess.stdout.emit('data', notification);

      expect(mockIo.emit).toHaveBeenCalledWith('provider_extension', expect.objectContaining({
        method: '_test.dev/metadata'
      }));
      handshakeSpy.mockRestore();
    });

    it('should handle process exit and reject pending requests', async () => {
      // Use EventEmitter-based mock for exit event
      const EventEmitter = (await import('events')).default;
      const emitterProcess = new EventEmitter();
      emitterProcess.stdout = new EventEmitter();
      emitterProcess.stderr = new EventEmitter();
      emitterProcess.stdin = { write: vi.fn() };
      spawn.mockReturnValue(emitterProcess);

      const handshakeSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();

      const reject = vi.fn();
      acpClient.pendingRequests.set(100, { resolve: vi.fn(), reject, method: 'test', params: {} });

      emitterProcess.emit('exit', 1);

      expect(reject).toHaveBeenCalledWith(expect.any(Error));
      expect(acpClient.isHandshakeComplete).toBe(false);
      handshakeSpy.mockRestore();
    });

    it('should handle error responses from ACP', async () => {
      const handshakeSpy = vi.spyOn(acpClient, 'performHandshake').mockResolvedValue();
      await acpClient.start();

      const reject = vi.fn();
      acpClient.pendingRequests.set(101, { resolve: vi.fn(), reject, method: 'test', params: {} });

      const errorResponse = JSON.stringify({ jsonrpc: '2.0', id: 101, error: { code: -1, message: 'fail' } }) + '\n';
      mockProcess.stdout.emit('data', errorResponse);

      expect(reject).toHaveBeenCalled();
      handshakeSpy.mockRestore();
    });
  });
});
