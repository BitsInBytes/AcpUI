export function normalizeConfigOptions(options) {
  return Array.isArray(options)
    ? options.filter(option => option && typeof option.id === 'string' && option.id.length > 0)
    : [];
}

export function normalizeRemovedConfigOptionIds(removeOptionIds) {
  return Array.isArray(removeOptionIds)
    ? removeOptionIds.filter(id => typeof id === 'string' && id.length > 0)
    : [];
}

export function applyConfigOptionsChange(currentOptions, incomingOptions, change = {}) {
  const current = normalizeConfigOptions(currentOptions);
  const incoming = normalizeConfigOptions(incomingOptions);
  const removeIds = new Set(normalizeRemovedConfigOptionIds(change.removeOptionIds));

  if (change.replace === true) {
    return incoming.filter(option => !removeIds.has(option.id));
  }

  if (incoming.length === 0 && removeIds.size === 0) return current;

  const merged = current.filter(option => !removeIds.has(option.id));
  const indexById = new Map(merged.map((option, index) => [option.id, index]));

  for (const option of incoming) {
    if (removeIds.has(option.id)) continue;
    const existingIndex = indexById.get(option.id);
    if (existingIndex === undefined) {
      indexById.set(option.id, merged.length);
      merged.push(option);
    } else {
      merged[existingIndex] = { ...merged[existingIndex], ...option };
    }
  }

  return merged;
}

export function mergeConfigOptions(currentOptions, incomingOptions) {
  return applyConfigOptionsChange(currentOptions, incomingOptions);
}
