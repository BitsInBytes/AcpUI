import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDelete } = vi.hoisted(() => ({
  mockDelete: vi.fn()
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({ config: { paths: { sessions: '/tmp/sessions' } } }),
  getProviderModule: vi.fn().mockResolvedValue({
    deleteSessionFiles: mockDelete
  })
}));
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

const { mockFs } = vi.hoisted(() => ({
  mockFs: { existsSync: vi.fn(), unlinkSync: vi.fn(), rmSync: vi.fn() }
}));
vi.mock('fs', () => ({ default: mockFs }));

import { cleanupAcpSession } from '../mcp/acpCleanup.js';

describe('cleanupAcpSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls deleteSessionFiles on the provider', async () => {
    await cleanupAcpSession('sess-123');
    expect(mockDelete).toHaveBeenCalledWith('sess-123');
  });

  it('does nothing for null/undefined acpSessionId', async () => {
    await cleanupAcpSession(null);
    await cleanupAcpSession(undefined);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
