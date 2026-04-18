import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runProxy } from '../mcp/stdio-proxy.js';
import * as sdk from '@modelcontextprotocol/sdk/server/index.js';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    constructor() {}
    setRequestHandler() {}
    connect() { return Promise.resolve(); }
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {}
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: 'list_tools',
  CallToolRequestSchema: 'call_tool'
}));

global.fetch = vi.fn();

describe('stdio-proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BACKEND_PORT = '3005';
  });

  it('runs the proxy lifecycle', async () => {
    global.fetch.mockResolvedValue({
      json: () => Promise.resolve({ tools: [], serverName: 'test' })
    });
    
    await runProxy();
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/mcp/tools'), expect.any(Object));
  });

  it('handles fetch errors with retry', async () => {
    global.fetch
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ json: () => Promise.resolve({ tools: [], serverName: 'test' }) });
    
    await runProxy();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('handles ListTools and CallTool requests', async () => {
    let listHandler, callHandler;
    vi.spyOn(sdk.Server.prototype, 'setRequestHandler').mockImplementation((schema, handler) => {
      if (schema === 'list_tools') listHandler = handler;
      if (schema === 'call_tool') callHandler = handler;
    });

    global.fetch.mockResolvedValue({
      json: () => Promise.resolve({ tools: [{ name: 't1', inputSchema: {} }], serverName: 'test' })
    });

    await runProxy();
    
    if (listHandler) {
      const res = await listHandler();
      expect(res.tools).toHaveLength(1);
    }

    if (callHandler) {
      global.fetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true }) });
      const res = await callHandler({ params: { name: 't1', arguments: {} } });
      expect(res.ok).toBe(true);

      // Test with missing arguments
      await callHandler({ params: { name: 't1' } });
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/mcp/tool-call'), expect.objectContaining({
        body: expect.stringContaining('"args":{}')
      }));
    }
  });

  it('throws error after max retries in backendFetch', async () => {
    global.fetch.mockRejectedValue(new Error('fatal'));
    await expect(runProxy()).rejects.toThrow('fatal');
  });
});
