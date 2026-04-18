const latestProviderStatusExtensions = new Map();
let latestProviderStatusExtension = null;

export function rememberProviderStatusExtension(extension, providerId = null) {
  if (!extension || typeof extension.method !== 'string') return;
  if (!extension.params || typeof extension.params !== 'object') return;

  const status = extension.params.status;
  if (!status || typeof status !== 'object' || !Array.isArray(status.sections)) return;

  const resolvedProviderId = providerId || extension.providerId || extension.params.providerId || status.providerId || null;
  const normalizedExtension = cloneJson({
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

  latestProviderStatusExtension = normalizedExtension;
  if (resolvedProviderId) {
    latestProviderStatusExtensions.set(resolvedProviderId, normalizedExtension);
  }
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
