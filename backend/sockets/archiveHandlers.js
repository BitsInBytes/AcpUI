import fs from 'fs';
import path from 'path';
import { writeLog } from '../services/logger.js';
import * as db from '../database.js';
import { getProvider, getProviderModule } from '../services/providerLoader.js';
import { getAttachmentsRoot } from '../services/attachmentVault.js';
import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';
import { createUiSessionId } from '../services/uiSessionId.js';

function collectDescendants(allSessions, parentId) {
  const descendants = [];
  const walk = (id) => {
    for (const session of allSessions) {
      if (session.forkedFrom === id) {
        descendants.push(session);
        walk(session.id);
      }
    }
  };
  walk(parentId);
  return descendants;
}

export default function registerArchiveHandlers(io, socket) {
  socket.on('archive_session', async ({ uiId }) => {
    try {
      const session = await db.getSession(uiId);
      if (!session) return;

      const provider = getProvider(session.provider || null);
      const providerId = provider.id;
      const archivePath = provider.config.paths.archive;
      if (!archivePath) return;

      const activeInvocation = await db.getActiveSubAgentInvocationForParent(providerId, uiId);
      if (activeInvocation) {
        await subAgentInvocationManager.cancelInvocation(providerId, activeInvocation.invocationId);
      }
      await db.deleteSubAgentInvocationsForParent(providerId, uiId);

      const allSessions = await db.getAllSessions();
      const descendants = collectDescendants(allSessions, uiId);
      const providerModuleCache = new Map();

      const getCachedProviderModule = async (pid) => {
        if (!providerModuleCache.has(pid)) {
          providerModuleCache.set(pid, await getProviderModule(pid));
        }
        return providerModuleCache.get(pid);
      };

      for (const child of descendants) {
        const childProviderId = getProvider(child.provider || providerId).id;
        const childProviderModule = await getCachedProviderModule(childProviderId);
        if (child.acpSessionId) {
          childProviderModule.deleteSessionFiles(child.acpSessionId);
        }
        const childAttach = path.join(getAttachmentsRoot(childProviderId), child.id);
        if (fs.existsSync(childAttach)) {
          fs.rmSync(childAttach, { recursive: true, force: true });
        }
        await db.deleteSession(child.id);
      }
      if (descendants.length) {
        writeLog(`[ARCHIVE] Deleted ${descendants.length} descendant(s) of ${uiId}`);
      }

      const safeName = (session.name || 'Unnamed').replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);
      const archiveDir = path.join(archivePath, safeName);
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }

      const providerModule = await getCachedProviderModule(providerId);
      if (session.acpSessionId) {
        providerModule.archiveSessionFiles(session.acpSessionId, archiveDir);
      }

      const attachDir = path.join(getAttachmentsRoot(providerId), uiId);
      if (fs.existsSync(attachDir)) {
        fs.cpSync(attachDir, path.join(archiveDir, 'attachments'), { recursive: true });
        fs.rmSync(attachDir, { recursive: true, force: true });
      }

      fs.writeFileSync(path.join(archiveDir, 'session.json'), JSON.stringify({
        id: session.id,
        acpSessionId: session.acpSessionId,
        name: session.name,
        model: session.model,
        currentModelId: session.currentModelId,
        modelOptions: session.modelOptions,
        messages: session.messages,
        isPinned: session.isPinned,
        cwd: session.cwd || null,
        configOptions: session.configOptions || [],
        provider: providerId
      }, null, 2));

      await db.deleteSession(uiId);
      writeLog(`[ARCHIVE] Session "${safeName}" archived`);
    } catch (err) {
      writeLog(`[ARCHIVE ERR] ${err.message}`);
    }
  });

  socket.on('delete_archive', (payload, callback) => {
    const resolvedPayload = typeof payload === 'function' ? {} : (payload || {});
    const resolvedCallback = typeof payload === 'function' ? payload : callback;
    const folderName = resolvedPayload.folderName;
    try {
      const provider = getProvider(resolvedPayload.providerId || null);
      const archivePath = provider.config.paths.archive;
      if (!archivePath) return resolvedCallback?.({ error: 'No archive path' });
      const archiveDir = path.join(archivePath, folderName);
      if (fs.existsSync(archiveDir)) {
        fs.rmSync(archiveDir, { recursive: true, force: true });
        writeLog(`[ARCHIVE] Deleted archive: ${folderName}`);
      }
      resolvedCallback?.({ success: true });
    } catch (err) {
      writeLog(`[ARCHIVE ERR] delete failed: ${err.message}`);
      resolvedCallback?.({ error: err.message });
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
      const archiveProvider = getProvider(providerId || null);
      const archivePath = archiveProvider.config.paths.archive;
      if (!archivePath) return callback?.({ error: 'No ARCHIVE_PATH configured' });
      const archiveDir = path.join(archivePath, folderName);
      const sessionFile = path.join(archiveDir, 'session.json');
      if (!fs.existsSync(sessionFile)) return callback?.({ error: 'session.json not found in archive' });

      const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      const restoredProvider = getProvider(saved.provider || archiveProvider.id);
      const restoredProviderId = restoredProvider.id;
      const newUiId = createUiSessionId();
      const providerModule = await getProviderModule(restoredProviderId);

      if (saved.acpSessionId) {
        providerModule.restoreSessionFiles(saved.acpSessionId, archiveDir);
        writeLog(`[RESTORE] Restored session files for ${saved.acpSessionId}`);
      }

      const attachSrc = path.join(archiveDir, 'attachments');
      if (fs.existsSync(attachSrc)) {
        const attachDest = path.join(getAttachmentsRoot(restoredProviderId), newUiId);
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
        configOptions: saved.configOptions || [],
        provider: restoredProviderId
      });

      fs.rmSync(archiveDir, { recursive: true, force: true });
      writeLog(`[RESTORE] Session "${saved.name}" restored as ${newUiId}`);
      callback?.({ success: true, uiId: newUiId, acpSessionId: saved.acpSessionId, providerId: restoredProviderId });
    } catch (err) {
      writeLog(`[RESTORE ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });
}
