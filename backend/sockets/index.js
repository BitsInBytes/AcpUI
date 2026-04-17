import { writeLog } from '../services/logger.js';
import registerSessionHandlers from './sessionHandlers.js';
import registerArchiveHandlers from './archiveHandlers.js';
import registerCanvasHandlers from './canvasHandlers.js';
import registerPromptHandlers from './promptHandlers.js';
import registerSystemHandlers from './systemHandlers.js';
import registerVoiceHandlers from './voiceHandlers.js';
import registerSystemSettingsHandlers from './systemSettingsHandlers.js';
import registerFolderHandlers from './folderHandlers.js';
import registerFileExplorerHandlers from './fileExplorerHandlers.js';
import registerGitHandlers from './gitHandlers.js';
import registerTerminalHandlers from './terminalHandlers.js';
import acpClient from '../services/acpClient.js';
import { loadWorkspaces } from '../services/workspaceConfig.js';
import { loadCommands } from '../services/commandsConfig.js';
import { getProvider } from '../services/providerLoader.js';

import { isSTTEnabled } from '../voiceService.js';

export default function registerSocketHandlers(io) {
  // On connect: emit all config/state so the UI can hydrate without extra round-trips
  io.on('connection', (socket) => {
    writeLog(`Client connected: ${socket.id}`);
    
    if (acpClient.isHandshakeComplete) {
      socket.emit('ready', { message: 'Ready to help ⚡', bootId: acpClient.serverBootId });
    }
    socket.emit('voice_enabled', { enabled: isSTTEnabled() });
    socket.emit('workspace_cwds', { cwds: loadWorkspaces() });
    socket.emit('branding', { 
      ...getProvider().config.branding, 
      title: getProvider().config.title, 
      models: getProvider().config.models, 
      defaultModel: getProvider().config.models?.default,
      protocolPrefix: getProvider().config.protocolPrefix,
      supportsAgentSwitching: getProvider().config.supportsAgentSwitching ?? false
    });
    socket.emit('sidebar_settings', {
      deletePermanent: process.env.SIDEBAR_DELETE_PERMANENT === 'true',
      notificationSound: process.env.NOTIFICATION_SOUND !== 'false',
      notificationDesktop: process.env.NOTIFICATION_DESKTOP === 'true',
    });
    socket.emit('custom_commands', { commands: loadCommands() });

    registerSessionHandlers(io, socket);
    registerArchiveHandlers(io, socket);
    registerCanvasHandlers(io, socket);
    registerPromptHandlers(io, socket);
    registerSystemHandlers(io, socket);
    registerVoiceHandlers(io, socket);
    registerSystemSettingsHandlers(io, socket);
    registerFolderHandlers(io, socket);
    registerFileExplorerHandlers(io, socket);
    registerGitHandlers(io, socket);
    registerTerminalHandlers(io, socket);

    // Room system: clients join session-scoped rooms to receive only relevant streaming events
    socket.on('watch_session', ({ sessionId }) => {
      if (sessionId) {
        socket.join(`session:${sessionId}`);
        writeLog(`[ROOMS] ${socket.id} watching session ${sessionId}`);
      }
    });

    socket.on('unwatch_session', ({ sessionId }) => {
      if (sessionId) {
        socket.leave(`session:${sessionId}`);
        writeLog(`[ROOMS] ${socket.id} unwatching session ${sessionId}`);
      }
    });

    socket.on('disconnect', () => {
      writeLog(`Client disconnected: ${socket.id}`);
    });
  });
}
