import { describe, it, expect } from 'vitest';
import { createUiSessionId } from '../services/uiSessionId.js';

describe('createUiSessionId (backend)', () => {
  it('generates UUID-shaped IDs', () => {
    const id = createUiSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('supports prefixed IDs', () => {
    const id = createUiSessionId('fork');
    expect(id).toMatch(/^fork-[0-9a-f-]{36}$/i);
  });

  it('does not collide in rapid generation', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createUiSessionId()));
    expect(ids.size).toBe(500);
  });

  it('uses randomBytes when randomUUID is unavailable', () => {
    const id = createUiSessionId(null, {
      cryptoImpl: {
        randomUUID: null,
        randomBytes: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex')
      }
    });

    expect(id).toBe('00112233-4455-4677-8899-aabbccddeeff');
  });

  it('uses Math.random fallback when crypto helpers are unavailable', () => {
    const id = createUiSessionId(null, {
      cryptoImpl: {
        randomUUID: null,
        randomBytes: null
      },
      randomFn: () => 0
    });

    expect(id).toBe('00000000-0000-4000-8000-000000000000');
  });
});
