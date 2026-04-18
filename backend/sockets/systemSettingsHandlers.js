import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from '../services/logger.js';
import { getProvider } from '../services/providerLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const WORKSPACES_PATH = path.resolve(__dirname, '..', '..', process.env.WORKSPACES_CONFIG || 'workspaces.json');
const COMMANDS_PATH = path.resolve(__dirname, '..', '..', process.env.COMMANDS_CONFIG || 'commands.json');

function getProviderPaths(providerId = null) {
  const provider = getProvider(providerId);
  const basePath = path.resolve(__dirname, '..', '..', 'providers', provider.id);
  return {
    path: path.join(basePath, 'user.json'),
    example: path.join(basePath, 'user.json.example')
  };
}

export default function registerSystemSettingsHandlers(io, socket) {
  socket.on('get_env', (callback) => {
    try {
      const content = fs.readFileSync(ENV_PATH, 'utf8');
      const vars = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        vars[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
      }
      callback({ vars });
    } catch (err) {
      writeLog(`[ENV ERR] ${err.message}`);
      callback({ error: err.message });
    }
  });

  socket.on('update_env', ({ key, value }, callback) => {
    try {
      let content = fs.readFileSync(ENV_PATH, 'utf8');
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
      fs.writeFileSync(ENV_PATH, content, 'utf8');
      process.env[key] = value;
      writeLog(`[ENV] Updated ${key}=${value}`);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[ENV ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('get_workspaces_config', (callback) => {
    try {
      callback({ content: fs.readFileSync(WORKSPACES_PATH, 'utf8') });
    } catch (err) {
      writeLog(`[WORKSPACES ERR] ${err.message}`);
      callback({ content: '{\n  "workspaces": []\n}', error: err.message });
    }
  });

  socket.on('save_workspaces_config', ({ content }, callback) => {
    try {
      JSON.parse(content); // validate JSON
      fs.writeFileSync(WORKSPACES_PATH, content, 'utf8');
      writeLog(`[WORKSPACES] Config saved`);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[WORKSPACES ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('get_commands_config', (callback) => {
    try {
      callback({ content: fs.readFileSync(COMMANDS_PATH, 'utf8') });
    } catch (err) {
      writeLog(`[COMMANDS ERR] ${err.message}`);
      callback({ content: '{\n  "commands": []\n}', error: err.message });
    }
  });

  socket.on('save_commands_config', ({ content }, callback) => {
    try {
      JSON.parse(content);
      fs.writeFileSync(COMMANDS_PATH, content, 'utf8');
      writeLog(`[COMMANDS] Config saved`);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[COMMANDS ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('get_provider_config', (payload, callback) => {
    const cb = typeof payload === 'function' ? payload : callback;
    const providerId = typeof payload === 'object' ? payload.providerId : null;
    try {
      const paths = getProviderPaths(providerId);
      let target = paths.path;
      if (!fs.existsSync(target) && fs.existsSync(paths.example)) {
        target = paths.example;
      }
      cb({ content: fs.readFileSync(target, 'utf8') });
    } catch (err) {
      writeLog(`[PROVIDER ERR] ${err.message}`);
      cb({ content: '{}', error: err.message });
    }
  });

  socket.on('save_provider_config', (payload, callback) => {
    const { content, providerId } = payload;
    try {
      JSON.parse(content);
      fs.writeFileSync(getProviderPaths(providerId).path, content, 'utf8');
      writeLog(`[PROVIDER] Config saved`);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[PROVIDER ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });
}
