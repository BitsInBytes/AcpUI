import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cached = null;

export function loadWorkspaces() {
  if (cached) return cached;

  const configPath = process.env.WORKSPACES_CONFIG
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', process.env.WORKSPACES_CONFIG)
    : path.resolve(__dirname, '..', '..', 'workspaces.json');

  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cached = (data.workspaces || [])
      .filter(w => w.label && w.path)
      .map(w => ({ label: w.label, path: w.path, agent: w.agent || '', pinned: !!w.pinned }));
    writeLog(`[CONFIG] Loaded ${cached.length} workspace(s) from ${configPath}`);
    return cached;
  } catch (err) {
    writeLog(`[CONFIG] Failed to load ${configPath}: ${err.message}, falling back to env vars`);
    cached = [
      { label: 'Project-A', path: process.env.DEFAULT_WORKSPACE_CWD || '', agent: process.env.DEFAULT_WORKSPACE_AGENT || '', pinned: true },
      { label: 'Project-B', path: process.env.WORKSPACE_B_CWD || '', agent: process.env.WORKSPACE_B_AGENT || '', pinned: true },
    ].filter(w => w.path);
    return cached;
  }
}
