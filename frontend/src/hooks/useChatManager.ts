import type { StreamEventData, StreamDoneData, ChatSession } from '../types';
import { useEffect } from 'react';
import { useSystemStore } from '../store/useSystemStore';
import { shouldNotify as shouldNotifyHelper } from '../utils/notificationHelper';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
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
  const { handleInitialLoad, setSessions } = useSessionLifecycleStore();

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

    // Per-shell buffers: keyed by shellId from the backend.
    // Each shell invocation gets its own buffer so parallel shells don't mix output.
    // shellId → { buffer, maxLines, timer }
    type ShellBuf = { buffer: string; maxLines: number | null; timer: ReturnType<typeof setInterval> | null };
    const shellBuffers = new Map<string, ShellBuf>();

    // Flush one shell's buffer to the ToolStep stamped with that shellId.
    // Returns true if the write succeeded, false if the ToolStep wasn't ready yet.
    const flushShellBuffer = (shellId: string) => {
      const entry = shellBuffers.get(shellId);
      if (!entry || !entry.buffer) return false;
      let flushed = false;
      const chunk = entry.buffer;

      useSessionLifecycleStore.setState(state => {
        let globalFlushed = false;
        const newSessions = state.sessions.map(s => {
          if (globalFlushed) return s;
          const msgs = [...s.messages];
          const msg = msgs[msgs.length - 1];
          if (!msg || msg.role !== 'assistant' || !msg.timeline) return s;

          // Only flush if the target ToolStep (matched by shellId) is still in-progress in this session
          if (!msg.timeline.some(e => e.type === 'tool' && e.event.shellId === shellId && e.event.status === 'in_progress')) return s;

          globalFlushed = true;
          flushed = true;

          const timeline = msg.timeline.map(e =>
            e.type === 'tool' && e.event.shellId === shellId
              ? { ...e, event: { ...e.event, output: trimShellOutputLines((e.event.output || '') + chunk, entry.maxLines) } }
              : e
          );
          msgs[msgs.length - 1] = { ...msg, timeline };
          return { ...s, messages: msgs };
        });
        return globalFlushed ? { sessions: newSessions } : state;
      });

      if (flushed) {
        entry.buffer = '';
      }
      return flushed;
    };

    // Stamp shellId onto the first unclaimed in-progress ux_invoke_shell ToolStep
    // across any session. Called on the first chunk for a new shellId.
    const claimShellToolStep = (shellId: string) => {
      useSessionLifecycleStore.setState(state => {
        let globalClaimed = false;
        const newSessions = state.sessions.map(s => {
          if (globalClaimed) return s;
          const msgs = [...s.messages];
          const lastMsg = msgs[msgs.length - 1];
          if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.timeline) return s;
          
          let localClaimed = false;
          const timeline = lastMsg.timeline.map(e => {
            if (!localClaimed && e.type === 'tool' && e.event.status === 'in_progress' && e.event.toolName === 'ux_invoke_shell' && !e.event.shellId) {
              localClaimed = true;
              globalClaimed = true;
              return { ...e, event: { ...e.event, shellId } };
            }
            return e;
          });
          
          if (!localClaimed) return s;
          msgs[msgs.length - 1] = { ...lastMsg, timeline };
          return { ...s, messages: msgs };
        });
        return globalClaimed ? { sessions: newSessions } : state;
      });
    };

    // Legacy fallback buffer for tool_output_stream events without a shellId
    // (backwards compatibility with older backend versions).
    let legacyToolOutputBuffer: string | null = null;
    let legacyToolOutputMaxLines: number | null = null;

    const flushLegacyBuffer = () => {
      const activeId = useSessionLifecycleStore.getState().activeSessionId;
      if (!activeId || !legacyToolOutputBuffer) return false;
      const session = useSessionLifecycleStore.getState().sessions.find(s => s.id === activeId);
      if (!session) return false;
      const lastMsg = session.messages[session.messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.timeline) return false;
      if (!lastMsg.timeline.some(e => e.type === 'tool' && e.event.status === 'in_progress')) return false;
      const chunk = legacyToolOutputBuffer;
      legacyToolOutputBuffer = null;
      useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => {
          if (s.id !== activeId) return s;
          const msgs = [...s.messages];
          const msg = msgs[msgs.length - 1];
          if (!msg || msg.role !== 'assistant' || !msg.timeline) return s;
          const timeline = msg.timeline.map(e =>
            e.type === 'tool' && e.event.status === 'in_progress'
              ? { ...e, event: { ...e.event, output: trimShellOutputLines((e.event.output || '') + chunk, legacyToolOutputMaxLines) } }
              : e
          );
          msgs[msgs.length - 1] = { ...msg, timeline };
          return { ...s, messages: msgs };
        }) }));
      return true;
    };

    let legacyFlushTimer: ReturnType<typeof setInterval> | null = null;

    // Pending sub-agents — session created lazily on first token
    const pendingSubAgents = new Map<string, { providerId: string; acpSessionId: string; uiId: string; index: number; name: string; prompt: string; agent: string; parentSessionId: string; parentUiId: string; model: string }>();

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
        useSessionLifecycleStore.setState(state => ({ sessions: [...state.sessions, subSession] }));
      }
      origOnStreamToken(data);
    };

    socket.on('stats_push', (data: { sessionId: string; usedTokens?: number; totalTokens?: number }) => {
      if (!data || !data.sessionId) return;
      setSessions(useSessionLifecycleStore.getState().sessions.map(s => {
        if (s.acpSessionId !== data.sessionId) return s;
        return {
          ...s,
          stats: { ...s.stats, usedTokens: data.usedTokens, totalTokens: data.totalTokens } as ChatSession['stats']
        };
      }));
    });

    socket.on('session_renamed', (data: { uiId: string, newName: string }) => {
      setSessions(useSessionLifecycleStore.getState().sessions.map(s => s.id === data.uiId ? { ...s, name: data.newName } : s));
    });

    // Inject a user message from a fork merge — the backend sends this before
    // prompting the parent ACP session so the summary appears in the chat UI
    socket.on('merge_message', (data: { sessionId: string; text: string }) => {
      useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => {
          if (s.acpSessionId !== data.sessionId) return s;
          return { ...s, messages: [...s.messages, { id: `merge-${Date.now()}`, role: 'user' as const, content: data.text }] };
        }) }));
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
      const activeAcpId = useSessionLifecycleStore.getState().sessions.find(s => s.id === useSessionLifecycleStore.getState().activeSessionId)?.acpSessionId;
      const session = useSessionLifecycleStore.getState().sessions.find(s => s.acpSessionId === data.sessionId);
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
      useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s =>
          s.acpSessionId === data.sessionId ? { ...s, isHooksRunning: data.running } : s
        ) }));
    });

    socket.on('tool_output_stream', (data: { chunk: string; maxLines?: number; shellId?: string }) => {
      if (data.shellId) {
        // Per-shell path: isolated buffer, targeted ToolStep flush
        const shellId = data.shellId;
        if (!shellBuffers.has(shellId)) {
          // First chunk for this shell — claim the matching ToolStep
          shellBuffers.set(shellId, { buffer: '', maxLines: null, timer: null });
          claimShellToolStep(shellId);
        }
        const entry = shellBuffers.get(shellId)!;
        if (typeof data.maxLines === 'number' && Number.isInteger(data.maxLines) && data.maxLines > 0) {
          entry.maxLines = data.maxLines;
        }
        entry.buffer += data.chunk;
        entry.buffer = trimShellOutputLines(entry.buffer, entry.maxLines);
        if (!flushShellBuffer(shellId) && !entry.timer) {
          entry.timer = setInterval(() => {
            flushShellBuffer(shellId);
            const e = shellBuffers.get(shellId);
            if (e && !e.buffer && e.timer) { clearInterval(e.timer); e.timer = null; shellBuffers.delete(shellId); }
          }, 50);
        }
      } else {
        // Legacy path: no shellId (old backend) — write to first in-progress tool step
        const maxLines = data.maxLines;
        if (typeof maxLines === 'number' && Number.isInteger(maxLines) && maxLines > 0) {
          legacyToolOutputMaxLines = maxLines;
        }
        if (!legacyToolOutputBuffer) legacyToolOutputBuffer = '';
        legacyToolOutputBuffer += data.chunk;
        legacyToolOutputBuffer = trimShellOutputLines(legacyToolOutputBuffer, legacyToolOutputMaxLines);
        if (!flushLegacyBuffer() && !legacyFlushTimer) {
          legacyFlushTimer = setInterval(() => {
            flushLegacyBuffer();
            if (!legacyToolOutputBuffer && legacyFlushTimer) { clearInterval(legacyFlushTimer); legacyFlushTimer = null; }
          }, 50);
        }
      }
    });

    // Sub-agent events
    //
    // sub_agents_starting fires immediately when ux_invoke_subagents begins (before the
    // 1-second stagger), so the UI clears stale sidebar sessions right away instead of
    // waiting for the first sub_agent_started event (fixes the "flash of old agents" bug).
    socket.on('sub_agents_starting', (data: { invocationId: string; parentUiId: string | null; providerId: string; count: number }) => {
      const parentUiId = data.parentUiId || 'unknown';

      // Immediately remove old sub-agent sidebar sessions for this parent
      const oldSubAgents = useSessionLifecycleStore.getState().sessions.filter(
        s => s.isSubAgent && s.forkedFrom === parentUiId
      );
      for (const old of oldSubAgents) {
        socket.emit('delete_session', { uiId: old.id });
      }
      useSessionLifecycleStore.setState(state => ({
        sessions: state.sessions.filter(s => !(s.isSubAgent && s.forkedFrom === parentUiId))
      }));
    });

    socket.on('sub_agent_started', (data: { providerId: string; acpSessionId: string; uiId: string; parentUiId: string | null; index: number; name: string; prompt: string; agent: string; model?: string; invocationId: string }) => {
      const parentUiId = data.parentUiId || 'unknown';
      const parentSession = useSessionLifecycleStore.getState().sessions.find(s => s.id === parentUiId);
      const parentSessionId = parentSession?.acpSessionId || 'unknown';
      useSubAgentStore.getState().addAgent({ ...data, parentSessionId });
      pendingSubAgents.set(data.acpSessionId, { ...data, parentSessionId, parentUiId, model: data.model || 'balanced' });

      // Stamp the invocationId onto the in-progress ux_invoke_subagents / ux_invoke_counsel
      // ToolStep on the first agent (index 0).  We defer to here rather than sub_agents_starting
      // because the ToolStep is processed asynchronously through the stream queue/typewriter —
      // by the time sub_agent_started[0] arrives (after at least one RPC roundtrip, 100ms+),
      // the ToolStep is guaranteed to be in useSessionLifecycleStore.
      if (data.index === 0) {
        useSessionLifecycleStore.setState(state => ({
          sessions: state.sessions.map(s => {
            if (s.id !== parentUiId) return s;
            const msgs = [...s.messages];
            const lastMsg = msgs[msgs.length - 1];
            if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.timeline) return s;
            const timeline = lastMsg.timeline.map(entry => {
              if (
                entry.type === 'tool' &&
                entry.event.status === 'in_progress' &&
                (entry.event.toolName === 'ux_invoke_subagents' || entry.event.toolName === 'ux_invoke_counsel')
              ) {
                return { ...entry, event: { ...entry.event, invocationId: data.invocationId } };
              }
              return entry;
            });
            msgs[msgs.length - 1] = { ...lastMsg, timeline };
            return { ...s, messages: msgs };
          })
        }));
      }
    });

    socket.on('sub_agent_completed', (data: { acpSessionId: string }) => {
      useSubAgentStore.getState().completeAgent(data.acpSessionId);
      useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => {
          if (s.acpSessionId !== data.acpSessionId) return s;
          // Mark as done and ensure last message isn't stuck as streaming
          const messages = s.messages.map(m => m.isStreaming ? { ...m, isStreaming: false } : m);
          return { ...s, isTyping: false, messages };
        }) }));
    });

    // Route system_event for sub-agent tool steps to the sub-agent store
    const subAgentSystemHandler = (data: { sessionId: string; type: string; id: string; title: string; status?: string; output?: string }) => {
      // Lazily create session if pending
      if (pendingSubAgents.has(data.sessionId)) {
        const pending = pendingSubAgents.get(data.sessionId)!;
        pendingSubAgents.delete(data.sessionId);
        useSessionLifecycleStore.setState(state => ({ sessions: [...state.sessions, {
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
      // Clean up all per-shell timers
      for (const entry of shellBuffers.values()) {
        if (entry.timer) clearInterval(entry.timer);
      }
      shellBuffers.clear();
      if (legacyFlushTimer) clearInterval(legacyFlushTimer);
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
      socket.off('sub_agents_starting');
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

export function trimShellOutputLines(output: string, maxLines?: number | null) {
  if (!output || !Number.isInteger(maxLines) || !maxLines || maxLines <= 0) return output;

  const lines = output.split(/\r?\n/);
  const hasTrailingNewline = /\r?\n$/.test(output);
  const lineCount = hasTrailingNewline ? lines.length - 1 : lines.length;
  if (lineCount <= maxLines) return output;

  const start = lineCount - maxLines;
  const tail = lines.slice(start, hasTrailingNewline ? -1 : undefined).join('\n');
  return hasTrailingNewline ? `${tail}\n` : tail;
}
