import { create } from 'zustand';
import { Socket } from 'socket.io-client';
import { useSystemStore } from './useSystemStore';
import { mergeProviderConfigOptions } from '../utils/configOptions';
import { getDefaultModelSelection, getModelIdForSelection, normalizeModelOptions } from '../utils/modelOptions';
import type { ChatSession, Message, LoadSessionsResponse, CreateSessionResponse, SessionHistoryResponse, StatsResponse } from '../types';

function mergeModelOptions(current?: ChatSession['modelOptions'], incoming?: ChatSession['modelOptions']) {
  const existing = normalizeModelOptions(current);
  const updates = normalizeModelOptions(incoming);
  if (updates.length === 0) return existing;

  const byId = new Map(existing.map(option => [option.id, option]));
  updates.forEach(option => byId.set(option.id, { ...byId.get(option.id), ...option }));
  return Array.from(byId.values());
}

function applyModelState(
  session: ChatSession,
  state: { model?: string; currentModelId?: string | null; modelOptions?: ChatSession['modelOptions'] }
): ChatSession {
  const modelOptions = mergeModelOptions(session.modelOptions, state.modelOptions);
  const sysState = useSystemStore.getState();
  const branding = sysState.getBranding(session.provider);
  const providerModels = branding.models;
  const currentModelId = state.currentModelId ?? session.currentModelId ?? getModelIdForSelection(state.model || session.model, providerModels);
  return {
    ...session,
    ...(state.model ? { model: state.model } : {}),
    currentModelId,
    modelOptions
  };
}

function maybeHydrateContextUsage(session: ChatSession) {
  const acpSessionId = session.acpSessionId;
  const used = Number(session.stats?.usedTokens);
  const total = Number(session.stats?.totalTokens);
  if (!acpSessionId || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return;
  const nextPct = (used / total) * 100;
  const currentPct = useSystemStore.getState().getContextUsage(session.provider, acpSessionId);
  if (Number.isFinite(currentPct) && Number(currentPct) > 0 && nextPct <= 0) return;
  useSystemStore.getState().setContextUsage(session.provider, acpSessionId, nextPct);
}

interface SessionLifecycleState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  isUrlSyncReady: boolean;
  isInitiallyLoaded: boolean;
  lastStatsFetchByAcp: Record<string, number>; // acpId -> timestamp
  sessionNotes: Record<string, boolean>; // uiId -> hasNotes

  // Actions
  setSessions: (sessions: ChatSession[] | ((prev: ChatSession[]) => ChatSession[])) => void;
  setActiveSessionId: (id: string | null) => void;
  
  handleNewChat: (socket: Socket | null, forcedId?: string, cwd?: string, agent?: string) => void;
  handleSessionSelect: (socket: Socket | null, uiId: string) => void;
  handleDeleteSession: (socket: Socket | null, uiId: string, forcePermanent?: boolean) => void;
  handleTogglePin: (socket: Socket | null, id: string) => void;
  handleRenameSession: (socket: Socket | null, id: string, newName: string) => void;
  hydrateSession: (socket: Socket | null, uiId: string) => void;
  fetchStats: (socket: Socket | null, acpSessionId: string) => Promise<StatsResponse>;
  handleActiveSessionModelChange: (socket: Socket | null, model: string) => void;
  handleSessionModelChange: (socket: Socket | null, uiId: string, model: string) => void;
  handleUpdateModel: (id: string, model: string) => void;
  handleSetSessionOption: (socket: Socket | null, uiId: string, optionId: string, value: unknown) => void;
  handleRestartProcess: (socket: Socket | null) => void;
  handleSaveSession: (socket: Socket | null) => void;
  handleInitialLoad: (socket: Socket | null, fetchAudioDevices: () => void) => void;
  checkPendingPrompts: (socket: Socket | null) => void;
}

export const useSessionLifecycleStore = create<SessionLifecycleState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isUrlSyncReady: false,
  isInitiallyLoaded: false,
  lastStatsFetchByAcp: {},
  sessionNotes: {},

  setSessions: (sessions) => set(state => ({
    sessions: typeof sessions === 'function' ? sessions(state.sessions) : sessions
  })),

  setActiveSessionId: (id) => {
    set({ activeSessionId: id });
    if (get().isUrlSyncReady) {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set('s', id);
      else url.searchParams.delete('s');
      window.history.replaceState({}, '', url.toString());
    }
  },

  handleInitialLoad: (socket, fetchAudioDevices) => {
    if (!socket || get().isInitiallyLoaded) return;
    set({ isInitiallyLoaded: true });
    fetchAudioDevices();

    socket.emit('load_sessions', (res: LoadSessionsResponse) => {
      if (res && res.sessions) {
        if (res.sessions.length > 0) {
          const notesMap: Record<string, boolean> = {};
          res.sessions.forEach((s: ChatSession & { hasNotes?: boolean }) => {
            if (s.hasNotes) notesMap[s.id] = true;
          });
          set({
            sessions: res.sessions.map((s: ChatSession) => applyModelState(
              { ...s, isTyping: Boolean(s.isTyping), isWarmingUp: false },
              { currentModelId: s.currentModelId, modelOptions: s.modelOptions }
            )),
            sessionNotes: notesMap
          });
          res.sessions.forEach((s: ChatSession) => maybeHydrateContextUsage(s));

          const urlParams = new URLSearchParams(window.location.search);
          const urlSessionId = urlParams.get('s');

          set({ isUrlSyncReady: true });
          if (urlSessionId && res.sessions.some((s: ChatSession) => s.id === urlSessionId)) {
            get().handleSessionSelect(socket, urlSessionId);
          }
        } else {
          set({ sessions: [], isUrlSyncReady: true });
        }
      }
    });
  },

  fetchStats: async (socket, acpSessionId) => {
    if (!socket) return { error: 'Socket not connected' };
    return new Promise((resolve) => {
      const session = get().sessions.find(s => s.acpSessionId === acpSessionId);
      socket.emit('get_stats', { sessionId: acpSessionId, providerId: session?.provider || null, uiId: session?.id || null }, (res: StatsResponse) => {
        if (res.stats) {
          const used = Number(res.stats.usedTokens);
          const total = Number(res.stats.totalTokens);
          if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
            const nextPct = (used / total) * 100;
            const currentPct = useSystemStore.getState().getContextUsage(session?.provider, acpSessionId);
            if (!(Number.isFinite(currentPct) && Number(currentPct) > 0 && nextPct <= 0)) {
              useSystemStore.getState().setContextUsage(session?.provider, acpSessionId, nextPct);
            }
          }
          set(state => ({
            sessions: state.sessions.map(s => s.acpSessionId === acpSessionId ? { ...s, stats: res.stats } : s)
          }));
        }
        resolve(res);
      });
    });
  },

  handleNewChat: (socket, id, cwd, agent) => {
    if (!socket) return;
    const uiId = id || Date.now().toString();
    const { sessions } = get();

    if (sessions.find(s => s.id === uiId)) return;

    const sysState = useSystemStore.getState();
    const providerId = sysState.activeProviderId || sysState.defaultProviderId || sysState.branding.providerId || sysState.branding.assistantName;
    const branding = sysState.getBranding(providerId);
    const defaultModel = getDefaultModelSelection(branding.models);
    const defaultModelId = getModelIdForSelection(defaultModel, branding.models);

    const newSession: ChatSession = {
      id: uiId,
      acpSessionId: null,
      name: 'New Chat',
      messages: [],
      isTyping: false,
      isWarmingUp: true,
      model: defaultModel,
      currentModelId: defaultModelId || defaultModel,
      cwd: cwd || null,
      provider: providerId
    };

    set(state => ({
      sessions: [...state.sessions, newSession]
    }));
    get().setActiveSessionId(uiId);

    socket.emit('save_snapshot', newSession);

    const attemptCreate = () => {
      if (!socket.connected) return;
      socket.emit('create_session', { providerId, model: newSession.model, cwd, agent }, (res: CreateSessionResponse) => {
        if (res && (res.sessionId || res.acpSessionId)) {
          const acpId = res.sessionId || res.acpSessionId || null;
          set(state => ({
            sessions: state.sessions.map(s => s.id === uiId ? {
              ...s,
              acpSessionId: acpId,
              isWarmingUp: false,
              model: res.model || s.model,
              currentModelId: res.currentModelId ?? s.currentModelId,
              modelOptions: mergeModelOptions(s.modelOptions, res.modelOptions),
              configOptions: mergeProviderConfigOptions(s.configOptions, res.configOptions)
            } : s)
          }));
          if (acpId) get().fetchStats(socket, acpId);
          socket.emit('watch_session', { providerId, sessionId: acpId });
          const updatedSession = get().sessions.find(s => s.id === uiId);
          if (updatedSession) socket.emit('save_snapshot', updatedSession);
        } else if (res && res.error === 'Daemon not ready') {
          setTimeout(attemptCreate, 1000);
        } else {
          if (res?.error) console.error('[CHAT] Create session error:', res.error);
          set(state => ({
            sessions: state.sessions.map(s => s.id === uiId ? { ...s, isWarmingUp: false } : s)
          }));
        }
      });
    };
    attemptCreate();
  },

  handleSessionSelect: (socket, uiId) => {
    const { sessions } = get();
    const session = sessions.find(s => s.id === uiId);
    if (!session) return;
    maybeHydrateContextUsage(session);
    const hasCachedContext = session.acpSessionId
      ? useSystemStore.getState().hasContextUsage(session.provider, session.acpSessionId)
      : false;

    set(state => ({
      sessions: state.sessions.map(s => s.id === uiId ? { ...s, hasUnreadResponse: false } : s)
    }));
    get().setActiveSessionId(uiId);

    if (session.acpSessionId && !session.isWarmingUp && session.messages.length > 0) {
      if (!hasCachedContext) get().hydrateSession(socket, uiId);
      return;
    }
    get().hydrateSession(socket, uiId);
  },

  hydrateSession: (socket, uiId) => {
    if (!socket) return;
    const session = get().sessions.find(s => s.id === uiId);
    if (session) maybeHydrateContextUsage(session);
    set(state => ({
      sessions: state.sessions.map(s => s.id === uiId ? { ...s, isWarmingUp: true } : s)
    }));

    const attemptHydrate = () => {
      socket.emit('get_session_history', { uiId }, (res: SessionHistoryResponse) => {
        if (res && res.session) {
          const fullHistory = res.session;
          let activeAssistantIndex = -1;
          for (let i = fullHistory.messages.length - 1; i >= 0; i--) {
            const message = fullHistory.messages[i];
            if (message.role === 'assistant' && message.isStreaming) {
              activeAssistantIndex = i;
              break;
            }
          }
          const cleanedMessages = fullHistory.messages.map((m: Message, index: number) => {
            const isActiveAssistant = index === activeAssistantIndex;
            return {
              ...m,
              isStreaming: isActiveAssistant,
              timeline: m.timeline
                ?.filter(step => step.type !== 'thought' || (isActiveAssistant && step.content !== '_Thinking..._'))
                .map(step => step.type === 'tool'
                  ? { ...step, isCollapsed: isActiveAssistant ? step.isCollapsed : true }
                  : step)
            };
          });
          const hasAwaitingPermission = cleanedMessages.some((message: Message) =>
            message.timeline?.some(step => step.type === 'permission' && !step.response)
          );
          set(state => ({
            sessions: state.sessions.map(s => s.id === uiId ? {
              ...s,
              messages: cleanedMessages,
              isTyping: activeAssistantIndex !== -1,
              isAwaitingPermission: hasAwaitingPermission,
              configOptions: mergeProviderConfigOptions(s.configOptions, fullHistory.configOptions),
              model: fullHistory.model || s.model,
              currentModelId: fullHistory.currentModelId ?? s.currentModelId,
              modelOptions: mergeModelOptions(s.modelOptions, fullHistory.modelOptions)
            } : s)
          }));
          maybeHydrateContextUsage(fullHistory);

          const resumeAgent = useSystemStore.getState().workspaceCwds.find(w => w.path === fullHistory.cwd)?.agent || useSystemStore.getState().workspaceCwds[0]?.agent;
          socket.emit('create_session', { providerId: fullHistory.provider, model: fullHistory.currentModelId || fullHistory.model, existingAcpId: fullHistory.acpSessionId, cwd: fullHistory.cwd, agent: resumeAgent }, (acpRes: CreateSessionResponse) => {
            if (acpRes && acpRes.sessionId) {
              const acpId = acpRes.sessionId;
              set(state => ({
                sessions: state.sessions.map(s => {
                  if (s.id !== uiId) return s;
                  const hasActiveStream = s.messages.some(message => message.role === 'assistant' && message.isStreaming);
                  const hasOpenPermission = s.messages.some(message =>
                    message.timeline?.some(step => step.type === 'permission' && !step.response)
                  );
                  return {
                    ...s,
                    acpSessionId: acpId,
                    isTyping: hasActiveStream,
                    isAwaitingPermission: hasOpenPermission,
                    isWarmingUp: false,
                    model: acpRes.model || s.model,
                    currentModelId: acpRes.currentModelId ?? s.currentModelId,
                    modelOptions: mergeModelOptions(s.modelOptions, acpRes.modelOptions),
                    configOptions: mergeProviderConfigOptions(s.configOptions, acpRes.configOptions)
                  };
                })
              }));
              get().fetchStats(socket, acpId);
              socket.emit('watch_session', { providerId: fullHistory.provider, sessionId: acpId });
            } else if (acpRes && acpRes.error === 'Daemon not ready') {
              setTimeout(attemptHydrate, 1000);
            } else {
              if (acpRes?.error) console.error('[CHAT] Hydration error:', acpRes.error);
              set(state => ({
                sessions: state.sessions.map(s => s.id === uiId ? { ...s, isTyping: false, isWarmingUp: false } : s)
              }));
            }
          });
        } else {
          if (res?.error) console.error('[CHAT] get_session_history error:', res.error);
          set(state => ({
            sessions: state.sessions.map(s => s.id === uiId ? { ...s, isWarmingUp: false } : s)
          }));
        }
      });
    };
    attemptHydrate();
  },

  handleDeleteSession: (socket, uiId, forcePermanent = false) => {
    const session = get().sessions.find(s => s.id === uiId);
    if (socket && session) {
      if (forcePermanent || useSystemStore.getState().deletePermanent) {
        socket.emit('delete_session', { providerId: session.provider, uiId });
      } else {
        socket.emit('archive_session', { providerId: session.provider, uiId });
      }
    }
    const { sessions, activeSessionId } = get();
    const updated = sessions.filter(s => s.id !== uiId);
    const nextActiveId = activeSessionId && updated.some(s => s.id === activeSessionId)
      ? activeSessionId
      : null;

    set({ sessions: updated });
    get().setActiveSessionId(nextActiveId);
  },

  handleTogglePin: (socket, id) => {
    set(state => {
      const updated = state.sessions.map(s => s.id === id ? { ...s, isPinned: !s.isPinned } : s);
      const sorted = [...updated].sort((a, b) => (a.isPinned === b.isPinned ? 0 : a.isPinned ? -1 : 1));
      const session = sorted.find(s => s.id === id);
      if (session && socket) socket.emit('save_snapshot', session);
      return { sessions: sorted };
    });
  },

  handleRenameSession: (socket, id, newName) => {
    set(state => {
      const updated = state.sessions.map(s => s.id === id ? { ...s, name: newName } : s);
      const session = updated.find(s => s.id === id);
      if (session && socket) socket.emit('save_snapshot', session);
      return { sessions: updated };
    });
  },

  handleActiveSessionModelChange: (socket, model) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    get().handleSessionModelChange(socket, activeSessionId, model);
  },

  handleSessionModelChange: (socket, uiId, model) => {
    const session = get().sessions.find(s => s.id === uiId);
    const sysState = useSystemStore.getState();
    const providerModels = sysState.providersById[session?.provider || '']?.branding?.models || sysState.branding.models;
    const currentModelId = getModelIdForSelection(model, providerModels) || model;
    set(state => ({
      sessions: state.sessions.map(s => s.id === uiId ? applyModelState(s, { model, currentModelId }) : s)
    }));

    if (socket) {
      socket.emit('set_session_model', { uiId, model }, (res?: CreateSessionResponse) => {
        if (!res || res.error) return;
        set(state => ({
          sessions: state.sessions.map(s => s.id === uiId ? {
            ...applyModelState(s, {
              model: res.model || model,
              currentModelId: res.currentModelId ?? currentModelId,
              modelOptions: res.modelOptions
            }),
            configOptions: mergeProviderConfigOptions(s.configOptions, res.configOptions)
          } : s)
        }));
      });
    }
  },

  handleUpdateModel: (id, model) => {
    set(state => ({
      sessions: state.sessions.map(s => s.id === id ? applyModelState(s, {
        model,
        currentModelId: getModelIdForSelection(model, useSystemStore.getState().providersById[get().sessions.find(session => session.id === id)?.provider || '']?.branding?.models || useSystemStore.getState().branding.models) || model
      }) : s)
    }));
  },

  handleSetSessionOption: (socket, uiId, optionId, value) => {
    const session = get().sessions.find(s => s.id === uiId);
    if (!session) return;

    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== uiId) return s;
        const opts = s.configOptions?.map(o => o.id === optionId ? { ...o, currentValue: value } : o);
        return { ...s, configOptions: opts };
      })
    }));
    if (socket) {
      socket.emit('set_session_option', { uiId, optionId, value });
    }
  },

  handleRestartProcess: (socket) => {
    if (socket) {
      socket.emit('restart_process');
    }
  },

  handleSaveSession: (socket) => {
    const activeSession = get().sessions.find(s => s.id === get().activeSessionId);
    if (socket && activeSession) socket.emit('save_snapshot', activeSession);
  },

  checkPendingPrompts: () => {
    // No-op for current provider implementation
  }
}));
