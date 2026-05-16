import { create } from 'zustand';
import { Socket } from 'socket.io-client';
import { useSystemStore } from './useSystemStore';
import { useStreamStore } from './useStreamStore';
import { useInputStore } from './useInputStore';
import { useSessionLifecycleStore } from './useSessionLifecycleStore';
import { mergeProviderConfigOptions } from '../utils/configOptions';
import { normalizeModelOptions } from '../utils/modelOptions';
import { createMessageId } from '../utils/messageIds';
import type { ChatSession, Attachment, ForkSessionResponse } from '../types';

function mergeModelOptions(current?: ChatSession['modelOptions'], incoming?: ChatSession['modelOptions']) {
  const existing = normalizeModelOptions(current);
  const updates = normalizeModelOptions(incoming);
  if (updates.length === 0) return existing;

  const byId = new Map(existing.map(option => [option.id, option]));
  updates.forEach(option => byId.set(option.id, { ...byId.get(option.id), ...option }));
  return Array.from(byId.values());
}

interface ChatState {
  // Coordinating Actions
  handleSubmit: (socket: Socket | null, overridePrompt?: string, attachmentsOverride?: Attachment[]) => void;
  handleCancel: (socket: Socket | null) => void;
  handleForkSession: (socket: Socket | null, sessionId: string, messageIndex: number, onComplete?: () => void) => void;
  handleRespondPermission: (socket: Socket | null, requestId: number, optionId: string, toolCallId?: string, acpSessionId?: string) => void;
}

export const useChatStore = create<ChatState>((_set, get) => ({
  handleSubmit: (socket, overridePrompt, attachmentsOverride) => {
    const lifecycle = useSessionLifecycleStore.getState();
    const inputStore = useInputStore.getState();
    const { activeSessionId, sessions } = lifecycle;
    const { inputs, attachmentsMap } = inputStore;

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

    const turnStartTime = Date.now();
    const userMsgId = createMessageId('user');
    const assistantMsgId = createMessageId('assistant');

    // Update streaming store state
    useStreamStore.setState(state => ({
      isProcessActiveByAcp: { ...state.isProcessActiveByAcp, [acpId]: true },
      activeMsgIdByAcp: { ...state.activeMsgIdByAcp, [acpId]: assistantMsgId }
    }));

    // Clear input
    inputStore.clearInput(activeSessionId);

    // Update session with new messages
    lifecycle.setSessions(sessions.map(s => s.id === activeSessionId ? {
      ...s,
      isTyping: true,
      messages: [...s.messages,
        { id: userMsgId, role: 'user', content: promptText, attachments: [...attachments] },
        { id: assistantMsgId, role: 'assistant', content: '', isStreaming: true, timeline: [{ type: 'thought', content: '_Thinking..._' }], turnStartTime }
      ]
    } : s));

    const updatedSession = useSessionLifecycleStore.getState().sessions.find(s => s.id === activeSessionId);
    if (updatedSession) socket.emit('save_snapshot', updatedSession);

    socket.emit('prompt', {
      providerId: activeSession.provider,
      uiId: activeSession.id,
      sessionId: acpId,
      prompt: promptText,
      model: activeSession.model,
      attachments,
      assistantMessageId: assistantMsgId,
      userMessageId: userMsgId,
      turnStartTime
    });
  },

  handleCancel: (socket) => {
    const { activeSessionId, sessions } = useSessionLifecycleStore.getState();
    const activeSession = sessions.find(s => s.id === activeSessionId);
    const acpId = activeSession?.acpSessionId;
    if (socket && acpId) {
      socket.emit('cancel_prompt', { providerId: activeSession.provider, sessionId: acpId });
    }
  },

  handleForkSession: (socket, sessionId, messageIndex, onComplete) => {
    if (!socket) return;
    const lifecycle = useSessionLifecycleStore.getState();
    
    socket.emit('fork_session', { uiId: sessionId, messageIndex }, (res: ForkSessionResponse) => {
      onComplete?.();
      if (!res?.success || !res.newUiId || !res.newAcpId) return;
      
      const original = lifecycle.sessions.find(s => s.id === sessionId);
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
        currentModelId: res.currentModelId ?? original.currentModelId,
        modelOptions: mergeModelOptions(original.modelOptions, res.modelOptions),
        cwd: original.cwd,
        folderId: original.folderId,
        forkedFrom: sessionId,
        forkPoint: messageIndex,
        configOptions: mergeProviderConfigOptions(original.configOptions, res.configOptions),
        provider: original.provider
      };
      
      lifecycle.setSessions([...lifecycle.sessions, newSession]);
      lifecycle.setActiveSessionId(res.newUiId!);
      lifecycle.fetchStats(socket, res.newAcpId);
      
      socket.emit('watch_session', { providerId: original.provider, sessionId: res.newAcpId });
      
      setTimeout(() => {
        get().handleSubmit(socket, 'This is a conversation fork. You are now detached from the original session and acting as a new session with the existing history. If you are asked about work you did, only refer to work you did after this message. Acknowledge briefly.');
      }, 500);
    });
  },

  handleRespondPermission: (socket, requestId, optionId, toolCallId, acpSessionId) => {
    if (!socket) return;
    const lifecycle = useSessionLifecycleStore.getState();

    lifecycle.setSessions(lifecycle.sessions.map(session => {
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
    }));

    const session = lifecycle.sessions.find(s => s.acpSessionId === acpSessionId);
    const providerId = session?.provider;

    socket.emit('respond_permission', { 
      providerId,
      id: requestId, 
      optionId, 
      toolCallId, 
      sessionId: acpSessionId 
    });

    const updatedSession = useSessionLifecycleStore.getState().sessions.find(s => s.acpSessionId === acpSessionId);
    if (updatedSession) socket.emit('save_snapshot', updatedSession);
  }
}));
