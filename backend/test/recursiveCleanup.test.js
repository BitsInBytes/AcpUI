import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerSessionHandlers from '../sockets/sessionHandlers.js';
import * as db from '../database.js';
import fs from 'fs';
import EventEmitter from 'events';

vi.mock('../database.js');
vi.mock('../services/logger.js');
vi.mock('../services/providerLoader.js');
vi.mock('../services/attachmentVault.js', () => ({ getAttachmentsRoot: () => '/tmp/attach' }));
vi.mock('../mcp/acpCleanup.js', () => ({ cleanupAcpSession: vi.fn() }));

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn().mockReturnValue(true),
    rmSync: vi.fn(),
    cpSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
    createWriteStream: vi.fn().mockReturnValue({ write: vi.fn(), on: vi.fn() })
  }
}));

vi.mock('fs', () => ({
  default: mockFs,
  ...mockFs
}));

describe('Recursive Cleanup', () => {
  let mockIo, mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = new EventEmitter();
    mockSocket = new EventEmitter();
    registerSessionHandlers(mockIo, mockSocket);
  });

  it('should delete parent and children recursively', async () => {
    const parent = { id: 'p1', acpSessionId: 'ap1', provider: 'p1' };
    const child = { id: 'c1', acpSessionId: 'ac1', forkedFrom: 'p1', provider: 'p1' };
    const grandchild = { id: 'g1', acpSessionId: 'ag1', forkedFrom: 'c1', provider: 'p1' };

    db.getSession.mockResolvedValue(parent);
    db.getAllSessions.mockResolvedValue([parent, child, grandchild]);

    const handler = mockSocket.listeners('delete_session')[0];
    await handler({ uiId: 'p1' });

    expect(db.deleteSession).toHaveBeenCalledWith('p1');
    expect(db.deleteSession).toHaveBeenCalledWith('c1');
    expect(db.deleteSession).toHaveBeenCalledWith('g1');
    expect(mockFs.rmSync).toHaveBeenCalledTimes(3);
  });
});
