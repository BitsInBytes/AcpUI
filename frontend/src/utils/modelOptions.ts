import type { ChatSession, ProviderModelOption } from '../types';

export const QUICK_MODEL_KEYS = ['fast', 'balanced', 'flagship'] as const;
export type QuickModelKey = typeof QUICK_MODEL_KEYS[number];

export interface BrandingModels {
  default?: string;
  flagship?: { id: string; displayName: string };
  balanced?: { id: string; displayName: string };
  fast?: { id: string; displayName: string };
}

export interface ModelChoice {
  selection: string;
  id: string;
  name: string;
  description?: string;
  quickKey?: QuickModelKey;
}

export function normalizeModelOptions(options?: ProviderModelOption[] | null): ProviderModelOption[] {
  if (!Array.isArray(options)) return [];

  const seen = new Set<string>();
  return options.filter(option => {
    if (!option?.id || seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

export function getModelIdForSelection(selection: string | undefined | null, models?: BrandingModels): string {
  if (!selection) return '';
  const quickModel = models?.[selection as QuickModelKey];
  return quickModel?.id || selection;
}

export function getCurrentModelId(session: ChatSession, models?: BrandingModels): string {
  return session.currentModelId || getModelIdForSelection(session.model, models) || session.model;
}

export function getModelLabel(session: ChatSession, models?: BrandingModels): string {
  const currentModelId = getCurrentModelId(session, models);
  const catalogMatch = normalizeModelOptions(session.modelOptions).find(option => option.id === currentModelId);
  if (catalogMatch) return catalogMatch.name;

  const quickKey = QUICK_MODEL_KEYS.find(key => models?.[key]?.id === currentModelId) ||
    QUICK_MODEL_KEYS.find(key => key === session.model);
  if (quickKey) return models?.[quickKey]?.displayName || quickKey;

  return currentModelId || 'Model';
}

export function getQuickModelChoices(models?: BrandingModels): ModelChoice[] {
  return QUICK_MODEL_KEYS
    .map(key => {
      const model = models?.[key];
      if (!model?.id) return null;
      return {
        selection: key,
        id: model.id,
        name: model.displayName || key,
        quickKey: key
      };
    })
    .filter(Boolean) as ModelChoice[];
}

export function getFooterModelChoices(session: ChatSession, models?: BrandingModels): ModelChoice[] {
  const currentModelId = getCurrentModelId(session, models);
  const quickChoices = getQuickModelChoices(models);
  const hasCurrentQuick = quickChoices.some(choice => choice.id === currentModelId || choice.selection === session.model);
  if (hasCurrentQuick || !currentModelId) return quickChoices;

  const catalogMatch = normalizeModelOptions(session.modelOptions).find(option => option.id === currentModelId);
  return [
    {
      selection: currentModelId,
      id: currentModelId,
      name: catalogMatch?.name || currentModelId,
      description: catalogMatch?.description
    },
    ...quickChoices
  ];
}

export function getFullModelChoices(session: ChatSession, models?: BrandingModels): ModelChoice[] {
  const catalogChoices = normalizeModelOptions(session.modelOptions).map(option => ({
    selection: option.id,
    id: option.id,
    name: option.name,
    description: option.description
  }));

  return catalogChoices.length > 0 ? catalogChoices : getQuickModelChoices(models);
}

export function getFullModelSelectionValue(session: ChatSession, models?: BrandingModels): string {
  const hasCatalog = normalizeModelOptions(session.modelOptions).length > 0;
  if (hasCatalog) return getCurrentModelId(session, models);

  const quickMatch = QUICK_MODEL_KEYS.find(key => models?.[key]?.id === session.currentModelId) ||
    QUICK_MODEL_KEYS.find(key => key === session.model);
  return quickMatch || session.model;
}

export function isModelChoiceActive(session: ChatSession, choice: ModelChoice, models?: BrandingModels): boolean {
  const currentModelId = getCurrentModelId(session, models);
  if (currentModelId) return choice.id === currentModelId;
  return choice.selection === session.model;
}
