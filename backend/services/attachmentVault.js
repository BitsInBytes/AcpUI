import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { writeLog } from './logger.js';
import { getProviderModuleSync } from './providerLoader.js';

export function getAttachmentsRoot(providerId = null) {
  const providerModule = getProviderModuleSync(providerId);
  const root = providerModule.getAttachmentsDir();
  if (root && !fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const { uiId } = _req.params;
    const providerId = (_req?.query || {}).providerId || (_req?.body || {}).providerId || null;
    const sessionDir = path.join(getAttachmentsRoot(providerId), uiId);
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
