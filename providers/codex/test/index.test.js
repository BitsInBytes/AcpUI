import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as Diff from 'diff';
import * as codex from '../index.js';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    protocolPrefix: '_codex/',
    mcpName: 'AcpUI',
    clientInfo: { name: 'AcpUI', version: '1.0.0' },
    authMethod: 'auto',
    toolCategories: {
      shell: { category: 'shell', isShellCommand: true },
      ux_invoke_shell: { category: 'shell', isShellCommand: true },
      read_file: { category: 'file_read', isFileOperation: true },
      edit_file: { category: 'file_edit', isFileOperation: true },
      search: { category: 'grep' }
    },
    paths: {
      home: '',
      sessions: '',
      attachments: '',
      agents: '',
      archive: ''
    }
  }
}));

vi.mock('../../../backend/services/providerLoader.js', () => ({
  getProvider: () => ({ config: mockConfig })
}));

describe('Codex Provider', () => {
  let tempRoot;
  let originalCodexApiKey;
  let originalOpenAiApiKey;
  let originalQuotaClientId;
  let originalFetch;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-'));
    mockConfig.authMethod = 'auto';
    mockConfig.apiKey = '';
    mockConfig.codexApiKey = '';
    mockConfig.openaiApiKey = '';
    mockConfig.apiKeyEnv = '';
    mockConfig.noBrowser = false;
    mockConfig.fetchQuotaStatus = false;
    mockConfig.refreshQuotaOAuth = true;
    mockConfig.quotaStatusIntervalMs = 0;
    mockConfig.quotaOAuthClientId = '';
    mockConfig.quotaOAuthClientIdEnv = 'CODEX_QUOTA_OAUTH_CLIENT_ID';
    mockConfig.paths = {
      home: path.join(tempRoot, '.codex'),
      sessions: path.join(tempRoot, '.codex', 'sessions'),
      attachments: path.join(tempRoot, '.codex', 'attachments'),
      agents: path.join(tempRoot, '.codex', 'agents'),
      archive: path.join(tempRoot, '.codex', 'archive')
    };

    originalCodexApiKey = process.env.CODEX_API_KEY;
    originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    originalQuotaClientId = process.env.CODEX_QUOTA_OAUTH_CLIENT_ID;
    originalFetch = global.fetch;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_QUOTA_OAUTH_CLIENT_ID;
    vi.clearAllMocks();
  });

  afterEach(() => {
    codex.stopQuotaFetching();
    global.fetch = originalFetch;
    if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = originalCodexApiKey;
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    if (originalQuotaClientId === undefined) delete process.env.CODEX_QUOTA_OAUTH_CLIENT_ID;
    else process.env.CODEX_QUOTA_OAUTH_CLIENT_ID = originalQuotaClientId;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('performHandshake', () => {
    it('sends initialize and skips auth when no auto auth source exists', async () => {
      const client = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      await codex.performHandshake(client);

      expect(client.transport.sendRequest).toHaveBeenCalledTimes(1);
      expect(client.transport.sendRequest).toHaveBeenCalledWith('initialize', {
        protocolVersion: 1,
        clientCapabilities: { terminal: true },
        clientInfo: { name: 'AcpUI', version: '1.0.0' }
      });
    });

    it('authenticates with codex-api-key when CODEX_API_KEY is present', async () => {
      process.env.CODEX_API_KEY = 'sk-test';
      const client = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      await codex.performHandshake(client);

      expect(client.transport.sendRequest).toHaveBeenCalledWith('authenticate', {
        methodId: 'codex-api-key'
      });
    });
  });

  describe('prepareAcpEnvironment', () => {
    it('injects configured API keys into the child environment', async () => {
      mockConfig.apiKey = 'sk-configured';
      mockConfig.apiKeyEnv = 'OPENAI_API_KEY';
      mockConfig.noBrowser = true;

      const env = await codex.prepareAcpEnvironment({ KEEP: '1' });
      expect(env.KEEP).toBe('1');
      expect(env.OPENAI_API_KEY).toBe('sk-configured');
      expect(env.NO_BROWSER).toBe('1');
    });

    it('emits persisted context for a loaded session on request', async () => {
      fs.mkdirSync(mockConfig.paths.home, { recursive: true });
      fs.writeFileSync(
        path.join(mockConfig.paths.home, 'acp_session_context.json'),
        JSON.stringify({ 'codex-session-1': 51.75 }),
        'utf8'
      );
      const emitProviderExtension = vi.fn();

      await codex.prepareAcpEnvironment({ KEEP: '1' }, { emitProviderExtension });

      expect(codex.emitCachedContext('codex-session-1')).toBe(true);
      expect(emitProviderExtension).toHaveBeenCalledWith('_codex/metadata', {
        sessionId: 'codex-session-1',
        contextUsagePercentage: 51.75
      });
    });
  });

  describe('quota status', () => {
    const quotaBody = {
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 69, limit_window_seconds: 18000, reset_at: 1777745710 },
        secondary_window: { used_percent: 26, limit_window_seconds: 604800, reset_at: 1778285436 }
      },
      credits: {
        has_credits: false,
        unlimited: false,
        balance: '0',
        overage_limit_reached: false
      },
      additional_rate_limits: null,
      rate_limit_reached_type: null
    };

    function writeAuth(overrides = {}) {
      fs.mkdirSync(mockConfig.paths.home, { recursive: true });
      const auth = {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'access-old',
          refresh_token: 'refresh-old',
          account_id: 'acct-1',
          id_token: {
            raw_jwt: 'id-old',
            chatgpt_account_id: 'acct-from-id',
            chatgpt_account_is_fedramp: false
          },
          ...overrides.tokens
        },
        ...overrides
      };
      const authPath = path.join(mockConfig.paths.home, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf8');
      return { authPath, auth };
    }

    function jsonResponse(status, body) {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Unauthorized',
        headers: {
          get: key => key.toLowerCase() === 'content-type' ? 'application/json' : null,
          entries: function* entries() {
            yield ['content-type', 'application/json'];
          }
        },
        text: vi.fn().mockResolvedValue(JSON.stringify(body))
      };
    }

    it('fetches quota with Codex OAuth headers from auth.json', async () => {
      writeAuth();
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, quotaBody));

      const result = await codex.fetchCodexQuota({ homePath: mockConfig.paths.home });

      expect(result.body.plan_type).toBe('plus');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://chatgpt.com/backend-api/wham/usage',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer access-old',
            'ChatGPT-Account-ID': 'acct-1'
          })
        })
      );
    });

    function createJwt(payload) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signature = 'fake-signature';
      return `${header}.${body}.${signature}`;
    }

    it('derives client ID from access_token JWT payload and refreshes on 401', async () => {
      const accessTokenWithClientId = createJwt({
        iss: 'https://auth.openai.com',
        client_id: 'client-from-jwt',
        sub: 'user-id'
      });
      const { authPath } = writeAuth({
        tokens: {
          access_token: accessTokenWithClientId,
          refresh_token: 'refresh-old',
          account_id: 'acct-1'
        }
      });
      global.fetch = vi.fn()
        .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
        .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
        .mockResolvedValueOnce(jsonResponse(200, {
          id_token: 'id-new',
          access_token: createJwt({ client_id: 'client-from-jwt' }),
          refresh_token: 'refresh-new'
        }))
        .mockResolvedValueOnce(jsonResponse(200, quotaBody));

      const result = await codex.fetchCodexQuota({ homePath: mockConfig.paths.home });
      const stored = JSON.parse(fs.readFileSync(authPath, 'utf8'));

      expect(result.body.rate_limit.primary_window.used_percent).toBe(69);
      expect(stored.tokens.access_token).not.toBe(accessTokenWithClientId);
      expect(stored.tokens.refresh_token).toBe('refresh-new');
      expect(global.fetch).toHaveBeenNthCalledWith(
        3,
        'https://auth.openai.com/oauth/token',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            client_id: 'client-from-jwt',
            grant_type: 'refresh_token',
            refresh_token: 'refresh-old'
          })
        })
      );
    });

    it('fails when access_token JWT has no client_id field', async () => {
      const accessTokenNoClientId = createJwt({
        iss: 'https://auth.openai.com',
        sub: 'user-id'
      });
      writeAuth({
        tokens: {
          access_token: accessTokenNoClientId,
          refresh_token: 'refresh-old',
          account_id: 'acct-1'
        }
      });
      global.fetch = vi.fn()
        .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
        .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }));

      await expect(
        codex.fetchCodexQuota({ homePath: mockConfig.paths.home })
      ).rejects.toThrow('client_id could not be derived from access_token JWT');
    });

    it('builds provider status with 5h, weekly, and credit details', () => {
      const status = codex.buildCodexProviderStatus(quotaBody, { authPath: 'auth.json' });

      expect(status.providerId).toBe('codex');
      expect(status.summary.items).toEqual([
        expect.objectContaining({ id: 'primary', label: '5h', value: '69%' }),
        expect.objectContaining({ id: 'secondary', label: '7d', value: '26%' })
      ]);
      expect(status.sections.find(section => section.id === 'credits').items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'credits-balance', value: '0' })])
      );
    });

    it('emits provider status when quota fetching is enabled', async () => {
      writeAuth();
      const emitProviderExtension = vi.fn();
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, quotaBody));

      await codex.prepareAcpEnvironment({}, { emitProviderExtension });
      await codex.fetchAndEmitQuota('session-1', mockConfig.paths.home);

      expect(emitProviderExtension).toHaveBeenCalledWith('_codex/provider/status', {
        status: expect.objectContaining({
          providerId: 'codex',
          summary: expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ label: '5h' }),
              expect.objectContaining({ label: '7d' })
            ])
          })
        })
      });
    });
  });

  describe('intercept', () => {
    it('normalizes available commands into slash commands', () => {
      const result = codex.intercept({
        method: 'session/update',
        params: {
          sessionId: 's1',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'review', description: 'Review' },
              { name: '/compact', description: 'Compact', input: { hint: 'optional note' } }
            ]
          }
        }
      });

      expect(result.method).toBe('_codex/commands/available');
      expect(result.params.commands[0].name).toBe('/review');
      expect(result.params.commands[1].meta.hint).toBe('optional note');
    });

    it('filters model config options and marks reasoning effort', () => {
      const result = codex.intercept({
        method: 'session/update',
        params: {
          sessionId: 's1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [
              {
                id: 'model',
                type: 'select',
                currentValue: 'gpt-test',
                options: [
                  { value: 'gpt-test/low', name: 'GPT Test (low)' },
                  { value: 'gpt-test/high', name: 'GPT Test (high)' }
                ]
              },
              { id: 'reasoning_effort', currentValue: 'medium', options: [{ value: 'high', name: 'High' }] },
              { id: 'mode', currentValue: 'default' }
            ]
          }
        }
      });

      expect(result.method).toBe('_codex/config_options');
      expect(result.params.options).toEqual([
        expect.objectContaining({ id: 'reasoning_effort', kind: 'reasoning_effort' }),
        expect.objectContaining({ id: 'mode', currentValue: 'default' })
      ]);
      expect(result.params.options.some(option => option.id === 'model')).toBe(false);
      expect(result.params.modelOptions).toEqual([
        expect.objectContaining({ id: 'gpt-test/low', name: 'GPT Test (low)' }),
        expect.objectContaining({ id: 'gpt-test/high', name: 'GPT Test (high)' })
      ]);
    });

    it('forwards model-only catalog updates as modelOptions', () => {
      const result = codex.intercept({
        method: 'session/update',
        params: {
          sessionId: 's1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [
              {
                id: 'model',
                type: 'select',
                currentValue: 'gpt-test',
                options: [{ value: 'gpt-test/high', name: 'GPT Test (high)' }]
              }
            ]
          }
        }
      });

      expect(result.method).toBe('_codex/config_options');
      expect(result.params.options).toEqual([]);
      expect(result.params.modelOptions).toEqual([
        expect.objectContaining({ id: 'gpt-test/high', name: 'GPT Test (high)' })
      ]);
    });

    it('swallows model-only config updates when no catalog is advertised', () => {
      const result = codex.intercept({
        method: 'session/update',
        params: {
          sessionId: 's1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [{ id: 'model', currentValue: 'gpt-test' }]
          }
        }
      });

      expect(result).toBeNull();
    });

    it('promotes error.data.message to error.message for user-facing display', () => {
      const result = codex.intercept({
        id: 4,
        error: {
          code: -32603,
          message: 'Internal error',
          data: {
            message: "You've hit your usage limit. Try again later.",
            codex_error_info: 'usage_limit_exceeded'
          }
        }
      });

      expect(result.error.message).toBe("You've hit your usage limit. Try again later.");
      expect(result.error.code).toBe(-32603);
      expect(result.error.data).toEqual({
        message: "You've hit your usage limit. Try again later.",
        codex_error_info: 'usage_limit_exceeded'
      });
    });

    it('leaves error payload unchanged when error.data.message is absent', () => {
      const payload = {
        id: 5,
        error: { code: -32600, message: 'Invalid Request' }
      };
      const result = codex.intercept(payload);
      expect(result.error.message).toBe('Invalid Request');
    });

    it('leaves non-error payload unchanged', () => {
      const payload = {
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'turn_end' } }
      };
      const result = codex.intercept(payload);
      expect(result).toBe(payload);
    });

    it('does not start the poll timer on agent_message_chunk', () => {
      mockConfig.fetchQuotaStatus = true;
      mockConfig.quotaStatusIntervalMs = 100;
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      codex.intercept({
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'word' } } }
      });

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it('starts the poll timer on user_message and stops it on stopReason', () => {
      mockConfig.fetchQuotaStatus = true;
      mockConfig.quotaStatusIntervalMs = 100;
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      // user_message: polling should start
      codex.intercept({
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'user_message' } }
      });
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 100);

      // many chunks: must not start a second timer
      const chunksBefore = setIntervalSpy.mock.calls.length;
      for (let i = 0; i < 5; i++) {
        codex.intercept({
          method: 'session/update',
          params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x' } } }
        });
      }
      expect(setIntervalSpy.mock.calls.length).toBe(chunksBefore);

      // stopReason result: polling should stop
      codex.intercept({ id: 1, result: { stopReason: 'end_turn' } });
      expect(clearIntervalSpy).toHaveBeenCalled();

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });
  });

  describe('normalizeModelState', () => {
    it('preserves effort-suffixed model IDs as canonical options', () => {
      const state = codex.normalizeModelState({
        currentModelId: 'gpt-5-codex/medium',
        modelOptions: [
          { id: 'gpt-5-codex/low', name: 'GPT-5 Codex (low)' },
          { id: 'gpt-5-codex/medium', name: 'GPT-5 Codex (medium)' },
          { id: 'gpt-5-codex/high', name: 'GPT-5 Codex (high)' },
          { id: 'gpt-5-codex/high', name: 'GPT-5 Codex (high duplicate)' },
          { id: 'o4-mini/medium', name: 'o4-mini - medium' },
          { id: 'gpt-5.5/xhigh', name: 'GPT-5.5 (xhigh)' }
        ]
      });

      expect(state.currentModelId).toBe('gpt-5-codex/medium');
      expect(state.replaceModelOptions).toBe(true);
      expect(state.modelOptions).toEqual([
        expect.objectContaining({ id: 'gpt-5-codex/low', name: 'GPT-5 Codex (low)' }),
        expect.objectContaining({ id: 'gpt-5-codex/medium', name: 'GPT-5 Codex (medium)' }),
        expect.objectContaining({ id: 'gpt-5-codex/high', name: 'GPT-5 Codex (high)' }),
        expect.objectContaining({ id: 'o4-mini/medium', name: 'o4-mini - medium' }),
        expect.objectContaining({ id: 'gpt-5.5/xhigh', name: 'GPT-5.5 (xhigh)' })
      ]);
    });

    it('keeps non-effort slash model IDs intact', () => {
      const state = codex.normalizeModelState({
        currentModelId: 'vendor/model-name',
        modelOptions: [{ id: 'vendor/model-name', name: 'Vendor Model' }]
      });

      expect(state.currentModelId).toBe('vendor/model-name');
      expect(state.modelOptions).toEqual([
        expect.objectContaining({ id: 'vendor/model-name', name: 'Vendor Model' })
      ]);
    });

    it('augments model options from configOptions model select catalog', () => {
      const state = codex.normalizeModelState(
        {
          currentModelId: 'gpt-5.5/xhigh',
          modelOptions: [{ id: 'gpt-5.5/xhigh', name: 'GPT 5.5 (xhigh)' }]
        },
        {
          configOptions: [
            {
              id: 'model',
              type: 'select',
              currentValue: 'gpt-5.5',
              options: [
                { value: 'gpt-5.5/low', name: 'GPT 5.5 (low)' },
                { value: 'gpt-5.5/high', name: 'GPT 5.5 (high)' }
              ]
            }
          ]
        }
      );

      expect(state.modelOptions).toEqual([
        expect.objectContaining({ id: 'gpt-5.5/xhigh', name: 'GPT 5.5 (xhigh)' }),
        expect.objectContaining({ id: 'gpt-5.5/low', name: 'GPT 5.5 (low)' }),
        expect.objectContaining({ id: 'gpt-5.5/high', name: 'GPT 5.5 (high)' })
      ]);
      expect(state.currentModelId).toBe('gpt-5.5/xhigh');
    });
  });

  describe('setConfigOption', () => {
    it('routes mode and generic options to the expected ACP requests', async () => {
      const client = { transport: { sendRequest: vi.fn().mockResolvedValue({ configOptions: [] }) } };
      await codex.setConfigOption(client, 's1', 'mode', 'read-only');
      await codex.setConfigOption(client, 's1', 'reasoning_effort', 'high');

      expect(client.transport.sendRequest).toHaveBeenCalledWith('session/set_mode', {
        sessionId: 's1',
        modeId: 'read-only'
      });
      expect(client.transport.sendRequest).toHaveBeenCalledWith('session/set_config_option', {
        sessionId: 's1',
        configId: 'reasoning_effort',
        value: 'high'
      });
    });

    it('routes model through the dedicated model request', async () => {
      const client = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      await codex.setConfigOption(client, 's1', 'model', 'gpt-test/high');
      expect(client.transport.sendRequest).toHaveBeenCalledWith('session/set_model', {
        sessionId: 's1',
        modelId: 'gpt-test/high'
      });
    });
  });

  describe('tool helpers', () => {
    it('extracts output from ACP content blocks and raw command output', () => {
      expect(codex.extractToolOutput({
        content: [{ type: 'content', content: { type: 'text', text: 'hello' } }]
      })).toBe('hello');

      expect(codex.extractToolOutput({
        rawOutput: { stdout: 'out', stderr: 'err' }
      })).toBe('out\nerr');
    });

    it('extracts file paths and diffs from standard ACP diff blocks', () => {
      const update = {
        content: [{ type: 'diff', path: 'src/app.js', oldText: 'old', newText: 'new' }]
      };

      expect(codex.extractFilePath(update, p => path.normalize(p))).toBe(path.normalize('src/app.js'));
      expect(codex.extractDiffFromToolCall(update, Diff)).toContain('src/app.js');
    });

    it('normalizes Codex MCP tool titles and categorizes UI shell calls', () => {
      const event = codex.normalizeTool(
        { type: 'tool_start', id: 't1', title: 'Tool: AcpUI/ux_invoke_shell' },
        {
          title: 'Tool: AcpUI/ux_invoke_shell',
          rawInput: { invocation: { server: 'AcpUI', tool: 'ux_invoke_shell', arguments: { command: 'npm test' } } }
        }
      );

      expect(event.toolName).toBe('ux_invoke_shell');
      expect(event.title).toBe('Run shell command: npm test');
      expect(codex.categorizeToolCall(event)).toEqual({ category: 'shell', isShellCommand: true });
    });

    it('normalizes legacy and MCP tool names correctly', () => {
      const toolStart = { type: 'tool_start', id: 't1' };

      // Case 1: shell_command -> shell
      const shellEvent = codex.normalizeTool(toolStart, {
        rawInput: { invocation: { server: 'mcp-server', tool: 'shell_command', arguments: { command: 'ls' } } }
      });
      expect(shellEvent.toolName).toBe('shell');
      expect(shellEvent.title).toBe('Run command: ls');

      // Case 2: apply_patch -> edit_file
      const editEvent = codex.normalizeTool(toolStart, {
        rawInput: { invocation: { server: 'mcp-server', tool: 'apply_patch', arguments: { path: 'file.txt' } } }
      });
      expect(editEvent.toolName).toBe('edit_file');
      expect(editEvent.title).toBe('Edit file: file.txt');

      // Case 3: MCP prefixed name
      const mcpEvent = codex.normalizeTool(toolStart, {
        rawInput: { invocation: { server: 'custom', tool: 'mcp__server__tool_name' } }
      });
      expect(mcpEvent.toolName).toBe('tool_name');
    });
  });

  describe('getMcpServerMeta', () => {
    it('returns undefined when acpSupportsMcpTimeouts is false', () => {
      mockConfig.acpSupportsMcpTimeouts = false;
      mockConfig.acpMcpStartupTimeoutSec = 30;
      mockConfig.acpMcpToolTimeoutSec = 3600;
      expect(codex.getMcpServerMeta()).toBeUndefined();
    });

    it('returns undefined when acpSupportsMcpTimeouts is missing', () => {
      delete mockConfig.acpSupportsMcpTimeouts;
      mockConfig.acpMcpStartupTimeoutSec = 30;
      mockConfig.acpMcpToolTimeoutSec = 3600;
      expect(codex.getMcpServerMeta()).toBeUndefined();
    });

    it('returns undefined when both timeout values are invalid', () => {
      mockConfig.acpSupportsMcpTimeouts = true;
      mockConfig.acpMcpStartupTimeoutSec = 0;
      mockConfig.acpMcpToolTimeoutSec = 'bad';
      expect(codex.getMcpServerMeta()).toBeUndefined();
    });

    it('returns codex_acp meta with both timeouts when both are valid', () => {
      mockConfig.acpSupportsMcpTimeouts = true;
      mockConfig.acpMcpStartupTimeoutSec = 30;
      mockConfig.acpMcpToolTimeoutSec = 3600;
      expect(codex.getMcpServerMeta()).toEqual({
        codex_acp: { startup_timeout_sec: 30, tool_timeout_sec: 3600 }
      });
    });

    it('omits startup_timeout_sec when only tool timeout is valid', () => {
      mockConfig.acpSupportsMcpTimeouts = true;
      mockConfig.acpMcpStartupTimeoutSec = -1;
      mockConfig.acpMcpToolTimeoutSec = 3600;
      expect(codex.getMcpServerMeta()).toEqual({
        codex_acp: { tool_timeout_sec: 3600 }
      });
    });

    it('omits tool_timeout_sec when only startup timeout is valid', () => {
      mockConfig.acpSupportsMcpTimeouts = true;
      mockConfig.acpMcpStartupTimeoutSec = 30;
      mockConfig.acpMcpToolTimeoutSec = undefined;
      expect(codex.getMcpServerMeta()).toEqual({
        codex_acp: { startup_timeout_sec: 30 }
      });
    });

    it('parses string integers correctly', () => {
      mockConfig.acpSupportsMcpTimeouts = true;
      mockConfig.acpMcpStartupTimeoutSec = '45';
      mockConfig.acpMcpToolTimeoutSec = '7200';
      expect(codex.getMcpServerMeta()).toEqual({
        codex_acp: { startup_timeout_sec: 45, tool_timeout_sec: 7200 }
      });
    });
  });

  describe('session file operations', () => {
    it('clones and prunes Codex rollout files recursively', () => {
      const oldId = '11111111-1111-1111-1111-111111111111';
      const newId = '22222222-2222-2222-2222-222222222222';
      const sessionDir = path.join(mockConfig.paths.sessions, '2026', '05', '01');
      fs.mkdirSync(sessionDir, { recursive: true });
      const rollout = path.join(sessionDir, `rollout-2026-05-01T01-02-03-${oldId}.jsonl`);
      fs.writeFileSync(rollout, [
        JSON.stringify({ type: 'session_meta', payload: { meta: { id: oldId } } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'one' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'answer one' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'two' } })
      ].join('\n'));
      const oldTasksDir = path.join(sessionDir, oldId);
      fs.mkdirSync(oldTasksDir, { recursive: true });
      fs.writeFileSync(path.join(oldTasksDir, 'task.json'), '{"ok":true}', 'utf8');

      codex.cloneSession(oldId, newId, 1);
      const newPath = codex.getSessionPaths(newId).jsonl;
      const cloned = fs.readFileSync(newPath, 'utf8');
      const newTasksDir = path.join(sessionDir, newId);

      expect(path.basename(newPath)).toContain(newId);
      expect(cloned).toContain(newId);
      expect(cloned).not.toContain(oldId);
      expect(cloned).toContain('answer one');
      expect(cloned).not.toContain('two');
      expect(fs.existsSync(path.join(newTasksDir, 'task.json'))).toBe(true);
    });

    it('prunes modern rollout turns from the next turn boundary', () => {
      const oldId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const newId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const sessionDir = path.join(mockConfig.paths.sessions, '2026', '05', '02');
      fs.mkdirSync(sessionDir, { recursive: true });
      const rollout = path.join(sessionDir, `rollout-2026-05-02T01-02-03-${oldId}.jsonl`);
      fs.writeFileSync(rollout, [
        JSON.stringify({ type: 'session_meta', payload: { id: oldId } }),
        JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Test id 123' }] }
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Test id 123' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Test id 123', phase: 'final_answer' }
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
        JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-2' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Test id 456' }] }
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Test id 456' } })
      ].join('\n'));

      codex.cloneSession(oldId, newId, 1);
      const newPath = codex.getSessionPaths(newId).jsonl;
      const cloned = fs.readFileSync(newPath, 'utf8');

      expect(cloned).toContain('turn-1');
      expect(cloned).not.toContain('turn-2');
      expect(cloned).toContain('Test id 123');
      expect(cloned).not.toContain('Test id 456');
    });

    it('parses Codex rollout history into AcpUI messages', async () => {
      const sessionDir = path.join(tempRoot, '.codex', 'sessions', '2026', '05', '01');
      fs.mkdirSync(sessionDir, { recursive: true });
      const rollout = path.join(sessionDir, 'rollout.jsonl');
      fs.writeFileSync(rollout, [
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'thinking' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'mcp_tool_call_begin', call_id: 't1', invocation: { server: 'AcpUI', tool: 'ux_invoke_shell', arguments: { command: 'pwd' } } } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'exec_command_end', call_id: 't1', stdout: 'done', exit_code: 0, locations: [{ path: 'root/dir' }] } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'I am thinking about it.', phase: 'commentary' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'finished' } })
      ].join('\n'));

      const messages = await codex.parseSessionHistory(rollout, Diff);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' });
      expect(messages[1].content).toBe('finished');
      expect(messages[1].timeline[0]).toMatchObject({ type: 'thought', content: 'thinking' });
      expect(messages[1].timeline[1].event).toMatchObject({
        id: 't1',
        toolName: 'ux_invoke_shell',
        status: 'completed',
        output: 'done',
        filePath: 'root/dir'
      });
      expect(messages[1].timeline[2]).toMatchObject({ type: 'thought', content: 'I am thinking about it.' });
    });

    it('parses modern Codex JSONL records and links tool completion by call_id', async () => {
      const sessionDir = path.join(mockConfig.paths.sessions, '2026', '05', '01');
      fs.mkdirSync(sessionDir, { recursive: true });
      const rollout = path.join(sessionDir, 'rollout-modern.jsonl');
      fs.writeFileSync(rollout, [
        JSON.stringify({ timestamp: '2026-05-01T00:00:00.000Z', type: 'session_meta', payload: { id: 's1' } }),
        JSON.stringify({ timestamp: '2026-05-01T00:00:00.010Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
        JSON.stringify({ timestamp: '2026-05-01T00:00:00.020Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
        JSON.stringify({ timestamp: '2026-05-01T00:00:00.030Z', type: 'event_msg', payload: { type: 'user_message', message: 'List files' } }),
        JSON.stringify({
          timestamp: '2026-05-01T00:00:00.040Z',
          type: 'response_item',
          payload: { type: 'reasoning', summary: [{ text: 'Checking workspace state.' }], encrypted_content: 'redacted' }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T00:00:00.050Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell_command',
            arguments: JSON.stringify({ command: 'rg --files', workdir: 'D:\\\\Git\\\\AcpUI' }),
            call_id: 'call-shell-1'
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T00:00:00.060Z',
          type: 'event_msg',
          payload: {
            type: 'exec_command_end',
            call_id: 'call-shell-1',
            aggregated_output: 'README.md\\nbackend\\\\server.js',
            exit_code: 0,
            status: 'completed'
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T00:00:00.070Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-shell-1',
            output: 'Exit code: 0\\nOutput:\\nREADME.md\\nbackend\\\\server.js'
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T00:00:00.080Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'I checked the files.', phase: 'commentary' }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T00:00:00.090Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Done listing files.', phase: 'final_answer' }
        })
      ].join('\n'));

      const messages = await codex.parseSessionHistory(rollout, Diff);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'List files' });
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Done listing files.' });
      expect(messages[1].timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'thought', content: 'Checking workspace state.' }),
        expect.objectContaining({ type: 'thought', content: 'I checked the files.' }),
        expect.objectContaining({
          type: 'tool',
          event: expect.objectContaining({
            id: 'call-shell-1',
            toolName: 'shell',
            status: 'completed'
          })
        })
      ]));
      const toolStep = messages[1].timeline.find(step => step.type === 'tool' && step.event.id === 'call-shell-1');
      expect(toolStep.event.output).toContain('README.md');
    });

    it('resets prior history on compacted records and keeps replacement user messages', async () => {
      const sessionDir = path.join(mockConfig.paths.sessions, '2026', '05', '01');
      fs.mkdirSync(sessionDir, { recursive: true });
      const rollout = path.join(sessionDir, 'rollout-compacted.jsonl');
      fs.writeFileSync(rollout, [
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Old question' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Old answer', phase: 'final_answer' } }),
        JSON.stringify({
          type: 'compacted',
          payload: {
            replacement_history: [
              { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Compacted prompt' }] },
              { type: 'compaction', encrypted_content: 'gAAAAA...' }
            ]
          }
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'New answer', phase: 'final_answer' } })
      ].join('\n'));

      const messages = await codex.parseSessionHistory(rollout, Diff);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Compacted prompt' });
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'New answer' });
    });
  });
});
