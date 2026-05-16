import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = 'configuration/mcp.json';
const DEFAULT_GOOGLE_SEARCH_API_KEY_ENV = 'MCP_GOOGLE_SEARCH_API_KEY';
const WILDCARD_ROOT_MODES = new Set(['warn', 'reject']);

let cachedConfig = null;

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function boolSetting(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && typeof value.enabled === 'boolean') return value.enabled;
  return fallback;
}

function numberSetting(value, fallback, { allowZero = false } = {}) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : fallback;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : [];
}

function stringSetting(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function wildcardRootModeSetting(value) {
  const normalized = stringSetting(value, 'warn').toLowerCase();
  return WILDCARD_ROOT_MODES.has(normalized) ? normalized : 'warn';
}

function disabledConfig(source, reason) {
  return {
    source,
    loaded: false,
    reason,
    tools: {
      invokeShell: false,
      subagents: false,
      counsel: false,
      io: false,
      googleSearch: false
    },
    io: {
      autoAllowWorkspaceCwd: false,
      allowedRoots: [],
      wildcardRootMode: 'warn',
      maxReadBytes: 1048576,
      maxWriteBytes: 1048576,
      maxReplaceBytes: 1048576,
      maxOutputBytes: 262144
    },
    webFetch: {
      allowedProtocols: ['http:', 'https:'],
      blockedHosts: [],
      blockedHostPatterns: [],
      blockedCidrs: [],
      maxResponseBytes: 1048576,
      timeoutMs: 15000,
      maxRedirects: 5
    },
    googleSearch: {
      apiKey: '',
      apiKeyEnv: DEFAULT_GOOGLE_SEARCH_API_KEY_ENV,
      timeoutMs: 15000,
      maxOutputBytes: 262144
    },
    subagents: {
      statusWaitTimeoutMs: 120000,
      statusPollIntervalMs: 1000
    }
  };
}

function normalizeMcpConfig(raw, source, env = process.env) {
  const tools = raw?.tools || {};
  const io = raw?.io || {};
  const webFetch = raw?.webFetch || {};
  const googleSearch = raw?.googleSearch || {};
  const subagents = raw?.subagents || {};

  const requestedIo = boolSetting(tools.io);
  const allowedRoots = stringArray(io.allowedRoots);
  const wildcardRootMode = wildcardRootModeSetting(io.wildcardRootMode);
  const hasWildcardRoot = allowedRoots.includes('*');
  const ioEnabled = requestedIo && !(hasWildcardRoot && wildcardRootMode === 'reject');

  const googleSearchApiKeyEnv = stringSetting(googleSearch.apiKeyEnv, DEFAULT_GOOGLE_SEARCH_API_KEY_ENV);
  const envGoogleSearchApiKey = stringSetting(env?.[googleSearchApiKeyEnv], '');
  const configGoogleSearchApiKey = stringSetting(googleSearch.apiKey, '');
  const googleSearchApiKey = envGoogleSearchApiKey || configGoogleSearchApiKey;
  const requestedGoogleSearch = boolSetting(tools.googleSearch);

  return {
    source,
    loaded: true,
    tools: {
      invokeShell: boolSetting(tools.invokeShell),
      subagents: boolSetting(tools.subagents),
      counsel: boolSetting(tools.counsel),
      io: ioEnabled,
      googleSearch: requestedGoogleSearch && Boolean(googleSearchApiKey)
    },
    io: {
      autoAllowWorkspaceCwd: boolSetting(io.autoAllowWorkspaceCwd),
      allowedRoots,
      wildcardRootMode,
      maxReadBytes: numberSetting(io.maxReadBytes, 1048576),
      maxWriteBytes: numberSetting(io.maxWriteBytes, 1048576),
      maxReplaceBytes: numberSetting(io.maxReplaceBytes, 1048576),
      maxOutputBytes: numberSetting(io.maxOutputBytes, 262144)
    },
    webFetch: {
      allowedProtocols: stringArray(webFetch.allowedProtocols).length
        ? stringArray(webFetch.allowedProtocols)
        : ['http:', 'https:'],
      blockedHosts: stringArray(webFetch.blockedHosts),
      blockedHostPatterns: stringArray(webFetch.blockedHostPatterns),
      blockedCidrs: stringArray(webFetch.blockedCidrs),
      maxResponseBytes: numberSetting(webFetch.maxResponseBytes, 1048576),
      timeoutMs: numberSetting(webFetch.timeoutMs, 15000),
      maxRedirects: numberSetting(webFetch.maxRedirects, 5, { allowZero: true })
    },
    googleSearch: {
      apiKey: googleSearchApiKey,
      apiKeyEnv: googleSearchApiKeyEnv,
      timeoutMs: numberSetting(googleSearch.timeoutMs, 15000),
      maxOutputBytes: numberSetting(googleSearch.maxOutputBytes, 262144)
    },
    subagents: {
      statusWaitTimeoutMs: numberSetting(subagents.statusWaitTimeoutMs, 120000),
      statusPollIntervalMs: numberSetting(subagents.statusPollIntervalMs, 1000)
    }
  };
}

function buildMcpConfig(env = process.env) {
  const configPath = env.MCP_CONFIG || DEFAULT_CONFIG_PATH;
  const resolvedPath = repoPath(configPath);

  try {
    const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    const config = normalizeMcpConfig(raw, resolvedPath, env);
    writeLog(`[MCP CONFIG] Loaded MCP config from ${resolvedPath}`);

    if (boolSetting(raw?.tools?.io) && config.io.allowedRoots.includes('*')) {
      if (config.io.wildcardRootMode === 'reject') {
        writeLog('[MCP CONFIG] IO MCP disabled; io.allowedRoots includes "*" while io.wildcardRootMode="reject". Replace wildcard roots with explicit paths or set wildcardRootMode="warn" for local-only override.');
      } else {
        writeLog('[MCP CONFIG] Warning: io.allowedRoots includes "*" with tools.io enabled. This grants broad local filesystem access. Prefer explicit allowed roots or set io.wildcardRootMode="reject" to block wildcard usage.');
      }
    }

    if (boolSetting(raw?.tools?.googleSearch)) {
      const envApiKey = stringSetting(env?.[config.googleSearch.apiKeyEnv], '');
      const configApiKey = stringSetting(raw?.googleSearch?.apiKey, '');
      if (!config.googleSearch.apiKey) {
        writeLog(`[MCP CONFIG] Google search MCP disabled; set ${config.googleSearch.apiKeyEnv} (preferred) or googleSearch.apiKey when tools.googleSearch is enabled.`);
      } else if (!envApiKey && configApiKey) {
        writeLog(`[MCP CONFIG] Google search MCP key loaded from configuration file. Prefer ${config.googleSearch.apiKeyEnv} to keep secrets out of mcp.json.`);
      }
    }

    return config;
  } catch (err) {
    writeLog(`[MCP CONFIG] MCP tools disabled; failed to load ${resolvedPath}: ${err.message}`);
    return disabledConfig(resolvedPath, err.message);
  }
}

export function getMcpConfig(env = process.env) {
  if (!cachedConfig) cachedConfig = buildMcpConfig(env);
  return cachedConfig;
}

export function invalidateMcpConfigCache() {
  cachedConfig = null;
}

export function resetMcpConfigForTests() {
  invalidateMcpConfigCache();
}

export function isInvokeShellMcpEnabled(env = process.env) {
  return getMcpConfig(env).tools.invokeShell === true;
}

export function isSubagentsMcpEnabled(env = process.env) {
  return getMcpConfig(env).tools.subagents === true;
}

export function isCounselMcpEnabled(env = process.env) {
  return getMcpConfig(env).tools.counsel === true;
}

export function isIoMcpEnabled(env = process.env) {
  return getMcpConfig(env).tools.io === true;
}

export function isGoogleSearchMcpEnabled(env = process.env) {
  return getMcpConfig(env).tools.googleSearch === true;
}

export function getIoMcpConfig(env = process.env) {
  return getMcpConfig(env).io;
}

export function getWebFetchMcpConfig(env = process.env) {
  return getMcpConfig(env).webFetch;
}

export function getGoogleSearchMcpConfig(env = process.env) {
  return getMcpConfig(env).googleSearch;
}

export function getSubagentsMcpConfig(env = process.env) {
  return getMcpConfig(env).subagents;
}
