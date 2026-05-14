import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMcpServers, createToolHandlers, getMaxShellResultLines } from '../mcp/mcpServer.js';
import { clearMcpProxyRegistry, getMcpProxyIdFromServers, resolveMcpProxy } from '../mcp/mcpProxyRegistry.js';
import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';
import { loadCounselConfig } from '../services/counselConfig.js';
import { mcpExecutionRegistry, toolCallState } from '../services/tools/index.js';
import { resetMcpConfigForTests } from '../services/mcpConfig.js';
import EventEmitter from 'events';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

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

const { mockGoogleWebSearch } = vi.hoisted(() => ({
    mockGoogleWebSearch: vi.fn()
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
vi.mock('../services/ioMcp/googleWebSearch.js', () => ({
  googleWebSearch: mockGoogleWebSearch
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
    getAllSessions: vi.fn().mockResolvedValue([]),
    saveSession: vi.fn().mockResolvedValue(),
    deleteSession: vi.fn().mockResolvedValue(),
    getActiveSubAgentInvocationForParent: vi.fn().mockResolvedValue(null),
    createSubAgentInvocation: vi.fn().mockResolvedValue(),
    addSubAgentInvocationAgent: vi.fn().mockResolvedValue(),
    updateSubAgentInvocationStatus: vi.fn().mockResolvedValue(),
    updateSubAgentInvocationAgentStatus: vi.fn().mockResolvedValue(),
    getSubAgentInvocationWithAgents: vi.fn().mockResolvedValue(null),
    deleteSubAgentInvocationsForParent: vi.fn().mockResolvedValue()
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

const BASE_MCP_CONFIG = {
  tools: {
    invokeShell: true,
    subagents: true,
    counsel: true,
    io: false,
    googleSearch: false
  },
  io: {
    autoAllowWorkspaceCwd: true,
    allowedRoots: ['*'],
    maxReadBytes: 1048576,
    maxWriteBytes: 1048576,
    maxReplaceBytes: 1048576,
    maxOutputBytes: 262144
  },
  webFetch: {
    allowedProtocols: ['http:', 'https:'],
    blockedHosts: [],
    blockedHostPatterns: [],
    blockedCidrs: [],
    maxResponseBytes: 1048576,
    timeoutMs: 15000,
    maxRedirects: 5
  },
  googleSearch: {
    apiKey: '',
    timeoutMs: 15000,
    maxOutputBytes: 262144
  }
};

function useMcpConfig(overrides = {}) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'acpui-mcp-config-'));
  const configPath = path.join(dir, 'mcp.json');
  const config = {
    ...BASE_MCP_CONFIG,
    ...overrides,
    tools: {
      ...BASE_MCP_CONFIG.tools,
      ...(overrides.tools || {})
    },
    io: {
      ...BASE_MCP_CONFIG.io,
      ...(overrides.io || {})
    },
    webFetch: {
      ...BASE_MCP_CONFIG.webFetch,
      ...(overrides.webFetch || {})
    },
    googleSearch: {
      ...BASE_MCP_CONFIG.googleSearch,
      ...(overrides.googleSearch || {})
    }
  };
  fsSync.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  vi.stubEnv('MCP_CONFIG', configPath);
  resetMcpConfigForTests();
  return configPath;
}

describe('mcpServer', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    useMcpConfig();
    mockGetProvider.mockReturnValue(DEFAULT_PROVIDER_CONFIG);
    mockIo = new EventEmitter();
    mockIo.emit = vi.fn();
    mockIo.to = vi.fn().mockReturnThis();
    mockIo.fetchSockets = vi.fn().mockResolvedValue([]);

    mockAcpClient.sessionMetadata.clear();
    mockAcpClient.stream.statsCaptures.clear();
    mockAcpClient.transport.pendingRequests.clear();
    toolCallState.clear();
    mcpExecutionRegistry.clear();
    clearMcpProxyRegistry();
    mockShellRunManager.startPreparedRun.mockResolvedValue({ content: [{ type: 'text', text: 'shell done' }] });
    
    mockProviderModule.buildSessionParams.mockImplementation((agent) => agent
      ? { _meta: { 'agent-meta': { options: { agent } } } }
      : undefined
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetMcpConfigForTests();
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

  describe('core MCP feature flags', () => {
    it('registers core handlers when MCP config enables them', () => {
      useMcpConfig();

      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_invoke_shell).toBeTypeOf('function');
      expect(handlers.ux_invoke_subagents).toBeTypeOf('function');
      expect(handlers.ux_invoke_counsel).toBeTypeOf('function');
      expect(handlers.ux_check_subagents).toBeTypeOf('function');
      expect(handlers.ux_abort_subagents).toBeTypeOf('function');
    });

    it('omits invoke shell handler when MCP config disables it', () => {
      useMcpConfig({ tools: { invokeShell: false } });

      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_invoke_shell).toBeUndefined();
      expect(handlers.ux_invoke_subagents).toBeTypeOf('function');
      expect(handlers.ux_invoke_counsel).toBeTypeOf('function');
      expect(handlers.ux_check_subagents).toBeTypeOf('function');
      expect(handlers.ux_abort_subagents).toBeTypeOf('function');
    });

    it('omits subagents handler when MCP config disables it', () => {
      useMcpConfig({ tools: { subagents: false } });

      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_invoke_shell).toBeTypeOf('function');
      expect(handlers.ux_invoke_subagents).toBeUndefined();
      expect(handlers.ux_invoke_counsel).toBeTypeOf('function');
      expect(handlers.ux_check_subagents).toBeTypeOf('function');
      expect(handlers.ux_abort_subagents).toBeTypeOf('function');
    });

    it('omits counsel handler when MCP config disables it', () => {
      useMcpConfig({ tools: { counsel: false } });

      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_invoke_shell).toBeTypeOf('function');
      expect(handlers.ux_invoke_subagents).toBeTypeOf('function');
      expect(handlers.ux_invoke_counsel).toBeUndefined();
      expect(handlers.ux_check_subagents).toBeTypeOf('function');
      expect(handlers.ux_abort_subagents).toBeTypeOf('function');
    });

    it('omits sub-agent status handlers when subagents and counsel are disabled', () => {
      useMcpConfig({ tools: { subagents: false, counsel: false } });

      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_invoke_subagents).toBeUndefined();
      expect(handlers.ux_invoke_counsel).toBeUndefined();
      expect(handlers.ux_check_subagents).toBeUndefined();
      expect(handlers.ux_abort_subagents).toBeUndefined();
    });
  });

  describe('optional IO MCP tools', () => {
    it('does not register optional IO or Google handlers by default', () => {
      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_read_file).toBeUndefined();
      expect(handlers.ux_web_fetch).toBeUndefined();
      expect(handlers.ux_google_web_search).toBeUndefined();
      expect(handlers.read_file).toBeUndefined();
      expect(handlers.web_fetch).toBeUndefined();
      expect(handlers.google_web_search).toBeUndefined();
    });

    it('registers IO handlers when MCP config enables IO', () => {
      useMcpConfig({ tools: { io: true } });

      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_read_file).toBeTypeOf('function');
      expect(handlers.ux_write_file).toBeTypeOf('function');
      expect(handlers.ux_replace).toBeTypeOf('function');
      expect(handlers.ux_list_directory).toBeTypeOf('function');
      expect(handlers.ux_glob).toBeTypeOf('function');
      expect(handlers.ux_grep_search).toBeTypeOf('function');
      expect(handlers.ux_web_fetch).toBeTypeOf('function');
      expect(handlers.read_file).toBeUndefined();
    });

    it('uses glob description for cached tool headers', async () => {
      useMcpConfig({ tools: { io: true } });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpui-io-mcp-'));
      try {
        const filePath = path.join(tmpDir, 'example.txt');
        await fs.writeFile(filePath, 'hello', 'utf8');
        const handlers = createToolHandlers(mockIo);

        const result = await handlers.ux_glob({
          providerId: 'provider-a',
          acpSessionId: 'acp-1',
          requestMeta: { toolCallId: 'tool-glob-1' },
          description: 'Find text files',
          pattern: '*.txt',
          dir_path: tmpDir
        });

        expect(result.content[0].text).toContain(filePath);
        expect(mockIo.to).toHaveBeenCalledWith('session:acp-1');
        expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
          type: 'tool_update',
          id: 'tool-glob-1',
          canonicalName: 'ux_glob',
          isAcpUxTool: true,
          title: 'Glob: Find text files',
          titleSource: 'mcp_handler'
        }));
        expect(toolCallState.get('provider-a', 'acp-1', 'tool-glob-1')).toEqual(expect.objectContaining({
          identity: expect.objectContaining({ canonicalName: 'ux_glob', mcpToolName: 'ux_glob' }),
          input: expect.objectContaining({ description: 'Find text files', pattern: '*.txt' }),
          display: expect.objectContaining({ title: 'Glob: Find text files', titleSource: 'mcp_handler' })
        }));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('uses grep description for cached tool headers', async () => {
      useMcpConfig({ tools: { io: true } });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpui-io-mcp-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'grep.txt'), 'needle\n', 'utf8');
        const handlers = createToolHandlers(mockIo);

        const result = await handlers.ux_grep_search({
          providerId: 'provider-a',
          acpSessionId: 'acp-1',
          requestMeta: { toolCallId: 'tool-grep-1' },
          description: 'Find needles',
          pattern: 'needle',
          dir_path: tmpDir,
          fixed_strings: true
        });

        expect(result.content[0].text).toContain('needle');
        expect(toolCallState.get('provider-a', 'acp-1', 'tool-grep-1')).toEqual(expect.objectContaining({
          display: expect.objectContaining({ title: 'Search: Find needles', titleSource: 'mcp_handler' })
        }));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('maps advanced grep schema args into structured search results', async () => {
      useMcpConfig({ tools: { io: true } });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpui-io-mcp-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'grep.ts'), 'Needle\nneedle\nneedle\n', 'utf8');
        await fs.writeFile(path.join(tmpDir, 'grep.js'), 'needle\n', 'utf8');
        const handlers = createToolHandlers(mockIo);

        const result = await handlers.ux_grep_search({
          providerId: 'provider-a',
          acpSessionId: 'acp-1',
          requestMeta: { toolCallId: 'tool-grep-advanced' },
          pattern: 'needle',
          dir_path: tmpDir,
          fixed_strings: true,
          case_mode: 'insensitive',
          include_globs: ['**/*.ts'],
          max_matches: 1,
          result_mode: 'files'
        });

        const payload = JSON.parse(result.content[0].text);
        expect(payload).toEqual(expect.objectContaining({
          type: 'ux_grep_search_result',
          resultMode: 'files',
          matchCount: 1,
          files: [expect.stringContaining('grep.ts')],
          matches: []
        }));
        expect(payload.files[0]).not.toContain('grep.js');
        expect(toolCallState.get('provider-a', 'acp-1', 'tool-grep-advanced')).toEqual(expect.objectContaining({
          input: expect.objectContaining({
            case_mode: 'insensitive',
            include_globs: ['**/*.ts'],
            max_matches: 1,
            result_mode: 'files'
          })
        }));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('rejects unsupported grep options instead of silently ignoring them', async () => {
      useMcpConfig({ tools: { io: true } });
      const handlers = createToolHandlers(mockIo);

      await expect(handlers.ux_grep_search({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        requestMeta: { toolCallId: 'tool-grep-unsupported' },
        pattern: 'needle',
        rg_args: ['--hidden']
      })).rejects.toThrow(/unsupported option\(s\): rg_args/);
    });

    it('returns written content from write_file', async () => {
      useMcpConfig({ tools: { io: true } });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpui-io-mcp-'));
      try {
        const filePath = path.join(tmpDir, 'hello.ts');
        const handlers = createToolHandlers(mockIo);

        const result = await handlers.ux_write_file({
          providerId: 'provider-a',
          acpSessionId: 'acp-1',
          requestMeta: { toolCallId: 'tool-write-1' },
          file_path: filePath,
          content: 'export const hello = true;\n'
        });

        expect(result.content[0].text).toBe('export const hello = true;\n');
        await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('export const hello = true;\n');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns a diff from replace', async () => {
      useMcpConfig({ tools: { io: true } });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpui-io-mcp-'));
      try {
        const filePath = path.join(tmpDir, 'replace.ts');
        await fs.writeFile(filePath, 'const value = 1;\n', 'utf8');
        const handlers = createToolHandlers(mockIo);

        const result = await handlers.ux_replace({
          providerId: 'provider-a',
          acpSessionId: 'acp-1',
          requestMeta: { toolCallId: 'tool-replace-1' },
          file_path: filePath,
          old_string: 'const value = 1;',
          new_string: 'const value = 2;'
        });

        expect(result.content[0].text).toContain('Index:');
        expect(result.content[0].text).toContain('--- ');
        expect(result.content[0].text).toContain('+++ ');
        expect(result.content[0].text).toContain('-const value = 1;');
        expect(result.content[0].text).toContain('+const value = 2;');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('emits full directory path in list_directory title', async () => {
      useMcpConfig({ tools: { io: true } });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpui-io-mcp-'));
      try {
        const handlers = createToolHandlers(mockIo);

        await handlers.ux_list_directory({
          providerId: 'provider-a',
          acpSessionId: 'acp-1',
          requestMeta: { toolCallId: 'tool-list-1' },
          dir_path: tmpDir
        });

        expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
          id: 'tool-list-1',
          title: `List Directory: ${tmpDir}`,
          isAcpUxTool: true,
          titleSource: 'mcp_handler'
        }));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('emits fetch URL title and structured web_fetch output', async () => {
      useMcpConfig({ tools: { io: true } });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: vi.fn(() => 'text/html') },
        text: vi.fn().mockResolvedValue('<html><head><title>Docs</title></head><body><h1>Hello</h1></body></html>')
      }));
      const handlers = createToolHandlers(mockIo);

      const result = await handlers.ux_web_fetch({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        requestMeta: { toolCallId: 'tool-fetch-1' },
        url: 'https://example.test/docs'
      });

      expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        id: 'tool-fetch-1',
        title: 'Fetch: https://example.test/docs',
        isAcpUxTool: true,
        titleSource: 'mcp_handler'
      }));
      expect(JSON.parse(result.content[0].text)).toEqual(expect.objectContaining({
        type: 'web_fetch_result',
        url: 'https://example.test/docs',
        title: 'Docs',
        text: 'Hello'
      }));
    });

    it('registers Google search handler when MCP config enables Google search', () => {
      useMcpConfig({ tools: { googleSearch: true }, googleSearch: { apiKey: 'configured-key' } });

      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_google_web_search).toBeTypeOf('function');
      expect(handlers.google_web_search).toBeUndefined();
    });

    it('does not register Google search handler when enabled without an MCP config API key', () => {
      useMcpConfig({ tools: { googleSearch: true }, googleSearch: { apiKey: '' } });

      const handlers = createToolHandlers(mockIo);

      expect(handlers.ux_google_web_search).toBeUndefined();
    });

    it('emits web search query title for google_web_search', async () => {
      useMcpConfig({ tools: { googleSearch: true }, googleSearch: { apiKey: 'configured-key' } });
      mockGoogleWebSearch.mockResolvedValue('search result');
      const handlers = createToolHandlers(mockIo);

      const result = await handlers.ux_google_web_search({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        requestMeta: { toolCallId: 'tool-search-1' },
        query: 'latest docs'
      });

      expect(result.content[0].text).toBe('search result');
      expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        id: 'tool-search-1',
        title: 'Web Search: latest docs',
        isAcpUxTool: true,
        titleSource: 'mcp_handler'
      }));
    });

    it('passes abortSignal into google web search handler calls', async () => {
      useMcpConfig({ tools: { googleSearch: true }, googleSearch: { apiKey: 'configured-key' } });
      mockGoogleWebSearch.mockResolvedValue('search result');
      const handlers = createToolHandlers(mockIo);
      const controller = new AbortController();

      await handlers.ux_google_web_search({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        requestMeta: { toolCallId: 'tool-search-2' },
        query: 'abortable search',
        abortSignal: controller.signal
      });

      expect(mockGoogleWebSearch).toHaveBeenCalledWith('abortable search', { abortSignal: controller.signal });
    });
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
        isAcpUxTool: true,
        title: 'Invoke Shell: Run test suite'
      }));
      expect(toolCallState.get('provider-a', 'acp-1', 'tool-1')).toEqual(expect.objectContaining({
        identity: expect.objectContaining({ canonicalName: 'ux_invoke_shell', mcpServer: 'TestUI' }),
        input: expect.objectContaining({ description: 'Run test suite', command: 'npm test', cwd: 'D:/repo' }),
        display: expect.objectContaining({ title: 'Invoke Shell: Run test suite', titleSource: 'mcp_handler' })
      }));
    });

    it('passes abortSignal to shellRunManager when provided', async () => {
      const handlers = createToolHandlers(mockIo);
      const controller = new AbortController();

      await handlers.ux_invoke_shell({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        mcpRequestId: 43,
        requestMeta: { toolCallId: 'tool-2' },
        description: 'Abortable shell',
        command: 'npm test',
        cwd: 'D:/repo',
        abortSignal: controller.signal
      });

      expect(mockShellRunManager.startPreparedRun).toHaveBeenCalledWith(expect.objectContaining({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        toolCallId: 'tool-2',
        abortSignal: controller.signal
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

    it('falls back to default MCP server name when provider lookup fails while caching metadata', async () => {
      mockGetProvider.mockImplementation(() => {
        throw new Error('missing provider');
      });
      const handlers = createToolHandlers(mockIo);

      await handlers.ux_invoke_shell({
        providerId: 'provider-a',
        acpSessionId: 'acp-1',
        requestMeta: { toolCallId: 'tool-1' },
        description: 'List files',
        command: 'ls'
      });

      expect(mockIo.to).toHaveBeenCalledWith('session:acp-1');
      expect(mockIo.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
        mcpServer: 'AcpUI'
      }));
    });
  });

  describe('ux_check_subagents and ux_abort_subagents', () => {
    it('waits by default and supports immediate status checks', async () => {
      useMcpConfig();
      const handlers = createToolHandlers(mockIo);
      const spy = vi.spyOn(subAgentInvocationManager, 'getInvocationStatus')
        .mockResolvedValue({ content: [{ type: 'text', text: 'status' }] });

      try {
        await handlers.ux_check_subagents({ providerId: 'provider-a', invocationId: 'inv-1' });
        expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
          providerId: 'provider-a',
          invocationId: 'inv-1',
          waitTimeoutMs: 120000,
          pollIntervalMs: 1000
        }));

        await handlers.ux_check_subagents({ providerId: 'provider-a', invocationId: 'inv-1', waitForCompletion: false });
        expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
          providerId: 'provider-a',
          invocationId: 'inv-1',
          waitTimeoutMs: 0,
          pollIntervalMs: 1000
        }));
      } finally {
        spy.mockRestore();
      }
    });

    it('aborts the invocation and returns an immediate status payload', async () => {
      useMcpConfig();
      const handlers = createToolHandlers(mockIo);
      const cancelSpy = vi.spyOn(subAgentInvocationManager, 'cancelInvocation').mockResolvedValue();
      const statusSpy = vi.spyOn(subAgentInvocationManager, 'getInvocationStatus')
        .mockResolvedValue({ content: [{ type: 'text', text: 'aborted status' }] });

      try {
        const result = await handlers.ux_abort_subagents({ providerId: 'provider-a', invocationId: 'inv-1' });

        expect(cancelSpy).toHaveBeenCalledWith('provider-a', 'inv-1');
        expect(statusSpy).toHaveBeenCalledWith(expect.objectContaining({
          providerId: 'provider-a',
          invocationId: 'inv-1',
          waitTimeoutMs: 0,
          pollIntervalMs: 1000
        }));
        expect(result.content[0].text).toBe('aborted status');
      } finally {
        cancelSpy.mockRestore();
        statusSpy.mockRestore();
      }
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

    it('passes abortSignal through to the sub-agent invocation manager', async () => {
      const handlers = createToolHandlers(mockIo);
      const controller = new AbortController();
      const spy = vi.spyOn(subAgentInvocationManager, 'runInvocation')
        .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      try {
        await handlers.ux_invoke_subagents({
          requests: [{ prompt: 'Do thing' }],
          providerId: 'provider-a',
          acpSessionId: 'parent-acp',
          abortSignal: controller.signal
        });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
          requests: [{ prompt: 'Do thing' }],
          providerId: 'provider-a',
          parentAcpSessionId: 'parent-acp',
          abortSignal: controller.signal
        }));
      } finally {
        spy.mockRestore();
      }
    });

    it('starts sub-agents asynchronously and returns status instructions', async () => {
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

      expect(result.content[0].text).toContain('Sub-agents have been started asynchronously');
      expect(result.content[0].text).toContain('ux_check_subagents');
    });

    it('deduplicates repeated MCP request ids for the same parent session', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'dedupe-sub-acp';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') {
          const meta = mockAcpClient.sessionMetadata.get(subId);
          if (meta) meta.lastResponseBuffer = 'Deduped response';
          return {};
        }
        return {};
      });

      vi.useFakeTimers();
      const args = {
        requests: [{ name: 'Agent 1', prompt: 'Do thing', agent: 'dev' }],
        providerId: 'provider-a',
        acpSessionId: 'parent-acp-dedupe',
        mcpRequestId: 42
      };
      const first = handlers.ux_invoke_subagents(args);
      const second = handlers.ux_invoke_subagents(args);
      await vi.runAllTimersAsync();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      vi.useRealTimers();

      expect(firstResult.content[0].text).toContain('ux_check_subagents');
      expect(secondResult.content[0].text).toContain('ux_check_subagents');
      expect(mockAcpClient.transport.sendRequest.mock.calls.filter(call => call[0] === 'session/new')).toHaveLength(1);
    });

    it('deduplicates by tool call metadata when MCP request id is absent', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'dedupe-meta-sub-acp';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') {
          const meta = mockAcpClient.sessionMetadata.get(subId);
          if (meta) meta.lastResponseBuffer = 'Metadata deduped response';
          return {};
        }
        return {};
      });

      vi.useFakeTimers();
      const args = {
        requests: [{ name: 'Agent 1', prompt: 'Do thing', agent: 'dev' }],
        providerId: 'provider-a',
        acpSessionId: 'parent-acp-dedupe',
        requestMeta: { tool_call_id: 'tool-call-123' }
      };
      const first = handlers.ux_invoke_subagents(args);
      const second = handlers.ux_invoke_subagents(args);
      await vi.runAllTimersAsync();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      vi.useRealTimers();

      expect(firstResult.content[0].text).toContain('ux_check_subagents');
      expect(secondResult.content[0].text).toContain('ux_check_subagents');
      expect(mockAcpClient.transport.sendRequest.mock.calls.filter(call => call[0] === 'session/new')).toHaveLength(1);
    });

    it('deduplicates by scoped input fingerprint when request ids are absent', async () => {
      const handlers = createToolHandlers(mockIo);
      const subId = 'dedupe-fingerprint-sub-acp';

      mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
        if (method === 'session/new') return { sessionId: subId };
        if (method === 'session/prompt') {
          const meta = mockAcpClient.sessionMetadata.get(subId);
          if (meta) meta.lastResponseBuffer = 'Fingerprint deduped response';
          return {};
        }
        return {};
      });

      vi.useFakeTimers();
      const args = {
        requests: [{ name: 'Agent 1', prompt: 'Do thing', agent: 'dev', cwd: 'D:/Git/AcpUI' }],
        model: 's',
        providerId: 'provider-a',
        acpSessionId: 'parent-acp-dedupe'
      };
      const first = handlers.ux_invoke_subagents(args);
      const second = handlers.ux_invoke_subagents({
        ...args,
        requests: [{ cwd: 'D:/Git/AcpUI', agent: 'dev', prompt: 'Do thing', name: 'Agent 1' }]
      });
      await vi.runAllTimersAsync();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      vi.useRealTimers();

      expect(firstResult.content[0].text).toContain('ux_check_subagents');
      expect(secondResult.content[0].text).toContain('ux_check_subagents');
      expect(mockAcpClient.transport.sendRequest.mock.calls.filter(call => call[0] === 'session/new')).toHaveLength(1);
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

      // sub_agents_starting is emitted after registry setup but before stagger timers fire.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
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
      expect(result.content[0].text).toContain('ux_check_subagents');
      expect(result.content[0].text).toContain('failed');
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
      expect(result.content[0].text).toContain('ux_check_subagents');
      expect(mockIo.emit).toHaveBeenCalledWith('sub_agent_completed', expect.objectContaining({
        status: 'failed',
        error: 'Aborted'
      }));
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

    it('prefers MCP session context over stale parent tracking', async () => {
      const { getSessionByAcpId } = await import('../database.js');
      vi.mocked(getSessionByAcpId).mockResolvedValueOnce({ id: 'parent-ui-explicit' });
      mockAcpClient.lastSubAgentParentAcpId = 'stale-parent-acp';

      const handlers = createToolHandlers(mockIo);
      await handlers.ux_invoke_subagents({
        requests: [{ prompt: 'hi' }],
        providerId: 'provider-a',
        acpSessionId: 'explicit-parent-acp',
        mcpRequestId: 99
      });

      expect(getSessionByAcpId).toHaveBeenCalledWith('provider-a', 'explicit-parent-acp');
      expect(getSessionByAcpId).not.toHaveBeenCalledWith('provider-a', 'stale-parent-acp');
      expect(mockIo.emit).toHaveBeenCalledWith('sub_agents_starting', expect.objectContaining({
        parentUiId: 'parent-ui-explicit'
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
      vi.mocked(loadCounselConfig).mockReturnValueOnce({ core: [], optional: {} });
      const handlers = createToolHandlers(mockIo);
      const result = await handlers.ux_invoke_counsel({ question: 'What to do?' });
      expect(result.content[0].text).toContain('Error: No counsel agents configured');
    });

    it('runs counsel through the sub-agent invocation pipeline when the subagents tool is hidden', async () => {
      useMcpConfig({ tools: { subagents: false } });
      vi.mocked(loadCounselConfig).mockReturnValueOnce({
        core: [{ name: 'Advocate', prompt: 'argue for' }],
        optional: { security: { name: 'Security', prompt: 'evaluate security' } }
      });
      const spy = vi.spyOn(subAgentInvocationManager, 'runInvocation')
        .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const handlers = createToolHandlers(mockIo);

      try {
        expect(handlers.ux_invoke_subagents).toBeUndefined();
        await handlers.ux_invoke_counsel({
          question: 'help',
          security: true,
          providerId: 'provider-a',
          acpSessionId: 'parent-acp'
        });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
          providerId: 'provider-a',
          parentAcpSessionId: 'parent-acp',
          requests: [
            expect.objectContaining({ name: 'Advocate', prompt: expect.stringContaining('help') }),
            expect.objectContaining({ name: 'Security', prompt: expect.stringContaining('help') })
          ]
        }));
      } finally {
        spy.mockRestore();
      }
    });
  });
});
