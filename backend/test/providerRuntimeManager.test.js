import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDefaultClient, mockAcpClientInstance, mockProvider, mockLogger } = vi.hoisted(() => ({
  mockDefaultClient: {
    setProviderId: vi.fn(),
    init: vi.fn(),
    isHandshakeComplete: false
  },
  mockAcpClientInstance: {
    setProviderId: vi.fn(),
    init: vi.fn(),
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

vi.mock('../services/logger.js', () => mockLogger);

describe('providerRuntimeManager', () => {
  let providerRuntimeManager;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
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

  it('does not re-initialize if already initialized', () => {
    const io = { emit: vi.fn() };
    providerRuntimeManager.init(io, 'boot-1');
    providerRuntimeManager.init(io, 'boot-2');

    expect(mockDefaultClient.init).toHaveBeenCalledTimes(1);
    expect(mockLogger.writeLog).toHaveBeenCalledWith(expect.stringContaining('Init ignored'));
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
