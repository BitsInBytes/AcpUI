import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { AsyncLocalStorage } from 'async_hooks';
import { writeLog } from './logger.js';
import { getDefaultProviderId, getProviderEntry, resolveProviderId } from './providerRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providerContext = new AsyncLocalStorage();
const cachedProviders = new Map();
const cachedModules = new Map();

function getContextProviderId() {
  return providerContext.getStore()?.providerId || null;
}

function resolveProviderIdWithContext(providerId) {
  return resolveProviderId(providerId || getContextProviderId() || getDefaultProviderId());
}

export function runWithProvider(providerId, fn) {
  const resolvedId = resolveProviderId(providerId);
  return providerContext.run({ providerId: resolvedId }, fn);
}

export function getProvider(providerId) {
  const resolvedId = resolveProviderIdWithContext(providerId);
  if (cachedProviders.has(resolvedId)) return cachedProviders.get(resolvedId);

  const entry = getProviderEntry(resolvedId);
  const basePath = entry.basePath || path.resolve(__dirname, '..', '..', entry.path);
  const modulePath = path.join(basePath, 'index.js');

  let providerData;
  try {
    providerData = JSON.parse(fs.readFileSync(path.join(basePath, 'provider.json'), 'utf8'));
  } catch (err) {
    writeLog(`[PROVIDER ERR] Failed to load provider.json from ${basePath}: ${err.message}`);
    throw new Error(`Failed to load provider "${resolvedId}" from ${entry.path}: ${err.message}`, { cause: err });
  }

  let brandingData = {};
  try {
    brandingData = JSON.parse(fs.readFileSync(path.join(basePath, 'branding.json'), 'utf8'));
  } catch { /* optional */ }

  let userData = {};
  try {
    userData = JSON.parse(fs.readFileSync(path.join(basePath, 'user.json'), 'utf8'));
  } catch { /* optional */ }

  const { title, ...brandingFields } = brandingData;

  const config = {
    providerId: resolvedId,
    providerPath: entry.path,
    basePath,
    ...providerData,
    ...userData,
    title,
    branding: brandingFields,
  };

  const provider = { id: resolvedId, config, modulePath, basePath, path: entry.path };
  cachedProviders.set(resolvedId, provider);
  writeLog(`[PROVIDER] Loaded "${config.name}" (${resolvedId}) from ${entry.path}`);
  return provider;
}

const DEFAULT_MODULE = {
  intercept: (p) => p,
  normalizeUpdate: (u) => u,
  normalizeModelState: (state) => state,
  normalizeConfigOptions: (options) => options,
  extractToolOutput: () => undefined,
  extractFilePath: () => undefined,
  extractDiffFromToolCall: () => undefined,
  extractToolInvocation: () => null,
  normalizeTool: (e) => e,
  categorizeToolCall: () => null,
  parseExtension: () => null,
  emitCachedContext: () => false,
  prepareAcpEnvironment: async (env) => env,
  performHandshake: async () => {},
  setInitialAgent: async () => {},
  setConfigOption: async () => undefined,
  onPromptStarted: () => {},
  onPromptCompleted: () => {},
  buildSessionParams: (_agent) => undefined,
  getMcpServerMeta: () => undefined,
  getSessionPaths: () => ({ jsonl: '', json: '', tasksDir: '' }),
  cloneSession: () => {},
  archiveSessionFiles: () => {},
  restoreSessionFiles: () => {},
  deleteSessionFiles: () => {},
  parseSessionHistory: async () => null,
  getSessionDir: () => '',
  getAttachmentsDir: () => '',
  getAgentsDir: () => '',
  getHooksForAgent: async () => [],
};

function bindProviderModule(providerId, mod) {
  const merged = { ...DEFAULT_MODULE, ...mod };
  const bound = {};

  for (const [key, value] of Object.entries(merged)) {
    bound[key] = typeof value === 'function'
      ? (...args) => runWithProvider(providerId, () => value(...args))
      : value;
  }

  return bound;
}

export async function getProviderModule(providerId) {
  const resolvedId = resolveProviderIdWithContext(providerId);
  if (cachedModules.has(resolvedId)) return cachedModules.get(resolvedId);
  const { modulePath } = getProvider(resolvedId);
  if (!modulePath || !fs.existsSync(modulePath)) {
    const defaultModule = bindProviderModule(resolvedId, DEFAULT_MODULE);
    cachedModules.set(resolvedId, defaultModule);
    return defaultModule;
  }
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    // Merge with defaults to ensure all required functions exist
    const boundModule = bindProviderModule(resolvedId, mod);
    cachedModules.set(resolvedId, boundModule);
    return boundModule;
  } catch (err) {
    writeLog(`[PROVIDER ERR] Failed to import module from ${modulePath}: ${err.message}`);
    const defaultModule = bindProviderModule(resolvedId, DEFAULT_MODULE);
    cachedModules.set(resolvedId, defaultModule);
    return defaultModule;
  }
}

export function getProviderModuleSync(providerId) {
  let resolvedId;
  try {
    resolvedId = resolveProviderIdWithContext(providerId);
  } catch {
    return DEFAULT_MODULE;
  }
  if (!cachedModules.has(resolvedId)) {
    // Fallback if not yet initialized (should be called after AcpClient.start())
    return bindProviderModule(resolvedId, DEFAULT_MODULE);
  }
  return cachedModules.get(resolvedId);
}

export function resetProviderLoaderForTests() {
  cachedProviders.clear();
  cachedModules.clear();
}
