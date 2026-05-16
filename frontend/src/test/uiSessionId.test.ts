import { describe, it, expect } from 'vitest';
import { createUiSessionId } from '../utils/uiSessionId';

describe('createUiSessionId (frontend)', () => {
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
});
