import { describe, it, expect, vi } from 'vitest';

const mockHandlers = {};
vi.mock('../mcp/mcpServer.js', () => ({
  createToolHandlers: () => mockHandlers
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
        expect.objectContaining({ name: 'run_shell_command', inputSchema: expect.objectContaining({ type: 'object' }) }),
        expect.objectContaining({ name: 'invoke_sub_agents', inputSchema: expect.objectContaining({ type: 'object' }) }),
      ])
    }));
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
});
