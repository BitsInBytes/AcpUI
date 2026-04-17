import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const frontendDistPath = path.join(__dirname, '..', '..', 'frontend', 'dist');

if (fs.existsSync(frontendDistPath)) {
  router.use(express.static(frontendDistPath));
  
  // SPA Fallback: serve index.html for any unknown routes
  router.get('/{*any}', (req, res, next) => {
    // If it looks like a file (has an extension), skip it
    if (path.extname(req.path)) return next();
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

export default router;
