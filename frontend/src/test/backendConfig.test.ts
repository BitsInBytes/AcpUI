import { describe, it, expect } from 'vitest';
import { BACKEND_PORT, BACKEND_URL } from '../utils/backendConfig';

describe('backendConfig', () => {
  it('exports BACKEND_PORT with default 3005', () => {
    expect(BACKEND_PORT).toBe('3005');
  });

  it('exports BACKEND_URL with protocol and hostname', () => {
    expect(BACKEND_URL).toContain('localhost');
    expect(BACKEND_URL).toContain(BACKEND_PORT);
  });
});
