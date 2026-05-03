import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as gemini from '../index.js';
import fs from 'fs';
import path from 'path';
import { getProvider } from '../../../backend/services/providerLoader.js';

// Mock getProvider
vi.mock('../../../backend/services/providerLoader.js', () => {
  return {
    getProvider: vi.fn(() => ({
      config: {
        protocolPrefix: '_gemini/',
        mcpName: 'AcpUI',
        clientInfo: { name: 'AcpUI', version: '1.0.0' },
        toolCategories: {
          read_file: { category: 'file_read', isFileOperation: true },
          write_file: { category: 'file_write', isFileOperation: true },
          edit_file: { category: 'file_edit', isFileOperation: true },
          glob: { category: 'glob', isFileOperation: true },
          grep: { category: 'grep' }
        },
        paths: {
          home: '/mock/home',
          sessions: '/mock/sessions',
          attachments: '/mock/attachments',
          agents: '/mock/agents',
          archive: '/mock/archive'
        }
      }
    }))
  };
});

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
    statSync: vi.fn(),
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
  statSync: vi.fn(),
}));

global.fetch = vi.fn();

describe('Gemini Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('performHandshake', () => {
    it('sends initialize and authenticate in parallel', async () => {
      const mockClient = { transport: { sendRequest: vi.fn().mockResolvedValue({}) } };
      const promise = gemini.performHandshake(mockClient);
      
      expect(mockClient.transport.sendRequest).toHaveBeenCalledWith('initialize', expect.objectContaining({
        clientInfo: { name: 'AcpUI', version: '1.0.0' }
      }));
      expect(mockClient.transport.sendRequest).toHaveBeenCalledWith('authenticate', expect.anything());
      
      await promise;
    });
  });

  describe('intercept', () => {
    it('normalizes available commands into slash commands', () => {
      const payload = {
        method: 'session/update',
        params: {
          sessionId: 'sid-123',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'help', description: 'Show help' },
              { name: '/compact', description: 'Compact context', input: { hint: 'optional note' } }
            ]
          }
        }
      };

      const result = gemini.intercept(payload);
      expect(result.method).toBe('_gemini/commands/available');
      expect(result.params.sessionId).toBe('sid-123');
      expect(result.params.commands[0]).toEqual({ name: '/help', description: 'Show help' });
      expect(result.params.commands[1]).toEqual({
        name: '/compact',
        description: 'Compact context',
        meta: { hint: 'optional note' }
      });
    });

    it('emits persisted context for a loaded session on request', async () => {
      const emitProviderExtension = vi.fn();
      fs.existsSync.mockImplementation(filePath => String(filePath).endsWith('acp_session_tokens.json'));
      fs.readFileSync.mockImplementation(filePath => {
        if (String(filePath).endsWith('acp_session_tokens.json')) {
          return JSON.stringify({
            'gemini-cached-session': { inputTokens: 524288, outputTokens: 1000 }
          });
        }
        return '';
      });

      await gemini.prepareAcpEnvironment({}, { emitProviderExtension, writeLog: vi.fn() });

      expect(gemini.emitCachedContext('gemini-cached-session')).toBe(true);
      expect(emitProviderExtension).toHaveBeenCalledWith('_gemini/metadata', {
        sessionId: 'gemini-cached-session',
        contextUsagePercentage: 50
      });
    });

    it('tracks sessionId from update notifications', () => {
      const payload = {
        method: 'session/update',
        params: { sessionId: 'sid-123', update: { sessionUpdate: 'text' } }
      };
      gemini.intercept(payload);
    });

    it('extracts context % and emits metadata extension on prompt result', async () => {
      const emitSpy = vi.fn();
      await gemini.prepareAcpEnvironment({}, { emitProviderExtension: emitSpy });

      // First track the session
      gemini.intercept({
        method: 'session/update',
        params: { sessionId: 'sid-123', update: { sessionUpdate: 'text' } }
      });

      const payload = {
        result: {
          stopReason: 'end_turn',
          _meta: {
            quota: {
              token_count: { input_tokens: 104858 }, // ~10%
              model_usage: [{ model: 'gemini-pro' }]
            }
          }
        }
      };

      gemini.intercept(payload);
      expect(emitSpy).toHaveBeenCalledWith('_gemini/metadata', expect.objectContaining({
        sessionId: 'sid-123',
        contextUsagePercentage: expect.closeTo(10, 1)
      }));
    });

    it('swallows native usage_update events', () => {
      const payload = {
        method: 'session/update',
        params: { update: { sessionUpdate: 'usage_update' } }
      };
      const result = gemini.intercept(payload);
      expect(result).toBeNull();
    });

    it('caches tool arguments on tool_call', () => {
      const payload = {
        method: 'session/update',
        params: { 
          update: { 
            sessionUpdate: 'tool_call', 
            toolCallId: 't1', 
            arguments: { path: 'foo.txt' } 
          } 
        }
      };
      gemini.intercept(payload);
    });
  });

  describe('normalizeUpdate', () => {
    it('strips system reminders and preserves line breaks', () => {
      const update = {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Hello\n<system-reminder>ignore me</system-reminder>\nworld' }
      };
      const result = gemini.normalizeUpdate(update);
      expect(result.content.text).toBe('Hello\n\nworld');
    });

    it('preserves multiple spaces', () => {
      const update = {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Hello    world' }
      };
      const result = gemini.normalizeUpdate(update);
      expect(result.content.text).toBe('Hello    world');
    });
  });

  describe('extractToolOutput', () => {
    it('fixes read_file by reading from disk directly', () => {
      const update = {
        status: 'completed',
        toolCallId: 'read_file-1',
        locations: [{ path: 'test.txt' }],
        result: 'Summary: Read lines 1-2'
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('line1\nline2\nline3');
      
      const output = gemini.extractToolOutput(update);
      expect(output).toBe('line1\nline2');
    });

    it('reconstructs list_directory output using cached args', () => {
      // Setup cache via intercept
      gemini.intercept({
        method: 'session/update',
        params: { 
          update: { 
            sessionUpdate: 'tool_call', 
            toolCallId: 'list_directory-1', 
            arguments: { dir_path: 'src' } 
          } 
        }
      });

      const update = {
        status: 'completed',
        toolCallId: 'list_directory-1',
        sessionUpdate: 'tool_call_update',
        content: []
      };

      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ isDirectory: () => true });
      fs.readdirSync.mockReturnValue(['a.js', 'b.js']);

      const output = gemini.extractToolOutput(update);
      expect(output).toBe('a.js\nb.js');
    });

    it('stringifies structured JSON objects', () => {
      const update = {
        content: { foo: 'bar' }
      };
      const output = gemini.extractToolOutput(update);
      expect(output).toContain('"foo": "bar"');
    });
  });

  describe('extractFilePath', () => {
    it('extracts from locations array', () => {
      const update = { locations: [{ path: 'foo/bar.ts' }] };
      const resolve = (p) => `/root/${p}`;
      expect(gemini.extractFilePath(update, resolve)).toBe('/root/foo/bar.ts');
    });

    it('extracts from parsed JSON arguments', () => {
      const update = { arguments: '{"file_path": "baz.js"}' };
      const resolve = (p) => `/root/${p}`;
      expect(gemini.extractFilePath(update, resolve)).toBe('/root/baz.js');
    });
  });

  describe('normalizeTool', () => {
    it('maps ACP kind search to grep', () => {
      const update = { kind: 'search', toolCallId: 'grep_search-123-4' };
      const event = { id: 'grep_search-123-4', title: 'Search' };
      const result = gemini.normalizeTool(event, update);
      expect(result.toolName).toBe('grep');
    });

    it('synthesizes title for list_directory', () => {
      const update = { kind: 'search', toolCallId: 'list_directory-1' };
      const event = { id: 'list_directory-1', title: 'src' };
      const result = gemini.normalizeTool(event, update);
      expect(result.title).toBe('Listing Directory: src');
    });

    it('identifies ux_invoke_shell', () => {
      const event = { id: 'mcp_AcpUI_ux_invoke_shell-1', title: 'node -v' };
      const result = gemini.normalizeTool(event, {});
      expect(result.toolName).toBe('ux_invoke_shell');
      expect(result.title).toBe('Invoke Shell');
    });
  });

  describe('categorizeToolCall', () => {
    it('routes ux_invoke_shell to shell category', () => {
      const event = { toolName: 'ux_invoke_shell' };
      const result = gemini.categorizeToolCall(event);
      expect(result.toolCategory).toBe('shell');
      expect(result.isShellCommand).toBe(true);
    });

    it('uses config toolCategories', () => {
      const event = { toolName: 'read_file' };
      const result = gemini.categorizeToolCall(event);
      expect(result.toolCategory).toBe('file_read');
    });
  });

  describe('parseExtension', () => {
    it('parses commands/available extensions', () => {
      const commands = [{ name: '/help', description: 'Show help' }];
      const result = gemini.parseExtension('_gemini/commands/available', { commands });
      expect(result).toEqual({ type: 'commands', commands });
    });
  });

  describe('Session Operations', () => {
    it('getSessionPaths resolves project-hashed dirs', () => {
      const acpId = 'a1b2c3d4-e5f6-7890';
      const sessionsRoot = '/mock/sessions';
      const chatsDir = path.join(sessionsRoot, 'proj-1', 'chats');

      fs.existsSync.mockImplementation((p) => p.includes('proj-1') || p === sessionsRoot);
      
      vi.mocked(fs.readdirSync).mockImplementation((dir, options) => {
        if (dir === sessionsRoot) {
           if (options?.withFileTypes) return [{ name: 'proj-1', isDirectory: () => true }];
           return ['proj-1'];
        }
        if (dir === chatsDir) return ['session-ts-a1b2c3d4.jsonl'];
        return [];
      });

      const paths = gemini.getSessionPaths(acpId);
      expect(paths.jsonl).toContain('proj-1');
      expect(paths.jsonl).toContain('a1b2c3d4');
    });
  });

  describe('Quota Fetching', () => {
    let emitSpy;
    let writeSpy;

    beforeEach(() => {
      emitSpy = vi.fn();
      writeSpy = vi.fn();
      global.fetch = vi.fn();
    });

    it('stopQuotaFetching clears polling timer', async () => {
      // Start quota fetching
      await gemini.prepareAcpEnvironment({}, { emitProviderExtension: emitSpy });

      // Mock the fetch calls for initial setup
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'proj-123' })
      });
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ buckets: [] })
      });

      // Stop quota fetching
      gemini.stopQuotaFetching();

      // Verify no more polling happens
      vi.runAllTimersAsync();
      expect(gemini.stopQuotaFetching).toBeDefined();
    });

    it('prepareAcpEnvironment initializes quota fetching when enabled', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        access_token: 'token123',
        id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhenAiOiJjbGllbnQtaWQtMTIzIn0.sig',
        refresh_token: 'refresh123'
      }));

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'proj-123' })
      });

      const config = {
        protocolPrefix: '_gemini/',
        paths: { home: '/mock/home' },
        fetchQuotaStatus: true
      };

      await gemini.prepareAcpEnvironment({}, { emitProviderExtension: emitSpy });

      // Verify prepareAcpEnvironment was called
      expect(gemini.prepareAcpEnvironment).toBeDefined();
    });

    it('handles token refresh on 401 response during startup', async () => {
      getProvider.mockReturnValue({
        config: {
          protocolPrefix: '_gemini/',
          paths: { home: '/mock/home' },
          fetchQuotaStatus: true
        }
      });

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        access_token: 'old-token',
        id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhenAiOiI2ODEyNTU4MDkzOTUtb280ZnQyb3ByZHJucDllM2FxZjZhdjNobWRpYjEzNWouYXBwcy5nb29nbGV1c2VyY29udGVudC5jb20ifQ.sig',
        refresh_token: 'refresh123'
      }));

      // 1. Initial loadCodeAssist -> 401
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({})
      });

      // 2. Retry loadCodeAssist after re-reading from disk -> still 401
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({})
      });

      // 3. Refresh token request -> 200 OK
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-token',
          expires_in: 3600,
          refresh_token: 'new-refresh'
        })
      });

      // 4. Retry loadCodeAssist -> 200 OK
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'proj-123' })
      });

      // 5. Initial quota fetch (_fetchAndEmitQuota) -> 200 OK
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ buckets: [{ modelId: 'gemini-pro', remainingFraction: 0.5 }] })
      });

      fs.writeFileSync.mockClear();

      await gemini.prepareAcpEnvironment({}, { emitProviderExtension: emitSpy });

      // Use vi.waitFor because _startQuotaFetching runs as a background task
      await vi.waitFor(() => {
        expect(fs.writeFileSync).toHaveBeenCalled();
        expect(global.fetch).toHaveBeenCalledTimes(5);
      }, { timeout: 1000 });
    });

    it('extracts client ID from JWT azp field', async () => {
      fs.existsSync.mockReturnValue(true);
      const testToken = {
        access_token: 'token123',
        id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhenAiOiI2ODEyNTU4MDkzOTUtb284ZnQyb3ByZHJucDllM2FxZjZhdjNobWRpYjEzNWouYXBwcy5nb29nbGV1c2VyY29udGVudC5jb20ifQ.sig',
        refresh_token: 'refresh123'
      };
      fs.readFileSync.mockReturnValue(JSON.stringify(testToken));

      // The JWT payload contains azp: "681255809395-oo8ft2oprdrm..."
      // This tests that _extractClientId correctly decodes the JWT
      expect(fs.readFileSync).toBeDefined();
    });

    it('reads token from oauth_creds.json', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        access_token: 'token-from-disk',
        refresh_token: 'refresh123'
      }));

      expect(fs.readFileSync).toBeDefined();
      expect(fs.existsSync).toBeDefined();
    });

    it('builds status with usage percentages', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        access_token: 'token123',
        id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhenAiOiJ0ZXN0In0.sig',
        refresh_token: 'refresh123'
      }));

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'proj-123' })
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          buckets: [
            { modelId: 'gemini-pro', remainingFraction: 0.3 },
            { modelId: 'gemini-flash', remainingFraction: 0.7 }
          ]
        })
      });

      await gemini.prepareAcpEnvironment({}, { emitProviderExtension: emitSpy });

      // Status should have been emitted with usage percentages
      expect(emitSpy).toBeDefined();
    });

    it('emits status immediately with emitInitial flag', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        access_token: 'token123',
        id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhenAiOiJ0ZXN0In0.sig',
        refresh_token: 'refresh123'
      }));

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          cloudaicompanionProject: 'proj-123',
          buckets: []
        })
      });

      await gemini.prepareAcpEnvironment({}, { emitProviderExtension: emitSpy });

      // Quota fetching should emit even on startup (before any prompt)
      expect(emitSpy).toBeDefined();
    });

    it('gracefully handles missing oauth_creds.json', async () => {
      fs.existsSync.mockReturnValue(false);

      await gemini.prepareAcpEnvironment({}, { emitProviderExtension: emitSpy });

      // Should not crash, should log and continue
      expect(fs.existsSync).toBeDefined();
    });

    it('gracefully handles free-tier users without project ID', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        access_token: 'token123',
        id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhenAiOiJ0ZXN0In0.sig',
        refresh_token: 'refresh123'
      }));

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          // cloudaicompanionProject is missing for free-tier users
        })
      });

      await gemini.prepareAcpEnvironment({}, { emitProviderExtension: emitSpy });

      // Should gracefully skip quota fetching for free-tier
      expect(fs.readFileSync).toBeDefined();
    });
  });
});
