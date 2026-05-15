import path from 'path';
import { fileURLToPath } from 'url';
import { getProvider, getProviderModuleSync } from '../services/providerLoader.js';
import { createMcpProxyBinding, getMcpProxyAuthToken } from './mcpProxyRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' }
    ],
    ...(mcpServerMeta ? { _meta: mcpServerMeta } : {})
  }];
}
