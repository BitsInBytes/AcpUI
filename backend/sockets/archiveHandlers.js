import fs from 'fs';
import path from 'path';
import { writeLog } from '../services/logger.js';
import * as db from '../database.js';
import { getProvider, getProviderModule } from '../services/providerLoader.js';
import { getAttachmentsRoot } from '../services/attachmentVault.js';

export default function registerArchiveHandlers(io, socket) {
  socket.on('archive_session', async ({ uiId }) => {
    try {
      const session = await db.getSession(uiId);
      const providerId = session?.provider || null;
      const provider = getProvider(providerId);
      const archivePath = provider.config.paths.archive;
      if (!archivePath || !session) return;

      const providerModule = await getProviderModule(providerId);

      // Delete all descendants (forks + sub-agents) recursively before archiving parent
      const allSessions = await db.getAllSessions();
      const descendants = [];
      const collectDescendants = (parentId) => {
        for (const s of allSessions) {
          if (s.forkedFrom === parentId) { descendants.push(s); collectDescendants(s.id); }
        }
      };
      collectDescendants(uiId);
      
      for (const child of descendants) {
        if (child.acpSessionId) {
          providerModule.deleteSessionFiles(child.acpSessionId);
        }
        const childAttach = path.join(getAttachmentsRoot(), child.id);
        if (fs.existsSync(childAttach)) fs.rmSync(childAttach, { recursive: true, force: true });
        await db.deleteSession(child.id);
      }
      if (descendants.length) writeLog(`[ARCHIVE] Deleted ${descendants.length} descendant(s) of ${uiId}`);

      const safeName = (session.name || 'Unnamed').replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);
      const archiveDir = path.join(archivePath, safeName);
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

      if (session.acpSessionId) {
        providerModule.archiveSessionFiles(session.acpSessionId, archiveDir);
      }

      const attachDir = path.join(getAttachmentsRoot(), uiId);
      if (fs.existsSync(attachDir)) {
        fs.cpSync(attachDir, path.join(archiveDir, 'attachments'), { recursive: true });
        fs.rmSync(attachDir, { recursive: true, force: true });
      }

      fs.writeFileSync(path.join(archiveDir, 'session.json'), JSON.stringify({
        id: session.id, acpSessionId: session.acpSessionId, name: session.name,
        model: session.model, currentModelId: session.currentModelId, modelOptions: session.modelOptions,
        messages: session.messages, isPinned: session.isPinned,
        cwd: session.cwd || null, configOptions: session.configOptions || []
      }, null, 2));

      await db.deleteSession(uiId);
      writeLog(`[ARCHIVE] Session "${safeName}" archived`);
    } catch (err) {
      writeLog(`[ARCHIVE ERR] ${err.message}`);
    }
  });

  socket.on('delete_archive', (payload, callback) => {
    const _cb = typeof payload === 'function' ? payload : callback;
    const folderName = payload.folderName;
    try {
      const provider = getProvider(payload?.providerId || null);
      const archivePath = provider.config.paths.archive;
      if (!archivePath) return callback?.({ error: 'No archive path' });
      const archiveDir = path.join(archivePath, folderName);
      if (fs.existsSync(archiveDir)) {
        fs.rmSync(archiveDir, { recursive: true, force: true });
        writeLog(`[ARCHIVE] Deleted archive: ${folderName}`);
      }
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[ARCHIVE ERR] delete failed: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('list_archives', (payload, callback) => {
    const _cb = typeof payload === 'function' ? payload : callback;
    try {
      const provider = getProvider(payload?.providerId || null);
      const archivePath = provider.config.paths.archive;
      if (!archivePath || !fs.existsSync(archivePath)) return _cb({ archives: [] });
      const dirs = fs.readdirSync(archivePath).filter(d => {
        const full = path.join(archivePath, d);
        return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'session.json'));
      });
      _cb({ archives: dirs });
    } catch (err) {
      writeLog(`[ARCHIVE ERR] list_archives: ${err.message}`);
      _cb({ archives: [] });
    }
  });

  socket.on('restore_archive', async (payload, callback) => {
    const { folderName, providerId } = payload;
    try {
      const provider = getProvider(payload?.providerId || null);
      const archivePath = provider.config.paths.archive;
      if (!archivePath) return callback({ error: 'No ARCHIVE_PATH configured' });
      const archiveDir = path.join(archivePath, folderName);
      const sessionFile = path.join(archiveDir, 'session.json');
      if (!fs.existsSync(sessionFile)) return callback({ error: 'session.json not found in archive' });

      const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      const newUiId = Date.now().toString();
      const providerModule = await getProviderModule(providerId);

      if (saved.acpSessionId) {
        providerModule.restoreSessionFiles(saved.acpSessionId, archiveDir);
        writeLog(`[RESTORE] Restored session files for ${saved.acpSessionId}`);
      }

      const attachSrc = path.join(archiveDir, 'attachments');
      if (fs.existsSync(attachSrc)) {
        const attachDest = path.join(getAttachmentsRoot(), newUiId);
        fs.cpSync(attachSrc, attachDest, { recursive: true });
        writeLog(`[RESTORE] Copied attachments to ${attachDest}`);
      }

      await db.saveSession({
        id: newUiId,
        acpSessionId: saved.acpSessionId,
        name: saved.name || folderName,
        model: saved.model || 'flagship',
        currentModelId: saved.currentModelId,
        modelOptions: saved.modelOptions,
        messages: saved.messages || [],
        isPinned: false,
        cwd: saved.cwd || null,
        configOptions: saved.configOptions || []
      });

      fs.rmSync(archiveDir, { recursive: true, force: true });
      writeLog(`[RESTORE] Session "${saved.name}" restored as ${newUiId}`);
      callback({ success: true, uiId: newUiId, acpSessionId: saved.acpSessionId });
    } catch (err) {
      writeLog(`[RESTORE ERR] ${err.message}`);
      callback({ error: err.message });
    }
  });
}
