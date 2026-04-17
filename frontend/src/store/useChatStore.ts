import { create } from 'zustand';
import { Socket } from 'socket.io-client';
import { useSystemStore } from './useSystemStore';
import { useStreamStore } from './useStreamStore';
import { mergeProviderConfigOptions } from '../utils/configOptions';
import type { ChatSession, Message, Attachment, LoadSessionsResponse, CreateSessionResponse, SessionHistoryResponse, StatsResponse, ForkSessionResponse } from '../types';

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  isUrlSyncReady: boolean;
  isInitiallyLoaded: boolean;
  inputs: Record<string, string>; // uiId -> current input text
  attachmentsMap: Record<string, Attachment[]>; // uiId -> attachments
  lastStatsFetchByAcp: Record<string, number>; // acpId -> timestamp
  sessionNotes: Record<string, boolean>; // uiId -> hasNotes

  // Actions
  setSessions: (sessions: ChatSession[]) => void;
  setActiveSessionId: (id: string | null) => void;
  setInput: (uiId: string, text: string) => void;
  setAttachments: (uiId: string, attachments: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void;

  // Logic
  handleNewChat: (socket: Socket | null, forcedId?: string, cwd?: string, agent?: string) => void;
  handleSessionSelect: (socket: Socket | null, uiId: string) => void;
  handleDeleteSession: (socket: Socket | null, uiId: string) => void;
  handleTogglePin: (socket: Socket | null, id: string) => void;
  handleRenameSession: (socket: Socket | null, id: string, newName: string) => void;
  hydrateSession: (socket: Socket | null, uiId: string) => void;
  fetchStats: (socket: Socket | null, acpSessionId: string) => Promise<StatsResponse>;
  handleActiveSessionModelChange: (socket: Socket | null, model: 'fast' | 'balanced' | 'flagship') => void;
  handleUpdateModel: (id: string, model: 'fast' | 'balanced' | 'flagship') => void;
  handleSetSessionOption: (socket: Socket | null, uiId: string, optionId: string, value: unknown) => void;
  handleRestartProcess: (socket: Socket | null) => void;

  // Prompting
  handleSubmit: (socket: Socket | null, overridePrompt?: string, attachmentsOverride?: Attachment[]) => void;
  handleCancel: (socket: Socket | null) => void;
  handleSaveSession: (socket: Socket | null) => void;
  handleForkSession: (socket: Socket | null, sessionId: string, messageIndex: number, onComplete?: () => void) => void;
  handleRespondPermission: (socket: Socket | null, requestId: number, optionId: string, toolCallId?: string, acpSessionId?: string) => void;

  checkPendingPrompts: (socket: Socket | null) => void;

  // File Upload
  handleFileUpload: (files: FileList | File[] | null, uiId: string | null) => Promise<void>;
  addAttachment: (uiId: string, attachment: Attachment) => void;
  removeAttachment: (uiId: string, index: number) => void;

  handleInitialLoad: (socket: Socket | null, fetchAudioDevices: () => void) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isUrlSyncReady: false,
  isInitiallyLoaded: false,
  inputs: {},
  attachmentsMap: {},
  lastStatsFetchByAcp: {},
  sessionNotes: {},

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => {
    set({ activeSessionId: id });
    if (get().isUrlSyncReady) {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set('s', id);
      else url.searchParams.delete('s');
      window.history.replaceState({}, '', url.toString());
    }
  },

  setInput: (uiId, text) => set(state => ({
    inputs: { ...state.inputs, [uiId]: text }
  })),

  setAttachments: (uiId, attachments) => set(state => {
    const current = state.attachmentsMap[uiId] || [];
    const newVal = typeof attachments === 'function' ? attachments(current) : attachments;
    return {
      attachmentsMap: { ...state.attachmentsMap, [uiId]: newVal }
    };
  }),

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
            sessions: res.sessions.map((s: ChatSession) => ({ ...s, isTyping: false, isWarmingUp: false })),
            sessionNotes: notesMap
          });

          const urlParams = new URLSearchParams(window.location.search);
          const urlSessionId = urlParams.get('s');

          set({ isUrlSyncReady: true });
          // Only auto-select if URL specifies a session
          if (urlSessionId && res.sessions.some((s: ChatSession) => s.id === urlSessionId)) {
            get().handleSessionSelect(socket, urlSessionId);
          }
        } else {
          set({ isUrlSyncReady: true });
        }
      }
    });
  },

  fetchStats: async (socket, acpSessionId) => {
    if (!socket) return { error: 'Socket not connected' };
    return new Promise((resolve) => {
      socket.emit('get_stats', { sessionId: acpSessionId }, (res: StatsResponse) => {
        if (res.stats) {
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

    const branding = useSystemStore.getState().branding;
    const defaultModel = branding.models?.default || 'flagship';

    const newSession: ChatSession = {
      id: uiId,
      acpSessionId: null,
      name: 'New Chat',
      messages: [],
      isTyping: false,
      isWarmingUp: true,
      model: defaultModel as ChatSession['model'],
      cwd: cwd || null,
      provider: branding.assistantName
    };

    set(state => ({
      sessions: [...state.sessions, newSession],
      activeSessionId: uiId
    }));

    socket.emit('save_snapshot', newSession);

    const attemptCreate = () => {
      if (!socket.connected) return;
      socket.emit('create_session', { model: newSession.model, cwd, agent }, (res: CreateSessionResponse) => {
        if (res && (res.sessionId || res.acpSessionId)) {
          const acpId = res.sessionId || res.acpSessionId || null;
          set(state => ({
            sessions: state.sessions.map(s => s.id === uiId ? {
              ...s,
              acpSessionId: acpId,
              isWarmingUp: false,
              configOptions: mergeProviderConfigOptions(s.configOptions, res.configOptions)
            } : s)
          }));
          if (acpId) get().fetchStats(socket, acpId);
          // Join the session room to receive streaming events
          socket.emit('watch_session', { sessionId: acpId });
          const updatedSession = get().sessions.find(s => s.id === uiId);
          if (updatedSession) socket.emit('save_snapshot', updatedSession);
        } else if (res && res.error === 'Daemon not ready') {
          setTimeout(attemptCreate, 1000);
        } else {
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

    set(state => ({
      activeSessionId: uiId,
      sessions: state.sessions.map(s => s.id === uiId ? { ...s, hasUnreadResponse: false } : s)
    }));

    if (session.acpSessionId && !session.isWarmingUp && session.messages.length > 0) return;
    get().hydrateSession(socket, uiId);
  },

  hydrateSession: (socket, uiId) => {
    if (!socket) return;
    set(state => ({
      sessions: state.sessions.map(s => s.id === uiId ? { ...s, isWarmingUp: true } : s)
    }));

    const attemptHydrate = () => {
      socket.emit('get_session_history', { uiId }, (res: SessionHistoryResponse) => {
        if (res && res.session) {
          const fullHistory = res.session;
          const cleanedMessages = fullHistory.messages.map((m: Message) => ({
             ...m, isStreaming: false,
             timeline: m.timeline?.filter(step => step.type !== 'thought').map(step => step.type === 'tool' ? { ...step, isCollapsed: true } : step)
          }));
          set(state => ({
            sessions: state.sessions.map(s => s.id === uiId ? {
              ...s,
              messages: cleanedMessages,
              configOptions: mergeProviderConfigOptions(s.configOptions, fullHistory.configOptions),
              model: fullHistory.model || s.model
            } : s)
          }));

          const resumeAgent = useSystemStore.getState().workspaceCwds.find(w => w.path === fullHistory.cwd)?.agent || useSystemStore.getState().workspaceCwds[0]?.agent;
          socket.emit('create_session', { model: fullHistory.model, existingAcpId: fullHistory.acpSessionId, cwd: fullHistory.cwd, agent: resumeAgent }, (acpRes: CreateSessionResponse) => {
            if (acpRes && acpRes.sessionId) {
              const acpId = acpRes.sessionId;
              set(state => ({
                sessions: state.sessions.map(s => s.id === uiId ? {
                  ...s,
                  acpSessionId: acpId,
                  isTyping: false,
                  isWarmingUp: false,
                  configOptions: mergeProviderConfigOptions(s.configOptions, acpRes.configOptions)
                } : s)
              }));
              get().fetchStats(socket, acpId);
              socket.emit('watch_session', { sessionId: acpId });
            } else if (acpRes && acpRes.error === 'Daemon not ready') {
              setTimeout(attemptHydrate, 1000);
            } else {
              set(state => ({
                sessions: state.sessions.map(s => s.id === uiId ? { ...s, isTyping: false, isWarmingUp: false } : s)
              }));
            }
          });
        }
      });
    };
    attemptHydrate();
  },

  handleDeleteSession: (socket, uiId) => {
    if (socket) socket.emit('delete_session', { uiId });
    const { sessions, activeSessionId } = get();
    const updated = sessions.filter(s => s.id !== uiId);

    if (updated.length === 0) {
      set({ sessions: [] });
      const defaultCwd = useSystemStore.getState().workspaceCwds[0]?.path;
      const defaultAgent = useSystemStore.getState().workspaceCwds[0]?.agent;
      get().handleNewChat(socket, undefined, defaultCwd, defaultAgent);
      return;
    }

    let nextActiveId = activeSessionId;
    if (activeSessionId === uiId) {
      nextActiveId = updated[0].id;
    }

    set({ sessions: updated, activeSessionId: nextActiveId });
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
    const { activeSessionId, sessions } = get();
    if (!activeSessionId) return;
    const updatedSessions = sessions.map(s => s.id === activeSessionId ? { ...s, model } : s);
    set({ sessions: updatedSessions });
    
    if (socket) {
      socket.emit('set_session_model', { uiId: activeSessionId, model });
    }
  },

  handleUpdateModel: (id, model) => {
    set(state => ({
      sessions: state.sessions.map(s => s.id === id ? { ...s, model } : s)
    }));
  },

  handleSetSessionOption: (socket, uiId, optionId, value) => {
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

  checkPendingPrompts: () => {
    // No-op for current provider implementation
  },

  handleFileUpload: async (files, activeSessionId) => {
    if (!files || files.length === 0 || !activeSessionId) return;

    const newAttachments: Attachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();

      const fileData = await new Promise<string>((resolve) => {
        reader.onload = (e) => {
          const result = e.target?.result as string;
          resolve(result.split(',')[1]); // Base64 part
        };
        reader.readAsDataURL(file);
      });

      newAttachments.push({
        name: file.name,
        size: file.size,
        mimeType: file.type,
        data: fileData
      });
    }

    set(state => {
      const current = state.attachmentsMap[activeSessionId] || [];
      return {
        attachmentsMap: { ...state.attachmentsMap, [activeSessionId]: [...current, ...newAttachments] }
      };
    });
  },

  handleSubmit: (socket, overridePrompt, attachmentsOverride) => {
    const { activeSessionId, sessions, inputs, attachmentsMap } = get();
    if (!activeSessionId) return;

    const activeSession = sessions.find(s => s.id === activeSessionId);
    const currentInput = inputs[activeSessionId] || '';
    const promptText = (overridePrompt || currentInput).trim();
    const attachments = attachmentsOverride || attachmentsMap[activeSessionId] || [];

    if (!socket || !activeSession || activeSession.isTyping || activeSession.isWarmingUp) return;
    if (!promptText && attachments.length === 0) return;

    const acpId = activeSession.acpSessionId;
    if (!acpId) return;

    // Intercept custom commands with a prompt
    const customCmd = useSystemStore.getState().customCommands.find(c => c.prompt && promptText === c.name);
    if (customCmd && customCmd.prompt) {
      get().handleSubmit(socket, customCmd.prompt);
      return;
    }

    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now()}`;

    // Update streaming store state
    useStreamStore.setState(state => ({
      isProcessActiveByAcp: { ...state.isProcessActiveByAcp, [acpId]: true },
      activeMsgIdByAcp: { ...state.activeMsgIdByAcp, [acpId]: assistantMsgId }
    }));

    set(state => ({
      inputs: { ...state.inputs, [activeSessionId]: '' },
      attachmentsMap: { ...state.attachmentsMap, [activeSessionId]: [] },
      sessions: state.sessions.map(s => s.id === activeSessionId ? {
        ...s,
        isTyping: true,
        messages: [...s.messages,
          { id: userMsgId, role: 'user', content: promptText, attachments: [...attachments] },
          { id: assistantMsgId, role: 'assistant', content: '', isStreaming: true, timeline: [{ type: 'thought', content: '_Thinking..._' }], turnStartTime: Date.now() }
        ]
      } : s)
    }));

    const updatedSession = get().sessions.find(s => s.id === activeSessionId);
    if (updatedSession) socket.emit('save_snapshot', updatedSession);

    socket.emit('prompt', {
      uiId: activeSession.id,
      sessionId: acpId,
      prompt: promptText,
      model: activeSession.model,
      attachments
    });
  },

  handleCancel: (socket) => {
    const { activeSessionId, sessions } = get();
    const activeSession = sessions.find(s => s.id === activeSessionId);
    const acpId = activeSession?.acpSessionId;
    if (socket && acpId) {
      socket.emit('cancel_prompt', { sessionId: acpId });
    }
  },

  handleSaveSession: (socket) => {
    const activeSession = get().sessions.find(s => s.id === get().activeSessionId);
    if (socket && activeSession) socket.emit('save_snapshot', activeSession);
  },

  handleForkSession: (socket, sessionId, messageIndex, onComplete) => {
    if (!socket) return;
    socket.emit('fork_session', { uiId: sessionId, messageIndex }, (res: ForkSessionResponse) => {
      onComplete?.();
      if (!res?.success || !res.newUiId || !res.newAcpId) return;
      const original = get().sessions.find(s => s.id === sessionId);
      if (!original) return;
      const forkedMessages = original.messages.slice(0, messageIndex + 1).map(m => ({ ...m, isStreaming: false }));
      const newSession: ChatSession = {
        id: res.newUiId,
        acpSessionId: res.newAcpId,
        name: `${original.name} (fork)`,
        messages: forkedMessages,
        isTyping: false,
        isWarmingUp: false,
        model: original.model,
        cwd: original.cwd,
        folderId: original.folderId,
        forkedFrom: sessionId,
        forkPoint: messageIndex,
        configOptions: mergeProviderConfigOptions(original.configOptions, res.configOptions)
      };
      set(state => ({
        sessions: [...state.sessions, newSession],
        activeSessionId: res.newUiId!,
      }));
      get().fetchStats(socket, res.newAcpId);
      socket.emit('watch_session', { sessionId: res.newAcpId });
      // Auto-send fork context prompt after a short delay for ACP to be ready
      setTimeout(() => {
        get().handleSubmit(socket, 'This is a conversation fork. You are now detached from the original session and acting as a new session with the existing history. If you are asked about work you did, only refer to work you did after this message. Acknowledge briefly.');
      }, 500);
    });
  },

  addAttachment: (uiId, attachment) => set(state => {
    const current = state.attachmentsMap[uiId] || [];
    return {
      attachmentsMap: { ...state.attachmentsMap, [uiId]: [...current, attachment] }
    };
  }),

  removeAttachment: (uiId, index) => set(state => {
    const current = state.attachmentsMap[uiId] || [];
    return {
      attachmentsMap: { ...state.attachmentsMap, [uiId]: current.filter((_, i) => i !== index) }
    };
  }),

  handleRespondPermission: (socket, requestId, optionId, toolCallId, acpSessionId) => {
    if (!socket) return;

    set(state => ({
      sessions: state.sessions.map(session => {
        if (session.acpSessionId !== acpSessionId) return session;

        return {
          ...session,
          isAwaitingPermission: false,
          messages: session.messages.map(msg => {
            if (!msg.timeline) return msg;

            const hasThisRequest = msg.timeline.some(step =>
              step.type === 'permission' && step.request.id === requestId
            );
            if (!hasThisRequest) return msg;

            return {
              ...msg,
              timeline: msg.timeline.map(step => {
                if (step.type === 'permission' && step.request.id === requestId) {
                  return { ...step, response: optionId };
                }
                return step;
              })
            };
          })
        };
      })
    }));

    socket.emit('respond_permission', { id: requestId, optionId, toolCallId, sessionId: acpSessionId });

    const updatedSession = get().sessions.find(s => s.acpSessionId === acpSessionId);
    if (updatedSession) socket.emit('save_snapshot', updatedSession);
  }
}));
