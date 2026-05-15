import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as kiro from '../index.js';
import fs from 'fs';
import path from 'path';

// Mock getProvider
vi.mock('../../../backend/services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      protocolPrefix: '_kiro.dev/',
      mcpName: 'AcpUI',
      toolIdPattern: '@{mcpName}/{toolName}',
      clientInfo: { name: 'AcpUI', version: '1.0.0' },
      paths: {
        sessions: '/mock/sessions',
        attachments: '/mock/attachments',
        agents: '/mock/agents',
        archive: '/mock/archive'
      },
      toolCategories: {
        "bash": { "category": "shell", "isShellCommand": true, "isStreamable": true },
        "read_file": { "category": "file_read", "isFileOperation": true },
        "write_file": { "category": "file_write", "isFileOperation": true },
        "replace": { "category": "file_edit", "isFileOperation": true },
        "list_directory": { "category": "glob", "isFileOperation": true },
        "glob": { "category": "glob", "isFileOperation": true }
      }
    }
  })
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    cpSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  cpSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(),
}));

describe('Kiro Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('performHandshake', () => {
    it('sends initialize with clientInfo from provider config', async () => {
      const mockClient = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      await kiro.performHandshake(mockClient);
      expect(mockClient.transport.sendRequest).toHaveBeenCalledOnce();
      expect(mockClient.transport.sendRequest).toHaveBeenCalledWith('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'AcpUI', version: '1.0.0' }
      });
    });

    it('does not send authenticate', async () => {
      const mockClient = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      await kiro.performHandshake(mockClient);
      expect(mockClient.transport.sendRequest).not.toHaveBeenCalledWith('authenticate', expect.anything());
    });
  });

      describe('prepareAcpEnvironment', () => {
    it('returns the provided environment unchanged', async () => {
      const env = { KEEP: '1' };
      await expect(kiro.prepareAcpEnvironment(env)).resolves.toBe(env);
    });

    it('emits persisted context for a loaded session on request', async () => {
      const emitProviderExtension = vi.fn();
      fs.existsSync.mockImplementation(filePath => String(filePath).endsWith('acp_session_context.json'));
      fs.readFileSync.mockImplementation(filePath => {
        if (String(filePath).endsWith('acp_session_context.json')) {
          return JSON.stringify({ 'kiro-session-1': 37.25 });
        }
        return '';
      });

      await kiro.prepareAcpEnvironment({ KEEP: '1' }, { emitProviderExtension });

      expect(kiro.emitCachedContext('kiro-session-1')).toBe(true);
      expect(emitProviderExtension).toHaveBeenCalledWith('_kiro.dev/metadata', {
        sessionId: 'kiro-session-1',
        contextUsagePercentage: 37.25
      });
        });
      });

      describe('prompt lifecycle hooks', () => {
        it('exports onPromptStarted and onPromptCompleted as no-op hooks', () => {
          expect(typeof kiro.onPromptStarted).toBe('function');
          expect(typeof kiro.onPromptCompleted).toBe('function');
          expect(() => kiro.onPromptStarted('sess-1')).not.toThrow();
          expect(() => kiro.onPromptCompleted('sess-1')).not.toThrow();
        });
      });

      describe('intercept', () => {
    it('normalizes agent switch model into currentModelId', () => {
      const payload = {
        method: '_kiro.dev/agent/switched',
        params: {
          sessionId: 's1',
          agentName: 'agent-dev',
          model: 'claude-opus-4.6'
        }
      };

      expect(kiro.intercept(payload)).toEqual({
        method: '_kiro.dev/agent/switched',
        params: {
          sessionId: 's1',
          agentName: 'agent-dev',
          model: 'claude-opus-4.6',
          currentModelId: 'claude-opus-4.6'
        }
      });
    });
  });

  describe('setConfigOption', () => {
    it('routes model through session/set_model', async () => {
      const mockClient = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };

      await kiro.setConfigOption(mockClient, 'sess-1', 'model', 'claude-sonnet-4.6');

      expect(mockClient.transport.sendRequest).toHaveBeenCalledWith('session/set_model', {
        sessionId: 'sess-1',
        modelId: 'claude-sonnet-4.6'
      });
    });

    it('does not call unsupported config or mode methods', async () => {
      const mockClient = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };

      const result = await kiro.setConfigOption(mockClient, 'sess-1', 'mode', 'kiro_default');

      expect(result).toBeNull();
      expect(mockClient.transport.sendRequest).not.toHaveBeenCalled();
    });
  });

  describe('normalizeUpdate', () => {
    it('normalizes PascalCase type to snake_case sessionUpdate', () => {
      const update = { type: 'AgentMessageChunk', content: { text: 'hi' } };
      const normalized = kiro.normalizeUpdate(update);
      expect(normalized.sessionUpdate).toBe('agent_message_chunk');
    });

    it('normalizes string content to { text } object', () => {
      const update = { type: 'AgentMessageChunk', content: 'hello' };
      const normalized = kiro.normalizeUpdate(update);
      expect(normalized.content).toEqual({ text: 'hello' });
      expect(normalized._originalContent).toBe('hello');
    });
  });

  describe('normalizeConfigOptions', () => {
    it('explicitly passes config options through unchanged', () => {
      const options = [{ id: 'mode', currentValue: 'default' }];
      expect(kiro.normalizeConfigOptions(options)).toBe(options);
      expect(kiro.normalizeConfigOptions(null)).toEqual([]);
    });
  });

  describe('extractToolOutput', () => {
    it('extracts text from rawOutput items', () => {
      const update = {
        rawOutput: {
          items: [
            { Text: 'Output part 1' },
            { Text: 'Output part 2' }
          ]
        }
      };
      const output = kiro.extractToolOutput(update);
      expect(output).toBe('Output part 1\nOutput part 2');
    });

    it('extracts json content from rawOutput items', () => {
      const update = {
        rawOutput: {
          items: [
            { Json: { content: [{ text: 'JSON text' }] } }
          ]
        }
      };
      const output = kiro.extractToolOutput(update);
      expect(output).toBe('JSON text');
    });

    it('ignores success messages', () => {
      const update = {
        rawOutput: {
          items: [{ Text: 'Successfully created file' }]
        }
      };
      const output = kiro.extractToolOutput(update);
      expect(output).toBeUndefined();
    });
  });

  describe('extractFilePath', () => {
    const resolve = (p) => `/root/${p}`;
    
    it('extracts from locations', () => {
      const update = { kind: 'read', locations: [{ path: 'test.txt' }] };
      expect(kiro.extractFilePath(update, resolve)).toBe('/root/test.txt');
    });

    it('extracts from content[0].path', () => {
      const update = { kind: 'edit', content: [{ path: 'edit.js' }] };
      expect(kiro.extractFilePath(update, resolve)).toBe('/root/edit.js');
    });

    it('extracts from arguments', () => {
      const update = { kind: 'edit', toolCallId: 'write_file', arguments: { path: 'arg.py' } };
      expect(kiro.extractFilePath(update, resolve)).toBe('/root/arg.py');
    });
  });

  describe('Session Operations', () => {
    const acpId = 'sess-123';

    it('getSessionPaths returns correct paths', () => {
      const paths = kiro.getSessionPaths(acpId);
      expect(paths.jsonl).toContain('sess-123.jsonl');
      expect(paths.json).toContain('sess-123.json');
      expect(paths.tasksDir).toBe(path.join('/mock/sessions', acpId));
    });

    it('deleteSessionFiles unlinks files', () => {
      fs.existsSync.mockReturnValue(true);
      kiro.deleteSessionFiles(acpId);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
      expect(fs.rmSync).toHaveBeenCalledWith(expect.stringContaining(acpId), expect.any(Object));
    });

    it('archiveSessionFiles copies and unlinks', () => {
      fs.existsSync.mockReturnValue(true);
      kiro.archiveSessionFiles(acpId, '/archive/dir');
      expect(fs.copyFileSync).toHaveBeenCalledTimes(2);
      expect(fs.cpSync).toHaveBeenCalled();
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
      expect(fs.rmSync).toHaveBeenCalled();
    });

    it('restoreSessionFiles copies back', () => {
      fs.existsSync.mockReturnValue(true);
      kiro.restoreSessionFiles(acpId, '/archive/dir');
      expect(fs.copyFileSync).toHaveBeenCalledTimes(2);
      expect(fs.cpSync).toHaveBeenCalled();
    });

    it('deleteSessionFiles clears Kiro runtime context cache state', async () => {
      const emitProviderExtension = vi.fn();
      fs.readFileSync.mockImplementation(filePath => {
        if (String(filePath).endsWith('acp_session_context.json')) {
          return JSON.stringify({ [acpId]: 42 });
        }
        return '';
      });
      await kiro.prepareAcpEnvironment({ KEEP: '1' }, { emitProviderExtension, writeLog: vi.fn() });
      expect(kiro.emitCachedContext(acpId)).toBe(true);

      fs.existsSync.mockReturnValue(true);
      const writesBeforeDelete = fs.writeFileSync.mock.calls.length;
      kiro.deleteSessionFiles(acpId);
      expect(fs.writeFileSync.mock.calls.length).toBeGreaterThan(writesBeforeDelete);

      fs.readFileSync.mockImplementation(filePath => {
        if (String(filePath).endsWith('acp_session_context.json')) {
          return JSON.stringify({ [acpId]: 30 });
        }
        return '';
      });
      await kiro.prepareAcpEnvironment({ KEEP: '1' }, { emitProviderExtension, writeLog: vi.fn() });
      emitProviderExtension.mockClear();
      expect(kiro.emitCachedContext(acpId)).toBe(true);
    });

    it('archiveSessionFiles clears Kiro runtime context cache state', async () => {
      const archiveSessionId = 'sess-archive-123';
      const emitProviderExtension = vi.fn();
      fs.readFileSync.mockImplementation(filePath => {
        if (String(filePath).endsWith('acp_session_context.json')) {
          return JSON.stringify({ [archiveSessionId]: 55 });
        }
        return '';
      });
      await kiro.prepareAcpEnvironment({ KEEP: '1' }, { emitProviderExtension, writeLog: vi.fn() });
      expect(kiro.emitCachedContext(archiveSessionId)).toBe(true);

      fs.existsSync.mockReturnValue(true);
      const writesBeforeArchive = fs.writeFileSync.mock.calls.length;
      kiro.archiveSessionFiles(archiveSessionId, '/archive/dir');
      expect(fs.writeFileSync.mock.calls.length).toBeGreaterThan(writesBeforeArchive);

      fs.readFileSync.mockImplementation(filePath => {
        if (String(filePath).endsWith('acp_session_context.json')) {
          return JSON.stringify({ [archiveSessionId]: 28 });
        }
        return '';
      });
      await kiro.prepareAcpEnvironment({ KEEP: '1' }, { emitProviderExtension, writeLog: vi.fn() });
      emitProviderExtension.mockClear();
      expect(kiro.emitCachedContext(archiveSessionId)).toBe(true);
    });
  });
  describe('normalizeTool', () => {
    it('normalizes kiro tool names from generic IDs via title', () => {
      const event = { id: 'call_bash_123', title: 'call_bash_123' };
      const normalized = kiro.normalizeTool(event);
      expect(normalized.toolName).toBe('bash');
    });

    it('strips primary MCP server prefix from tool name', () => {
      const event = { id: 'tooluse_123', title: 'Running: @TestMCP/do_something' };
      const update = { name: '@TestMCP/do_something' };
      const normalized = kiro.normalizeTool(event, update);
      expect(normalized.toolName).toBe('do_something');
      expect(normalized.title).not.toContain('@TestMCP/');
    });

    it('strips secondary MCP server prefix from tool name', () => {
      const event = { id: 'tooluse_456', title: 'Running: @OtherServer/fetch_data' };
      const update = { name: '@OtherServer/fetch_data' };
      const normalized = kiro.normalizeTool(event, update);
      expect(normalized.toolName).toBe('fetch_data');
      expect(normalized.title).not.toContain('@OtherServer/');
    });

    it('strips any @ServerName/ prefix from tool name', () => {
      const event = { id: 'tooluse_789', title: 'Running: @CustomMCP/my_tool' };
      const update = { name: '@CustomMCP/my_tool' };
      const normalized = kiro.normalizeTool(event, update);
      expect(normalized.toolName).toBe('my_tool');
    });

    it('extracts MCP tool name from title when update.name is a generic ID', () => {
      const event = { id: 'tooluse_abc', title: 'Running: @OtherServer/get_info' };
      const update = { name: 'tooluse_abc' };
      const normalized = kiro.normalizeTool(event, update);
      expect(normalized.toolName).toBe('get_info');
    });

    it('uses update.name over event.id when available', () => {
      const event = { id: 'tooluse_xyz', title: 'Running: some_tool' };
      const update = { name: 'some_tool' };
      const normalized = kiro.normalizeTool(event, update);
      expect(normalized.toolName).toBe('some_tool');
    });

    it('formats title from tool name', () => {
      const event = { id: 'x', title: 'Running: spawn_helpers' };
      const update = { name: 'spawn_helpers' };
      const normalized = kiro.normalizeTool(event, update);
      expect(normalized.title).toBe('Spawn Helpers');
    });

    it('normalizes optional AcpUI MCP tool titles without server prefixes', () => {
      const normalize = (toolName, args) => kiro.normalizeTool(
        { id: 'tooluse_optional', title: `Running: @AcpUI/${toolName}` },
        { name: `@AcpUI/${toolName}`, arguments: args }
      );

      expect(normalize('ux_read_file', { file_path: 'D:/Git/AcpUI/.devFiles/TEST_MCP/hello.ts' }).title).toBe('Read File: hello.ts');
      expect(normalize('ux_write_file', { file_path: 'D:/Git/AcpUI/.devFiles/TEST_MCP/hello.ts' }).title).toBe('Write File: hello.ts');
      expect(normalize('ux_replace', { file_path: 'D:/Git/AcpUI/.devFiles/TEST_MCP/hello.ts' }).title).toBe('Replace In File: hello.ts');
      expect(normalize('ux_list_directory', { dir_path: 'D:/Git/AcpUI/.devFiles' }).title).toBe('List Directory: D:/Git/AcpUI/.devFiles');
      expect(normalize('ux_glob', { description: 'Find feature docs', pattern: '*.md' }).title).toBe('Glob: Find feature docs');
      expect(normalize('ux_grep_search', { description: 'Find TODOs', pattern: 'TODO' }).title).toBe('Search: Find TODOs');
      expect(normalize('ux_web_fetch', { url: 'https://example.test/docs' }).title).toBe('Fetch: https://example.test/docs');
      expect(normalize('ux_google_web_search', { query: 'latest docs' }).title).toBe('Web Search: latest docs');
    });

    it('extracts canonical MCP invocation metadata from Kiro names', () => {
      const invocation = kiro.extractToolInvocation(
        {
          toolCallId: 'tooluse_1',
          name: '@AcpUI/ux_invoke_shell',
          arguments: { description: 'Run tests', command: 'npm test' }
        },
        { event: { id: 'tooluse_1', title: 'Running: @AcpUI/ux_invoke_shell' } }
      );

      expect(invocation).toEqual(expect.objectContaining({
        toolCallId: 'tooluse_1',
        canonicalName: 'ux_invoke_shell',
        mcpServer: 'AcpUI',
        mcpToolName: 'ux_invoke_shell',
        input: expect.objectContaining({ description: 'Run tests', command: 'npm test' })
      }));
    });
  });

  describe('categorizeToolCall', () => {
    it('categorizes shell tools', () => {
      const cat = kiro.categorizeToolCall({ toolName: 'bash' });
      expect(cat.toolCategory).toBe('shell');
      expect(cat.isShellCommand).toBe(true);
    });

    it('categorizes file tools', () => {
      const cat = kiro.categorizeToolCall({ toolName: 'read_file' });
      expect(cat.toolCategory).toBe('file_read');
      expect(cat.isFileOperation).toBe(true);
    });
  });

  describe('parseExtension', () => {
    it('parses agent switch notifications with current model state', () => {
      const parsed = kiro.parseExtension('_kiro.dev/agent/switched', {
        sessionId: 's1',
        agentName: 'agent-dev',
        previousAgentName: 'kiro_default',
        model: 'claude-sonnet-4.6'
      });

      expect(parsed).toEqual({
        type: 'agent_switched',
        sessionId: 's1',
        agentName: 'agent-dev',
        previousAgentName: 'kiro_default',
        welcomeMessage: undefined,
        currentModelId: 'claude-sonnet-4.6'
      });
    });
  });

  describe('getHooksForAgent', () => {
    it('returns hooks for a given hookType', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({
        hooks: {
          agentSpawn: [{ command: 'echo hello' }],
          stop: ['echo done'],
        }
      }));
      const hooks = await kiro.getHooksForAgent('my-agent', 'session_start');
      expect(hooks).toEqual([{ command: 'echo hello' }]);
    });

    it('normalizes string entries to { command } objects', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({
        hooks: { stop: ['echo bye'] }
      }));
      const hooks = await kiro.getHooksForAgent('my-agent', 'stop');
      expect(hooks).toEqual([{ command: 'echo bye' }]);
    });

    it('returns [] for unknown hookType', async () => {
      const hooks = await kiro.getHooksForAgent('my-agent', 'unknown_type');
      expect(hooks).toEqual([]);
    });

    it('returns [] when agentName is falsy', async () => {
      const hooks = await kiro.getHooksForAgent(null, 'session_start');
      expect(hooks).toEqual([]);
    });

    it('returns [] when agent file does not exist', async () => {
      fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const hooks = await kiro.getHooksForAgent('missing-agent', 'stop');
      expect(hooks).toEqual([]);
    });

    it('maps post_tool to postToolUse key', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({
        hooks: { postToolUse: [{ command: 'echo post', matcher: 'fs_write' }] }
      }));
      const hooks = await kiro.getHooksForAgent('my-agent', 'post_tool');
      expect(hooks).toEqual([{ command: 'echo post', matcher: 'fs_write' }]);
    });
  });

  describe('setInitialAgent', () => {
    it('sends /agent command via session/prompt with drain lifecycle', async () => {
      const mockClient = {
        transport: { sendRequest: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }) },
        stream: { beginDraining: vi.fn(), waitForDrainToFinish: vi.fn().mockResolvedValue() }
      };
      await kiro.setInitialAgent(mockClient, 'sess-1', 'test-agent');
      expect(mockClient.stream.beginDraining).toHaveBeenCalledWith('sess-1');
      expect(mockClient.transport.sendRequest).toHaveBeenCalledWith('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: '/agent test-agent' }]
      });
      expect(mockClient.stream.waitForDrainToFinish).toHaveBeenCalledWith('sess-1', 1000);
    });

    it('is a no-op when agent is falsy', async () => {
      const mockClient = {
        transport: { sendRequest: vi.fn() },
        stream: { beginDraining: vi.fn(), waitForDrainToFinish: vi.fn() }
      };
      await kiro.setInitialAgent(mockClient, 'sess-1', undefined);
      expect(mockClient.transport.sendRequest).not.toHaveBeenCalled();
      expect(mockClient.stream.beginDraining).not.toHaveBeenCalled();
    });
  });

  describe('buildSessionParams', () => {
    it('returns undefined when agent is provided', () => {
      expect(kiro.buildSessionParams('my-agent')).toBeUndefined();
    });

    it('returns undefined when agent is undefined', () => {
      expect(kiro.buildSessionParams(undefined)).toBeUndefined();
    });
  });
});
