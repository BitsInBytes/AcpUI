import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDefaultClient, mockAcpClientInstance, mockProvider, mockLogger, mockJsonDiagnostics } = vi.hoisted(() => ({
  mockDefaultClient: {
    setProviderId: vi.fn(),
    init: vi.fn(),
    stop: vi.fn().mockResolvedValue(),
    isHandshakeComplete: false
  },
  mockAcpClientInstance: {
    setProviderId: vi.fn(),
    init: vi.fn(),
    stop: vi.fn().mockResolvedValue(),
    isHandshakeComplete: true
  },
  mockProvider: {
    id: 'provider-default',
    config: {
      name: 'Provider Default',
      title: 'Provider Default UI',
      branding: { assistantName: 'Provider Assistant' }
    }
  },
  mockLogger: {
    writeLog: vi.fn()
  },
  mockJsonDiagnostics: {
    collectInvalidJsonConfigErrors: vi.fn(() => []),
    hasStartupBlockingJsonConfigError: vi.fn((issues) => issues.some(issue => issue.blocksStartup === true))
  }
}));

vi.mock('../services/acpClient.js', () => {
  return {
    default: mockDefaultClient,
    AcpClient: vi.fn().mockImplementation(function() {
      return mockAcpClientInstance;
    })
  };
});

const mockRegistry = {
  getProviderEntries: vi.fn(() => [
    { id: 'provider-default', label: 'Provider Default Label' },
    { id: 'provider-alt', label: 'Provider Alt Label' }
  ]),
  getDefaultProviderId: vi.fn(() => 'provider-default'),
  resolveProviderId: vi.fn((providerId) => providerId || 'provider-default')
};

vi.mock('../services/providerRegistry.js', () => mockRegistry);

vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn((id) => ({
    ...mockProvider,
    id,
    config: { ...mockProvider.config, name: id.charAt(0).toUpperCase() + id.slice(1) }
  }))
}));

vi.mock('../services/jsonConfigDiagnostics.js', () => mockJsonDiagnostics);

vi.mock('../services/logger.js', () => mockLogger);

import { getProvider } from '../services/providerLoader.js';

describe('providerRuntimeManager', () => {
  let providerRuntimeManager;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockRegistry.getProviderEntries.mockReturnValue([
      { id: 'provider-default', label: 'Provider Default Label' },
      { id: 'provider-alt', label: 'Provider Alt Label' }
    ]);
    mockRegistry.getDefaultProviderId.mockReturnValue('provider-default');
    mockRegistry.resolveProviderId.mockImplementation((providerId) => providerId || 'provider-default');
    mockJsonDiagnostics.collectInvalidJsonConfigErrors.mockReturnValue([]);
    mockJsonDiagnostics.hasStartupBlockingJsonConfigError.mockImplementation((issues) => issues.some(issue => issue.blocksStartup === true));
    getProvider.mockImplementation((id) => ({
      ...mockProvider,
      id,
      config: { ...mockProvider.config, name: id.charAt(0).toUpperCase() + id.slice(1) }
    }));
    const mod = await import('../services/providerRuntimeManager.js');
    providerRuntimeManager = mod.providerRuntimeManager;
  });

  it('initializes all providers in the registry', () => {
    const io = { emit: vi.fn() };
    providerRuntimeManager.init(io, 'boot-123');

    expect(mockDefaultClient.setProviderId).toHaveBeenCalledWith('provider-default');
    expect(mockDefaultClient.init).toHaveBeenCalledWith(io, 'boot-123');

    expect(mockAcpClientInstance.setProviderId).toHaveBeenCalledWith('provider-alt');
    expect(mockAcpClientInstance.init).toHaveBeenCalledWith(io, 'boot-123');

    expect(providerRuntimeManager.getRuntimes()).toHaveLength(2);
  });

  it('blocks init when startup-blocking config diagnostics exist', () => {
    const io = { emit: vi.fn() };
    mockJsonDiagnostics.collectInvalidJsonConfigErrors.mockReturnValue([
      { path: 'configuration/providers.json', blocksStartup: true }
    ]);

    const runtimes = providerRuntimeManager.init(io, 'boot-blocked');

    expect(runtimes).toEqual([]);
    expect(mockDefaultClient.init).not.toHaveBeenCalled();
    expect(mockAcpClientInstance.init).not.toHaveBeenCalled();
    expect(mockLogger.writeLog).toHaveBeenCalledWith(expect.stringContaining('Provider startup blocked by invalid JSON config'));
  });

  it('returns empty runtimes when provider registry loading throws', () => {
    const io = { emit: vi.fn() };
    mockRegistry.getDefaultProviderId.mockImplementationOnce(() => {
      throw new Error('registry failed');
    });

    const runtimes = providerRuntimeManager.init(io, 'boot-registry-fail');

    expect(runtimes).toEqual([]);
    expect(mockDefaultClient.init).not.toHaveBeenCalled();
    expect(mockLogger.writeLog).toHaveBeenCalledWith(expect.stringContaining('Provider startup failed while loading provider registry: registry failed'));
  });

  it('clears partially built runtimes when provider config loading throws', () => {
    const io = { emit: vi.fn() };
    getProvider.mockImplementation((id) => {
      if (id === 'provider-alt') throw new Error('provider config failed');
      return {
        ...mockProvider,
        id,
        config: { ...mockProvider.config, name: id }
      };
    });

    const runtimes = providerRuntimeManager.init(io, 'boot-provider-fail');

    expect(runtimes).toEqual([]);
    expect(providerRuntimeManager.getRuntimes()).toEqual([]);
    expect(mockDefaultClient.init).not.toHaveBeenCalled();
    expect(mockLogger.writeLog).toHaveBeenCalledWith(expect.stringContaining('Provider startup failed while loading provider config: provider config failed'));
  });

  it('does not re-initialize if already initialized', () => {
    const io = { emit: vi.fn() };
    providerRuntimeManager.init(io, 'boot-1');
    providerRuntimeManager.init(io, 'boot-2');

    expect(mockDefaultClient.init).toHaveBeenCalledTimes(1);
    expect(mockLogger.writeLog).toHaveBeenCalledWith(expect.stringContaining('Init ignored'));
  });

  it('stops all runtimes and allows initialization again', async () => {
    const io = { emit: vi.fn() };
    providerRuntimeManager.init(io, 'boot-1');

    await providerRuntimeManager.stopAll();

    expect(mockDefaultClient.stop).toHaveBeenCalled();
    expect(mockAcpClientInstance.stop).toHaveBeenCalled();
    expect(providerRuntimeManager.getRuntimes()).toEqual([]);

    providerRuntimeManager.init(io, 'boot-2');
    expect(mockDefaultClient.init).toHaveBeenCalledTimes(2);
  });

  it('getRuntime returns the correct runtime', () => {
    providerRuntimeManager.init({}, 'boot');

    const runtime = providerRuntimeManager.getRuntime('provider-alt');
    expect(runtime.providerId).toBe('provider-alt');
    expect(runtime.client).toBe(mockAcpClientInstance);
  });

  it('getRuntime defaults to default provider if no id provided', () => {
    providerRuntimeManager.init({}, 'boot');

    const runtime = providerRuntimeManager.getRuntime();
    expect(runtime.providerId).toBe('provider-default');
    expect(runtime.client).toBe(mockDefaultClient);
  });

  it('getClient returns the correct client', () => {
    providerRuntimeManager.init({}, 'boot');
    expect(providerRuntimeManager.getClient('provider-default')).toBe(mockDefaultClient);
    expect(providerRuntimeManager.getClient('provider-alt')).toBe(mockAcpClientInstance);
  });

  it('getProviderSummaries returns correct data', () => {
    providerRuntimeManager.init({}, 'boot');
    mockDefaultClient.isHandshakeComplete = false;
    mockAcpClientInstance.isHandshakeComplete = true;

    const summaries = providerRuntimeManager.getProviderSummaries();
    expect(summaries).toHaveLength(2);

    const defaultProvider = summaries.find(s => s.providerId === 'provider-default');
    expect(defaultProvider.label).toBe('Provider Default Label');
    expect(defaultProvider.default).toBe(true);
    expect(defaultProvider.ready).toBe(false);

    const altProvider = summaries.find(s => s.providerId === 'provider-alt');
    expect(altProvider.label).toBe('Provider Alt Label');
    expect(altProvider.default).toBe(false);
    expect(altProvider.ready).toBe(true);
  });

  it('throws error if runtime is not found', () => {
    mockRegistry.resolveProviderId.mockReturnValue('unknown');
    
    providerRuntimeManager.init({}, 'boot');
    expect(() => providerRuntimeManager.getRuntime('unknown')).toThrow('Provider runtime is not initialized for "unknown"');
  });
});
