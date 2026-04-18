import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

describe('loadCounselConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.COUNSEL_CONFIG;
  });

  it('returns core and optional agents from JSON', async () => {
    vi.doMock('fs', () => ({
      default: {
        readFileSync: vi.fn().mockReturnValue(JSON.stringify({
          agents: {
            core: [{ id: 'a', name: 'A', prompt: 'p1' }],
            optional: { architect: { name: 'Arch', prompt: 'p2' } }
          }
        }))
      }
    }));
    const { loadCounselConfig } = await import('../services/counselConfig.js');
    const config = loadCounselConfig();
    expect(config.core).toEqual([{ id: 'a', name: 'A', prompt: 'p1' }]);
    expect(config.optional.architect).toEqual({ name: 'Arch', prompt: 'p2' });
  });

  it('returns defaults when file not found', async () => {
    vi.doMock('fs', () => ({
      default: {
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); })
      }
    }));
    const { loadCounselConfig } = await import('../services/counselConfig.js');
    const config = loadCounselConfig();
    expect(config).toEqual({ core: [], optional: {} });
  });
});
