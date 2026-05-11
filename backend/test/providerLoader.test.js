import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// 1. Hoist Mocks
const { mockFs, mockLogger } = vi.hoisted(() => ({
    mockFs: {
        readFileSync: vi.fn(),
        realpathSync: vi.fn(p => p),
        existsSync: vi.fn().mockReturnValue(true)
    },
    mockLogger: {
        writeLog: vi.fn()
    }
}));

vi.mock('fs', () => ({
  default: mockFs,
  readFileSync: (...args) => mockFs.readFileSync(...args),
  realpathSync: (...args) => mockFs.realpathSync(...args),
  existsSync: (...args) => mockFs.existsSync(...args)
}));

vi.mock('../services/logger.js', () => mockLogger);

describe('providerLoader', () => {
  let providerLoader;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation(p => p);
    delete process.env.ACP_PROVIDERS_CONFIG;
    
    // Default mock behavior for registry
    mockFs.readFileSync.mockImplementation((p) => {
      const pStr = String(p);
      if (pStr.includes('providers.json')) {
        return JSON.stringify({
          defaultProviderId: 'test',
          providers: [{ id: 'test', path: './providers/test' }]
        });
      }
      if (pStr.includes('provider.json')) return JSON.stringify({ name: 'Test' });
      return '{}';
    });

    providerLoader = await import('../services/providerLoader.js');
    const { resetProviderRegistryForTests } = await import('../services/providerRegistry.js');
    if (providerLoader.resetProviderLoaderForTests) {
      providerLoader.resetProviderLoaderForTests();
    }
    if (resetProviderRegistryForTests) {
      resetProviderRegistryForTests();
    }
  });

  it('loads provider from registry', () => {
    mockFs.readFileSync.mockImplementation((p) => {
      const pStr = String(p);
      if (pStr.includes('providers.json')) {
        return JSON.stringify({
          defaultProviderId: 'test-load',
          providers: [{ id: 'test-load', path: './providers/test-load' }]
        });
      }
      if (pStr.includes('test-load') && pStr.includes('provider.json')) return JSON.stringify({ name: 'Test' });
      if (pStr.includes('branding.json')) return JSON.stringify({ title: 'Test UI' });
      if (pStr.includes('user.json')) return JSON.stringify({ paths: { sessions: '/tmp' } });
      return '{}';
    });

    const result = providerLoader.getProvider('test-load');
    expect(result.id).toBe('test-load');
    expect(result.config.providerId).toBe('test-load');
    expect(result.config.name).toBe('Test');
    expect(result.config.title).toBe('Test UI');
    expect(result.config.paths.sessions).toBe('/tmp');
  });

  it('getProviderModule returns DEFAULT_MODULE when module file does not exist', async () => {
    mockFs.existsSync.mockImplementation(p => !String(p).endsWith('index.js'));

    providerLoader.getProvider('test');
    const result = await providerLoader.getProviderModule('test');
    expect(result.intercept('test')).toBe('test');
  });

  it('getProviderModuleSync returns DEFAULT_MODULE if not initialized', () => {
      const result = providerLoader.getProviderModuleSync('test');
      expect(result).toHaveProperty('intercept');
  });

  it('handles provider.json read error', () => {
    mockFs.readFileSync.mockImplementation((p) => {
      const pStr = String(p);
      if (pStr.includes('providers.json')) return JSON.stringify({ defaultProviderId: 'bad', providers: [{ id: 'bad', path: './providers/bad' }] });
      if (pStr.includes('bad') && pStr.includes('provider.json')) throw new Error('fail');
      return '{}';
    });
    expect(() => providerLoader.getProvider('bad')).toThrow('Failed to load provider');
  });

  it('throws when registry file is missing', () => {
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => providerLoader.getProvider()).toThrow('Failed to load provider registry');
  });

  it('getProvider returns cached provider on repeat calls', () => {
    const first = providerLoader.getProvider('test');
    const second = providerLoader.getProvider('test');

    expect(first).toBe(second);
  });

  it('loads multiple providers from ACP_PROVIDERS_CONFIG', () => {
    process.env.ACP_PROVIDERS_CONFIG = './configuration/providers.test.json';
    mockFs.readFileSync.mockImplementation((p) => {
      const pStr = String(p);
      if (pStr.includes('providers.test.json')) {
        return JSON.stringify({
          defaultProviderId: 'provider-a',
          providers: [
            { id: 'provider-a', path: './providers/a' },
            { id: 'provider-b', path: './providers/b' }
          ]
        });
      }
      if (pStr.includes('providers/a') && pStr.includes('provider.json')) return JSON.stringify({ name: 'provider-a' });
      if (pStr.includes('providers/b') && pStr.includes('provider.json')) return JSON.stringify({ name: 'provider-b' });
      return '{}';
    });

    const pA = providerLoader.getProvider('provider-a');
    const pB = providerLoader.getProvider('provider-b');

    expect(pA.id).toBe('provider-a');
    expect(pB.id).toBe('provider-b');
    expect(providerLoader.getProvider().id).toBe('provider-a');
  });

  it('rejects duplicate provider ids in ACP_PROVIDERS_CONFIG', () => {
    process.env.ACP_PROVIDERS_CONFIG = './configuration/providers.test.json';
    mockFs.readFileSync.mockImplementation((p) => {
      const pStr = String(p);
      if (pStr.includes('providers.test.json')) {
        return JSON.stringify({
          defaultProviderId: 'same',
          providers: [
            { id: 'same', path: './providers/a' },
            { id: 'same', path: './providers/b' }
          ]
        });
      }
      return '{}';
    });

    expect(() => providerLoader.getProvider('same')).toThrow('Duplicate provider id');
  });

  it('getProviderModule returns cached module on repeat calls', async () => {
    mockFs.existsSync.mockImplementation(p => !String(p).endsWith('index.js'));

    const first = await providerLoader.getProviderModule('test');
    const second = await providerLoader.getProviderModule('test');

    expect(first).toBe(second);
  });

  it('getProviderModuleSync returns cached module after async initialization', async () => {
    mockFs.existsSync.mockImplementation(p => !String(p).endsWith('index.js'));

    await providerLoader.getProviderModule('test');
    const result = providerLoader.getProviderModuleSync('test');

    expect(result).toHaveProperty('intercept');
    expect(typeof result.intercept).toBe('function');
  });

  it('DEFAULT_MODULE functions all have correct default behaviors', async () => {
    mockFs.existsSync.mockImplementation(p => !String(p).endsWith('index.js'));

    const mod = await providerLoader.getProviderModule('test');
    const payload = { data: 1 };
    const event = { type: 'event' };

    expect(mod.intercept(payload)).toBe(payload);
    expect(mod.normalizeUpdate(payload)).toBe(payload);
    expect(mod.normalizeModelState(payload)).toBe(payload);
    expect(mod.extractToolOutput()).toBeUndefined();
    expect(mod.extractFilePath()).toBeUndefined();
    expect(mod.extractDiffFromToolCall()).toBeUndefined();
    expect(mod.extractToolInvocation()).toBeNull();
    expect(mod.normalizeTool(event)).toBe(event);
    expect(mod.categorizeToolCall()).toBeNull();
    expect(mod.parseExtension()).toBeNull();
    expect(mod.emitCachedContext()).toBe(false);
    await expect(mod.prepareAcpEnvironment(payload)).resolves.toBe(payload);
    await expect(mod.performHandshake()).resolves.toBeUndefined();
    await expect(mod.setInitialAgent()).resolves.toBeUndefined();
    expect(mod.buildSessionParams('any')).toBeUndefined();
    expect(mod.getSessionPaths()).toEqual({ jsonl: '', json: '', tasksDir: '' });
    expect(mod.cloneSession()).toBeUndefined();
    expect(mod.archiveSessionFiles()).toBeUndefined();
    expect(mod.restoreSessionFiles()).toBeUndefined();
    expect(mod.deleteSessionFiles()).toBeUndefined();
    await expect(mod.parseSessionHistory()).resolves.toBeNull();
    expect(mod.getSessionDir()).toBe('');
    expect(mod.getAttachmentsDir()).toBe('');
    expect(mod.getAgentsDir()).toBe('');
  });
});
