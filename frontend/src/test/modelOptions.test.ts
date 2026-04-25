import { describe, expect, it } from 'vitest';
import type { ChatSession } from '../types';
import {
  getCurrentModelId,
  getFooterModelChoices,
  getFullModelChoices,
  getFullModelSelectionValue,
  getModelIdForSelection,
  getModelLabel,
  getQuickModelChoices,
  isModelChoiceActive,
  normalizeModelOptions
} from '../utils/modelOptions';

const brandingModels = {
  default: 'balanced',
  flagship: { id: 'opus', displayName: 'Opus' },
  balanced: { id: 'default', displayName: 'Sonnet' },
  fast: { id: 'haiku', displayName: 'Haiku' }
};

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 's1',
  acpSessionId: 'acp-1',
  name: 'Test',
  messages: [],
  isTyping: false,
  isWarmingUp: false,
  model: 'balanced',
  ...overrides
});

describe('frontend modelOptions utilities', () => {
  it('normalizes model options and removes invalid duplicates', () => {
    expect(normalizeModelOptions([
      { id: 'opus', name: 'Opus' },
      { id: 'opus', name: 'Duplicate' },
      { id: '', name: 'Invalid' },
      null as any
    ])).toEqual([{ id: 'opus', name: 'Opus' }]);

    expect(normalizeModelOptions(null)).toEqual([]);
  });

  it('resolves selected model ids from quick aliases or raw ids', () => {
    expect(getModelIdForSelection('flagship', brandingModels)).toBe('opus');
    expect(getModelIdForSelection('sonnet[1m]', brandingModels)).toBe('sonnet[1m]');
    expect(getModelIdForSelection(null, brandingModels)).toBe('');
  });

  it('labels current models from catalog, quick access, or raw id', () => {
    expect(getCurrentModelId(session({ currentModelId: 'opus' }), brandingModels)).toBe('opus');
    expect(getCurrentModelId(session({ model: 'flagship' }), brandingModels)).toBe('opus');

    expect(getModelLabel(session({
      currentModelId: 'sonnet[1m]',
      modelOptions: [{ id: 'sonnet[1m]', name: 'Sonnet 1M' }]
    }), brandingModels)).toBe('Sonnet 1M');

    expect(getModelLabel(session({ currentModelId: 'opus' }), brandingModels)).toBe('Opus');
    expect(getModelLabel(session({ model: 'custom-model' }), brandingModels)).toBe('custom-model');
  });

  it('builds quick model choices from branding', () => {
    expect(getQuickModelChoices(brandingModels)).toEqual([
      { selection: 'fast', id: 'haiku', name: 'Haiku', quickKey: 'fast' },
      { selection: 'balanced', id: 'default', name: 'Sonnet', quickKey: 'balanced' },
      { selection: 'flagship', id: 'opus', name: 'Opus', quickKey: 'flagship' }
    ]);

    expect(getQuickModelChoices({ balanced: { id: 'default', displayName: 'Sonnet' } })).toEqual([
      { selection: 'balanced', id: 'default', name: 'Sonnet', quickKey: 'balanced' }
    ]);
  });

  it('keeps footer choices quick-access unless current model is outside quick access', () => {
    expect(getFooterModelChoices(session({ currentModelId: 'opus' }), brandingModels).map(choice => choice.selection)).toEqual([
      'fast',
      'balanced',
      'flagship'
    ]);

    expect(getFooterModelChoices(session({
      currentModelId: 'sonnet[1m]',
      model: 'sonnet[1m]',
      modelOptions: [{ id: 'sonnet[1m]', name: 'Sonnet 1M', description: 'Large context' }]
    }), brandingModels)).toEqual([
      { selection: 'sonnet[1m]', id: 'sonnet[1m]', name: 'Sonnet 1M', description: 'Large context' },
      { selection: 'fast', id: 'haiku', name: 'Haiku', quickKey: 'fast' },
      { selection: 'balanced', id: 'default', name: 'Sonnet', quickKey: 'balanced' },
      { selection: 'flagship', id: 'opus', name: 'Opus', quickKey: 'flagship' }
    ]);
  });

  it('builds full model choices from catalog with quick fallback', () => {
    expect(getFullModelChoices(session({
      modelOptions: [{ id: 'default', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }]
    }), brandingModels)).toEqual([
      { selection: 'default', id: 'default', name: 'Sonnet', description: undefined },
      { selection: 'opus', id: 'opus', name: 'Opus', description: undefined }
    ]);

    expect(getFullModelChoices(session(), brandingModels).map(choice => choice.selection)).toEqual([
      'fast',
      'balanced',
      'flagship'
    ]);
  });

  it('selects full model value from catalog or quick fallback', () => {
    expect(getFullModelSelectionValue(session({
      currentModelId: 'sonnet[1m]',
      modelOptions: [{ id: 'sonnet[1m]', name: 'Sonnet 1M' }]
    }), brandingModels)).toBe('sonnet[1m]');

    expect(getFullModelSelectionValue(session({ currentModelId: 'opus' }), brandingModels)).toBe('flagship');
    expect(getFullModelSelectionValue(session({ model: 'custom-model' }), brandingModels)).toBe('custom-model');
  });

  it('detects active choices by model id or selection', () => {
    expect(isModelChoiceActive(session({ currentModelId: 'opus' }), { selection: 'flagship', id: 'opus', name: 'Opus' }, brandingModels)).toBe(true);
    expect(isModelChoiceActive(session({ model: 'balanced' }), { selection: 'balanced', id: 'default', name: 'Sonnet' }, brandingModels)).toBe(true);
    expect(isModelChoiceActive(session({ currentModelId: 'haiku' }), { selection: 'flagship', id: 'opus', name: 'Opus' }, brandingModels)).toBe(false);
  });
});

