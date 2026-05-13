const latestProviderStatusExtensions = new Map();
let latestProviderStatusExtension = null;

export function normalizeProviderStatusExtension(extension, providerId = null) {
  if (!extension || typeof extension.method !== 'string') return null;
  if (!extension.params || typeof extension.params !== 'object') return null;

  const status = extension.params.status;
  if (!status || typeof status !== 'object' || !Array.isArray(status.sections)) return null;

  const resolvedProviderId = providerId || extension.providerId || extension.params.providerId || status.providerId || null;
  return cloneJson({
    ...extension,
    ...(resolvedProviderId ? { providerId: resolvedProviderId } : {}),
    params: {
      ...extension.params,
      ...(resolvedProviderId ? { providerId: resolvedProviderId } : {}),
      status: {
        ...status,
        ...(resolvedProviderId ? { providerId: resolvedProviderId } : {})
      }
    }
  });
}

export function rememberProviderStatusExtension(extension, providerId = null) {
  const normalizedExtension = normalizeProviderStatusExtension(extension, providerId);
  if (!normalizedExtension) return null;

  latestProviderStatusExtension = normalizedExtension;
  if (normalizedExtension.providerId) {
    latestProviderStatusExtensions.set(normalizedExtension.providerId, normalizedExtension);
  }
  return cloneJson(normalizedExtension);
}

export function getLatestProviderStatusExtension(providerId = null) {
  if (providerId) {
    const extension = latestProviderStatusExtensions.get(providerId);
    return extension ? cloneJson(extension) : null;
  }
  return latestProviderStatusExtension ? cloneJson(latestProviderStatusExtension) : null;
}

export function getLatestProviderStatusExtensions() {
  return Array.from(latestProviderStatusExtensions.values()).map(cloneJson);
}

export function clearProviderStatusExtension(providerId = null) {
  if (providerId) {
    latestProviderStatusExtensions.delete(providerId);
    if (latestProviderStatusExtension?.providerId === providerId) {
      latestProviderStatusExtension = null;
    }
    return;
  }
  latestProviderStatusExtension = null;
  latestProviderStatusExtensions.clear();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
