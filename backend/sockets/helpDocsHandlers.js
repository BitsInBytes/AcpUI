import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from '../services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.vite',
  '.turbo',
  'build',
]);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isInsideRoot(rootDir, resolvedPath) {
  const relative = path.relative(rootDir, resolvedPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureMarkdownDocPath(rootDir, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new Error('Document path is required');
  }

  const normalizedPath = requestedPath.replace(/\\/g, '/');
  if (path.isAbsolute(normalizedPath)) {
    throw new Error('Path traversal blocked');
  }

  const resolved = path.resolve(rootDir, normalizedPath);
  if (!isInsideRoot(rootDir, resolved)) {
    throw new Error('Path traversal blocked');
  }

  if (!resolved.toLowerCase().endsWith('.md')) {
    throw new Error('Only Markdown documents can be viewed');
  }

  return resolved;
}

function collectMarkdownFiles(rootDir, currentDir = rootDir, basePath = '') {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const childBase = basePath ? path.join(basePath, entry.name) : entry.name;
      files.push(...collectMarkdownFiles(rootDir, path.join(currentDir, entry.name), childBase));
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

    const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;
    const docPath = toPosixPath(relativePath);
    files.push({
      name: entry.name,
      path: docPath,
      directory: toPosixPath(basePath),
    });
  }

  return files;
}

export function createHelpDocsHandlers({ rootDir = DEFAULT_REPO_ROOT } = {}) {
  const resolvedRoot = path.resolve(rootDir);

  function listDocs() {
    return collectMarkdownFiles(resolvedRoot)
      .sort((a, b) => {
        const nameOrder = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        if (nameOrder !== 0) return nameOrder;

        const depthOrder = a.path.split('/').length - b.path.split('/').length;
        if (depthOrder !== 0) return depthOrder;

        return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });
      });
  }

  function readDoc(filePath) {
    const fullPath = ensureMarkdownDocPath(resolvedRoot, filePath);
    return fs.readFileSync(fullPath, 'utf8');
  }

  function register(_io, socket) {
    socket.on('help_docs_list', (payloadOrCallback, maybeCallback) => {
      const callback = typeof payloadOrCallback === 'function' ? payloadOrCallback : maybeCallback;

      try {
        callback?.({ files: listDocs(), root: resolvedRoot });
      } catch (err) {
        writeLog(`[HELP DOCS ERR] list: ${err.message}`);
        callback?.({ files: [], error: err.message });
      }
    });

    socket.on('help_docs_read', (payload, callback) => {
      try {
        const filePath = payload?.filePath;
        const content = readDoc(filePath);
        callback?.({ content, filePath });
      } catch (err) {
        writeLog(`[HELP DOCS ERR] read: ${err.message}`);
        callback?.({ error: err.message });
      }
    });
  }

  return { listDocs, readDoc, register };
}

export default function registerHelpDocsHandlers(io, socket) {
  return createHelpDocsHandlers().register(io, socket);
}
