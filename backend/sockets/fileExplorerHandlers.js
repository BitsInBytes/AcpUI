import fs from 'fs';
import path from 'path';
import { writeLog } from '../services/logger.js';
import { getProvider } from '../services/providerLoader.js';

function getRoot() {
  const provider = getProvider();
  return provider.config.paths?.home || '';
}

function safePath(requestedPath) {
  const root = getRoot();
  const resolved = path.resolve(root, requestedPath);
  if (!resolved.startsWith(root)) throw new Error('Path traversal blocked');
  return resolved;
}

export default function registerFileExplorerHandlers(io, socket) {
  socket.on('explorer_list', async ({ dirPath }, callback) => {
    try {
      const fullPath = safePath(dirPath || '');
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({ name: e.name, isDirectory: e.isDirectory() }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      callback?.({ items, path: dirPath || '' });
    } catch (err) {
      writeLog(`[EXPLORER ERR] list: ${err.message}`);
      callback?.({ items: [], error: err.message });
    }
  });

  socket.on('explorer_read', async ({ filePath }, callback) => {
    try {
      const fullPath = safePath(filePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      callback?.({ content, filePath });
    } catch (err) {
      writeLog(`[EXPLORER ERR] read: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('explorer_write', async ({ filePath, content }, callback) => {
    try {
      const fullPath = safePath(filePath);
      fs.writeFileSync(fullPath, content, 'utf8');
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[EXPLORER ERR] write: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('explorer_root', (callback) => {
    callback?.({ root: getRoot() });
  });
}
