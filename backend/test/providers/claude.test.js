import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as claude from '../../../providers/claude/index.js';
import fs from 'fs';
import path from 'path';

// Mock getProvider
vi.mock('../../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      protocolPrefix: '_anthropic/',
      mcpName: 'AcpUI',
      clientInfo: { name: 'claude-code', version: '2.1.114' },
      toolCategories: {
        read: { category: 'file_read', isFileOperation: true },
        edit: { category: 'file_edit', isFileOperation: true }
      },
      paths: {
        sessions: '/mock/claude/sessions',
        attachments: '/mock/attachments',
        agents: '/mock/agents',
        archive: '/mock/archive'
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
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  cpSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('Claude Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('performHandshake', () => {
    it('sends initialize with clientInfo from provider config', async () => {
      const mockClient = { sendRequest: vi.fn().mockResolvedValue({}) };
      await claude.performHandshake(mockClient);
      expect(mockClient.sendRequest).toHaveBeenCalledOnce();
      expect(mockClient.sendRequest).toHaveBeenCalledWith('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'claude-code', version: '2.1.114' }
      });
    });

    it('does not send authenticate', async () => {
      const mockClient = { sendRequest: vi.fn().mockResolvedValue({}) };
      await claude.performHandshake(mockClient);
      expect(mockClient.sendRequest).not.toHaveBeenCalledWith('authenticate', expect.anything());
    });
  });

  describe('intercept', () => {
    it('normalizes available_commands_update', () => {
      const payload = {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'compact', description: 'Compact' },
              { name: '/help', description: 'Help', input: { hint: 'arg' } }
            ]
          }
        }
      };
      const result = claude.intercept(payload);
      expect(result.method).toBe('_anthropic/commands/available');
      expect(result.params.commands[0].name).toBe('/compact');
      expect(result.params.commands[1].meta.hint).toBe('arg');
    });

    it('normalizes non-model config_option_update', () => {
      const payload = {
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [
              { id: 'model', currentValue: 'sonnet' },
              { id: 'effort', currentValue: 'medium' }
            ]
          }
        }
      };

      const result = claude.intercept(payload);
      expect(result.method).toBe('_anthropic/config_options');
      expect(result.params.sessionId).toBe('sess-1');
      expect(result.params.options).toEqual([{ id: 'effort', currentValue: 'medium', kind: 'reasoning_effort' }]);
      expect(result.params.replace).toBe(true);
    });

    it('emits an authoritative snapshot when effort is absent for the active model', () => {
      const payload = {
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [
              { id: 'mode', currentValue: 'acceptEdits' },
              { id: 'model', currentValue: 'haiku' }
            ]
          }
        }
      };

      const result = claude.intercept(payload);
      expect(result.method).toBe('_anthropic/config_options');
      expect(result.params.options).toEqual([{ id: 'mode', currentValue: 'acceptEdits' }]);
      expect(result.params.replace).toBe(true);
    });

    it('swallows model-only config_option_update', () => {
      const payload = {
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [{ id: 'model', currentValue: 'sonnet' }]
          }
        }
      };

      expect(claude.intercept(payload)).toBeNull();
    });

    it('returns original payload for other methods', () => {
      const payload = { method: 'other' };
      expect(claude.intercept(payload)).toBe(payload);
    });
  });

  describe('extractToolOutput', () => {
    it('extracts from content array', () => {
      const update = { content: [{ type: 'text', text: 'Output' }] };
      expect(claude.extractToolOutput(update)).toBe('Output');
    });

    it('extracts from _meta.claudeCode', () => {
      const update = { _meta: { claudeCode: { toolResponse: [{ type: 'text', text: 'Meta Output' }] } } };
      expect(claude.extractToolOutput(update)).toBe('Meta Output');
    });

    it('extracts object-shaped Claude toolResponse file content', () => {
      const update = {
        _meta: {
          claudeCode: {
            toolResponse: {
              type: 'text',
              file: {
                filePath: '/tmp/package.json',
                content: '{ "name": "backend" }'
              }
            }
          }
        }
      };
      expect(claude.extractToolOutput(update)).toBe('{ "name": "backend" }');
    });

    it('extracts filename lists from Claude toolResponse', () => {
      const update = {
        _meta: {
          claudeCode: {
            toolResponse: {
              filenames: ['a.txt', 'b.txt']
            }
          }
        }
      };
      expect(claude.extractToolOutput(update)).toBe('a.txt\nb.txt');
    });
  });

  describe('extractFilePath', () => {
    const resolve = (p) => `/root/${p}`;

    it('extracts from content[0].path', () => {
      const update = { kind: 'edit', content: [{ path: 'test.ts' }] };
      expect(claude.extractFilePath(update, resolve)).toBe('/root/test.ts');
    });

    it('extracts from arguments.file_path', () => {
      const update = { kind: 'read', toolCallId: 'read', arguments: { file_path: 'foo.txt' } };
      expect(claude.extractFilePath(update, resolve)).toBe('/root/foo.txt');
    });

    it('extracts from object-shaped Claude toolResponse file path', () => {
      const update = {
        _meta: {
          claudeCode: {
            toolResponse: {
              file: { filePath: 'meta-file.txt', content: 'text' }
            }
          }
        }
      };
      expect(claude.extractFilePath(update, resolve)).toBe('/root/meta-file.txt');
    });
  });

  describe('setConfigOption', () => {
    it('uses session/set_model for model config fallbacks', async () => {
      const mockClient = { sendRequest: vi.fn().mockResolvedValue({}) };
      await claude.setConfigOption(mockClient, 'sess-1', 'model', 'default');
      expect(mockClient.sendRequest).toHaveBeenCalledWith('session/set_model', {
        sessionId: 'sess-1',
        modelId: 'default'
      });
    });

    it('normalizes returned config options for effort changes', async () => {
      const mockClient = {
        sendRequest: vi.fn().mockResolvedValue({
          configOptions: [
            { id: 'model', currentValue: 'default' },
            { id: 'effort', currentValue: 'max' },
            { id: 'mode', currentValue: 'acceptEdits' }
          ]
        })
      };

      const result = await claude.setConfigOption(mockClient, 'sess-1', 'effort', 'max');
      expect(mockClient.sendRequest).toHaveBeenCalledWith('session/set_config_option', {
        sessionId: 'sess-1',
        configId: 'effort',
        value: 'max'
      });
      expect(result.configOptions).toEqual([
        { id: 'effort', currentValue: 'max', kind: 'reasoning_effort' },
        { id: 'mode', currentValue: 'acceptEdits' }
      ]);
    });
  });

  describe('normalizeTool', () => {
    it('extracts toolName from title with MCP prefix', () => {
      const event = { title: 'mcp__AcpUI__read_file' };
      const normalized = claude.normalizeTool(event);
      expect(normalized.toolName).toBe('read_file');
      expect(normalized.title).toBe('Read File');
    });
  });

  describe('categorizeToolCall', () => {
    it('uses toolCategories from config', () => {
      const event = { toolName: 'read' };
      const cat = claude.categorizeToolCall(event);
      expect(cat.toolCategory).toBe('file_read');
      expect(cat.isFileOperation).toBe(true);
    });
  });

  describe('Session Operations', () => {
    const acpId = 'sess-999';

    it('deleteSessionFiles unlinks files', () => {
      fs.existsSync.mockReturnValue(true);
      claude.deleteSessionFiles(acpId);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
      expect(fs.rmSync).toHaveBeenCalled();
    });

    it('archiveSessionFiles copies and unlinks', () => {
      fs.existsSync.mockReturnValue(true);
      claude.archiveSessionFiles(acpId, '/archive/dir');
      expect(fs.copyFileSync).toHaveBeenCalledTimes(2);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('getHooksForAgent', () => {
    it('reads SessionStart hooks from settings.json', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo start' }] }
          ]
        }
      }));
      const hooks = await claude.getHooksForAgent(null, 'session_start');
      expect(hooks).toEqual([{ command: 'echo start' }]);
    });

    it('preserves matcher from outer entry', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo post' }] }
          ]
        }
      }));
      const hooks = await claude.getHooksForAgent(null, 'post_tool');
      expect(hooks).toEqual([{ command: 'echo post', matcher: 'Bash' }]);
    });

    it('returns [] when settings.json has no hooks', async () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({}));
      const hooks = await claude.getHooksForAgent(null, 'session_start');
      expect(hooks).toEqual([]);
    });

    it('returns [] when settings.json is missing', async () => {
      fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const hooks = await claude.getHooksForAgent(null, 'stop');
      expect(hooks).toEqual([]);
    });

    it('returns [] for unknown hookType', async () => {
      const hooks = await claude.getHooksForAgent(null, 'unknown');
      expect(hooks).toEqual([]);
    });
  });
});
