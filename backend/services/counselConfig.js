/**
 * Loads the counsel agent configuration from counsel.json (or COUNSEL_CONFIG override).
 * The config defines which sub-agent perspectives are spawned by the ux_invoke_counsel MCP tool:
 *   - core[] — always-included agents (Advocate, Critic, Pragmatist)
 *   - optional.{key} — domain experts toggled by boolean flags (architect, performance, security, ux)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadCounselConfig() {
  const configPath = path.resolve(__dirname, '..', '..', process.env.COUNSEL_CONFIG || 'counsel.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    writeLog(`[CONFIG] Loaded counsel config from ${configPath}`);
    return config.agents || { core: [], optional: {} };
  } catch {
    writeLog(`[CONFIG] No counsel config found at ${configPath}, using defaults`);
    return { core: [], optional: {} };
  }
}
