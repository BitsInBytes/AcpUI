import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    cpSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  cpSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../database.js', () => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  deleteSession: vi.fn(),
  getAllSessions: vi.fn().mockResolvedValue([]),
  getActiveSubAgentInvocationForParent: vi.fn().mockResolvedValue(null),
  deleteSubAgentInvocationsForParent: vi.fn().mockResolvedValue(),
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => ({
    config: {
      name: 'Test',
      command: 'test-cli',
      args: ['acp'],
      protocolPrefix: '_test.dev/',
      paths: { sessions: '/tmp/test-sessions', agents: '/tmp/test-agents', attachments: '/tmp/test-attachments', archive: '/tmp/archives' },
      clientInfo: { name: 'TestUI', version: '1.0.0' },
      branding: { assistantName: 'Test' },
      models: { flagship: { id: 'test-flagship', displayName: 'Flagship' }, balanced: { id: 'test-balanced', displayName: 'Balanced' }, titleGeneration: 'test-balanced' },
    }
  }),
  getProviderModule: vi.fn().mockResolvedValue({
    deleteSessionFiles: vi.fn(),
    archiveSessionFiles: vi.fn(),
    restoreSessionFiles: vi.fn()
  })
}));

vi.mock('../services/attachmentVault.js', () => ({
  getAttachmentsRoot: () => '/tmp/test-attachments',
  upload: { array: () => (req, res, next) => next() },
  handleUpload: vi.fn()
}));

import registerArchiveHandlers from '../sockets/archiveHandlers.js';
import fs from 'fs';
import * as db from '../database.js';
import { getProviderModule } from '../services/providerLoader.js';

describe('archiveHandlers', () => {
  let mockIo, mockSocket, mockProviderModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.HOME = '/home/test';
    mockIo = new EventEmitter();
    mockSocket = new EventEmitter();
    mockSocket.id = 'test-socket';
    mockProviderModule = await getProviderModule();
    registerArchiveHandlers(mockIo, mockSocket);
  });

  describe('list_archives', () => {
    it('returns folder names that contain session.json', () => {
      fs.existsSync.mockImplementation((p) => true);
      fs.readdirSync.mockReturnValue(['chat1', 'chat2']);
      fs.statSync.mockReturnValue({ isDirectory: () => true });

      const callback = vi.fn();
      mockSocket.listeners('list_archives')[0](callback);

      expect(callback).toHaveBeenCalledWith({ archives: ['chat1', 'chat2'] });
    });

    it('returns empty archives when archive path does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      const callback = vi.fn();
      mockSocket.listeners('list_archives')[0](callback);
      expect(callback).toHaveBeenCalledWith({ archives: [] });
    });

    it('returns empty archives on error', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockImplementation(() => { throw new Error('EACCES'); });
      const callback = vi.fn();
      mockSocket.listeners('list_archives')[0](callback);
      expect(callback).toHaveBeenCalledWith({ archives: [] });
    });
  });

  describe('restore_archive', () => {
    it('copies files via provider and creates DB record', async () => {
      const saved = { acpSessionId: 'acp-1', name: 'Test', model: 'flagship', messages: [] };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(saved));
      db.saveSession.mockResolvedValue();

      const callback = vi.fn();
      await mockSocket.listeners('restore_archive')[0]({ folderName: 'Test' }, callback);

      expect(mockProviderModule.restoreSessionFiles).toHaveBeenCalledWith('acp-1', expect.stringContaining('Test'));
      expect(db.saveSession).toHaveBeenCalledWith(expect.objectContaining({ name: 'Test', acpSessionId: 'acp-1' }));
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('returns error when session.json not found in archive', async () => {
      fs.existsSync.mockReturnValue(false);
      const callback = vi.fn();
      await mockSocket.listeners('restore_archive')[0]({ folderName: 'missing' }, callback);
      expect(callback).toHaveBeenCalledWith({ error: expect.stringContaining('session.json not found') });
    });

    it('returns error when restore throws', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => { throw new Error('read failed'); });
      const callback = vi.fn();
      await mockSocket.listeners('restore_archive')[0]({ folderName: 'bad' }, callback);
      expect(callback).toHaveBeenCalledWith({ error: expect.stringContaining('read failed') });
    });
  });

  describe('delete_archive', () => {
    it('removes folder', () => {
      fs.existsSync.mockReturnValue(true);
      const callback = vi.fn();
      mockSocket.listeners('delete_archive')[0]({ folderName: 'old-chat' }, callback);

      expect(fs.rmSync).toHaveBeenCalledWith(expect.stringContaining('old-chat'), { recursive: true, force: true });
      expect(callback).toHaveBeenCalledWith({ success: true });
    });

    it('returns error when rmSync throws', () => {
      fs.existsSync.mockReturnValue(true);
      fs.rmSync.mockImplementationOnce(() => { throw new Error('permission denied'); });
      const callback = vi.fn();
      mockSocket.listeners('delete_archive')[0]({ folderName: 'locked-chat' }, callback);
      expect(callback).toHaveBeenCalledWith({ error: 'permission denied' });
    });
  });

  describe('archive_session', () => {
    it('archives via provider and saves session.json', async () => {
      db.getSession.mockResolvedValue({ id: 'ui-1', acpSessionId: 'acp-1', name: 'My Chat', model: 'flagship', messages: [], isPinned: false });
      // archiveDir doesn't exist yet (triggers mkdir), but session files and attach dir do
      fs.existsSync.mockImplementation((p) => !p.endsWith('My Chat'));

      await mockSocket.listeners('archive_session')[0]({ uiId: 'ui-1' });

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(mockProviderModule.archiveSessionFiles).toHaveBeenCalledWith('acp-1', expect.stringContaining('My Chat'));
      expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('session.json'), expect.any(String));
      expect(db.deleteSession).toHaveBeenCalledWith('ui-1');
    });

    it('recursively deletes descendant sessions before archiving parent', async () => {
      db.getSession.mockResolvedValue({ id: 'parent', acpSessionId: 'acp-parent', name: 'Parent Chat', model: 'flagship', messages: [], isPinned: false });
      db.getAllSessions.mockResolvedValue([
        { id: 'parent', acpSessionId: 'acp-parent', name: 'Parent Chat' },
        { id: 'child', acpSessionId: 'acp-child', forkedFrom: 'parent' },
        { id: 'grandchild', acpSessionId: 'acp-grandchild', forkedFrom: 'child' },
        { id: 'other', acpSessionId: 'acp-other' },
      ]);
      fs.existsSync.mockReturnValue(false);

      await mockSocket.listeners('archive_session')[0]({ uiId: 'parent' });

      expect(mockProviderModule.deleteSessionFiles).toHaveBeenCalledWith('acp-child');
      expect(mockProviderModule.deleteSessionFiles).toHaveBeenCalledWith('acp-grandchild');
      expect(db.deleteSession).toHaveBeenCalledWith('child');
      expect(db.deleteSession).toHaveBeenCalledWith('grandchild');
      expect(db.deleteSession).not.toHaveBeenCalledWith('other');
    });

    it('logs error when getSession throws', async () => {
      const { writeLog } = await import('../services/logger.js');
      db.getSession.mockRejectedValueOnce(new Error('DB down'));
      await mockSocket.listeners('archive_session')[0]({ uiId: 'ui-err' });
      expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('DB down'));
    });

    it('does not call deleteSession for descendants when there are none', async () => {
      db.getSession.mockResolvedValue({ id: 'solo', acpSessionId: 'acp-solo', name: 'Solo Chat', model: 'flagship', messages: [], isPinned: false });
      db.getAllSessions.mockResolvedValue([
        { id: 'solo', acpSessionId: 'acp-solo', name: 'Solo Chat' },
        { id: 'unrelated', acpSessionId: 'acp-unrelated' },
      ]);
      fs.existsSync.mockReturnValue(false);

      await mockSocket.listeners('archive_session')[0]({ uiId: 'solo' });

      // Only the parent itself should be deleted (from archiveHandlers after move)
      expect(db.deleteSession).toHaveBeenCalledWith('solo');
      expect(db.deleteSession).not.toHaveBeenCalledWith('unrelated');
    });
  });
});
