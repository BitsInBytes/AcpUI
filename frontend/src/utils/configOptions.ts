import type { ProviderConfigOption } from '../types';

type ProviderConfigOptionLike = Partial<ProviderConfigOption> & Pick<ProviderConfigOption, 'id'>;

export interface ProviderConfigOptionsChange {
  replace?: boolean;
  removeOptionIds?: string[];
}

export function mergeProviderConfigOptions(
  currentOptions?: ProviderConfigOptionLike[],
  incomingOptions?: ProviderConfigOptionLike[],
  change: ProviderConfigOptionsChange = {}
): ProviderConfigOption[] {
  const current = (currentOptions?.filter(option => option?.id) || []) as ProviderConfigOption[];
  const incoming = incomingOptions?.filter(option => option?.id) || [];
  const removeIds = new Set((change.removeOptionIds || []).filter(id => typeof id === 'string' && id.length > 0));

  if (change.replace === true) {
    return incoming.filter(option => !removeIds.has(option.id)) as ProviderConfigOption[];
  }

  if (incoming.length === 0 && removeIds.size === 0) return current;

  const merged = current.filter(option => !removeIds.has(option.id));
  const indexById = new Map(merged.map((option, index) => [option.id, index]));

  for (const option of incoming) {
    if (removeIds.has(option.id)) continue;
    const existingIndex = indexById.get(option.id);
    if (existingIndex === undefined) {
      indexById.set(option.id, merged.length);
      merged.push(option as ProviderConfigOption);
    } else {
      merged[existingIndex] = { ...merged[existingIndex], ...option };
    }
  }

  return merged;
}
