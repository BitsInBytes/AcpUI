import { useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useSystemStore } from '../store/useSystemStore';
import { useVoiceStore } from '../store/useVoiceStore';
import type { ProviderModelOption, WorkspaceCwd } from '../types';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useStreamStore } from '../store/useStreamStore';
import { routeExtension } from '../utils/extensionRouter';
import { mergeProviderConfigOptions } from '../utils/configOptions';
import type { ProviderSummary } from '../types';

import { BACKEND_URL } from '../utils/backendConfig';

/**
 * Module-level singleton socket — survives React strict-mode double-mounts and
 * component re-renders. Created once on first call, never destroyed.
 */
let _socket: Socket | null = null;
function getOrCreateSocket(): Socket {
  if (_socket) return _socket;
  _socket = io(BACKEND_URL, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    timeout: 60000,
  });

  _socket.on('connect', () => {
    useSystemStore.getState().setConnected(true);
  });
  _socket.on('ready', (data: { bootId: string }) => {
    const providerId = (data as { providerId?: string }).providerId;
    if (providerId) useSystemStore.getState().setProviderReady(providerId, true);
    else useSystemStore.getState().setIsEngineReady(true);
    useSystemStore.getState().setBackendBootId(data.bootId);
  });
  _socket.on('voice_enabled', (data: { enabled: boolean }) => {
    useVoiceStore.getState().setIsVoiceEnabled(data.enabled);
  });
  _socket.on('workspace_cwds', (data: { cwds: WorkspaceCwd[] }) => {
    useSystemStore.getState().setWorkspaceCwds(data.cwds);
  });
  _socket.on('providers', (data: { defaultProviderId?: string | null; providers?: ProviderSummary[] }) => {
    useSystemStore.getState().setProviders(data.defaultProviderId || null, data.providers || []);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _socket.on('branding', (data: any) => {
    if (data.providerId) {
      useSystemStore.getState().setProviderBranding(data);
    } else {
      useSystemStore.setState({ branding: data });
    }
    const state = useSystemStore.getState();
    const activeBranding = state.branding;
    document.title = activeBranding.title || activeBranding.assistantName || 'ACP UI';
  });
  _socket.on('sidebar_settings', (data: { deletePermanent: boolean; notificationSound: boolean; notificationDesktop: boolean }) => {
    useSystemStore.getState().setDeletePermanent(data.deletePermanent);
    useSystemStore.getState().setNotificationSettings(data.notificationSound, data.notificationDesktop);
    if (data.notificationDesktop && Notification.permission === 'default') Notification.requestPermission();
  });
  _socket.on('custom_commands', (data: { commands: { name: string; description: string; prompt?: string | null }[] }) => {
    useSystemStore.getState().setCustomCommands(data.commands);
    // Immediately surface custom commands in the slash dropdown.
    // Without this, they only appear after provider_extension fires (i.e. when a
    // new ACP session starts). On page load/reconnect that event never replays,
    // so the dropdown stays empty until the user creates a new session.
    const localCmds = data.commands
      .filter(c => c.prompt)
      .map(c => ({ name: c.name, description: c.description, meta: { local: true as const } }));
    if (localCmds.length > 0) {
      // Preserve any provider-defined commands already in the list (e.g. if
      // provider_extension already fired before this handler runs).
      const providerCmds = useSystemStore.getState().slashCommands.filter(c => !c.meta?.local);
      useSystemStore.getState().setSlashCommands([...localCmds, ...providerCmds]);
    }
  });
  _socket.on('session_model_options', (data: { sessionId: string; currentModelId?: string | null; modelOptions?: ProviderModelOption[] }) => {
    useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => s.acpSessionId === data.sessionId ? {
        ...s,
        model: data.currentModelId || s.model,
        currentModelId: data.currentModelId ?? s.currentModelId,
        modelOptions: data.modelOptions && data.modelOptions.length > 0 ? data.modelOptions : s.modelOptions
      } : s) }));
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _socket.on('provider_extension', (data: { method: string; params: any }) => {
    // Routes ACP provider extensions (slash commands, context metadata, compaction)
    // through routeExtension() which matches method names against the branding prefix
    // (e.g. "_provider/listCommands") and returns typed action objects.
    const p = data.params || {};
    const providerId = (data as { providerId?: string }).providerId || p.providerId || p.status?.providerId;
    const providerBranding = useSystemStore.getState().getBranding(providerId);
    const ext = providerBranding?.protocolPrefix || '_provider/';
    const result = routeExtension(data.method, p, ext, [], useSystemStore.getState().customCommands);
    if (!result) return;

    if (result.type === 'commands') {
      useSystemStore.getState().setSlashCommands(result.commands, providerId);
    } else if (result.type === 'metadata') {
      useSystemStore.getState().setContextUsage(result.sessionId, result.contextUsagePercentage);
    } else if (result.type === 'provider_status') {
      useSystemStore.getState().setProviderStatus(result.status, providerId);
    } else if (result.type === 'config_options') {
      // Merge is the safe default. Providers must explicitly request replace/remove
      // when they are sending an authoritative config snapshot.
      if (result.options.length > 0 || result.replace || result.removeOptionIds?.length) {
        useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => {
            if (s.acpSessionId !== result.sessionId) return s;
            return {
              ...s,
              configOptions: mergeProviderConfigOptions(s.configOptions, result.options, {
                replace: result.replace,
                removeOptionIds: result.removeOptionIds
              })
            };
          }) }));
      }
    } else if (result.type === 'compaction_started') {
      useSystemStore.getState().setCompacting(result.sessionId, true);
      useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => s.acpSessionId === result.sessionId ? { ...s, isTyping: true } : s) }));
    } else if (result.type === 'compaction_completed') {
      useSystemStore.getState().setCompacting(result.sessionId, false);
      if (result.summary) {
        useStreamStore.getState().onStreamToken({ sessionId: result.sessionId, text: `\n\n---\n\n**Context Compacted**\n\n${result.summary}` });
      }
      const waitAndSave = () => {
        const queues = useStreamStore.getState().streamQueues;
        const hasQueue = queues[result.sessionId] && queues[result.sessionId].length > 0;
        if (hasQueue) { setTimeout(waitAndSave, 200); return; }
        useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => s.acpSessionId === result.sessionId ? { ...s, isTyping: false } : s) }));
        const session = useSessionLifecycleStore.getState().sessions.find(s => s.acpSessionId === result.sessionId);
        if (session && _socket) _socket.emit('save_snapshot', session);
      };
      setTimeout(waitAndSave, 500);
    }
  });
  _socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
  });
  _socket.on('disconnect', () => {
    useSystemStore.getState().setConnected(false);
  });

  useSystemStore.getState().setSocket(_socket);
  return _socket;
}

export function useSocket() {
  const backendBootIdRef = useRef<string | null>(null);
  const socket = getOrCreateSocket();

  const connected = useSystemStore(state => state.connected);
  const isEngineReady = useSystemStore(state => state.isEngineReady);
  const backendBootId = useSystemStore(state => state.backendBootId);
  const sslError = useSystemStore(state => state.sslError);

  return {
    socket,
    socketRef: { current: socket },
    connected,
    isEngineReady,
    backendBootId,
    sslError,
    backendBootIdRef
  };
}
