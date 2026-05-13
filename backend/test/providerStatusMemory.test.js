import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderStatusExtension,
  getLatestProviderStatusExtension,
  normalizeProviderStatusExtension,
  rememberProviderStatusExtension
} from '../services/providerStatusMemory.js';

describe('providerStatusMemory', () => {
  beforeEach(() => {
    clearProviderStatusExtension();
  });

  it('remembers the latest provider status extension', () => {
    const extension = {
      method: '_test.dev/provider/status',
      params: {
        status: {
          providerId: 'test',
          sections: [{ id: 'usage', items: [{ id: 'five-hour', label: '5h', value: '42%' }] }]
        }
      }
    };

    expect(rememberProviderStatusExtension(extension)).toEqual({
      providerId: 'test',
      method: extension.method,
      params: {
        providerId: 'test',
        status: extension.params.status
      }
    });

    expect(getLatestProviderStatusExtension()).toEqual({
      providerId: 'test',
      method: extension.method,
      params: {
        providerId: 'test',
        status: extension.params.status
      }
    });
    expect(getLatestProviderStatusExtension('test')?.params.status.sections[0].items[0].value).toBe('42%');
  });

  it('ignores extensions that are not provider status payloads', () => {
    rememberProviderStatusExtension({
      method: '_test.dev/compaction/status',
      params: { status: { type: 'completed' } }
    });

    expect(getLatestProviderStatusExtension()).toBeNull();
  });

  it('returns a copy so callers cannot mutate cached memory', () => {
    const extension = {
      method: '_test.dev/provider/status',
      params: {
        status: {
          providerId: 'test',
          sections: [{ id: 'usage', items: [{ id: 'five-hour', label: '5h', value: '42%' }] }]
        }
      }
    };

    rememberProviderStatusExtension(extension);
    const cached = getLatestProviderStatusExtension();
    cached.params.status.sections[0].items[0].value = '99%';

    expect(getLatestProviderStatusExtension().params.status.sections[0].items[0].value).toBe('42%');
  });

  it('keeps provider status memory isolated by provider id', () => {
    rememberProviderStatusExtension({
      method: '_a/provider/status',
      params: {
        status: { providerId: 'a', sections: [{ id: 'usage', items: [{ id: 'quota', label: 'A', value: '10%' }] }] }
      }
    });
    rememberProviderStatusExtension({
      method: '_b/provider/status',
      params: {
        status: { providerId: 'b', sections: [{ id: 'usage', items: [{ id: 'quota', label: 'B', value: '90%' }] }] }
      }
    });

    expect(getLatestProviderStatusExtension('a').params.status.sections[0].items[0].value).toBe('10%');
    expect(getLatestProviderStatusExtension('b').params.status.sections[0].items[0].value).toBe('90%');
  });

  it('normalizes provider id into status extensions without mutating the source', () => {
    const extension = {
      method: '_test.dev/provider/status',
      params: {
        status: { sections: [{ id: 'usage', items: [] }] }
      }
    };

    expect(normalizeProviderStatusExtension(extension, 'test')).toEqual({
      providerId: 'test',
      method: extension.method,
      params: {
        providerId: 'test',
        status: { providerId: 'test', sections: [{ id: 'usage', items: [] }] }
      }
    });
    expect(extension.params.status.providerId).toBeUndefined();
  });
});
