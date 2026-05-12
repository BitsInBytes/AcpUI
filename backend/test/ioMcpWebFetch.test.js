import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { webFetch } from '../services/ioMcp/webFetch.js';
import { resetMcpConfigForTests } from '../services/mcpConfig.js';

function mockResponse({ ok = true, status = 200, statusText = 'OK', contentType = 'text/plain', text = '', location = null, contentLength = null } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: {
      get: vi.fn(name => {
        const key = name.toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'location') return location;
        if (key === 'content-length') return contentLength;
        return null;
      })
    },
    text: vi.fn().mockResolvedValue(text)
  };
}

function useMcpConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-mcp-config-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({
    tools: { io: true },
    webFetch: {
      allowedProtocols: ['http:', 'https:'],
      blockedHosts: [],
      blockedHostPatterns: [],
      blockedCidrs: [],
      maxResponseBytes: 1024,
      timeoutMs: 15000,
      maxRedirects: 5,
      ...(overrides.webFetch || {})
    }
  }), 'utf8');
  vi.stubEnv('MCP_CONFIG', configPath);
  resetMcpConfigForTests();
}

describe('IO MCP webFetch', () => {
  beforeEach(() => {
    useMcpConfig();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMcpConfigForTests();
  });

  it('returns structured non-HTML text', async () => {
    global.fetch.mockResolvedValue(mockResponse({ text: 'plain text' }));

    await expect(webFetch('https://example.test/plain')).resolves.toEqual({
      type: 'web_fetch_result',
      url: 'https://example.test/plain',
      status: 200,
      contentType: 'text/plain',
      title: '',
      text: 'plain text'
    });
  });

  it('extracts structured normalized body text from HTML', async () => {
    global.fetch.mockResolvedValue(mockResponse({
      contentType: 'text/html',
      text: '<html><head><title>Example</title></head><body><h1>Hello</h1> <script>bad()</script><p>World</p></body></html>'
    }));

    await expect(webFetch('https://example.test/html')).resolves.toEqual({
      type: 'web_fetch_result',
      url: 'https://example.test/html',
      status: 200,
      contentType: 'text/html',
      title: 'Example',
      text: 'Hello World'
    });
  });

  it('throws for non-OK responses', async () => {
    global.fetch.mockResolvedValue(mockResponse({ ok: false, status: 404, statusText: 'Not Found' }));

    await expect(webFetch('https://example.test/missing')).rejects.toThrow('404 Not Found');
  });

  it('blocks configured hosts before fetching', async () => {
    useMcpConfig({ webFetch: { blockedHosts: ['example.test'] } });

    await expect(webFetch('https://example.test/blocked')).rejects.toThrow(/blocked/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('follows redirects through the configured policy checks', async () => {
    global.fetch
      .mockResolvedValueOnce(mockResponse({ status: 302, location: '/final' }))
      .mockResolvedValueOnce(mockResponse({ text: 'final text' }));

    await expect(webFetch('https://example.test/start')).resolves.toEqual(expect.objectContaining({
      url: 'https://example.test/final',
      text: 'final text'
    }));
  });

  it('enforces response size caps', async () => {
    useMcpConfig({ webFetch: { maxResponseBytes: 4 } });
    global.fetch.mockResolvedValue(mockResponse({ text: '12345' }));

    await expect(webFetch('https://example.test/large')).rejects.toThrow(/size cap/);
  });
});
