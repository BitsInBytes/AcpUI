import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProvider, getProviderModuleSync } from '../services/providerLoader.js';
import { writeLog } from '../services/logger.js';
import { createMcpProxyBinding, getMcpProxyAuthToken } from './mcpProxyRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_DEV_CA_CERT_PATH = path.resolve(__dirname, '..', '.ssl', 'cert.pem');
const INSECURE_MCP_PROXY_TLS_ENV = 'ACP_UI_ALLOW_INSECURE_MCP_PROXY_TLS';

let insecureTlsWarningEmitted = false;

function isTruthyEnvValue(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldDisableTlsVerification(env = process.env) {
  return isTruthyEnvValue(env?.[INSECURE_MCP_PROXY_TLS_ENV]);
}

function maybeEmitInsecureTlsWarning() {
  if (insecureTlsWarningEmitted) return;
  insecureTlsWarningEmitted = true;
  writeLog(`[MCP TLS] WARNING: ${INSECURE_MCP_PROXY_TLS_ENV}=1 disables TLS certificate verification for MCP proxy backend calls. Use local development trusted certificates instead whenever possible.`);
}

function buildProxyTlsEnv(env = process.env) {
  const tlsEnv = [];

  if (fs.existsSync(LOCAL_DEV_CA_CERT_PATH)) {
    tlsEnv.push({ name: 'NODE_EXTRA_CA_CERTS', value: LOCAL_DEV_CA_CERT_PATH });
  }

  if (shouldDisableTlsVerification(env)) {
    maybeEmitInsecureTlsWarning();
    tlsEnv.push({ name: INSECURE_MCP_PROXY_TLS_ENV, value: '1' });
    tlsEnv.push({ name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' });
  }

  return tlsEnv;
}

export function buildMcpServersForProvider(providerId = null, { acpSessionId = null } = {}) {
  const provider = getProvider(providerId);
  const resolvedProviderId = provider.id || providerId;
  const name = provider.config?.mcpName;
  if (!name || !resolvedProviderId) return [];

  const providerModule = getProviderModuleSync(resolvedProviderId);
  const mcpServerMeta = providerModule.getMcpServerMeta?.();
  const proxyPath = path.resolve(__dirname, 'stdio-proxy.js');
  const proxyId = createMcpProxyBinding({ providerId: resolvedProviderId, acpSessionId });
  const proxyAuthToken = getMcpProxyAuthToken(proxyId);

  return [{
    name,
    command: 'node',
    args: [proxyPath],
    env: [
      { name: 'ACP_SESSION_PROVIDER_ID', value: String(resolvedProviderId) },
      { name: 'ACP_UI_MCP_PROXY_ID', value: proxyId },
      { name: 'ACP_UI_MCP_PROXY_AUTH_TOKEN', value: String(proxyAuthToken || '') },
      { name: 'BACKEND_PORT', value: String(process.env.BACKEND_PORT || 3005) },
      ...buildProxyTlsEnv(process.env)
    ],
    ...(mcpServerMeta ? { _meta: mcpServerMeta } : {})
  }];
}
