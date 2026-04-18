import type { ChatSession, ProviderModelOption } from '../types';

export interface BrandingQuickModel {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
}

export interface BrandingModels {
  default?: string;
  quickAccess?: BrandingQuickModel[];
  titleGeneration?: string;
  subAgent?: string;
}

export interface ModelChoice {
  selection: string;
  id: string;
  name: string;
  description?: string;
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

export function getModelIdForSelection(selection: string | undefined | null, _models?: BrandingModels): string {
  void _models;
  if (!selection) return '';
  return selection;
}

export function getCurrentModelId(session: ChatSession, models?: BrandingModels): string {
  return session.currentModelId || getModelIdForSelection(session.model, models) || session.model;
}

export function getModelLabel(session: ChatSession, models?: BrandingModels): string {
  const currentModelId = getCurrentModelId(session, models);
  const catalogMatch = normalizeModelOptions(session.modelOptions).find(option => option.id === currentModelId);
  if (catalogMatch) return catalogMatch.name;

  const quickMatch = getQuickModelChoices(models).find(choice => choice.id === currentModelId);
  if (quickMatch) return quickMatch.name;

  return currentModelId || 'Model';
}

export function getQuickModelChoices(models?: BrandingModels): ModelChoice[] {
  if (!Array.isArray(models?.quickAccess)) return [];

  const seen = new Set<string>();
  return models.quickAccess
    .filter(model => {
      if (!model?.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    })
    .map(model => ({
      selection: model.id,
      id: model.id,
      name: model.displayName || model.name || model.id,
      description: model.description
    }));
}

export function getFooterModelChoices(session: ChatSession, models?: BrandingModels): ModelChoice[] {
  void session;
  return getQuickModelChoices(models);
}

export function getFullModelChoices(session: ChatSession, models?: BrandingModels): ModelChoice[] {
  const catalogChoices = normalizeModelOptions(session.modelOptions).map(option => ({
    selection: option.id,
    id: option.id,
    name: option.name,
    description: option.description
  }));

  const quickChoices = getQuickModelChoices(models);
  if (catalogChoices.length > 0) return catalogChoices;
  if (quickChoices.length > 0) return quickChoices;

  const currentModelId = getCurrentModelId(session, models);
  return currentModelId
    ? [{ selection: currentModelId, id: currentModelId, name: currentModelId }]
    : [];
}

export function getFullModelSelectionValue(session: ChatSession, models?: BrandingModels): string {
  const hasCatalog = normalizeModelOptions(session.modelOptions).length > 0;
  if (hasCatalog) return getCurrentModelId(session, models);

  return getCurrentModelId(session, models);
}

export function isModelChoiceActive(session: ChatSession, choice: ModelChoice, models?: BrandingModels): boolean {
  const currentModelId = getCurrentModelId(session, models);
  if (currentModelId) return choice.id === currentModelId;
  return choice.selection === session.model;
}

export function getDefaultModelSelection(models?: BrandingModels): string {
  return models?.default || getQuickModelChoices(models)[0]?.id || '';
}
