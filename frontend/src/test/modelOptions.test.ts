import { describe, it, expect } from 'vitest';
import { getDefaultModelSelection, getModelIdForSelection, normalizeModelOptions } from '../utils/modelOptions';

describe('modelOptions utils', () => {
  it('getDefaultModelSelection handles missing models', () => {
    expect(getDefaultModelSelection(undefined)).toBe('');
  });

  it('getModelIdForSelection returns selection', () => {
    const models = { default: 'gpt-4', fast: 'gpt-3.5' };
    expect(getModelIdForSelection('balanced', models as any)).toBe('balanced');
    expect(getModelIdForSelection('fast', models as any)).toBe('fast');
  });

  it('normalizeModelOptions handles arrays', () => {
    const raw = [{ id: 'm1', name: 'M1' }];
    const result = normalizeModelOptions(raw as any);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m1');
    expect(result[0].name).toBe('M1');

    expect(normalizeModelOptions(null)).toEqual([]);
  });
});
