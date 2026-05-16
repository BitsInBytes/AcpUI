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
    process.env.ACP_SESSION_PROVIDER_ID = 'provider-a';
    process.env.ACP_UI_MCP_PROXY_ID = 'proxy-1';
    process.env.ACP_UI_MCP_PROXY_AUTH_TOKEN = 'proxy-auth-token';
    delete process.env.ACP_UI_ALLOW_INSECURE_MCP_PROXY_TLS;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  it('runs the proxy lifecycle', async () => {
    global.fetch.mockResolvedValue({
      json: () => Promise.resolve({ tools: [], serverName: 'test' })
    });
    
    await runProxy();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/mcp/tools?providerId=provider-a&proxyId=proxy-1'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-acpui-mcp-proxy-auth': 'proxy-auth-token' })
      })
    );
  });

  it('does not force-disable TLS verification by default', async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
    global.fetch.mockResolvedValue({
      json: () => Promise.resolve({ tools: [], serverName: 'test' })
    });

    await runProxy();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
  });

  it('handles fetch errors with retry', async () => {
    global.fetch
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ json: () => Promise.resolve({ tools: [], serverName: 'test' }) });
    
    await runProxy();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces actionable TLS trust errors without retrying', async () => {
    const certErr = new Error('self-signed certificate');
    certErr.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
    global.fetch.mockRejectedValueOnce(certErr);

    try {
      await runProxy();
      throw new Error('Expected runProxy to fail on TLS certificate error');
    } catch (err) {
      expect(String(err?.message || err)).toContain('TLS certificate verification failed');
      expect(String(err?.message || err)).toContain('SETUP.md');
    }

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('handles ListTools and CallTool requests', async () => {
    let listHandler, callHandler;
    vi.spyOn(sdk.Server.prototype, 'setRequestHandler').mockImplementation((schema, handler) => {
      if (schema === 'list_tools') listHandler = handler;
      if (schema === 'call_tool') callHandler = handler;
    });

    global.fetch.mockResolvedValue({
      json: () => Promise.resolve({
        tools: [{
          name: 't1',
          title: 'Tool One',
          description: 'test tool',
          inputSchema: {},
          annotations: { readOnlyHint: false },
          execution: { supportsAbort: true },
          outputSchema: { type: 'object' },
          _meta: { custom: true }
        }],
        serverName: 'test'
      })
    });

    await runProxy();
    
    if (listHandler) {
      const res = await listHandler();
      expect(res.tools).toHaveLength(1);
      expect(res.tools[0]).toEqual(expect.objectContaining({
        title: 'Tool One',
        description: 'test tool',
        annotations: { readOnlyHint: false },
        execution: { supportsAbort: true },
        outputSchema: { type: 'object' },
        _meta: { custom: true }
      }));
    }

    if (callHandler) {
      global.fetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true }) });
      const controller = new AbortController();
      const res = await callHandler({ params: { name: 't1', arguments: {}, _meta: { request: 'meta' } } }, { requestId: 42, signal: controller.signal });
      expect(res.ok).toBe(true);

      // Test with missing arguments
      await callHandler({ params: { name: 't1' } });
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/mcp/tool-call'), expect.objectContaining({
        body: expect.stringContaining('"args":{}')
      }));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/mcp/tool-call'), expect.objectContaining({
        body: expect.stringContaining('"providerId":"provider-a"')
      }));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/mcp/tool-call'), expect.objectContaining({
        body: expect.stringContaining('"proxyId":"proxy-1"')
      }));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/mcp/tool-call'), expect.objectContaining({
        body: expect.stringContaining('"mcpRequestId":42')
      }));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/mcp/tool-call'), expect.objectContaining({
        signal: controller.signal
      }));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/mcp/tool-call'), expect.objectContaining({
        headers: expect.objectContaining({ 'x-acpui-mcp-proxy-auth': 'proxy-auth-token' })
      }));
    }
  });

  it('throws error after max retries in backendFetch', async () => {
    global.fetch.mockRejectedValue(new Error('fatal'));
    await expect(runProxy()).rejects.toThrow('fatal');
  });

  it('does not retry when fetch throws an AbortError', async () => {
    const abortError = new Error('fetch was aborted');
    abortError.name = 'AbortError';
    // Second mock is intentionally absent — it must never be reached
    global.fetch.mockRejectedValueOnce(abortError);

    await expect(runProxy()).rejects.toThrow('fetch was aborted');
    // Retry logic must be bypassed: only one fetch attempt should have been made
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
