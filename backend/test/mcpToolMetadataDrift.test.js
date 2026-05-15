import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    id: 'provider-a',
    config: {
      mcpName: 'testmcp',
      models: {
        flagship: { id: 'test-model', displayName: 'Test Model' },
        subAgent: 'test-model'
      }
    }
  }),
  getProviderModule: vi.fn().mockResolvedValue({}),
  getProviderModuleSync: vi.fn().mockReturnValue({ getMcpServerMeta: () => undefined })
}));
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

import createMcpApiRoutes from '../routes/mcpApi.js';
import { createToolHandlers } from '../mcp/mcpServer.js';
import { getAdvertisedMcpToolDefinitions } from '../mcp/mcpToolMetadata.js';
import { mapBackendToolsToMcpListTools } from '../mcp/stdio-proxy.js';
import { ACP_UX_TOOL_NAMES } from '../services/tools/acpUxTools.js';
import { resetMcpConfigForTests } from '../services/mcpConfig.js';

const BASE_MCP_CONFIG = {
  tools: {
    invokeShell: true,
    subagents: true,
    counsel: true,
    io: true,
    googleSearch: true
  },
  googleSearch: {
    apiKey: 'configured-key',
    timeoutMs: 15000,
    maxOutputBytes: 262144
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
    },
    googleSearch: {
      ...BASE_MCP_CONFIG.googleSearch,
      ...(overrides.googleSearch || {})
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  vi.stubEnv('MCP_CONFIG', configPath);
  resetMcpConfigForTests();
}

function getRoute(router, method, routePath) {
  return router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]);
}

function getAdvertisedToolNamesFromRoute() {
  const router = createMcpApiRoutes({ emit: vi.fn(), to: vi.fn().mockReturnThis(), fetchSockets: vi.fn().mockResolvedValue([]) });
  const route = getRoute(router, 'get', '/tools');
  const res = { json: vi.fn() };
  route.route.stack[0].handle({}, res, vi.fn());
  return res.json.mock.calls[0][0].tools.map(tool => tool.name);
}

function extractFrontendToolNames() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const frontendPath = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'utils', 'acpUxTools.ts');
  const source = fs.readFileSync(frontendPath, 'utf8');
  const blockMatch = source.match(/export const ACP_UX_TOOL_NAMES = Object\.freeze\(\{([\s\S]*?)\}\);/);
  if (!blockMatch) throw new Error('Unable to locate frontend ACP_UX_TOOL_NAMES block');

  return [...blockMatch[1].matchAll(/:\s*'([^']+)'/g)].map(match => match[1]);
}

describe('mcp tool metadata drift checks', () => {
  beforeEach(() => {
    useMcpConfig();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMcpConfigForTests();
  });

  it('keeps advertised route tools in sync with registered handlers', () => {
    const advertisedNames = getAdvertisedToolNamesFromRoute();
    const handlers = createToolHandlers({ emit: vi.fn(), to: vi.fn().mockReturnThis(), fetchSockets: vi.fn().mockResolvedValue([]) });
    const handlerNames = Object.keys(handlers);

    expect(new Set(handlerNames)).toEqual(new Set(advertisedNames));
  });

  it('keeps stdio proxy schema mapping aligned with advertised tool metadata', () => {
    const advertisedTools = getAdvertisedMcpToolDefinitions({ modelDescription: 'Optional model id.' });
    const proxyTools = mapBackendToolsToMcpListTools(advertisedTools);

    expect(proxyTools).toHaveLength(advertisedTools.length);
    expect(proxyTools.map(tool => tool.name)).toEqual(advertisedTools.map(tool => tool.name));

    for (let i = 0; i < advertisedTools.length; i += 1) {
      const expected = advertisedTools[i];
      const actual = proxyTools[i];
      expect(actual.inputSchema).toEqual(expected.inputSchema);
      expect(actual.title).toBe(expected.title);
      expect(actual.annotations).toEqual(expected.annotations);
      expect(actual.execution).toEqual(expected.execution);
      expect(actual.outputSchema).toEqual(expected.outputSchema);
      expect(actual._meta).toEqual(expected._meta);
    }
  });

  it('keeps frontend and backend AcpUI tool-name registries aligned', () => {
    const frontendToolNames = extractFrontendToolNames();
    const backendToolNames = Object.values(ACP_UX_TOOL_NAMES);

    expect(new Set(frontendToolNames)).toEqual(new Set(backendToolNames));
  });
});
