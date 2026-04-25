import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as kiro from '../../../providers/kiro/index.js';
import fs from 'fs';
import path from 'path';

// Mock getProvider
vi.mock('../../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      protocolPrefix: '_kiro.dev/',
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
      const mockClient = { sendRequest: vi.fn().mockResolvedValue({}) };
      await kiro.performHandshake(mockClient);
      expect(mockClient.sendRequest).toHaveBeenCalledOnce();
      expect(mockClient.sendRequest).toHaveBeenCalledWith('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'AcpUI', version: '1.0.0' }
      });
    });

    it('does not send authenticate', async () => {
      const mockClient = { sendRequest: vi.fn().mockResolvedValue({}) };
      await kiro.performHandshake(mockClient);
      expect(mockClient.sendRequest).not.toHaveBeenCalledWith('authenticate', expect.anything());
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
      const mockClient = { sendRequest: vi.fn().mockResolvedValue({}) };

      await kiro.setConfigOption(mockClient, 'sess-1', 'model', 'claude-sonnet-4.6');

      expect(mockClient.sendRequest).toHaveBeenCalledWith('session/set_model', {
        sessionId: 'sess-1',
        modelId: 'claude-sonnet-4.6'
      });
    });

    it('does not call unsupported config or mode methods', async () => {
      const mockClient = { sendRequest: vi.fn().mockResolvedValue({}) };

      const result = await kiro.setConfigOption(mockClient, 'sess-1', 'mode', 'kiro_default');

      expect(result).toBeNull();
      expect(mockClient.sendRequest).not.toHaveBeenCalled();
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
  });

  describe('normalizeTool', () => {
    it('normalizes kiro tool names', () => {
      const event = { id: 'call_bash_123', title: 'call_bash_123' };
      const normalized = kiro.normalizeTool(event);
      expect(normalized.toolName).toBe('bash');
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
});
