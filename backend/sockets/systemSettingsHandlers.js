import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLog } from '../services/logger.js';
import { getProvider } from '../services/providerLoader.js';
import { invalidateWorkspacesCache, loadWorkspaces } from '../services/workspaceConfig.js';
import { invalidateCommandsCache, loadCommands } from '../services/commandsConfig.js';
import { invalidateMcpConfigCache } from '../services/mcpConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

function getWorkspacesPath() {
  return path.resolve(__dirname, '..', '..', process.env.WORKSPACES_CONFIG || 'workspaces.json');
}

function getCommandsPath() {
  return path.resolve(__dirname, '..', '..', process.env.COMMANDS_CONFIG || 'commands.json');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getProviderPaths(providerId = null) {
  const provider = getProvider(providerId);
  const basePath = path.resolve(__dirname, '..', '..', 'providers', provider.id);
  return {
    path: path.join(basePath, 'user.json'),
    example: path.join(basePath, 'user.json.example')
  };
}

function refreshWorkspaceCwds(io) {
  invalidateWorkspacesCache();
  io.emit('workspace_cwds', { cwds: loadWorkspaces() });
}

function refreshCustomCommands(io) {
  invalidateCommandsCache();
  io.emit('custom_commands', { commands: loadCommands() });
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
      const regex = new RegExp(`^${escapeRegex(key)}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
      fs.writeFileSync(ENV_PATH, content, 'utf8');
      process.env[key] = value;

      const envKey = String(key || '').trim();
      const refreshWorkspace = envKey === 'WORKSPACES_CONFIG'
        || envKey === 'DEFAULT_WORKSPACE_CWD'
        || envKey === 'DEFAULT_WORKSPACE_AGENT'
        || envKey === 'WORKSPACE_B_CWD'
        || envKey === 'WORKSPACE_B_AGENT';
      const refreshCommands = envKey === 'COMMANDS_CONFIG';
      const clearMcpCache = envKey === 'MCP_CONFIG';

      if (refreshWorkspace) refreshWorkspaceCwds(io);
      if (refreshCommands) refreshCustomCommands(io);
      if (clearMcpCache) invalidateMcpConfigCache();

      writeLog(`[ENV] Updated ${key}=${value}`);
      callback?.({
        success: true,
        runtimeRefresh: {
          workspaceCwds: refreshWorkspace,
          customCommands: refreshCommands,
          mcpConfigCacheCleared: clearMcpCache,
          requiresBackendRestart: envKey === 'WORKSPACES_CONFIG' || envKey === 'COMMANDS_CONFIG' || envKey === 'MCP_CONFIG'
        }
      });
    } catch (err) {
      writeLog(`[ENV ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('get_workspaces_config', (callback) => {
    try {
      callback({ content: fs.readFileSync(getWorkspacesPath(), 'utf8') });
    } catch (err) {
      writeLog(`[WORKSPACES ERR] ${err.message}`);
      callback({ content: '{\n  "workspaces": []\n}', error: err.message });
    }
  });

  socket.on('save_workspaces_config', ({ content }, callback) => {
    try {
      JSON.parse(content);
      fs.writeFileSync(getWorkspacesPath(), content, 'utf8');
      refreshWorkspaceCwds(io);
      writeLog('[WORKSPACES] Config saved and runtime cache refreshed');
      callback?.({ success: true, runtimeRefresh: { workspaceCwds: true, requiresBackendRestart: false } });
    } catch (err) {
      writeLog(`[WORKSPACES ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('get_commands_config', (callback) => {
    try {
      callback({ content: fs.readFileSync(getCommandsPath(), 'utf8') });
    } catch (err) {
      writeLog(`[COMMANDS ERR] ${err.message}`);
      callback({ content: '{\n  "commands": []\n}', error: err.message });
    }
  });

  socket.on('save_commands_config', ({ content }, callback) => {
    try {
      JSON.parse(content);
      fs.writeFileSync(getCommandsPath(), content, 'utf8');
      refreshCustomCommands(io);
      writeLog('[COMMANDS] Config saved and runtime cache refreshed');
      callback?.({ success: true, runtimeRefresh: { customCommands: true, requiresBackendRestart: false } });
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
      writeLog('[PROVIDER] Config saved');
      callback?.({ success: true, runtimeRefresh: { requiresBackendRestart: true } });
    } catch (err) {
      writeLog(`[PROVIDER ERR] ${err.message}`);
      callback?.({ error: err.message });
    }
  });
}
