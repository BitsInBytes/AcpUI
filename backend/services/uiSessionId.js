import * as crypto from 'crypto';

function randomHexFallback(randomFn = Math.random) {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(randomFn() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createUuid(cryptoImpl = crypto, randomFn = Math.random) {
  if (typeof cryptoImpl.randomUUID === 'function') {
    return cryptoImpl.randomUUID();
  }
  if (typeof cryptoImpl.randomBytes === 'function') {
    const bytes = cryptoImpl.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return randomHexFallback(randomFn);
}

export function createUiSessionId(prefix = null, options = null) {
  const cryptoImpl = options?.cryptoImpl || crypto;
  const randomFn = options?.randomFn || Math.random;
  const id = createUuid(cryptoImpl, randomFn);
  return prefix ? `${prefix}-${id}` : id;
}
