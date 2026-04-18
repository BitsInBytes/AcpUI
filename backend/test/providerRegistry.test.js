import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Hoist mocks
const { mockFs, mockLogger } = vi.hoisted(() => ({
  mockFs: {
    readFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true)
  },
  mockLogger: {
    writeLog: vi.fn()
  }
}));

vi.mock('fs', () => ({
  default: mockFs,
  readFileSync: (...args) => mockFs.readFileSync(...args),
  existsSync: (...args) => mockFs.existsSync(...args)
}));

vi.mock('../services/logger.js', () => mockLogger);

describe('providerRegistry', () => {
  let providerRegistry;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    delete process.env.ACP_PROVIDERS_CONFIG;

    providerRegistry = await import('../services/providerRegistry.js');
    providerRegistry.resetProviderRegistryForTests();
  });

  it('loads registry from default config path', () => {
    mockFs.readFileSync.mockImplementation((p) => {
      const pStr = String(p);
      if (pStr.includes('providers.json')) {
        return JSON.stringify({
          defaultProviderId: 'test-p',
          providers: [{ id: 'test-p', path: './providers/test-p' }]
        });
      }
      return '{}';
    });

    const entries = providerRegistry.getProviderEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('test-p');
    expect(providerRegistry.getDefaultProviderId()).toBe('test-p');
  });

  it('throws error if registry file is missing', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => providerRegistry.getProviderRegistry()).toThrow('Failed to load provider registry');
  });

  it('throws error if defaultProviderId is missing', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      providers: []
    }));

    expect(() => providerRegistry.getProviderRegistry()).toThrow('missing the required "defaultProviderId" field');
  });

  it('throws error if no enabled providers are found', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'test',
      providers: [{ id: 'test', path: './providers/test', enabled: false }]
    }));

    expect(() => providerRegistry.getProviderRegistry()).toThrow('Provider registry does not contain any enabled providers');
  });

  it('normalizes provider ids', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'My Provider!',
      providers: [{ id: 'My Provider!', path: './providers/test' }]
    }));

    expect(providerRegistry.getDefaultProviderId()).toBe('my-provider');
    expect(providerRegistry.getProviderEntries()[0].id).toBe('my-provider');
  });

  it('infers provider id from path if not provided', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'inferred',
      providers: [{ path: './providers/inferred' }]
    }));

    expect(providerRegistry.getProviderEntries()[0].id).toBe('inferred');
  });

  it('throws error if provider path does not exist', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'missing',
      providers: [{ id: 'missing', path: './providers/missing' }]
    }));
    mockFs.existsSync.mockImplementation((p) => !String(p).includes('missing'));

    expect(() => providerRegistry.getProviderRegistry()).toThrow('path does not exist');
  });

  it('throws error if provider.json is missing in provider directory', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'no-json',
      providers: [{ id: 'no-json', path: './providers/no-json' }]
    }));
    mockFs.existsSync.mockImplementation((p) => {
      const pStr = String(p);
      if (pStr.includes('no-json') && pStr.endsWith('provider.json')) return false;
      return true;
    });

    expect(() => providerRegistry.getProviderRegistry()).toThrow('missing provider.json');
  });

  it('throws error if duplicate provider ids are found', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'dup',
      providers: [
        { id: 'dup', path: './providers/a' },
        { id: 'dup', path: './providers/b' }
      ]
    }));

    expect(() => providerRegistry.getProviderRegistry()).toThrow('Duplicate provider id');
  });

  it('throws error if default provider is not in the registry', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'non-existent',
      providers: [{ id: 'exists', path: './providers/exists' }]
    }));

    expect(() => providerRegistry.getProviderRegistry()).toThrow('The default provider "non-existent" is either disabled or not defined');
  });

  it('resolves provider id correctly', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'def',
      providers: [
        { id: 'def', path: './providers/def' },
        { id: 'other', path: './providers/other' }
      ]
    }));

    expect(providerRegistry.resolveProviderId(null)).toBe('def');
    expect(providerRegistry.resolveProviderId('other')).toBe('other');
    expect(() => providerRegistry.resolveProviderId('unknown')).toThrow('Unknown provider id');
  });

  it('sorts providers with default first, then by order', () => {
    mockFs.readFileSync.mockImplementation(() => JSON.stringify({
      defaultProviderId: 'def',
      providers: [
        { id: 'z', path: './providers/z', order: 10 },
        { id: 'def', path: './providers/def', order: 5 },
        { id: 'a', path: './providers/a', order: 1 }
      ]
    }));

    const entries = providerRegistry.getProviderEntries();
    expect(entries[0].id).toBe('def');
    expect(entries[1].id).toBe('a');
    expect(entries[2].id).toBe('z');
  });
});
