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
import registerHelpDocsHandlers from './helpDocsHandlers.js';
import registerGitHandlers from './gitHandlers.js';
import registerTerminalHandlers from './terminalHandlers.js';
import registerShellRunHandlers, { emitShellRunSnapshotsForSession } from './shellRunHandlers.js';
import registerSubAgentHandlers, { emitSubAgentSnapshotsForSession } from './subAgentHandlers.js';
import acpClient from '../services/acpClient.js';
import providerRuntimeManager from '../services/providerRuntimeManager.js';
import { loadWorkspaces } from '../services/workspaceConfig.js';
import { loadCommands } from '../services/commandsConfig.js';
import { getProvider } from '../services/providerLoader.js';
import { getLatestProviderStatusExtension, getLatestProviderStatusExtensions } from '../services/providerStatusMemory.js';
import { getStreamResumeSnapshot } from '../services/sessionStreamPersistence.js';
import { getDefaultProviderId, getProviderEntries } from '../services/providerRegistry.js';
import { collectInvalidJsonConfigErrors, hasStartupBlockingJsonConfigError } from '../services/jsonConfigDiagnostics.js';
import * as db from '../database.js';

import { isSTTEnabled } from '../voiceService.js';

function buildBrandingPayload(providerId) {
  const provider = getProvider(providerId);
  const providerConfig = provider.config;
  return {
    providerId,
    ...providerConfig.branding,
    title: providerConfig.title,
    models: providerConfig.models,
    defaultModel: providerConfig.models?.default,
    protocolPrefix: providerConfig.protocolPrefix,
    supportsAgentSwitching: providerConfig.supportsAgentSwitching ?? false
  };
}

function runtimeForWatchedSession(providerId, sessionId) {
  const runtimes = providerRuntimeManager.getRuntimes?.() || [];
  if (providerId) return runtimes.find(runtime => runtime.providerId === providerId) || null;
  return runtimes.find(runtime => runtime.client?.sessionMetadata?.has?.(sessionId))
    || runtimes[0]
    || null;
}

async function emitStreamResumeSnapshot(socket, { providerId = null, sessionId } = {}) {
  const runtime = runtimeForWatchedSession(providerId, sessionId);
  if (!runtime?.client) return;
  const snapshot = await getStreamResumeSnapshot(runtime.client, sessionId);
  if (snapshot) socket.emit('stream_resume_snapshot', snapshot);
}

function getProviderPayloads() {
  const defaultProviderId = getDefaultProviderId();
  return getProviderEntries().map(entry => ({
    providerId: entry.id,
    label: entry.label,
    default: entry.id === defaultProviderId,
    ready: providerRuntimeManager.getRuntimes().find(runtime => runtime.providerId === entry.id)?.client.isHandshakeComplete === true,
    branding: buildBrandingPayload(entry.id)
  }));
}

function runtimeConfigIssue(err) {
  return {
    id: 'runtime-config-load',
    label: 'Runtime configuration',
    path: 'configuration/providers.json',
    message: err?.message || 'Failed to load runtime configuration',
    blocksStartup: true
  };
}

function getStatusExtensionProviderId(extension) {
  return extension?.providerId || extension?.params?.providerId || extension?.params?.status?.providerId || null;
}

function emitProviderStatusExtension(socket, extension, emittedProviderIds) {
  if (!extension) return false;
  const providerId = getStatusExtensionProviderId(extension);
  socket.emit('provider_extension', extension);
  if (providerId) emittedProviderIds.add(providerId);
  return true;
}

function emitPendingPermissionSnapshot(socket, { providerId = null, sessionId }) {
  if (!sessionId) return;
  const runtimes = typeof providerRuntimeManager.getRuntimes === 'function'
    ? providerRuntimeManager.getRuntimes()
    : [];
  const candidates = [...runtimes, { providerId: acpClient.providerId || null, client: acpClient }];
  const emittedRequestIds = new Set();

  for (const runtime of candidates) {
    if (providerId && runtime.providerId && runtime.providerId !== providerId) continue;
    const payload = runtime.client?.permissions?.getPendingPermissionForSession?.(sessionId, runtime.providerId || providerId);
    if (!payload || emittedRequestIds.has(payload.id)) continue;
    emittedRequestIds.add(payload.id);
    socket.emit('permission_request', payload);
  }
}

function emitCachedProviderStatuses(socket, defaultProviderId) {
  const emittedProviderIds = new Set();

  const providerStatusExtensions = getLatestProviderStatusExtensions();
  if (providerStatusExtensions.length > 0) {
    for (const providerStatusExtension of providerStatusExtensions) {
      emitProviderStatusExtension(socket, providerStatusExtension, emittedProviderIds);
    }
  } else {
    emitProviderStatusExtension(
      socket,
      getLatestProviderStatusExtension(defaultProviderId),
      emittedProviderIds
    );
  }

  if (typeof db.getProviderStatusExtensions !== 'function') return;

  Promise.resolve()
    .then(() => (typeof db.initDb === 'function' ? db.initDb() : undefined))
    .then(() => db.getProviderStatusExtensions())
    .then((persistedExtensions) => {
      const currentMemoryProviderIds = new Set([
        ...emittedProviderIds,
        ...getLatestProviderStatusExtensions().map(getStatusExtensionProviderId).filter(Boolean)
      ]);

      for (const persistedExtension of persistedExtensions || []) {
        const providerId = getStatusExtensionProviderId(persistedExtension);
        if (providerId && currentMemoryProviderIds.has(providerId)) continue;
        emitProviderStatusExtension(socket, persistedExtension, emittedProviderIds);
        if (providerId) currentMemoryProviderIds.add(providerId);
      }
    })
    .catch(err => writeLog(`[DB ERR] Failed to load provider status extensions: ${err.message}`));
}

export default function registerSocketHandlers(io) {
  // On connect: emit all config/state so the UI can hydrate without extra round-trips
  io.on('connection', (socket) => {
    const userAgent = socket.handshake?.headers?.['user-agent'] || 'unknown user-agent';
    const referer = socket.handshake?.headers?.referer || socket.handshake?.headers?.origin || 'no referrer';
    const address = socket.handshake?.address || 'unknown address';
    writeLog(`Client connected: ${socket.id} (${address}; ${referer}; ${userAgent})`);

    const configErrors = collectInvalidJsonConfigErrors();
    socket.emit('config_errors', { errors: configErrors });
    if (hasStartupBlockingJsonConfigError(configErrors)) {
      writeLog(`[CONFIG] Blocking socket hydration because invalid JSON config was found: ${configErrors.map(issue => issue.path).join(', ')}`);
      socket.on('disconnect', () => {
        writeLog(`Client disconnected: ${socket.id}`);
      });
      return;
    }

    let defaultProviderId;
    let providerPayloads;
    try {
      defaultProviderId = getDefaultProviderId();
      providerPayloads = getProviderPayloads();
    } catch (err) {
      const issue = runtimeConfigIssue(err);
      socket.emit('config_errors', { errors: [...configErrors, issue] });
      writeLog(`[CONFIG] Blocking socket hydration because runtime configuration failed: ${issue.message}`);
      socket.on('disconnect', () => {
        writeLog(`Client disconnected: ${socket.id}`);
      });
      return;
    }

    socket.emit('providers', {
      defaultProviderId,
      providers: providerPayloads
    });

    const runtimes = providerRuntimeManager.getRuntimes();
    if (runtimes.length > 0) {
      for (const runtime of runtimes) {
        if (runtime.client.isHandshakeComplete) {
          socket.emit('ready', { providerId: runtime.providerId, message: 'Ready to help ⚡', bootId: runtime.client.serverBootId });
        }
      }
    } else if (acpClient.isHandshakeComplete) {
      socket.emit('ready', { providerId: defaultProviderId, message: 'Ready to help ⚡', bootId: acpClient.serverBootId });
    }
    socket.emit('voice_enabled', { enabled: isSTTEnabled() });
    socket.emit('workspace_cwds', { cwds: loadWorkspaces() });
    for (const provider of providerPayloads) {
      socket.emit('branding', provider.branding);
    }
    socket.emit('sidebar_settings', {
      deletePermanent: String(process.env.SIDEBAR_DELETE_PERMANENT || '').trim().toLowerCase() === 'true',
      notificationSound: process.env.NOTIFICATION_SOUND !== 'false',
      notificationDesktop: process.env.NOTIFICATION_DESKTOP === 'true',
    });
    socket.emit('custom_commands', { commands: loadCommands() });
    emitCachedProviderStatuses(socket, defaultProviderId);

    registerSessionHandlers(io, socket);
    registerArchiveHandlers(io, socket);
    registerCanvasHandlers(io, socket);
    registerPromptHandlers(io, socket);
    registerSystemHandlers(io, socket);
    registerVoiceHandlers(io, socket);
    registerSystemSettingsHandlers(io, socket);
    registerFolderHandlers(io, socket);
    registerFileExplorerHandlers(io, socket);
    registerHelpDocsHandlers(io, socket);
    registerGitHandlers(io, socket);
    registerTerminalHandlers(io, socket);
    registerShellRunHandlers(io, socket);
    registerSubAgentHandlers(io, socket);

    // Room system: clients join session-scoped rooms to receive only relevant streaming events
    socket.on('watch_session', ({ providerId = null, sessionId }) => {
      if (sessionId) {
        socket.join(`session:${sessionId}`);
        void emitStreamResumeSnapshot(socket, { providerId, sessionId })
          .catch(err => writeLog(`[STREAM SNAPSHOT ERR] ${err.message}`));
        emitShellRunSnapshotsForSession(socket, { providerId, sessionId });
        void emitSubAgentSnapshotsForSession(socket, { providerId, sessionId })
          .catch(err => writeLog(`[SUB-AGENT SNAPSHOT ERR] ${err.message}`));
        emitPendingPermissionSnapshot(socket, { providerId, sessionId });
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
