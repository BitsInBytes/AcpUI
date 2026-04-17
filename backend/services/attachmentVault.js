import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { writeLog } from './logger.js';
import { getProviderModuleSync } from './providerLoader.js';

let _root = null;
export function getAttachmentsRoot() {
  if (!_root) {
    const providerModule = getProviderModuleSync();
    _root = providerModule.getAttachmentsDir();
    if (_root && !fs.existsSync(_root)) fs.mkdirSync(_root, { recursive: true });
  }
  return _root;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const { uiId } = _req.params;
    const sessionDir = path.join(getAttachmentsRoot(), uiId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    cb(null, sessionDir);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
    cb(null, `${Date.now()}_${safeName}`);
  }
});

export const upload = multer({ storage });

export function handleUpload(req, res) {
  const { uiId } = req.params;
  const files = req.files.map(f => ({
    name: f.originalname,
    path: f.path,
    size: f.size,
    mimeType: f.mimetype
  }));
  writeLog(`[UPLOAD] ${files.length} file(s) added to session ${uiId}`);
  res.json({ success: true, files });
}
