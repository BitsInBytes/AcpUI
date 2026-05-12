import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getGoogleSearchMcpConfig,
  getIoMcpConfig,
  getMcpConfig,
  getWebFetchMcpConfig,
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

  it('normalizes IO, web fetch, and Google search settings', () => {
    writeTempConfig({
      tools: { io: true },
      io: {
        autoAllowWorkspaceCwd: true,
        allowedRoots: ['*', ' D:/Git/AcpUI '],
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
      }
    });

    expect(getIoMcpConfig()).toEqual({
      autoAllowWorkspaceCwd: true,
      allowedRoots: ['*', 'D:/Git/AcpUI'],
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
      timeoutMs: 48,
      maxOutputBytes: 49
    });
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
      timeoutMs: 48,
      maxOutputBytes: 49
    });
  });
});
