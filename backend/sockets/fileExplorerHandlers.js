import fs from 'fs';
import path from 'path';
import { writeLog } from '../services/logger.js';
import { getProvider } from '../services/providerLoader.js';
import { resolvePathWithinRoot } from '../services/ioMcp/filesystem.js';

function getRoot(providerId = null) {
  const provider = getProvider(providerId);
  const root = provider.config.paths?.home;

  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('File Explorer root is not configured.');
  }
  if (!path.isAbsolute(root)) {
    throw new Error('File Explorer root must be an absolute path.');
  }

  return path.resolve(root);
}

function safePath(requestedPath, providerId = null) {
  const root = getRoot(providerId);
  return resolvePathWithinRoot(root, requestedPath || '.', 'requested path');
}

export default function registerFileExplorerHandlers(io, socket) {
  socket.on('explorer_list', async (payload = {}, callback) => {
    try {
      const fullPath = safePath(payload.dirPath || '.', payload.providerId || null);
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({ name: e.name, isDirectory: e.isDirectory() }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      callback?.({ items, path: payload.dirPath || '' });
    } catch (err) {
      writeLog(`[EXPLORER ERR] list: ${err.message}`);
      callback?.({ items: [], error: err.message });
    }
  });

  socket.on('explorer_read', async (payload = {}, callback) => {
    try {
      const fullPath = safePath(payload.filePath, payload.providerId || null);
      const content = fs.readFileSync(fullPath, 'utf8');
      callback?.({ content, filePath: payload.filePath });
    } catch (err) {
      writeLog(`[EXPLORER ERR] read: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('explorer_write', async (payload = {}, callback) => {
    const { content, filePath } = payload;
    try {
      const fullPath = safePath(filePath, payload.providerId || null);
      fs.writeFileSync(fullPath, content, 'utf8');
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[EXPLORER ERR] write: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('explorer_root', (payload, callback) => {
    const cb = typeof payload === 'function' ? payload : callback;
    const providerId = typeof payload === 'object' && payload !== null ? payload.providerId || null : null;
    try {
      cb?.({ root: getRoot(providerId) });
    } catch (err) {
      cb?.({ root: '', error: err.message });
    }
  });
}
