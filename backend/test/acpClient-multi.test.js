import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpClient } from '../services/acpClient.js';
import { spawn } from 'child_process';
import EventEmitter from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

vi.mock('../database.js', () => ({
  initDb: vi.fn().mockResolvedValue({})
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn((id) => ({
    config: {
      name: id,
      command: 'cli-' + id,
      args: ['acp']
    }
  })),
  getProviderModule: vi.fn().mockResolvedValue({
    performHandshake: async () => {}
  }),
  runWithProvider: vi.fn((_id, fn) => fn())
}));

describe('AcpClient Multi-Instance', () => {
  let mockIo;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = { emit: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })) };
  });

  it('maintains isolation between instances', async () => {
    const clientA = new AcpClient('provider-a');
    const clientB = new AcpClient('provider-b');

    const mockProcessA = new EventEmitter();
    mockProcessA.stdout = new EventEmitter();
    mockProcessA.stderr = new EventEmitter();
    mockProcessA.stdin = { write: vi.fn() };
    
    const mockProcessB = new EventEmitter();
    mockProcessB.stdout = new EventEmitter();
    mockProcessB.stderr = new EventEmitter();
    mockProcessB.stdin = { write: vi.fn() };

    spawn.mockReturnValueOnce(mockProcessA).mockReturnValueOnce(mockProcessB);

    await clientA.init(mockIo, 'boot-a');
    await clientB.init(mockIo, 'boot-b');

    expect(clientA.getProviderId()).toBe('provider-a');
    expect(clientB.getProviderId()).toBe('provider-b');

    expect(spawn).toHaveBeenCalledWith('cli-provider-a', expect.any(Array), expect.any(Object));
    expect(spawn).toHaveBeenCalledWith('cli-provider-b', expect.any(Array), expect.any(Object));
  });

  it('restarts only the dead instance', async () => {
    const clientA = new AcpClient('provider-a');
    const clientB = new AcpClient('provider-b');

    const mockProcessA = new EventEmitter();
    mockProcessA.stdout = new EventEmitter();
    mockProcessA.stderr = new EventEmitter();
    mockProcessA.stdin = { write: vi.fn() };
    
    const mockProcessB = new EventEmitter();
    mockProcessB.stdout = new EventEmitter();
    mockProcessB.stderr = new EventEmitter();
    mockProcessB.stdin = { write: vi.fn() };

    spawn.mockReturnValueOnce(mockProcessA).mockReturnValueOnce(mockProcessB);

    await clientA.init(mockIo, 'boot-a');
    await clientB.init(mockIo, 'boot-b');

    expect(clientA.acpProcess).toBe(mockProcessA);
    expect(clientB.acpProcess).toBe(mockProcessB);

    // Kill A
    mockProcessA.emit('exit', 1);
    expect(clientA.acpProcess).toBeNull();
    expect(clientB.acpProcess).toBe(mockProcessB);
  });
});
