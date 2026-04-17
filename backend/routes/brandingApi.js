import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getProvider } from '../services/providerLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

function getIconsDir() {
  return path.resolve(__dirname, '..', '..', process.env.ACP_PROVIDER || '.', 'icons');
}

// Serve provider icons from providers/<name>/icons/
router.get('/icons/:filename', (req, res) => {
  const iconPath = path.join(getIconsDir(), req.params.filename);
  if (fs.existsSync(iconPath)) {
    res.sendFile(iconPath);
  } else {
    res.status(404).end();
  }
});

// Generate manifest.json from provider config
router.get('/manifest.json', (_req, res) => {
  const { config } = getProvider();
  const name = config.title || config.branding?.assistantName || 'ACP UI';
  res.json({
    name,
    short_name: config.branding?.assistantName || name,
    icons: [
      { src: '/api/branding/icons/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/api/branding/icons/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: '#1a1a2e',
    background_color: '#1a1a2e',
    display: 'standalone',
    start_url: '/',
  });
});

export default router;
