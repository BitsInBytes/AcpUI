import defaultAcpClient, { AcpClient } from './acpClient.js';
import { getProviderEntries, getDefaultProviderId, resolveProviderId } from './providerRegistry.js';
import { getProvider } from './providerLoader.js';
import { writeLog } from './logger.js';

class ProviderRuntimeManager {
  constructor() {
    this.runtimes = new Map();
    this.io = null;
    this.serverBootId = null;
    this.initialized = false;
  }

  init(io, serverBootId) {
    if (this.initialized) {
      writeLog(`[PROVIDER RUNTIME] Init ignored; ${this.runtimes.size} provider runtime(s) already started`);
      return this.getRuntimes();
    }

    this.io = io;
    this.serverBootId = serverBootId;

    const defaultProviderId = getDefaultProviderId();
    const entries = getProviderEntries();

    for (const entry of entries) {
      const client = entry.id === defaultProviderId
        ? defaultAcpClient
        : new AcpClient(entry.id);
      client.setProviderId(entry.id);

      const provider = getProvider(entry.id);
      this.runtimes.set(entry.id, {
        providerId: entry.id,
        provider,
        client
      });
    }

    this.initialized = true;
    writeLog(`[PROVIDER RUNTIME] Starting ${this.runtimes.size} provider runtime(s)`);
    for (const runtime of this.runtimes.values()) {
      runtime.client.init(io, serverBootId);
    }

    return this.getRuntimes();
  }

  getRuntime(providerId = null) {
    const resolvedId = resolveProviderId(providerId);
    const runtime = this.runtimes.get(resolvedId);
    if (!runtime) {
      throw new Error(`Provider runtime is not initialized for "${resolvedId}"`);
    }
    return runtime;
  }

  getClient(providerId = null) {
    return this.getRuntime(providerId).client;
  }

  getDefaultRuntime() {
    return this.getRuntime(getDefaultProviderId());
  }

  getDefaultClient() {
    return this.getDefaultRuntime().client;
  }

  getRuntimes() {
    return Array.from(this.runtimes.values());
  }

  getProviderSummaries() {
    return getProviderEntries().map(entry => {
      const provider = getProvider(entry.id);
      return {
        providerId: entry.id,
        label: entry.label,
        name: provider.config.name,
        title: provider.config.title,
        assistantName: provider.config.branding?.assistantName || provider.config.name || entry.label,
        default: entry.id === getDefaultProviderId(),
        ready: this.runtimes.get(entry.id)?.client.isHandshakeComplete === true
      };
    });
  }
}

export const providerRuntimeManager = new ProviderRuntimeManager();
export default providerRuntimeManager;
