import { beforeEach, describe, it, expect, vi } from 'vitest';

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

describe('MCP API Routes', () => {
  const io = { emit: vi.fn(), fetchSockets: vi.fn().mockResolvedValue([]) };
  const acpClient = null;

  beforeEach(() => {
    for (const key of Object.keys(mockHandlers)) delete mockHandlers[key];
    mockResolveMcpProxy.mockReset();
    mockResolveMcpProxy.mockReturnValue(null);
  });

  function getRoute(router, method, path) {
    return router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  }

  function mockReq(body = {}) {
    return { body, setTimeout: vi.fn(), socket: { setTimeout: vi.fn() } };
  }

  function mockRes() {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setTimeout: vi.fn() };
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
      ])
    }));
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

    expect(mockHandlers.good_tool).toHaveBeenCalledWith({ x: 1 });
    expect(res.json).toHaveBeenCalledWith(expected);
  });

  it('POST /tool-call passes resolved proxy context to handlers', async () => {
    const expected = { content: [{ type: 'text', text: 'done' }] };
    mockResolveMcpProxy.mockReturnValue({
      proxyId: 'proxy-1',
      providerId: 'provider-a',
      acpSessionId: 'acp-1'
    });
    mockHandlers.good_tool = vi.fn().mockResolvedValue(expected);

    const router = createMcpApiRoutes(io, acpClient);
    const route = getRoute(router, 'post', '/tool-call');
    const res = mockRes();
    await route.route.stack[0].handle(mockReq({
      tool: 'good_tool',
      args: { x: 1 },
      providerId: 'fallback-provider',
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
      requestMeta: { source: 'test' }
    });
    expect(res.json).toHaveBeenCalledWith(expected);
  });
});
