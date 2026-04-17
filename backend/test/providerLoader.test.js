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
    delete process.env.ACP_PROVIDER;
    providerLoader = await import('../services/providerLoader.js');
  });

  it('loads provider from config path', () => {
    process.env.ACP_PROVIDER = './providers/test-load';
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes('provider.json')) return JSON.stringify({ name: 'Test' });
      if (p.includes('branding.json')) return JSON.stringify({ title: 'Test UI' });
      if (p.includes('user.json')) return JSON.stringify({ paths: { sessions: '/tmp' } });
      throw new Error('unexpected path');
    });

    const result = providerLoader.getProvider();
    expect(result.config.name).toBe('Test');
    expect(result.config.title).toBe('Test UI');
    expect(result.config.paths.sessions).toBe('/tmp');
    expect(mockFs.readFileSync).toHaveBeenCalled();
  });

  it('getProviderModule returns DEFAULT_MODULE when module file does not exist', async () => {
    process.env.ACP_PROVIDER = './providers/test';
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes('provider.json')) return JSON.stringify({ name: 'Test' });
      throw new Error('ENOENT');
    });
    mockFs.existsSync.mockReturnValue(false);

    providerLoader.getProvider();
    const result = await providerLoader.getProviderModule();
    expect(result.intercept('test')).toBe('test');
  });

  it('getProviderModuleSync returns DEFAULT_MODULE if not initialized', () => {
      const result = providerLoader.getProviderModuleSync();
      expect(result).toHaveProperty('intercept');
  });

  it('handles provider.json read error', () => {
    process.env.ACP_PROVIDER = './providers/bad';
    mockFs.readFileSync.mockImplementation(() => { throw new Error('fail'); });
    expect(() => providerLoader.getProvider()).toThrow('Failed to load provider');
  });

  it('throws when ACP_PROVIDER is not set', () => {
    delete process.env.ACP_PROVIDER;
    expect(() => providerLoader.getProvider()).toThrow('ACP_PROVIDER not configured');
  });

  it('getProvider returns cached provider on repeat calls', () => {
    process.env.ACP_PROVIDER = './providers/test';
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes('provider.json')) return JSON.stringify({ name: 'Cached' });
      throw new Error('ENOENT');
    });

    const first = providerLoader.getProvider();
    const second = providerLoader.getProvider();

    expect(first).toBe(second);
    // Only reads files on first call (branding/user throw → caught silently, so 1 successful read)
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(3);
  });

  it('getProviderModule returns cached module on repeat calls', async () => {
    process.env.ACP_PROVIDER = './providers/test';
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes('provider.json')) return JSON.stringify({ name: 'Test' });
      throw new Error('ENOENT');
    });
    mockFs.existsSync.mockReturnValue(false);

    const first = await providerLoader.getProviderModule();
    const second = await providerLoader.getProviderModule();

    expect(first).toBe(second);
  });

  it('getProviderModule falls back to DEFAULT_MODULE when import throws', async () => {
    process.env.ACP_PROVIDER = './providers/nonexistent-import-test';
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes('provider.json')) return JSON.stringify({ name: 'Test' });
      throw new Error('ENOENT');
    });
    mockFs.existsSync.mockReturnValue(true); // pretend module file exists so import is attempted

    // The dynamic import will fail (file doesn't actually exist) → falls back to DEFAULT_MODULE
    const result = await providerLoader.getProviderModule();
    expect(result.intercept('x')).toBe('x');
  });

  it('getProviderModuleSync returns cached module after async initialization', async () => {
    process.env.ACP_PROVIDER = './providers/test';
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes('provider.json')) return JSON.stringify({ name: 'Test' });
      throw new Error('ENOENT');
    });
    mockFs.existsSync.mockReturnValue(false);

    await providerLoader.getProviderModule();
    const result = providerLoader.getProviderModuleSync();

    expect(result).toHaveProperty('intercept');
    expect(typeof result.intercept).toBe('function');
  });

  it('DEFAULT_MODULE functions all have correct default behaviors', async () => {
    process.env.ACP_PROVIDER = './providers/test';
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes('provider.json')) return JSON.stringify({ name: 'Test' });
      throw new Error('ENOENT');
    });
    mockFs.existsSync.mockReturnValue(false);

    const mod = await providerLoader.getProviderModule();
    const payload = { data: 1 };
    const event = { type: 'event' };

    expect(mod.intercept(payload)).toBe(payload);
    expect(mod.normalizeUpdate(payload)).toBe(payload);
    expect(mod.extractToolOutput()).toBeUndefined();
    expect(mod.extractFilePath()).toBeUndefined();
    expect(mod.extractDiffFromToolCall()).toBeUndefined();
    expect(mod.normalizeTool(event)).toBe(event);
    expect(mod.categorizeToolCall()).toBeNull();
    expect(mod.parseExtension()).toBeNull();
    await expect(mod.performHandshake()).resolves.toBeUndefined();
    await expect(mod.setInitialAgent()).resolves.toBeUndefined();
    expect(mod.getSessionPaths()).toEqual({ jsonl: '', json: '', tasksDir: '' });
    expect(mod.cloneSession()).toBeUndefined();
    expect(mod.archiveSessionFiles()).toBeUndefined();
    expect(mod.restoreSessionFiles()).toBeUndefined();
    expect(mod.deleteSessionFiles()).toBeUndefined();
    expect(mod.getSessionDir()).toBe('');
    expect(mod.getAttachmentsDir()).toBe('');
    expect(mod.getAgentsDir()).toBe('');
  });
});
