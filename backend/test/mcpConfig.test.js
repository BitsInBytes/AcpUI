import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getGoogleSearchMcpConfig,
  getIoMcpConfig,
  getMcpConfig,
  getSubagentsMcpConfig,
  getWebFetchMcpConfig,
  invalidateMcpConfigCache,
  isCounselMcpEnabled,
  isGoogleSearchMcpEnabled,
  isInvokeShellMcpEnabled,
  isIoMcpEnabled,
  isSubagentsMcpEnabled,
  resetMcpConfigForTests
} from '../services/mcpConfig.js';

function writeTempConfig(config, filename = 'mcp.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-mcp-config-'));
  const configPath = path.join(dir, filename);
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  vi.stubEnv('MCP_CONFIG', configPath);
  resetMcpConfigForTests();
  return configPath;
}

describe('MCP config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetMcpConfigForTests();
  });

  it('disables config-controlled tools when the config is missing', () => {
    vi.stubEnv('MCP_CONFIG', path.join(os.tmpdir(), `missing-mcp-${Date.now()}.json`));
    resetMcpConfigForTests();

    expect(getMcpConfig().loaded).toBe(false);
    expect(isInvokeShellMcpEnabled()).toBe(false);
    expect(isSubagentsMcpEnabled()).toBe(false);
    expect(isCounselMcpEnabled()).toBe(false);
    expect(isIoMcpEnabled()).toBe(false);
    expect(isGoogleSearchMcpEnabled()).toBe(false);
    expect(getSubagentsMcpConfig()).toEqual({
      statusWaitTimeoutMs: 120000,
      statusPollIntervalMs: 1000
    });
  });

  it('disables config-controlled tools when the config is malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-mcp-config-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, '{ bad json', 'utf8');
    vi.stubEnv('MCP_CONFIG', configPath);
    resetMcpConfigForTests();

    expect(getMcpConfig()).toEqual(expect.objectContaining({
      loaded: false,
      source: configPath
    }));
    expect(isInvokeShellMcpEnabled()).toBe(false);
    expect(isIoMcpEnabled()).toBe(false);
  });

  it('reads enabled tools from configuration/mcp.json shape', () => {
    writeTempConfig({
      tools: {
        invokeShell: { enabled: true },
        subagents: { enabled: false },
        counsel: { enabled: true },
        io: { enabled: true },
        googleSearch: { enabled: false }
      }
    });

    expect(isInvokeShellMcpEnabled()).toBe(true);
    expect(isSubagentsMcpEnabled()).toBe(false);
    expect(isCounselMcpEnabled()).toBe(true);
    expect(isIoMcpEnabled()).toBe(true);
    expect(isGoogleSearchMcpEnabled()).toBe(false);
  });

  it('reloads config after invalidateMcpConfigCache', () => {
    const configPath = writeTempConfig({
      tools: { invokeShell: false }
    });

    expect(isInvokeShellMcpEnabled()).toBe(false);

    fs.writeFileSync(configPath, JSON.stringify({ tools: { invokeShell: true } }), 'utf8');

    // Cache remains stale until explicit invalidation.
    expect(isInvokeShellMcpEnabled()).toBe(false);

    invalidateMcpConfigCache();
    expect(isInvokeShellMcpEnabled()).toBe(true);
  });

  it('normalizes IO, web fetch, Google search, and sub-agent status settings', () => {
    writeTempConfig({
      tools: { io: true },
      io: {
        autoAllowWorkspaceCwd: true,
        allowedRoots: ['*', ' D:/Git/AcpUI '],
        wildcardRootMode: 'warn',
        maxReadBytes: 42,
        maxWriteBytes: 43,
        maxReplaceBytes: 44,
        maxOutputBytes: 45
      },
      webFetch: {
        allowedProtocols: ['https:'],
        blockedHosts: ['localhost'],
        blockedHostPatterns: ['*.internal'],
        blockedCidrs: ['169.254.169.254/32'],
        maxResponseBytes: 46,
        timeoutMs: 47,
        maxRedirects: 3
      },
      googleSearch: {
        apiKey: 'configured-key',
        timeoutMs: 48,
        maxOutputBytes: 49
      },
      subagents: {
        statusWaitTimeoutMs: 50,
        statusPollIntervalMs: 51
      }
    });

    expect(getIoMcpConfig()).toEqual({
      autoAllowWorkspaceCwd: true,
      allowedRoots: ['*', 'D:/Git/AcpUI'],
      wildcardRootMode: 'warn',
      maxReadBytes: 42,
      maxWriteBytes: 43,
      maxReplaceBytes: 44,
      maxOutputBytes: 45
    });
    expect(getWebFetchMcpConfig()).toEqual({
      allowedProtocols: ['https:'],
      blockedHosts: ['localhost'],
      blockedHostPatterns: ['*.internal'],
      blockedCidrs: ['169.254.169.254/32'],
      maxResponseBytes: 46,
      timeoutMs: 47,
      maxRedirects: 3
    });
    expect(getGoogleSearchMcpConfig()).toEqual({
      apiKey: 'configured-key',
      apiKeyEnv: 'MCP_GOOGLE_SEARCH_API_KEY',
      timeoutMs: 48,
      maxOutputBytes: 49
    });
    expect(getSubagentsMcpConfig()).toEqual({
      statusWaitTimeoutMs: 50,
      statusPollIntervalMs: 51
    });
  });

  it('uses default sub-agent status settings when omitted or invalid', () => {
    writeTempConfig({
      tools: { subagents: true },
      subagents: {
        statusWaitTimeoutMs: 'invalid',
        statusPollIntervalMs: null
      }
    });

    expect(getSubagentsMcpConfig()).toEqual({
      statusWaitTimeoutMs: 120000,
      statusPollIntervalMs: 1000
    });
  });

  it('rejects wildcard roots when strict wildcard mode is enabled', () => {
    writeTempConfig({
      tools: { io: true },
      io: {
        allowedRoots: ['*'],
        wildcardRootMode: 'reject'
      }
    });

    expect(isIoMcpEnabled()).toBe(false);
    expect(getIoMcpConfig()).toEqual(expect.objectContaining({
      allowedRoots: ['*'],
      wildcardRootMode: 'reject'
    }));
  });

  it('uses Google search API key from environment when configured', () => {
    vi.stubEnv('MCP_GOOGLE_SEARCH_API_KEY', 'env-key');
    writeTempConfig({
      tools: { googleSearch: true },
      googleSearch: {
        apiKey: 'configured-key',
        apiKeyEnv: 'MCP_GOOGLE_SEARCH_API_KEY'
      }
    });

    expect(isGoogleSearchMcpEnabled()).toBe(true);
    expect(getGoogleSearchMcpConfig()).toEqual(expect.objectContaining({
      apiKey: 'env-key',
      apiKeyEnv: 'MCP_GOOGLE_SEARCH_API_KEY'
    }));
  });

  it('disables Google search when enabled without an MCP config API key', () => {
    writeTempConfig({
      tools: { googleSearch: true },
      googleSearch: {
        apiKey: '',
        timeoutMs: 48,
        maxOutputBytes: 49
      }
    });

    expect(isGoogleSearchMcpEnabled()).toBe(false);
    expect(getGoogleSearchMcpConfig()).toEqual({
      apiKey: '',
      apiKeyEnv: 'MCP_GOOGLE_SEARCH_API_KEY',
      timeoutMs: 48,
      maxOutputBytes: 49
    });
  });
});
