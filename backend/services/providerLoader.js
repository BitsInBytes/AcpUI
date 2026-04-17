import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { writeLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedProvider = null;
let cachedModule = null;

export function getProvider() {
  if (cachedProvider) return cachedProvider;

  const providerPath = process.env.ACP_PROVIDER;
  if (!providerPath) {
    writeLog('[PROVIDER ERR] ACP_PROVIDER not configured in .env');
    throw new Error('ACP_PROVIDER not configured. Set ACP_PROVIDER in .env (e.g., ./providers/my-provider)');
  }

  const basePath = path.resolve(__dirname, '..', '..', providerPath);
  const modulePath = path.join(basePath, 'index.js');

  let providerData;
  try {
    providerData = JSON.parse(fs.readFileSync(path.join(basePath, 'provider.json'), 'utf8'));
  } catch (err) {
    writeLog(`[PROVIDER ERR] Failed to load provider.json from ${basePath}: ${err.message}`);
    throw new Error(`Failed to load provider from ${providerPath}: ${err.message}`, { cause: err });
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
    ...providerData,
    ...userData,
    title,
    branding: brandingFields,
  };

  cachedProvider = { config, modulePath };
  writeLog(`[PROVIDER] Loaded "${config.name}" from ${providerPath}`);
  return cachedProvider;
}

const DEFAULT_MODULE = {
  intercept: (p) => p,
  normalizeUpdate: (u) => u,
  extractToolOutput: () => undefined,
  extractFilePath: () => undefined,
  extractDiffFromToolCall: () => undefined,
  normalizeTool: (e) => e,
  categorizeToolCall: () => null,
  parseExtension: () => null,
  performHandshake: async () => {},
  setInitialAgent: async () => {},
  getSessionPaths: () => ({ jsonl: '', json: '', tasksDir: '' }),
  cloneSession: () => {},
  archiveSessionFiles: () => {},
  restoreSessionFiles: () => {},
  deleteSessionFiles: () => {},
  getSessionDir: () => '',
  getAttachmentsDir: () => '',
  getAgentsDir: () => '',
  getHooksForAgent: async () => [],
};

export async function getProviderModule() {
  if (cachedModule) return cachedModule;
  const { modulePath } = getProvider();
  if (!modulePath || !fs.existsSync(modulePath)) {
    cachedModule = DEFAULT_MODULE;
    return cachedModule;
  }
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    // Merge with defaults to ensure all required functions exist
    cachedModule = { ...DEFAULT_MODULE, ...mod };
    return cachedModule;
  } catch (err) {
    writeLog(`[PROVIDER ERR] Failed to import module from ${modulePath}: ${err.message}`);
    cachedModule = DEFAULT_MODULE;
    return cachedModule;
  }
}

export function getProviderModuleSync() {
  if (!cachedModule) {
    // Fallback if not yet initialized (should be called after AcpClient.start())
    return DEFAULT_MODULE;
  }
  return cachedModule;
}
