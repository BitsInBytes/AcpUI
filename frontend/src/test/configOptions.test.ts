import { describe, it, expect } from 'vitest';
import { mergeProviderConfigOptions } from '../utils/configOptions';

describe('configOptions utils', () => {
  it('mergeProviderConfigOptions handles null/undefined', () => {
    expect(mergeProviderConfigOptions(undefined, undefined)).toEqual([]);
    expect(mergeProviderConfigOptions([], undefined)).toEqual([]);
  });

  it('merges new options while preserving current values', () => {
    const current = [{ id: 'opt1', currentValue: 'v1' }];
    const incoming = [{ id: 'opt1', name: 'Option 1', type: 'text' }];
    const result = mergeProviderConfigOptions(current as any, incoming as any);
    expect(result).toHaveLength(1);
    expect(result[0].currentValue).toBe('v1');
    expect(result[0].name).toBe('Option 1');
  });

  it('adds brand new options as provided', () => {
    const current = [{ id: 'opt1', currentValue: 'v1' }];
    const incoming = [{ id: 'opt2', name: 'Option 2' }];
    const result = mergeProviderConfigOptions(current as any, incoming as any);
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe('opt2');
    expect(result[1].name).toBe('Option 2');
  });
});
