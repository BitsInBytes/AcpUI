import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

let cachedRegistry = null;

function repoPath(value) {
  return path.resolve(REPO_ROOT, value);
}

function normalizeProviderId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function providerIdFromPath(providerPath) {
  return normalizeProviderId(path.basename(path.resolve(REPO_ROOT, providerPath || '')));
}

function readRegistryFile(configPath) {
  const resolvedPath = repoPath(configPath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (err) {
    writeLog(`[PROVIDER REGISTRY ERR] Failed to read ${resolvedPath}: ${err.message}`);
    throw new Error(`Failed to load provider registry from ${configPath}: ${err.message}`, { cause: err });
  }

  const defaultProviderId = parsed.defaultProviderId || parsed.default || null;
  if (!defaultProviderId) {
    writeLog(`[PROVIDER REGISTRY ERR] Missing "defaultProviderId" in ${resolvedPath}`);
    throw new Error(`Provider registry at ${configPath} is missing the required "defaultProviderId" field`);
  }

  const providers = Array.isArray(parsed.providers) ? parsed.providers : [];
  return {
    defaultProviderId,
    providers,
    source: resolvedPath
  };
}

function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Provider registry entry at index ${index} must be an object`);
  }
  if (entry.enabled === false) return null;

  const providerPath = entry.path || entry.providerPath || entry.dir;
  if (!providerPath || typeof providerPath !== 'string') {
    throw new Error(`Provider registry entry at index ${index} is missing a string "path"`);
  }

  const id = normalizeProviderId(entry.id || providerIdFromPath(providerPath));
  if (!id) {
    throw new Error(`Provider registry entry at index ${index} is missing a valid provider id`);
  }

  const basePath = repoPath(providerPath);
  if (!fs.existsSync(basePath)) {
    throw new Error(`Provider "${id}" path does not exist: ${basePath}`);
  }
  if (!fs.existsSync(path.join(basePath, 'provider.json'))) {
    throw new Error(`Provider "${id}" is missing provider.json in ${basePath}`);
  }

  return {
    id,
    path: providerPath,
    basePath,
    enabled: true,
    label: entry.label || entry.name || id,
    order: Number.isFinite(entry.order) ? entry.order : index
  };
}

function buildRegistry() {
  const configPath = process.env.ACP_PROVIDERS_CONFIG || 'configuration/providers.json';
  const raw = readRegistryFile(configPath);

  const entries = [];
  const seen = new Set();

  raw.providers.forEach((entry, index) => {
    const normalized = normalizeEntry(entry, index);
    if (!normalized) return;
    if (seen.has(normalized.id)) {
      throw new Error(`Duplicate provider id "${normalized.id}" in provider registry`);
    }
    seen.add(normalized.id);
    entries.push(normalized);
  });

  if (entries.length === 0) {
    throw new Error('Provider registry does not contain any enabled providers');
  }

  const requestedDefault = normalizeProviderId(raw.defaultProviderId);
  const defaultProviderId = entries.some(entry => entry.id === requestedDefault)
    ? requestedDefault
    : null;

  if (!defaultProviderId) {
    throw new Error(`The default provider "${requestedDefault}" is either disabled or not defined in the registry`);
  }

  const registry = {
    source: raw.source,
    defaultProviderId,
    providers: entries.sort((a, b) => {
      if (a.id === defaultProviderId) return -1;
      if (b.id === defaultProviderId) return 1;
      return a.order - b.order;
    }),
    byId: new Map(entries.map(entry => [entry.id, entry]))
  };

  writeLog(`[PROVIDER REGISTRY] Loaded ${registry.providers.length} provider(s); default=${defaultProviderId}`);
  return registry;
}

export function getProviderRegistry() {
  if (!cachedRegistry) cachedRegistry = buildRegistry();
  return cachedRegistry;
}

export function getProviderEntries() {
  return getProviderRegistry().providers;
}

export function getDefaultProviderId() {
  return getProviderRegistry().defaultProviderId;
}

export function resolveProviderId(providerId) {
  const registry = getProviderRegistry();
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return registry.defaultProviderId;
  if (!registry.byId.has(normalized)) {
    throw new Error(`Unknown provider id "${providerId}"`);
  }
  return normalized;
}

export function getProviderEntry(providerId) {
  const resolvedId = resolveProviderId(providerId);
  return getProviderRegistry().byId.get(resolvedId);
}

export function resetProviderRegistryForTests() {
  cachedRegistry = null;
}
