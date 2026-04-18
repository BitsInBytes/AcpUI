function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeModelOption(option) {
  if (typeof option === 'string' && option.trim()) {
    return { id: option, name: option };
  }
  if (!isObject(option)) return null;

  const id = option.id || option.modelId || option.value;
  if (!id || typeof id !== 'string') return null;

  return {
    id,
    name: option.name || option.displayName || id,
    ...(option.description ? { description: option.description } : {})
  };
}

export function normalizeModelOptions(options) {
  if (!Array.isArray(options)) return [];

  const seen = new Set();
  const normalized = [];
  for (const option of options) {
    const modelOption = normalizeModelOption(option);
    if (!modelOption || seen.has(modelOption.id)) continue;
    seen.add(modelOption.id);
    normalized.push(modelOption);
  }
  return normalized;
}

export function modelOptionsFromProviderConfig(models = {}) {
  return normalizeModelOptions(models?.quickAccess || []);
}

export function findModelConfigOption(configOptions) {
  if (!Array.isArray(configOptions)) return null;
  return configOptions.find(option =>
    option?.type === 'select' &&
    Array.isArray(option.options) &&
    (option.id === 'model' || option.category === 'model' || option.kind === 'model')
  ) || null;
}

export function extractModelState(source = {}, providerModels = {}, fallbackSelection) {
  const resultModels = isObject(source.models) ? source.models : {};
  const modelConfigOption = findModelConfigOption(source.configOptions);

  const modelOptions = normalizeModelOptions(
    resultModels.availableModels ||
    source.modelOptions ||
    modelConfigOption?.options ||
    []
  );

  const hasFallbackSelection = typeof fallbackSelection === 'string' && fallbackSelection.trim();
  const currentModelId =
    resultModels.currentModelId ||
    source.currentModelId ||
    modelConfigOption?.currentValue ||
    (hasFallbackSelection ? resolveModelSelection(fallbackSelection, providerModels, modelOptions).modelId : null) ||
    null;

  return { modelOptions, currentModelId };
}

export function mergeModelOptions(currentOptions, incomingOptions) {
  const current = normalizeModelOptions(currentOptions);
  const incoming = normalizeModelOptions(incomingOptions);
  if (incoming.length === 0) return current;

  const byId = new Map(current.map(option => [option.id, option]));
  for (const option of incoming) {
    byId.set(option.id, { ...byId.get(option.id), ...option });
  }
  return Array.from(byId.values());
}

export function resolveModelSelection(selection, providerModels = {}, modelOptions = []) {
  const configuredQuickOptions = modelOptionsFromProviderConfig(providerModels);
  const advertisedOptions = normalizeModelOptions(modelOptions);
  const fallbackModelId =
    (typeof providerModels.default === 'string' && providerModels.default.trim() ? providerModels.default : null) ||
    configuredQuickOptions[0]?.id ||
    advertisedOptions[0]?.id ||
    '';
  const normalizedSelection = typeof selection === 'string' && selection.trim()
    ? selection
    : fallbackModelId;

  const advertisedModel = advertisedOptions.find(option => option.id === normalizedSelection);
  if (advertisedModel) {
    return { modelKey: normalizedSelection, modelId: normalizedSelection };
  }

  const quickModel = configuredQuickOptions.find(option => option.id === normalizedSelection);
  if (quickModel) {
    return { modelKey: normalizedSelection, modelId: normalizedSelection };
  }

  if (typeof normalizedSelection === 'string' && normalizedSelection.trim()) {
    return { modelKey: normalizedSelection, modelId: normalizedSelection };
  }

  return { modelKey: '', modelId: '' };
}
