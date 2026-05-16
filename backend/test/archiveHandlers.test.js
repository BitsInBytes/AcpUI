import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    cpSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
  cpSync: vi.fn(),
  rmSync: vi.fn(),
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

vi.mock('../mcp/subAgentInvocationManager.js', () => ({
  subAgentInvocationManager: {
    cancelInvocation: vi.fn().mockResolvedValue(),
  },
}));

const providerModules = {
  'provider-a': {
    deleteSessionFiles: vi.fn(),
    archiveSessionFiles: vi.fn(),
    restoreSessionFiles: vi.fn(),
  },
  'provider-b': {
    deleteSessionFiles: vi.fn(),
    archiveSessionFiles: vi.fn(),
    restoreSessionFiles: vi.fn(),
  },
};

const providers = {
  'provider-a': {
    id: 'provider-a',
    config: { paths: { archive: '/tmp/archives/provider-a' } },
  },
  'provider-b': {
    id: 'provider-b',
    config: { paths: { archive: '/tmp/archives/provider-b' } },
  },
};

vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn((id) => providers[id || 'provider-a']),
  getProviderModule: vi.fn(async (id) => providerModules[id || 'provider-a']),
}));

vi.mock('../services/attachmentVault.js', () => ({
  getAttachmentsRoot: vi.fn((providerId = null) => `/tmp/attachments/${providerId || 'default'}`),
  upload: { array: () => (req, res, next) => next() },
  handleUpload: vi.fn(),
}));

import registerArchiveHandlers from '../sockets/archiveHandlers.js';
import fs from 'fs';
import * as db from '../database.js';
import { writeLog } from '../services/logger.js';
import { getAttachmentsRoot } from '../services/attachmentVault.js';
import { getProviderModule } from '../services/providerLoader.js';
import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';

describe('archiveHandlers', () => {
  let mockIo;
  let mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = new EventEmitter();
    mockSocket = new EventEmitter();
    mockSocket.id = 'test-socket';
    registerArchiveHandlers(mockIo, mockSocket);
  });

  describe('list_archives', () => {
    it('returns folder names that contain session.json', () => {
      fs.existsSync.mockImplementation(() => true);
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

    it('returns empty archives on list error', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      const callback = vi.fn();
      mockSocket.listeners('list_archives')[0](callback);

      expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('[ARCHIVE ERR] list_archives: EACCES'));
      expect(callback).toHaveBeenCalledWith({ archives: [] });
    });
  });

  describe('restore_archive', () => {
    it('preserves saved provider identity and uses provider-scoped attachment root', async () => {
      const saved = {
        acpSessionId: 'acp-1',
        name: 'Restored',
        model: 'flagship',
        messages: [],
        provider: 'provider-b',
      };
      fs.existsSync.mockImplementation((p) => p.includes('session.json') || p.endsWith('attachments'));
      fs.readFileSync.mockReturnValue(JSON.stringify(saved));
      db.saveSession.mockResolvedValue();

      const callback = vi.fn();
      await mockSocket.listeners('restore_archive')[0]({ folderName: 'RestoreMe', providerId: 'provider-a' }, callback);

      const providerBModule = await getProviderModule('provider-b');
      expect(providerBModule.restoreSessionFiles).toHaveBeenCalledWith('acp-1', expect.stringContaining('RestoreMe'));
      expect(getAttachmentsRoot).toHaveBeenCalledWith('provider-b');
      expect(db.saveSession).toHaveBeenCalledWith(expect.objectContaining({
        acpSessionId: 'acp-1',
        provider: 'provider-b',
      }));
      expect(db.saveSession.mock.calls[0][0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: true, providerId: 'provider-b' }));
    });

    it('returns error when session.json is missing', async () => {
      fs.existsSync.mockReturnValue(false);
      const callback = vi.fn();

      await mockSocket.listeners('restore_archive')[0]({ folderName: 'missing', providerId: 'provider-a' }, callback);

      expect(callback).toHaveBeenCalledWith({ error: 'session.json not found in archive' });
    });

    it('returns callback error when restore throws', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('read failed');
      });
      const callback = vi.fn();

      await mockSocket.listeners('restore_archive')[0]({ folderName: 'broken', providerId: 'provider-a' }, callback);

      expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('[RESTORE ERR] read failed'));
      expect(callback).toHaveBeenCalledWith({ error: 'read failed' });
    });
  });

  describe('archive_session', () => {
    it('archives via provider and saves session.json with provider id', async () => {
      db.getSession.mockResolvedValue({
        id: 'ui-1',
        acpSessionId: 'acp-1',
        name: 'My Chat',
        model: 'flagship',
        messages: [],
        isPinned: false,
        provider: 'provider-a',
      });
      fs.existsSync.mockImplementation((p) => !p.includes('My Chat'));

      await mockSocket.listeners('archive_session')[0]({ uiId: 'ui-1' });

      const providerAModule = await getProviderModule('provider-a');
      expect(providerAModule.archiveSessionFiles).toHaveBeenCalledWith('acp-1', expect.stringContaining('My Chat'));
      expect(getAttachmentsRoot).toHaveBeenCalledWith('provider-a');
      const savedJson = fs.writeFileSync.mock.calls[0][1];
      expect(savedJson).toContain('"provider": "provider-a"');
      expect(db.deleteSession).toHaveBeenCalledWith('ui-1');
    });

    it('cancels active sub-agent invocation before archive cleanup', async () => {
      db.getSession.mockResolvedValue({
        id: 'ui-1',
        acpSessionId: 'acp-1',
        name: 'My Chat',
        model: 'flagship',
        messages: [],
        isPinned: false,
        provider: 'provider-a',
      });
      db.getActiveSubAgentInvocationForParent.mockResolvedValueOnce({ invocationId: 'inv-1' });
      fs.existsSync.mockReturnValue(false);

      await mockSocket.listeners('archive_session')[0]({ uiId: 'ui-1' });

      expect(subAgentInvocationManager.cancelInvocation).toHaveBeenCalledWith('provider-a', 'inv-1');
    });

    it('uses each descendant provider for cleanup and attachment deletion', async () => {
      db.getSession.mockResolvedValue({
        id: 'parent',
        acpSessionId: 'acp-parent',
        name: 'Parent Chat',
        model: 'flagship',
        messages: [],
        isPinned: false,
        provider: 'provider-a',
      });
      db.getAllSessions.mockResolvedValue([
        { id: 'parent', acpSessionId: 'acp-parent', provider: 'provider-a' },
        { id: 'child-a', acpSessionId: 'acp-child-a', forkedFrom: 'parent', provider: 'provider-a' },
        { id: 'child-b', acpSessionId: 'acp-child-b', forkedFrom: 'parent', provider: 'provider-b' },
      ]);
      fs.existsSync.mockImplementation((p) => (p.includes('provider-a') && p.includes('child-a')) || (p.includes('provider-b') && p.includes('child-b')));

      await mockSocket.listeners('archive_session')[0]({ uiId: 'parent' });

      const providerAModule = await getProviderModule('provider-a');
      const providerBModule = await getProviderModule('provider-b');
      expect(providerAModule.deleteSessionFiles).toHaveBeenCalledWith('acp-child-a');
      expect(providerBModule.deleteSessionFiles).toHaveBeenCalledWith('acp-child-b');
      expect(getAttachmentsRoot).toHaveBeenCalledWith('provider-a');
      expect(getAttachmentsRoot).toHaveBeenCalledWith('provider-b');
      expect(db.deleteSession).toHaveBeenCalledWith('child-a');
      expect(db.deleteSession).toHaveBeenCalledWith('child-b');
    });

    it('logs archive error when session lookup throws', async () => {
      db.getSession.mockRejectedValueOnce(new Error('db down'));

      await mockSocket.listeners('archive_session')[0]({ uiId: 'ui-err' });

      expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('[ARCHIVE ERR] db down'));
    });
  });

  describe('delete_archive', () => {
    it('removes folder', () => {
      fs.existsSync.mockReturnValue(true);
      const callback = vi.fn();
      mockSocket.listeners('delete_archive')[0]({ folderName: 'old-chat', providerId: 'provider-a' }, callback);

      expect(fs.rmSync).toHaveBeenCalledWith(expect.stringContaining('old-chat'), { recursive: true, force: true });
      expect(callback).toHaveBeenCalledWith({ success: true });
    });

    it('returns callback error when delete throws', () => {
      fs.existsSync.mockReturnValue(true);
      fs.rmSync.mockImplementation(() => {
        throw new Error('permission denied');
      });

      const callback = vi.fn();
      mockSocket.listeners('delete_archive')[0]({ folderName: 'locked-chat', providerId: 'provider-a' }, callback);

      expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('[ARCHIVE ERR] delete failed: permission denied'));
      expect(callback).toHaveBeenCalledWith({ error: 'permission denied' });
    });
  });
});
