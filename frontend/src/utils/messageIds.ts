export type MessageIdPrefix = 'assistant' | 'user' | 'merge';

let fallbackCounter = 0;

function createFallbackSuffix(): string {
  fallbackCounter += 1;
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

export function createMessageId(prefix: MessageIdPrefix): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${createFallbackSuffix()}`;
}
