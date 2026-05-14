import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import EventEmitter from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockHandlers = {};
const { mockResolveMcpProxy } = vi.hoisted(() => ({
  mockResolveMcpProxy: vi.fn(() => null)
}));

vi.mock('../mcp/mcpServer.js', () => ({
  createToolHandlers: () => mockHandlers
}));
vi.mock('../mcp/mcpProxyRegistry.js', () => ({
  resolveMcpProxy: mockResolveMcpProxy
}));
vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({ config: { mcpName: 'testmcp', defaultSubAgentName: 'test-agent', defaultSystemAgentName: 'default', models: { flagship: { id: 'test-model', displayName: 'Test Model' }, subAgent: 'test-model' } } }),
  getProviderModule: vi.fn().mockResolvedValue({})
}));
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

import createMcpApiRoutes from '../routes/mcpApi.js';
import { resetMcpConfigForTests } from '../services/mcpConfig.js';

const DEFAULT_PROXY = {
  proxyId: 'proxy-1',
  providerId: 'provider-a',
  acpSessionId: 'acp-1',
  authToken: 'proxy-auth-token'
};

const BASE_MCP_CONFIG = {
  tools: {
    invokeShell: true,
    subagents: true,
    counsel: true,
    io: false,
    googleSearch: false
  }
};

function useMcpConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-mcp-config-'));
  const configPath = path.join(dir, 'mcp.json');
  const config = {
    ...BASE_MCP_CONFIG,
    ...overrides,
    tools: {
      ...BASE_MCP_CONFIG.tools,
      ...(overrides.tools || {})
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  vi.stubEnv('MCP_CONFIG', configPath);
  resetMcpConfigForTests();
  return configPath;
}

describe('MCP API Routes', () => {
  const io = { emit: vi.fn(), fetchSockets: vi.fn().mockResolvedValue([]) };
  const acpClient = null;

  beforeEach(() => {
    for (const key of Object.keys(mockHandlers)) delete mockHandlers[key];
    useMcpConfig();
    mockResolveMcpProxy.mockReset();
    mockResolveMcpProxy.mockReturnValue({ ...DEFAULT_PROXY });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMcpConfigForTests();
  });

  function getRoute(router, method, path) {
    return router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  }

  function mockReq(body = {}, { includeAuth = true, headers = {} } = {}) {
    const req = new EventEmitter();
    req.body = {
      proxyId: DEFAULT_PROXY.proxyId,
      providerId: DEFAULT_PROXY.providerId,
      ...body
    };
    const authHeader = includeAuth ? { 'x-acpui-mcp-proxy-auth': DEFAULT_PROXY.authToken } : {};
    req.headers = { ...authHeader, ...headers };
    req.get = vi.fn((name) => req.headers[(name || '').toLowerCase()]);
    req.setTimeout = vi.fn();
    req.socket = { setTimeout: vi.fn() };
    return req;
  }

  function mockRes() {
    const res = new EventEmitter();
    res.status = vi.fn().mockReturnThis();
    res.json = vi.fn(() => {
      res.writableEnded = true;
    });
    res.setTimeout = vi.fn();
    res.writableEnded = false;
    res.destroyed = false;
    return res;
  }

  it('GET /tools returns tool list with JSON Schema', () => {
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'testmcp',
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'ux_invoke_shell', inputSchema: expect.objectContaining({ type: 'object' }) }),
        expect.objectContaining({ name: 'ux_invoke_subagents', inputSchema: expect.objectContaining({ type: 'object' }) }),
        expect.objectContaining({ name: 'ux_invoke_counsel', inputSchema: expect.objectContaining({ type: 'object' }) }),
        expect.objectContaining({ name: 'ux_check_subagents', inputSchema: expect.objectContaining({ type: 'object' }) }),
        expect.objectContaining({ name: 'ux_abort_subagents', inputSchema: expect.objectContaining({ type: 'object' }) }),
      ])
    }));
  });

  it('GET /tools includes default-on core tools when flags are blank', () => {
    useMcpConfig();
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    const names = res.json.mock.calls[0][0].tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'ux_invoke_shell',
      'ux_invoke_subagents',
      'ux_invoke_counsel',
      'ux_check_subagents',
      'ux_abort_subagents'
    ]));
  });

  it('GET /tools describes sub-agent status and abort controls', () => {
    useMcpConfig();
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    const tools = res.json.mock.calls[0][0].tools;
    const checkTool = tools.find(tool => tool.name === 'ux_check_subagents');
    const abortTool = tools.find(tool => tool.name === 'ux_abort_subagents');

    expect(checkTool.annotations.title).toBe('Check Subagents');
    expect(checkTool.inputSchema.properties.waitForCompletion).toEqual(expect.objectContaining({
      type: 'boolean',
      default: true
    }));
    expect(abortTool.annotations).toEqual(expect.objectContaining({
      title: 'Abort Subagents',
      destructiveHint: true
    }));
  });

  it('GET /tools hides disabled core tools', () => {
    useMcpConfig({
      tools: {
        invokeShell: false,
        subagents: false,
        counsel: false,
        io: false,
        googleSearch: false
      }
    });
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    const names = res.json.mock.calls[0][0].tools.map(tool => tool.name);
    expect(names).not.toContain('ux_invoke_shell');
    expect(names).not.toContain('ux_invoke_subagents');
    expect(names).not.toContain('ux_invoke_counsel');
    expect(names).not.toContain('ux_check_subagents');
    expect(names).not.toContain('ux_abort_subagents');
  });

  it('GET /tools describes ux_invoke_shell as an interactive terminal-backed shell replacement', () => {
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    const tools = res.json.mock.calls[0][0].tools;
    const shellTool = tools.find(tool => tool.name === 'ux_invoke_shell');

    expect(shellTool.description).toContain('Always use this tool for shell commands');
    expect(shellTool.description).toContain('never use system shell, bash, or powershell tools');
    expect(shellTool.description).toContain('user-interactive stdin');
    expect(shellTool.description).toContain('Multiple ux_invoke_shell calls may be invoked concurrently');
    expect(shellTool.description).toContain('terminal becomes read-only after exit');
    expect(shellTool.inputSchema.properties.description.description).toContain('displayed to the user');
    expect(shellTool.inputSchema.required).toEqual(['description', 'command']);
    expect(shellTool.annotations).toEqual(expect.objectContaining({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }));
    expect(shellTool._meta).toEqual(expect.objectContaining({
      'acpui/concurrentInvocationsSupported': true
    }));
    expect(shellTool.description).not.toContain('only use non-interactive commands');
  });

  it('GET /tools hides optional IO and Google tools by default', () => {
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    const names = res.json.mock.calls[0][0].tools.map(tool => tool.name);
    expect(names).not.toContain('ux_read_file');
    expect(names).not.toContain('ux_web_fetch');
    expect(names).not.toContain('ux_google_web_search');
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('web_fetch');
    expect(names).not.toContain('google_web_search');
  });

  it('GET /tools advertises IO tools when MCP config enables them', () => {
    useMcpConfig({ tools: { io: true } });
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    const tools = res.json.mock.calls[0][0].tools;
    const names = tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'ux_read_file',
      'ux_write_file',
      'ux_replace',
      'ux_list_directory',
      'ux_glob',
      'ux_grep_search',
      'ux_web_fetch'
    ]));
    for (const oldName of ['read_file', 'write_file', 'replace', 'list_directory', 'glob', 'grep_search', 'web_fetch']) {
      expect(names).not.toContain(oldName);
    }

    const globTool = tools.find(tool => tool.name === 'ux_glob');
    const grepTool = tools.find(tool => tool.name === 'ux_grep_search');
    expect(globTool.inputSchema.properties.description.description).toContain('tool header');
    expect(grepTool.inputSchema.properties.description.description).toContain('tool header');
    expect(grepTool.inputSchema.properties.case_mode.enum).toEqual(['smart', 'sensitive', 'insensitive']);
    expect(grepTool.inputSchema.properties.result_mode.enum).toEqual(['matches', 'files', 'count']);
    expect(grepTool.inputSchema.properties.regex_engine.enum).toEqual(['default', 'pcre2', 'auto']);
    expect(grepTool.inputSchema.properties.include_globs.type).toBe('array');
    expect(grepTool.inputSchema.properties.exclude_globs.type).toBe('array');
    expect(grepTool.inputSchema.properties.file_types.type).toBe('array');
    expect(grepTool.inputSchema.additionalProperties).toBe(false);
    expect(grepTool.inputSchema.properties.case_sensitive).toBeDefined();
    expect(grepTool.inputSchema.properties.context).toBeDefined();
    expect(grepTool.inputSchema.properties.fixed_strings).toBeDefined();
  });

  it('GET /tools advertises Google search only when MCP config enables it', () => {
    useMcpConfig({ tools: { googleSearch: true }, googleSearch: { apiKey: 'configured-key' } });
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    const searchTool = res.json.mock.calls[0][0].tools.find(tool => tool.name === 'ux_google_web_search');
    expect(searchTool).toEqual(expect.objectContaining({
      name: 'ux_google_web_search',
      inputSchema: expect.objectContaining({
        required: ['query']
      })
    }));
    expect(searchTool.inputSchema.properties.api_key).toBeUndefined();
  });

  it('GET /tools does not advertise Google search when enabled without an MCP config API key', () => {
    useMcpConfig({ tools: { googleSearch: true }, googleSearch: { apiKey: '' } });
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'get', '/tools');
    const res = { json: vi.fn() };
    route.route.stack[0].handle({}, res, vi.fn());

    const names = res.json.mock.calls[0][0].tools.map(tool => tool.name);
    expect(names).not.toContain('ux_google_web_search');
  });

  it('POST /tool-call returns 404 for unknown tool', async () => {
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();
    await route.route.stack[0].handle(mockReq({ tool: 'nonexistent', args: {} }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('nonexistent') });
  });

  it('POST /tool-call returns error content when handler throws', async () => {
    mockHandlers.boom = vi.fn().mockRejectedValue(new Error('kaboom'));
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();
    await route.route.stack[0].handle(mockReq({ tool: 'boom', args: {} }), res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'Error: kaboom' }]
    });
  });

  it('POST /tool-call with valid tool returns result', async () => {
    const expected = { content: [{ type: 'text', text: 'done' }] };
    mockHandlers.good_tool = vi.fn().mockResolvedValue(expected);
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();
    await route.route.stack[0].handle(mockReq({ tool: 'good_tool', args: { x: 1 } }), res, vi.fn());

    expect(mockHandlers.good_tool).toHaveBeenCalledWith({
      x: 1,
      providerId: 'provider-a',
      acpSessionId: 'acp-1',
      mcpProxyId: 'proxy-1',
      abortSignal: expect.objectContaining({ aborted: false })
    });
    expect(res.json).toHaveBeenCalledWith(expected);
  });

  it('POST /tool-call passes resolved proxy context to handlers', async () => {
    const expected = { content: [{ type: 'text', text: 'done' }] };
    mockResolveMcpProxy.mockReturnValue({
      proxyId: 'proxy-1',
      providerId: 'provider-a',
      acpSessionId: 'acp-1',
      authToken: 'proxy-auth-token'
    });
    mockHandlers.good_tool = vi.fn().mockResolvedValue(expected);

    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();
    await route.route.stack[0].handle(mockReq({
      tool: 'good_tool',
      args: { x: 1 },
      providerId: 'provider-a',
      proxyId: 'proxy-1',
      mcpRequestId: 42,
      requestMeta: { source: 'test' }
    }), res, vi.fn());

    expect(mockResolveMcpProxy).toHaveBeenCalledWith('proxy-1');
    expect(mockHandlers.good_tool).toHaveBeenCalledWith({
      x: 1,
      providerId: 'provider-a',
      acpSessionId: 'acp-1',
      mcpProxyId: 'proxy-1',
      mcpRequestId: 42,
      requestMeta: { source: 'test' },
      abortSignal: expect.objectContaining({ aborted: false })
    });
    expect(res.json).toHaveBeenCalledWith(expected);
  });

  it('POST /tool-call rejects unauthenticated direct calls', async () => {
    mockHandlers.good_tool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();

    await route.route.stack[0].handle(
      mockReq({ tool: 'good_tool', args: { x: 1 } }, { includeAuth: false }),
      res,
      vi.fn()
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockHandlers.good_tool).not.toHaveBeenCalled();
  });

  it('POST /tool-call rejects unknown proxy ids', async () => {
    mockResolveMcpProxy.mockReturnValue(null);
    mockHandlers.good_tool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();

    await route.route.stack[0].handle(mockReq({ tool: 'good_tool', args: { x: 1 } }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockHandlers.good_tool).not.toHaveBeenCalled();
  });

  it('POST /tool-call rejects proxies missing session context', async () => {
    mockResolveMcpProxy.mockReturnValue({
      proxyId: 'proxy-1',
      providerId: 'provider-a',
      acpSessionId: null,
      authToken: 'proxy-auth-token'
    });
    mockHandlers.good_tool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();

    await route.route.stack[0].handle(mockReq({ tool: 'good_tool', args: { x: 1 } }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockHandlers.good_tool).not.toHaveBeenCalled();
  });

  it('POST /tool-call rejects fallback provider mismatches', async () => {
    mockHandlers.good_tool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();

    await route.route.stack[0].handle(
      mockReq({ tool: 'good_tool', args: { x: 1 }, providerId: 'provider-b' }),
      res,
      vi.fn()
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockHandlers.good_tool).not.toHaveBeenCalled();
  });

  it('POST /tool-call aborts the handler signal when the request fires the "aborted" event', async () => {
    mockHandlers.slow_tool = vi.fn(({ abortSignal }) => new Promise(resolve => {
      abortSignal.addEventListener('abort', () => {
        resolve({ content: [{ type: 'text', text: 'aborted' }] });
      });
    }));

    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const req = mockReq({ tool: 'slow_tool', args: { x: 1 } });
    const res = mockRes();
    const routePromise = route.route.stack[0].handle(req, res, vi.fn());

    await Promise.resolve();

    const abortSignal = mockHandlers.slow_tool.mock.calls[0][0].abortSignal;
    expect(abortSignal.aborted).toBe(false);

    req.emit('aborted');
    await routePromise;

    expect(abortSignal.aborted).toBe(true);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('POST /tool-call suppresses the error response when res.destroyed is true before the handler throws', async () => {
    mockHandlers.failing_tool = vi.fn().mockRejectedValue(new Error('kaboom'));
    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const req = mockReq({ tool: 'failing_tool', args: {} });
    const res = mockRes();
    res.destroyed = true; // simulate destroyed response before handler resolves

    await route.route.stack[0].handle(req, res, vi.fn());

    expect(res.json).not.toHaveBeenCalled();
  });

  it('POST /tool-call aborts the handler signal when the response closes before completion', async () => {
    mockHandlers.slow_tool = vi.fn(({ abortSignal }) => new Promise(resolve => {
      abortSignal.addEventListener('abort', () => {
        resolve({ content: [{ type: 'text', text: 'aborted' }] });
      });
    }));

    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const req = mockReq({ tool: 'slow_tool', args: { x: 1 } });
    const res = mockRes();
    const routePromise = route.route.stack[0].handle(req, res, vi.fn());

    await Promise.resolve();

    const abortSignal = mockHandlers.slow_tool.mock.calls[0][0].abortSignal;
    expect(abortSignal.aborted).toBe(false);

    res.emit('close');
    await routePromise;

    expect(abortSignal.aborted).toBe(true);
    expect(res.json).not.toHaveBeenCalled();
  });
});
