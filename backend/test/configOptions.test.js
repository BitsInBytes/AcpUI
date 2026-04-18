import { describe, it, expect } from 'vitest';
import { normalizeConfigOptions, normalizeRemovedConfigOptionIds, applyConfigOptionsChange, mergeConfigOptions } from '../services/configOptions.js';

describe('configOptions', () => {
  describe('normalizeConfigOptions', () => {
    it('returns empty array for non-array input', () => {
      expect(normalizeConfigOptions(null)).toEqual([]);
      expect(normalizeConfigOptions({})).toEqual([]);
    });

    it('filters out invalid options', () => {
      const input = [
        { id: 'opt1', label: 'Option 1' },
        { label: 'No ID' },
        null,
        { id: '', label: 'Empty ID' }
      ];
      expect(normalizeConfigOptions(input)).toEqual([{ id: 'opt1', label: 'Option 1' }]);
    });
  });

  describe('normalizeRemovedConfigOptionIds', () => {
    it('returns empty array for non-array input', () => {
      expect(normalizeRemovedConfigOptionIds(null)).toEqual([]);
    });

    it('filters out non-string or empty ids', () => {
      expect(normalizeRemovedConfigOptionIds(['id1', '', null, 123])).toEqual(['id1']);
    });
  });

  describe('applyConfigOptionsChange', () => {
    const current = [{ id: '1', val: 'a' }, { id: '2', val: 'b' }];

    it('returns current if nothing incoming and no removals', () => {
      expect(applyConfigOptionsChange(current, [])).toEqual(current);
    });

    it('replaces options if replace is true', () => {
      const incoming = [{ id: '3', val: 'c' }];
      expect(applyConfigOptionsChange(current, incoming, { replace: true })).toEqual(incoming);
    });

    it('removes options specified in removeOptionIds', () => {
      expect(applyConfigOptionsChange(current, [], { removeOptionIds: ['1'] })).toEqual([{ id: '2', val: 'b' }]);
    });

    it('merges incoming options into current', () => {
      const incoming = [{ id: '2', val: 'updated' }, { id: '3', val: 'new' }];
      const result = applyConfigOptionsChange(current, incoming);
      expect(result).toEqual([
        { id: '1', val: 'a' },
        { id: '2', val: 'updated' },
        { id: '3', val: 'new' }
      ]);
    });

    it('handles removals and merges together', () => {
      const incoming = [{ id: '3', val: 'new' }];
      const result = applyConfigOptionsChange(current, incoming, { removeOptionIds: ['1'] });
      expect(result).toEqual([
        { id: '2', val: 'b' },
        { id: '3', val: 'new' }
      ]);
    });

    it('incoming option removal takes precedence if same ID', () => {
      const incoming = [{ id: '2', val: 'updated' }];
      const result = applyConfigOptionsChange(current, incoming, { removeOptionIds: ['2'] });
      expect(result).toEqual([{ id: '1', val: 'a' }]);
    });
  });

  describe('mergeConfigOptions', () => {
    it('is an alias for applyConfigOptionsChange without third arg', () => {
      const current = [{ id: '1' }];
      const incoming = [{ id: '2' }];
      expect(mergeConfigOptions(current, incoming)).toEqual([{ id: '1' }, { id: '2' }]);
    });
  });
});
