import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn()
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      this.models = { generateContent: mockGenerateContent };
    }
  }
}));

import { googleWebSearch } from '../services/ioMcp/googleWebSearch.js';
import { resetMcpConfigForTests } from '../services/mcpConfig.js';

function useMcpConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-mcp-config-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  vi.stubEnv('MCP_CONFIG', configPath);
  resetMcpConfigForTests();
}

describe('IO MCP googleWebSearch', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    resetMcpConfigForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMcpConfigForTests();
  });

  it('requires googleSearch.apiKey in MCP config', async () => {
    useMcpConfig({
      tools: { googleSearch: true },
      googleSearch: {
        apiKey: '',
        timeoutMs: 15000,
        maxOutputBytes: 1024
      }
    });

    await expect(googleWebSearch('query')).rejects.toThrow('googleSearch.apiKey');
  });

  it('returns a no-results message for empty response text', async () => {
    mockGenerateContent.mockResolvedValue({ text: '' });

    await expect(googleWebSearch('empty', { apiKey: 'test-key' }))
      .resolves.toBe('No search results or information found for query: "empty"');
  });

  it('formats grounded results with citations and sources', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'AcpUI supports MCP tools.',
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            { web: { title: 'Docs', uri: 'https://example.test/docs' } }
          ],
          groundingSupports: [
            { segment: { endIndex: 'AcpUI supports MCP tools'.length }, groundingChunkIndices: [0] }
          ]
        }
      }]
    });

    const result = await googleWebSearch('acpui mcp', { apiKey: 'test-key' });

    expect(result).toContain('Web search results for "acpui mcp"');
    expect(result).toContain('AcpUI supports MCP tools[1].');
    expect(result).toContain('Sources:');
    expect(result).toContain('[1] Docs (https://example.test/docs)');
  });

  it('wraps SDK failures with tool-specific context', async () => {
    mockGenerateContent.mockRejectedValue(new Error('service unavailable'));

    await expect(googleWebSearch('failure', { apiKey: 'test-key' }))
      .rejects.toThrow('Google Web Search failed: service unavailable');
  });

  it('reads the API key configured in mcp.json', async () => {
    useMcpConfig({
      tools: { googleSearch: true },
      googleSearch: {
        apiKey: 'configured-key',
        timeoutMs: 15000,
        maxOutputBytes: 1024
      }
    });
    mockGenerateContent.mockResolvedValue({ text: 'configured result' });

    await expect(googleWebSearch('configured key')).resolves.toContain('configured result');
  });

  it('aborts search requests when abortSignal is triggered', async () => {
    mockGenerateContent.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();

    const promise = googleWebSearch('abort me', {
      apiKey: 'test-key',
      timeoutMs: 10_000,
      abortSignal: controller.signal
    });
    controller.abort(new Error('request aborted'));

    await expect(promise).rejects.toThrow('Google Web Search failed: request aborted');
  });

  it('truncates oversized search output', async () => {
    mockGenerateContent.mockResolvedValue({ text: '1234567890' });

    const result = await googleWebSearch('large', { apiKey: 'test-key', maxOutputBytes: 8 });

    expect(result).toContain('[ux_google_web_search output truncated after 8 bytes');
  });
});
