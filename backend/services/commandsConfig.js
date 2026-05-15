import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cached = null;

export function loadCommands() {
  if (cached) return cached;

  const configPath = path.resolve(__dirname, '..', '..', process.env.COMMANDS_CONFIG || 'commands.json');

  if (!fs.existsSync(configPath)) {
    writeLog(`[CONFIG] No commands config found at ${configPath} (skipping custom commands)`);
    cached = [];
    return cached;
  }

  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cached = (data.commands || []).filter(c => c.name && c.description);
    writeLog(`[CONFIG] Loaded ${cached.length} custom command(s) from ${configPath}`);
    return cached;
  } catch (err) {
    writeLog(`[CONFIG] ERROR: Failed to parse commands config at ${configPath}: ${err.message}`);
    cached = [];
    return cached;
  }
}

export function invalidateCommandsCache() {
  cached = null;
}
