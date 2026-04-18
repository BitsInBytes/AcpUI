import { describe, expect, it } from 'vitest';
import {
  extractModelState,
  findModelConfigOption,
  mergeModelOptions,
  modelOptionsFromProviderConfig,
  normalizeModelOptions,
  resolveModelSelection
} from '../services/modelOptions.js';

describe('modelOptions service', () => {
  const providerModels = {
    default: 'model-b',
    quickAccess: [
      { id: 'model-a', displayName: 'HighCapability', description: 'Highest capability' },
      { id: 'model-b', displayName: 'Balanced', description: 'Balanced everyday work' },
      { id: 'model-c', displayName: 'Fast', description: 'Fastest responses' }
    ],
    titleGeneration: 'model-c'
  };

  it('normalizes model options from ACP and filters invalid or duplicate entries', () => {
    expect(normalizeModelOptions([
      { modelId: 'model-b', name: 'Default', description: 'Balanced' },
      { value: 'model-a', name: 'HighCapability' },
      { id: 'model-a', name: 'Duplicate Model' },
      { id: '', name: 'Empty' },
      null,
      'bad'
    ])).toEqual([
      { id: 'model-b', name: 'Default', description: 'Balanced' },
      { id: 'model-a', name: 'HighCapability' },
      { id: 'bad', name: 'bad' }
    ]);
  });

  it('derives quick model options from provider quickAccess entries', () => {
    expect(modelOptionsFromProviderConfig(providerModels)).toEqual([
      { id: 'model-a', name: 'HighCapability', description: 'Highest capability' },
      { id: 'model-b', name: 'Balanced', description: 'Balanced everyday work' },
      { id: 'model-c', name: 'Fast', description: 'Fastest responses' }
    ]);
  });

  it('finds model config options by id, category, or kind', () => {
    expect(findModelConfigOption([{ id: 'effort', type: 'select', options: [] }])).toBeNull();
    expect(findModelConfigOption([{ id: 'model', type: 'select', options: [] }])).toEqual({ id: 'model', type: 'select', options: [] });
    expect(findModelConfigOption([{ id: 'x', category: 'model', type: 'select', options: [] }])).toEqual({ id: 'x', category: 'model', type: 'select', options: [] });
    expect(findModelConfigOption([{ id: 'y', kind: 'model', type: 'select', options: [] }])).toEqual({ id: 'y', kind: 'model', type: 'select', options: [] });
    expect(findModelConfigOption(null)).toBeNull();
  });

  it('extracts model state from session result models first', () => {
    expect(extractModelState({
      models: {
        currentModelId: 'model-a',
        availableModels: [{ modelId: 'model-a', name: 'HighCapability' }]
      }
    }, providerModels)).toEqual({
      currentModelId: 'model-a',
      modelOptions: [{ id: 'model-a', name: 'HighCapability' }]
    });
  });

  it('extracts model state from model config option and fallback selection', () => {
    const configState = extractModelState({
      configOptions: [{
        id: 'model',
        type: 'select',
        currentValue: 'model-c',
        options: [{ value: 'model-c', name: 'Fast' }]
      }]
    }, providerModels);

    expect(configState).toEqual({
      currentModelId: 'model-c',
      modelOptions: [{ id: 'model-c', name: 'Fast' }]
    });

    expect(extractModelState({}, providerModels, 'default')).toEqual({
      currentModelId: 'default',
      modelOptions: []
    });
  });

  it('merges incoming model options by id without losing existing metadata', () => {
    expect(mergeModelOptions(
      [{ id: 'model-a', name: 'Old Model', description: 'old' }, { id: 'model-c', name: 'Fast' }],
      [{ id: 'model-a', name: 'HighCapability' }, { id: 'model-b', name: 'Balanced' }]
    )).toEqual([
      { id: 'model-a', name: 'HighCapability', description: 'old' },
      { id: 'model-c', name: 'Fast' },
      { id: 'model-b', name: 'Balanced' }
    ]);

    expect(mergeModelOptions([{ id: 'model-a', name: 'HighCapability' }], [])).toEqual([{ id: 'model-a', name: 'HighCapability' }]);
  });

  it('resolves quick access ids, raw ids, advertised ids, and fallbacks', () => {
    expect(resolveModelSelection('model-a', providerModels)).toEqual({ modelKey: 'model-a', modelId: 'model-a' });
    expect(resolveModelSelection('model-custom', providerModels, [{ id: 'model-custom', name: 'Balanced 1M' }])).toEqual({ modelKey: 'model-custom', modelId: 'model-custom' });
    expect(resolveModelSelection('custom-raw-id', providerModels)).toEqual({ modelKey: 'custom-raw-id', modelId: 'custom-raw-id' });
    expect(resolveModelSelection('', providerModels)).toEqual({ modelKey: 'model-b', modelId: 'model-b' });
    expect(resolveModelSelection(null, {})).toEqual({ modelKey: '', modelId: '' });
  });
});

