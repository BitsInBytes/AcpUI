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
    default: 'balanced',
    flagship: { id: 'opus', displayName: 'Opus' },
    balanced: { id: 'default', displayName: 'Sonnet' },
    fast: { id: 'haiku', displayName: 'Haiku' },
    titleGeneration: 'haiku'
  };

  it('normalizes model options from ACP and filters invalid or duplicate entries', () => {
    expect(normalizeModelOptions([
      { modelId: 'default', name: 'Default', description: 'Sonnet' },
      { value: 'opus', name: 'Opus' },
      { id: 'opus', name: 'Duplicate Opus' },
      { id: '', name: 'Empty' },
      null,
      'bad'
    ])).toEqual([
      { id: 'default', name: 'Default', description: 'Sonnet' },
      { id: 'opus', name: 'Opus' }
    ]);
  });

  it('derives quick model options from provider config only for real model entries', () => {
    expect(modelOptionsFromProviderConfig(providerModels)).toEqual([
      { id: 'haiku', name: 'Haiku' },
      { id: 'default', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' }
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
        currentModelId: 'opus',
        availableModels: [{ modelId: 'opus', name: 'Opus' }]
      }
    }, providerModels)).toEqual({
      currentModelId: 'opus',
      modelOptions: [{ id: 'opus', name: 'Opus' }]
    });
  });

  it('extracts model state from model config option and fallback selection', () => {
    const configState = extractModelState({
      configOptions: [{
        id: 'model',
        type: 'select',
        currentValue: 'haiku',
        options: [{ value: 'haiku', name: 'Haiku' }]
      }]
    }, providerModels);

    expect(configState).toEqual({
      currentModelId: 'haiku',
      modelOptions: [{ id: 'haiku', name: 'Haiku' }]
    });

    expect(extractModelState({}, providerModels, 'balanced')).toEqual({
      currentModelId: 'default',
      modelOptions: []
    });
  });

  it('merges incoming model options by id without losing existing metadata', () => {
    expect(mergeModelOptions(
      [{ id: 'opus', name: 'Old Opus', description: 'old' }, { id: 'haiku', name: 'Haiku' }],
      [{ id: 'opus', name: 'Opus' }, { id: 'default', name: 'Sonnet' }]
    )).toEqual([
      { id: 'opus', name: 'Opus', description: 'old' },
      { id: 'haiku', name: 'Haiku' },
      { id: 'default', name: 'Sonnet' }
    ]);

    expect(mergeModelOptions([{ id: 'opus', name: 'Opus' }], [])).toEqual([{ id: 'opus', name: 'Opus' }]);
  });

  it('resolves quick aliases, raw ids, advertised ids, and fallbacks', () => {
    expect(resolveModelSelection('flagship', providerModels)).toEqual({ modelKey: 'flagship', modelId: 'opus' });
    expect(resolveModelSelection('opus', providerModels)).toEqual({ modelKey: 'flagship', modelId: 'opus' });
    expect(resolveModelSelection('sonnet[1m]', providerModels, [{ id: 'sonnet[1m]', name: 'Sonnet 1M' }])).toEqual({ modelKey: 'sonnet[1m]', modelId: 'sonnet[1m]' });
    expect(resolveModelSelection('custom-raw-id', providerModels)).toEqual({ modelKey: 'custom-raw-id', modelId: 'custom-raw-id' });
    expect(resolveModelSelection('', providerModels)).toEqual({ modelKey: 'balanced', modelId: 'default' });
    expect(resolveModelSelection(null, {})).toEqual({ modelKey: 'flagship', modelId: 'flagship' });
  });
});

