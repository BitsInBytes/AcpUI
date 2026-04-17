import type { StreamEventData, StreamDoneData, ChatSession } from '../types';
import { useEffect } from 'react';
import { useSystemStore } from '../store/useSystemStore';
import { shouldNotify as shouldNotifyHelper } from '../utils/notificationHelper';
import { useChatStore } from '../store/useChatStore';
import { useStreamStore } from '../store/useStreamStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { useSubAgentStore } from '../store/useSubAgentStore';

/**
 * Central socket event dispatcher. Wires socket.io events to the appropriate stores.
 *
 * Key mechanisms:
 * - tool_output_stream: Buffers shell output chunks and flushes every 50ms into the
 *   in-progress tool's timeline entry, avoiding per-character React re-renders.
 * - Sub-agent lazy session creation: ChatSession objects are NOT created on
 *   `sub_agent_started` — only when the first token/event arrives (pendingSubAgents map).
 *   This avoids empty ghost tabs for agents that fail before producing output.
 * - Permission routing: permission_request events are checked against useSubAgentStore
 *   first; if the sessionId belongs to a sub-agent, the permission is routed there
 *   instead of the main chat timeline.
 */
export function useChatManager(
  scrollToBottom: () => void,
  onFileEdited?: (path: string) => void,
  onOpenFileInCanvas?: (path: string) => void
) {
  const socket = useSystemStore(state => state.socket);
  
  // Session actions from chat store
  const {
    handleInitialLoad,
    setSessions
  } = useChatStore();

  // Streaming actions from stream store
  const {
    onStreamThought,
    onStreamToken,
    onStreamEvent,
    onStreamDone,
    processBuffer
  } = useStreamStore();

  // Initial Load
  useEffect(() => {
    if (socket) {
      // Mock fetchAudioDevices for now or import it correctly
      const mockFetch = async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioInputs = devices
            .filter(d => d.kind === 'audioinput')
            .map(d => ({ id: d.deviceId, label: d.label || 'Default Microphone' }));
          useVoiceStore.getState().setAvailableAudioDevices(audioInputs);
        } catch (e) {
          console.error(e);
        }
      };
      handleInitialLoad(socket, mockFetch);
    }
  }, [socket, handleInitialLoad]);

  // Socket Listeners
  useEffect(() => {
    if (!socket) return;

    let toolOutputBuffer: string | null = null;

    const flushToolBuffer = () => {
      const activeId = useChatStore.getState().activeSessionId;
      if (!activeId || !toolOutputBuffer) return false;
      const session = useChatStore.getState().sessions.find(s => s.id === activeId);
      if (!session) return false;
      const lastMsg = session.messages[session.messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.timeline) return false;
      if (!lastMsg.timeline.some(e => e.type === 'tool' && e.event.status === 'in_progress')) return false;
      const chunk = toolOutputBuffer;
      toolOutputBuffer = null;
      useChatStore.setState(state => ({
        sessions: state.sessions.map(s => {
          if (s.id !== activeId) return s;
          const msgs = [...s.messages];
          const msg = msgs[msgs.length - 1];
          if (!msg || msg.role !== 'assistant' || !msg.timeline) return s;
          const timeline = msg.timeline.map(entry =>
            entry.type === 'tool' && entry.event.status === 'in_progress'
              ? { ...entry, event: { ...entry.event, output: (entry.event.output || '') + chunk } }
              : entry
          );
          msgs[msgs.length - 1] = { ...msg, timeline };
          return { ...s, messages: msgs };
        })
      }));
      return true;
    };

    let flushTimer: ReturnType<typeof setInterval> | null = null;

    // Pending sub-agents — session created lazily on first token
    const pendingSubAgents = new Map<string, { acpSessionId: string; uiId: string; index: number; name: string; prompt: string; agent: string; parentSessionId: string; parentUiId: string; model: string }>();

    // Intercept tokens to lazily create sub-agent sessions
    const origOnStreamToken = onStreamToken;
    const wrappedOnStreamToken = (data: { sessionId: string; text: string }) => {
      if (pendingSubAgents.has(data.sessionId)) {
        const pending = pendingSubAgents.get(data.sessionId)!;
        pendingSubAgents.delete(data.sessionId);
        const subSession = {
          id: pending.uiId,
          acpSessionId: pending.acpSessionId,
          name: pending.name,
          messages: [],
          isTyping: true,
          isWarmingUp: false,
          model: pending.model as 'fast' | 'balanced' | 'flagship',
          isSubAgent: true,
          parentAcpSessionId: pending.parentSessionId,
          forkedFrom: pending.parentUiId,
        };
        useChatStore.setState(state => ({ sessions: [...state.sessions, subSession] }));
      }
      origOnStreamToken(data);
    };

    socket.on('stats_push', (data: { sessionId: string; usedTokens?: number; totalTokens?: number }) => {
      if (!data || !data.sessionId) return;
      setSessions(useChatStore.getState().sessions.map(s => {
        if (s.acpSessionId !== data.sessionId) return s;
        return {
          ...s,
          stats: { ...s.stats, usedTokens: data.usedTokens, totalTokens: data.totalTokens } as ChatSession['stats']
        };
      }));
    });

    socket.on('session_renamed', (data: { uiId: string, newName: string }) => {
      setSessions(useChatStore.getState().sessions.map(s => s.id === data.uiId ? { ...s, name: data.newName } : s));
    });

    // Inject a user message from a fork merge — the backend sends this before
    // prompting the parent ACP session so the summary appears in the chat UI
    socket.on('merge_message', (data: { sessionId: string; text: string }) => {
      useChatStore.setState(state => ({
        sessions: state.sessions.map(s => {
          if (s.acpSessionId !== data.sessionId) return s;
          return { ...s, messages: [...s.messages, { id: `merge-${Date.now()}`, role: 'user' as const, content: data.text }] };
        })
      }));
    });

    socket.on('thought', onStreamThought);
    socket.on('token', wrappedOnStreamToken);
    socket.on('system_event', onStreamEvent);
    socket.on('permission_request', (event: StreamEventData) => {
      // Check if this is a sub-agent permission
      const agents = useSubAgentStore.getState().agents;
      const evtData = event as unknown as { sessionId: string; id: number; options: { optionId: string; name: string; kind: string }[]; toolCall: { title: string; toolCallId?: string } };
      const subAgent = agents.find(a => a.acpSessionId === evtData.sessionId);
      if (subAgent) {
        useSubAgentStore.getState().setPermission(subAgent.acpSessionId, {
          id: evtData.id,
          sessionId: evtData.sessionId,
          options: evtData.options || [],
          toolCall: evtData.toolCall,
        });
        return;
      }
      new Audio('/memory-sound.mp3').play()?.catch(() => {});
      onStreamEvent({ ...event, type: 'permission_request' });
    });
    socket.on('token_done', (data: StreamDoneData) => {
      onStreamDone(socket, data);
      const { notificationSound, notificationDesktop, workspaceCwds, branding } = useSystemStore.getState();
      const activeAcpId = useChatStore.getState().sessions.find(s => s.id === useChatStore.getState().activeSessionId)?.acpSessionId;
      const session = useChatStore.getState().sessions.find(s => s.acpSessionId === data.sessionId);
      if (session && !session.isSubAgent) {
        const result = shouldNotifyHelper(data.sessionId, activeAcpId, session.name, workspaceCwds as readonly { path: string; label: string }[], session.cwd, { notificationSound, notificationDesktop });
        if (result) {
          if (result.shouldSound) { try { new Audio('/memory-sound.mp3').play()?.catch(() => {}); } catch { /* audio unavailable */ } }
          if (result.shouldDesktop && Notification.permission === 'granted') {
            new Notification(branding.notificationTitle, { body: result.body, icon: '/vite.svg' });
          }
        }
      }
    });

    socket.on('hooks_status', (data: { sessionId: string, running: boolean }) => {
      console.log('[HOOKS_STATUS]', data);
      useChatStore.setState(state => ({
        sessions: state.sessions.map(s =>
          s.acpSessionId === data.sessionId ? { ...s, isHooksRunning: data.running } : s
        )
      }));
    });

    socket.on('tool_output_stream', (data: { chunk: string }) => {
      if (!toolOutputBuffer) toolOutputBuffer = '';
      toolOutputBuffer += data.chunk;
      if (!flushToolBuffer() && !flushTimer) {
        flushTimer = setInterval(() => {
          flushToolBuffer();
          if (!toolOutputBuffer && flushTimer) { clearInterval(flushTimer); flushTimer = null; }
        }, 50);
      }
    });

    // Sub-agent events
    socket.on('sub_agent_started', (data: { acpSessionId: string; uiId: string; parentUiId: string | null; index: number; name: string; prompt: string; agent: string; model?: string }) => {
      const parentUiId = data.parentUiId || 'unknown';
      const parentSession = useChatStore.getState().sessions.find(s => s.id === parentUiId);
      const parentSessionId = parentSession?.acpSessionId || 'unknown';
      if (data.index === 0) {
        useSubAgentStore.getState().clearForParent(parentSessionId);
        // Delete old sub-agent sessions from DB
        const oldSubAgents = useChatStore.getState().sessions.filter(s => s.isSubAgent && s.forkedFrom === parentUiId);
        for (const old of oldSubAgents) {
          socket.emit('delete_session', { uiId: old.id });
        }
        useChatStore.setState(state => ({
          sessions: state.sessions.filter(s => !(s.isSubAgent && s.forkedFrom === parentUiId))
        }));
      }
      useSubAgentStore.getState().addAgent({ ...data, parentSessionId });
      pendingSubAgents.set(data.acpSessionId, { ...data, parentSessionId, parentUiId, model: data.model || 'balanced' });
    });

    socket.on('sub_agent_completed', (data: { acpSessionId: string }) => {
      useSubAgentStore.getState().completeAgent(data.acpSessionId);
      useChatStore.setState(state => ({
        sessions: state.sessions.map(s => {
          if (s.acpSessionId !== data.acpSessionId) return s;
          // Mark as done and ensure last message isn't stuck as streaming
          const messages = s.messages.map(m => m.isStreaming ? { ...m, isStreaming: false } : m);
          return { ...s, isTyping: false, messages };
        })
      }));
    });

    // Route system_event for sub-agent tool steps to the sub-agent store
    const subAgentSystemHandler = (data: { sessionId: string; type: string; id: string; title: string; status?: string; output?: string }) => {
      // Lazily create session if pending
      if (pendingSubAgents.has(data.sessionId)) {
        const pending = pendingSubAgents.get(data.sessionId)!;
        pendingSubAgents.delete(data.sessionId);
        useChatStore.setState(state => ({ sessions: [...state.sessions, {
          id: pending.uiId, acpSessionId: pending.acpSessionId,
          name: pending.name,
          messages: [], isTyping: true, isWarmingUp: false, model: pending.model as 'fast' | 'balanced' | 'flagship',
          isSubAgent: true, parentAcpSessionId: pending.parentSessionId,
          forkedFrom: pending.parentUiId,
        }] }));
      }
      const agents = useSubAgentStore.getState().agents;
      if (!agents.some(a => a.acpSessionId === data.sessionId)) return;
      if (data.type === 'tool_start') {
        useSubAgentStore.getState().addToolStep(data.sessionId, data.id, data.title);
      } else if (data.type === 'tool_end') {
        useSubAgentStore.getState().updateToolStep(data.sessionId, data.id, data.status || 'completed', data.output);
      }
    };

    socket.on('system_event', subAgentSystemHandler);

    return () => {
      if (flushTimer) clearInterval(flushTimer);
      socket.off('stats_push');
      socket.off('session_renamed');
      socket.off('merge_message');
      socket.off('thought');
      socket.off('token');
      socket.off('system_event');
      socket.off('permission_request');
      socket.off('token_done');
      socket.off('hooks_status');
      socket.off('tool_output_stream');
      socket.off('sub_agent_started');
      socket.off('sub_agent_completed');
    };
  }, [socket, setSessions, onStreamThought, onStreamToken, onStreamEvent, onStreamDone]);

  // Typewriter Loop
  const hasQueues = useStreamStore(state => Object.values(state.streamQueues).some(q => q.length > 0));
  const typewriterInterval = useStreamStore(state => state.typewriterInterval);

  useEffect(() => {
    if (hasQueues && !typewriterInterval) {
      processBuffer(scrollToBottom, onFileEdited, onOpenFileInCanvas);
    }
  }, [hasQueues, typewriterInterval, processBuffer, scrollToBottom, onFileEdited, onOpenFileInCanvas]);
}
