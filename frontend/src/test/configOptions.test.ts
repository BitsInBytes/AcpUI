import { describe, expect, it } from 'vitest';
import { mergeProviderConfigOptions } from '../utils/configOptions';

describe('mergeProviderConfigOptions', () => {
  it('ignores empty incoming updates', () => {
    const current = [{
      id: 'effort',
      name: 'Effort',
      type: 'select' as const,
      currentValue: 'medium',
      options: [{ value: 'medium', name: 'Medium' }]
    }];

    expect(mergeProviderConfigOptions(current, [])).toEqual(current);
  });

  it('merges partial incoming updates by id', () => {
    const current = [{
      id: 'effort',
      name: 'Effort',
      type: 'select' as const,
      currentValue: 'medium',
      options: [{ value: 'medium', name: 'Medium' }]
    }];

    expect(mergeProviderConfigOptions(current, [{ id: 'effort', currentValue: 'high' }])).toEqual([{
      ...current[0],
      currentValue: 'high'
    }]);
  });

  it('adds new options if they do not exist', () => {
    const current = [{ id: 'opt1' }] as any;
    const incoming = [{ id: 'opt2', val: 'new' }] as any;
    expect(mergeProviderConfigOptions(current, incoming)).toEqual([{ id: 'opt1' }, { id: 'opt2', val: 'new' }]);
  });

  it('removes options when removeOptionIds is provided', () => {
    const current = [{ id: 'opt1' }, { id: 'opt2' }] as any;
    expect(mergeProviderConfigOptions(current, [], { removeOptionIds: ['opt1'] })).toEqual([{ id: 'opt2' }]);
  });

  it('replaces all options when replace: true is provided', () => {
    const current = [{ id: 'old' }] as any;
    const incoming = [{ id: 'new' }] as any;
    expect(mergeProviderConfigOptions(current, incoming, { replace: true })).toEqual([{ id: 'new' }]);
  });

  it('handles removal and merge in one call', () => {
    const current = [{ id: 'rem' }, { id: 'keep' }] as any;
    const incoming = [{ id: 'keep', updated: true }, { id: 'new' }] as any;
    const result = mergeProviderConfigOptions(current, incoming, { removeOptionIds: ['rem'] });
    expect(result).toEqual([{ id: 'keep', updated: true }, { id: 'new' }]);
  });

  it('handles undefined or null inputs', () => {
    expect(mergeProviderConfigOptions(undefined, undefined)).toEqual([]);
    expect(mergeProviderConfigOptions([{ id: '1' }] as any, undefined)).toEqual([{ id: '1' }]);
    expect(mergeProviderConfigOptions(undefined, [{ id: '2' }] as any)).toEqual([{ id: '2' }]);
  });

  it('skips incoming options that are in removeOptionIds', () => {
    const current = [{ id: '1' }] as any;
    const incoming = [{ id: '2' }] as any;
    const result = mergeProviderConfigOptions(current, incoming, { removeOptionIds: ['2'] });
    expect(result).toEqual([{ id: '1' }]);
  });

  it('filters out options without ids', () => {
    const current = [{ id: '1' }, {}] as any;
    const incoming = [{ id: '2' }, { noId: true }] as any;
    expect(mergeProviderConfigOptions(current, incoming)).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('handles invalid removeOptionIds', () => {
    const current = [{ id: '1' }] as any;
    expect(mergeProviderConfigOptions(current, [], { removeOptionIds: [null as any, '', 123 as any] })).toEqual([{ id: '1' }]);
  });
});
