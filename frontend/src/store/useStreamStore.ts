import { create } from 'zustand';
import { useChatStore } from './useChatStore';
import { useSystemStore } from './useSystemStore';
import type { Socket } from 'socket.io-client';
import type { StreamTokenData, StreamEventData, StreamDoneData, Message } from '../types';

/**
 * Manages the typewriter rendering pipeline for streamed AI responses.
 *
 * Architecture: Incoming tokens/events are queued per ACP session (`streamQueues`),
 * then drained by `processBuffer` on a 32ms tick. This decouples network arrival rate
 * from render rate, enabling adaptive typewriter speed based on buffer depth.
 *
 * Priority: `tool_end` events preserve shell output — if the tool's existing output
 * starts with `$ ` (indicating live shell streaming), it is NOT overwritten by the
 * final tool_end output payload.
 */
export interface StreamState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streamQueues: Record<string, any[]>; // acpId -> queue
  activeMsgIdByAcp: Record<string, string>; // acpId -> msgId
  isProcessActiveByAcp: Record<string, boolean>; // acpId -> bool
  displayedContentByMsg: Record<string, string>; // msgId -> full text
  settledLengthByMsg: Record<string, number>; // msgId -> length of already-rendered content
  typewriterInterval: number | null;

  // Streaming listeners (called by socket listeners)
  onStreamThought: (data: StreamTokenData) => void;
  onStreamToken: (data: StreamTokenData) => void;
  onStreamEvent: (event: StreamEventData) => void;
  onStreamDone: (socket: Socket | null, data: StreamDoneData) => void;

  // Internal logic
  processBuffer: (scrollToBottom: () => void, onFileEdited?: (path: string) => void, onOpenFileInCanvas?: (path: string) => void) => void;
  ensureAssistantMessage: (acpSessionId: string) => void;
}

export const useStreamStore = create<StreamState>((set, get) => ({
  streamQueues: {},
  activeMsgIdByAcp: {},
  isProcessActiveByAcp: {},
  displayedContentByMsg: {},
  settledLengthByMsg: {},
  typewriterInterval: null,

  /** Lazily creates an assistant message placeholder if one doesn't exist yet for this ACP session. */
  ensureAssistantMessage: (acpSessionId) => {
    const { sessions } = useChatStore.getState();
    const { activeMsgIdByAcp } = get();
    const session = sessions.find(s => s.acpSessionId === acpSessionId);
    if (!session) return;

    const activeMsgId = activeMsgIdByAcp[acpSessionId];
    if (activeMsgId && session.messages.some(m => m.id === activeMsgId)) return;

    const newMsgId = `assistant-${Date.now()}`;
    set(state => ({
      activeMsgIdByAcp: { ...state.activeMsgIdByAcp, [acpSessionId]: newMsgId }
    }));
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s => s.acpSessionId === acpSessionId ? {
        ...s,
        messages: [...s.messages, {
          id: newMsgId,
          role: 'assistant',
          content: '',
          timeline: [],
          isStreaming: true,
          turnStartTime: Date.now()
        }]
      } : s)
    }));
  },

  onStreamThought: (data) => {
    if (!data || !data.sessionId) return;
    const { sessionId, text } = data;

    get().ensureAssistantMessage(sessionId);

    set(state => {
      const queue = [...(state.streamQueues[sessionId] || [])];
      queue.push({ type: 'thought', data: text || '' });
      return {
        isProcessActiveByAcp: { ...state.isProcessActiveByAcp, [sessionId]: true },
        streamQueues: { ...state.streamQueues, [sessionId]: queue }
      };
    });
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s => s.acpSessionId === sessionId ? { ...s, isTyping: true } : s)
    }));
  },

  /**
   * Queues a text token. If the previous queue item was a tool event (isProcessActive),
   * injects a RESPONSE_DIVIDER to visually separate tool output from subsequent prose —
   * but only when backtick count is even (not inside a code block).
   */
  onStreamToken: (data) => {
    if (!data || !data.sessionId) return;
    const { sessionId, text } = data;
    const { isProcessActiveByAcp, activeMsgIdByAcp, displayedContentByMsg } = get();

    let prefix = '';
    if (isProcessActiveByAcp[sessionId]) {
      const activeMsgId = activeMsgIdByAcp[sessionId];
      const existingContent = activeMsgId ? displayedContentByMsg[activeMsgId] : '';
      if (existingContent && existingContent.trim().length > 0) {
        const backticks = (existingContent.match(/`/g) || []).length;
        if (backticks % 2 === 0) prefix = '\n\n:::RESPONSE_DIVIDER:::\n\n';
      }
      set(state => ({ isProcessActiveByAcp: { ...state.isProcessActiveByAcp, [sessionId]: false } }));
    }

    get().ensureAssistantMessage(sessionId);

    set(state => {
      const queue = [...(state.streamQueues[sessionId] || [])];
      queue.push({ type: 'token', data: prefix + (text || '') });
      return {
        streamQueues: { ...state.streamQueues, [sessionId]: queue }
      };
    });
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s => s.acpSessionId === sessionId ? { ...s, isTyping: true } : s)
    }));
  },

  onStreamEvent: (event) => {
    if (!event || !event.sessionId) return;
    const { sessionId } = event;
    get().ensureAssistantMessage(sessionId);

    set(state => {
      const queue = [...(state.streamQueues[sessionId] || [])];
      queue.push({ type: 'event', data: event });
      return {
        isProcessActiveByAcp: { ...state.isProcessActiveByAcp, [sessionId]: true },
        streamQueues: { ...state.streamQueues, [sessionId]: queue }
      };
    });
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s => s.acpSessionId === sessionId ? {
        ...s,
        isTyping: true,
        isAwaitingPermission: event.type === 'permission_request' ? true : s.isAwaitingPermission
      } : s)
    }));
  },

  onStreamDone: (socket, data) => {
    if (!data || !data.sessionId) return;
    const { sessionId } = data;
    // Don't clear isTyping if compaction is in progress
    const isCompacting = useSystemStore.getState().compactingBySession[sessionId];
    if (!isCompacting) {
      useChatStore.setState(state => ({
        sessions: state.sessions.map(s => s.acpSessionId === sessionId ? { ...s, isTyping: false } : s)
      }));
    }

    const startTime = Date.now();
    const check = setInterval(() => {
      const { streamQueues, activeMsgIdByAcp } = get();
      const isQueueEmpty = (!streamQueues[sessionId] || streamQueues[sessionId].length === 0);
      const isTimedOut = Date.now() - startTime > 10000;

      if (isQueueEmpty || isTimedOut) {
        clearInterval(check);
        const activeMsgId = activeMsgIdByAcp[sessionId];
        const isCompacting = useSystemStore.getState().compactingBySession[sessionId];

        useChatStore.setState(state => {
          const activeId = state.activeSessionId;
          const isBackground = state.sessions.some(s => s.acpSessionId === sessionId && s.id !== activeId);
          if (isBackground && useSystemStore.getState().notificationSound) try { new Audio('/memory-sound.mp3').play()?.catch(() => {}); } catch { /* audio may not be available */ };

          const updatedSessions = state.sessions.map(s => {
            if (s.acpSessionId !== sessionId) return s;
            return {
              ...s,
              isTyping: isCompacting ? true : false,
              hasUnreadResponse: activeId !== s.id,
              messages: s.messages.map(m => {
                if (m.id === activeMsgId) {
                  return { ...m, isStreaming: false, turnEndTime: Date.now(), timeline: (m.timeline || []).map(step =>
                    step.type === 'tool' && step.event.status === 'in_progress' ?
                    { ...step, event: { ...step.event, status: s.isSubAgent ? 'completed' : 'failed', output: s.isSubAgent ? step.event.output : 'Aborted', endTime: Date.now() } } : step
                  )} as Message;
                }
                return m;
              })
            };
          });
          const session = updatedSessions.find(s => s.acpSessionId === sessionId);
          if (session && socket) socket.emit('save_snapshot', session);
          return { sessions: updatedSessions };
        });
        useChatStore.getState().fetchStats(socket, sessionId);
      }
    }, 50);
  },

  /**
   * Drains one tick's worth of content from each session's queue into the UI.
   * Adaptive speed: chars-per-tick scales with buffer depth (1/5 for small, 1/3 for
   * medium, full flush for large >500 char buffers). Reschedules itself at 32ms (~30fps).
   */
  processBuffer: (scrollToBottom, onFileEdited, onOpenFileInCanvas) => {
    const { streamQueues, typewriterInterval } = get();
    const hasQueues = Object.values(streamQueues).some(q => q.length > 0);

    if (!hasQueues) {
      if (typewriterInterval) clearTimeout(typewriterInterval);
      set({ typewriterInterval: null });
      return;
    }

    // Read snapshots from both stores
    const streamSnapshot = get();
    const chatSnapshot = useChatStore.getState();

    const newStreamQueues = { ...streamSnapshot.streamQueues };
    const newDisplayedContent = { ...streamSnapshot.displayedContentByMsg };
    const newSettledLength = { ...streamSnapshot.settledLengthByMsg };

    const newSessions = chatSnapshot.sessions.map(session => {
      const acpId = session.acpSessionId;
      if (!acpId || session.isWarmingUp) return session;

      const queue = [...(newStreamQueues[acpId] || [])];
      if (queue.length === 0) return session;

      const activeMsgId = streamSnapshot.activeMsgIdByAcp[acpId];
      if (!activeMsgId) return session;

      const updatedSession = { ...session };

      // Priority Flush: Process all non-token items at the front of the queue immediately.
      // This ensures tool titles, file paths, and permissions update without waiting
      // for the typewriter to finish prose or thought blocks.
      while (queue.length > 0 && queue[0].type !== 'token') {
        const action = queue.shift()!;
        
        if (action.type === 'event') {
          const { id, type, status, output, filePath } = action.data;
          updatedSession.messages = updatedSession.messages.map(msg => {
            if (msg.id === activeMsgId) {
              const t = [...(msg.timeline || [])];
              if (type === 'permission_request') t.push({ type: 'permission', request: action.data, isCollapsed: false });
              else if (type === 'tool_start') {
                for (let i = 0; i < t.length; i++) t[i] = { ...t[i], isCollapsed: true };
                if (t[0]?.type === 'thought' && t[0].content === '_Thinking..._') t.shift();
                t.push({ type: 'tool', event: { ...action.data, status: 'in_progress', startTime: Date.now() }, isCollapsed: false });
              } else if (type === 'tool_end' || type === 'tool_update') {
                const idx = t.findLastIndex(s => s.type === 'tool' && s.event.id === id);
                if (idx !== -1) {
                  const existingStep = t[idx];
                  if (existingStep.type === 'tool') {
                    const { title: incomingTitle } = action.data;
                    const mergedFilePath = filePath || existingStep.event.filePath;
                    
                    // Selection logic:
                    // 1. Prefer the most detailed title (usually contains the most detail)
                    // 2. Prefer titles that already contain a colon (indicating filename/args)
                    let bestTitle = incomingTitle || existingStep.event.title;
                    const existingTitle = existingStep.event.title || '';
                    
                    if (existingTitle.length > (bestTitle || '').length || (existingTitle.includes(':') && !bestTitle?.includes(':'))) {
                      bestTitle = existingTitle;
                    }

                    // 3. Fallback: If we have a file path but still no detail in the title, force append it
                    if (mergedFilePath) {
                      const filename = mergedFilePath.split(/[/\\]/).pop();
                      if (filename && bestTitle && !bestTitle.toLowerCase().includes(filename.toLowerCase())) {
                        bestTitle += `: ${filename}`;
                      }
                    }

                    t[idx] = {
                      ...existingStep,
                      event: { 
                        ...existingStep.event, 
                        status: status || existingStep.event.status, 
                        output: (existingStep.event.output?.startsWith('$ ') ? existingStep.event.output : output) || existingStep.event.output, 
                        filePath: mergedFilePath, 
                        title: bestTitle,
                        toolCategory: action.data.toolCategory || existingStep.event.toolCategory,
                        endTime: status === 'completed' ? Date.now() : existingStep.event.endTime 
                      },
                      isCollapsed: false
                    };
                    
                    // Cache fallback output for jsonlParser to use on page reload
                    if (type === 'tool_update' && !existingStep.event._fallbackOutput && output) {
                      t[idx].event._fallbackOutput = output;
                    }
                  }
                }
                if (status === 'completed' && filePath) {
                    if (onFileEdited) onFileEdited(filePath);
                    if (filePath.toLowerCase().endsWith('plan.md') && onOpenFileInCanvas) onOpenFileInCanvas(filePath);
                }
              }
              return { ...msg, timeline: t } as Message;
            }
            return msg;
          });
        } else if (action.type === 'thought') {
          const text = action.data;
          // Thoughts are small enough to process immediately if they are at the front
          // and not interleaved with tokens.
          updatedSession.messages = updatedSession.messages.map(msg => {
            if (msg.id === activeMsgId) {
              const t = [...(msg.timeline || [])];
              if (t[0]?.type === 'thought' && t[0].content === '_Thinking..._') t.shift();
              const last = t[t.length - 1];
              if (last?.type === 'thought' && !last.isCollapsed) {
                t[t.length - 1] = { ...last, content: last.content + text };
              } else {
                for (let i = 0; i < t.length; i++) t[i] = { ...t[i], isCollapsed: true };
                t.push({ type: 'thought', content: text, isCollapsed: false });
              }
              return { ...msg, timeline: t } as Message;
            }
            return msg;
          });
        }
      }

      // After events are cleared, handle tokens with typewriter effect
      if (queue.length > 0 && queue[0].type === 'token') {
        let batchedText = '';
        while (queue.length > 0 && queue[0].type === 'token') {
          batchedText += queue[0].data;
          queue.shift();
        }

        // Adaptive typewriter: speed up based on buffer size
        const bufferLen = batchedText.length;
        const charsPerTick = bufferLen > 500 ? bufferLen : bufferLen > 100 ? Math.ceil(bufferLen / 3) : Math.max(1, Math.ceil(bufferLen / 5));
        const nextChars = batchedText.substring(0, charsPerTick);
        const remainingChars = batchedText.substring(charsPerTick);
        if (remainingChars.length > 0) {
          queue.unshift({ type: 'token', data: remainingChars });
        }

        const prevContent = newDisplayedContent[activeMsgId] || '';
        const newContent = prevContent + nextChars;
        newDisplayedContent[activeMsgId] = newContent;
        newSettledLength[activeMsgId] = prevContent.length;
        updatedSession.messages = updatedSession.messages.map(msg => {
          if (msg.id === activeMsgId) {
            const t = [...(msg.timeline || [])];
            if (t[0]?.type === 'thought' && t[0].content === '_Thinking..._') t.shift();
            const last = t[t.length - 1];
            if (last?.type === 'text') t[t.length - 1] = { ...last, content: last.content + nextChars };
            else {
              for (let i = 0; i < t.length; i++) t[i] = { ...t[i], isCollapsed: true };
              t.push({ type: 'text', content: nextChars });
            }
            return { ...msg, content: newContent, timeline: t } as Message;
          }
          return msg;
        });
      }

      newStreamQueues[acpId] = queue;
      return updatedSession;
    });

    // Write to both stores
    set({
      streamQueues: newStreamQueues,
      displayedContentByMsg: newDisplayedContent,
      settledLengthByMsg: newSettledLength
    });
    useChatStore.setState({ sessions: newSessions });

    scrollToBottom();
    set({ typewriterInterval: setTimeout(() => get().processBuffer(scrollToBottom, onFileEdited, onOpenFileInCanvas), 32) as unknown as number });
  }
}));
