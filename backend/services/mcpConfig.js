import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = 'configuration/mcp.json';

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
      timeoutMs: 15000,
      maxOutputBytes: 262144
    },
    subagents: {
      statusWaitTimeoutMs: 120000,
      statusPollIntervalMs: 1000
    }
  };
}

function normalizeMcpConfig(raw, source) {
  const tools = raw?.tools || {};
  const io = raw?.io || {};
  const webFetch = raw?.webFetch || {};
  const googleSearch = raw?.googleSearch || {};
  const subagents = raw?.subagents || {};

  const googleSearchApiKey = typeof googleSearch.apiKey === 'string'
    ? googleSearch.apiKey.trim()
    : '';
  const requestedGoogleSearch = boolSetting(tools.googleSearch);

  return {
    source,
    loaded: true,
    tools: {
      invokeShell: boolSetting(tools.invokeShell),
      subagents: boolSetting(tools.subagents),
      counsel: boolSetting(tools.counsel),
      io: boolSetting(tools.io),
      googleSearch: requestedGoogleSearch && Boolean(googleSearchApiKey)
    },
    io: {
      autoAllowWorkspaceCwd: boolSetting(io.autoAllowWorkspaceCwd),
      allowedRoots: stringArray(io.allowedRoots),
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
    const config = normalizeMcpConfig(raw, resolvedPath);
    writeLog(`[MCP CONFIG] Loaded MCP config from ${resolvedPath}`);
    if (boolSetting(raw?.tools?.googleSearch) && !config.googleSearch.apiKey) {
      writeLog('[MCP CONFIG] Google search MCP disabled; googleSearch.apiKey is required when tools.googleSearch is enabled.');
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

export function resetMcpConfigForTests() {
  cachedConfig = null;
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
