import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as claude from '../index.js';
import { extractClaudeQuotaHeaders, stopClaudeQuotaProxy } from '../quotaProxy.js';
import fs from 'fs';
import path from 'path';

// Mock getProvider
vi.mock('../../../backend/services/providerLoader.js', () => ({
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

  afterEach(async () => {
    await stopClaudeQuotaProxy();
  });

  describe('performHandshake', () => {
    it('sends initialize with clientInfo from provider config', async () => {
      const mockClient = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      await claude.performHandshake(mockClient);
      expect(mockClient.transport.sendRequest).toHaveBeenCalledOnce();
      expect(mockClient.transport.sendRequest).toHaveBeenCalledWith('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'claude-code', version: '2.1.114' }
      });
    });

    it('does not send authenticate', async () => {
      const mockClient = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      await claude.performHandshake(mockClient);
      expect(mockClient.transport.sendRequest).not.toHaveBeenCalledWith('authenticate', expect.anything());
    });
  });

  describe('prepareAcpEnvironment', () => {
    it('returns the provided environment unchanged when proxy capture is disabled', async () => {
      const env = {
        CLAUDE_QUOTA_PROXY: 'false',
        KEEP: '1'
      };

      const result = await claude.prepareAcpEnvironment(env);

      expect(result).toBe(env);
    });

    it('starts a provider-owned proxy and injects ANTHROPIC_BASE_URL', async () => {
      const writeLog = vi.fn();
      const env = { KEEP: '1' };

      const result = await claude.prepareAcpEnvironment(env, { writeLog });

      expect(result.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(result.KEEP).toBe('1');
      expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('Injecting ANTHROPIC_BASE_URL='));
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

  describe('parseExtension', () => {
    it('parses provider status extensions', () => {
      const status = {
        providerId: 'provider-id',
        sections: [{ id: 'section', items: [] }]
      };

      expect(claude.parseExtension('_anthropic/provider/status', { status })).toEqual({
        type: 'provider_status',
        status
      });
    });

    it('does not expose the old quota update event as a first-class route', () => {
      const result = claude.parseExtension('_anthropic/quota_update', { quotaData: {} });
      expect(result).toEqual({
        type: 'unknown',
        method: '_anthropic/quota_update',
        params: { quotaData: {} }
      });
    });
  });

  describe('buildClaudeProviderStatus', () => {
    it('translates quota headers into summary and full detail sections', () => {
      const status = claude.buildClaudeProviderStatus({
        source: 'test-source',
        captured_at: '2026-04-18T18:23:14.941Z',
        url: 'https://api.example.test/v1/messages',
        status: 200,
        '5h_utilization': 0.59,
        '5h_status': 'allowed',
        '5h_resets_at': '2026-04-18T22:50:00.000Z',
        '7d_utilization': 0.6,
        '7d_status': 'allowed',
        '7d_resets_at': '2026-04-18T12:00:00.000Z',
        overage_utilization: 0,
        overage_status: 'allowed',
        fallback_percentage: 0.5,
        representative_claim: 'five_hour',
        unified_status: 'allowed',
        raw: {
          'anthropic-ratelimit-unified-7d-utilization': '0.6',
          'anthropic-ratelimit-unified-5h-utilization': '0.59'
        }
      });

      expect(status.providerId).toBe('claude');
      expect(status.summary.items).toEqual([
        expect.objectContaining({ id: 'five-hour', label: '5h', value: '59%', detail: expect.stringContaining('Resets'), tone: 'info', progress: { value: 0.59 } }),
        expect.objectContaining({ id: 'seven-day', label: '7d', value: '60%', detail: expect.stringContaining('Resets'), tone: 'warning', progress: { value: 0.6 } })
      ]);
      expect(status.summary.items.some(item => item.id === 'overage')).toBe(false);
      expect(status.sections.find(section => section.id === 'details')?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'unified-status', value: 'Allowed' }),
        expect.objectContaining({ id: 'representative-claim', value: 'Five Hour' }),
        expect.objectContaining({ id: 'fallback', value: '50%' })
      ]));
      expect(status.sections.find(section => section.id === 'request')?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'http-status', value: '200' }),
        expect.objectContaining({ id: 'source', value: 'test-source' })
      ]));
    });

    it('shows overage in the summary only when overage is above zero and marks high usage as danger', () => {
      const status = claude.buildClaudeProviderStatus({
        captured_at: '2026-04-18T18:23:14.941Z',
        '5h_utilization': 0.86,
        '5h_status': 'allowed',
        '7d_utilization': 0.85,
        '7d_status': 'allowed',
        overage_utilization: 0.01,
        overage_status: 'allowed',
        raw: {}
      });

      expect(status.summary.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'five-hour', tone: 'danger', value: '86%' }),
        expect.objectContaining({ id: 'seven-day', tone: 'warning', value: '85%' }),
        expect.objectContaining({ id: 'overage', tone: 'info', value: '1%' })
      ]));
    });
  });

  describe('quota proxy header parsing', () => {
    it('returns null when response headers do not include provider quota data', () => {
      expect(extractClaudeQuotaHeaders({ 'content-type': 'application/json' })).toBeNull();
    });

    it('parses Anthropic rate-limit headers without depending on header casing', () => {
      const quota = extractClaudeQuotaHeaders({
        'Anthropic-RateLimit-Unified-5h-Utilization': '0.03',
        'Anthropic-RateLimit-Unified-5h-Status': 'allowed',
        'Anthropic-RateLimit-Unified-5h-Reset': '1777157400',
        'Anthropic-RateLimit-Unified-7d-Utilization': '0.5',
        'Anthropic-RateLimit-Unified-Overage-Utilization': ['0.0'],
        'Anthropic-RateLimit-Unified-Status': 'allowed'
      }, {
        url: 'https://api.example.test/v1/messages',
        status: 200
      });

      expect(quota).toEqual(expect.objectContaining({
        source: 'acpui-claude-provider-proxy',
        url: 'https://api.example.test/v1/messages',
        status: 200,
        '5h_utilization': 0.03,
        '5h_status': 'allowed',
        '5h_reset': 1777157400,
        '5h_resets_at': '2026-04-25T22:50:00.000Z',
        '7d_utilization': 0.5,
        overage_utilization: 0,
        unified_status: 'allowed',
        raw: expect.objectContaining({
          'anthropic-ratelimit-unified-5h-utilization': '0.03',
          'anthropic-ratelimit-unified-overage-utilization': '0.0'
        })
      }));
      expect(Number.isNaN(Date.parse(quota.captured_at))).toBe(false);
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
      const mockClient = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      await claude.setConfigOption(mockClient, 'sess-1', 'model', 'default');
      expect(mockClient.transport.sendRequest).toHaveBeenCalledWith('session/set_model', {
        sessionId: 'sess-1',
        modelId: 'default'
      });
    });

    it('normalizes returned config options for effort changes', async () => {
      const mockClient = {
        transport: {
          sendRequest: vi.fn().mockResolvedValue({
            configOptions: [
              { id: 'model', currentValue: 'default' },
              { id: 'effort', currentValue: 'max' },
              { id: 'mode', currentValue: 'acceptEdits' }
            ]
          })
        }
      };

      const result = await claude.setConfigOption(mockClient, 'sess-1', 'effort', 'max');
      expect(mockClient.transport.sendRequest).toHaveBeenCalledWith('session/set_config_option', {
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

  describe('buildSessionParams', () => {
    const DISALLOWED = ['Bash', 'PowerShell', 'Agent'];

    it('returns _meta with disallowedTools + agent when agent is provided', () => {
      expect(claude.buildSessionParams('my-agent')).toEqual({
        _meta: { claudeCode: { options: { disallowedTools: DISALLOWED, agent: 'my-agent' } } }
      });
    });

    it('returns _meta with only disallowedTools when agent is undefined', () => {
      expect(claude.buildSessionParams(undefined)).toEqual({
        _meta: { claudeCode: { options: { disallowedTools: DISALLOWED } } }
      });
    });

    it('returns _meta with only disallowedTools when agent is null', () => {
      expect(claude.buildSessionParams(null)).toEqual({
        _meta: { claudeCode: { options: { disallowedTools: DISALLOWED } } }
      });
    });

    it('returns _meta with only disallowedTools when agent is empty string', () => {
      expect(claude.buildSessionParams('')).toEqual({
        _meta: { claudeCode: { options: { disallowedTools: DISALLOWED } } }
      });
    });
  });
});
