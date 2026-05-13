import type { StreamEventData, StreamDoneData, ChatSession, SystemEvent } from '../types';
import { useEffect } from 'react';
import { useSystemStore } from '../store/useSystemStore';
import { shouldNotify as shouldNotifyHelper } from '../utils/notificationHelper';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useStreamStore } from '../store/useStreamStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { useShellRunStore, type ShellRunSnapshot } from '../store/useShellRunStore';
import { ACP_UX_TOOL_NAMES, isAcpUxShellToolEvent, isAcpUxSubAgentStartToolEvent } from '../utils/acpUxTools';

/**
 * Central socket event dispatcher. Wires socket.io events to the appropriate stores.
 *
 * Key mechanisms:
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

    const shellEventStatus = (snapshot: ShellRunSnapshot, patch: Partial<SystemEvent>): SystemEvent['status'] => {
      if (patch.status) return patch.status;
      if ((patch.shellState || snapshot.status) !== 'exited') return 'in_progress';
      return snapshot.reason === 'completed' || snapshot.exitCode === 0 ? 'completed' : 'failed';
    };

    const shellRunSnapshotPatch = (snapshot: ShellRunSnapshot, status = snapshot.status): Partial<SystemEvent> => ({
      shellRunId: snapshot.runId,
      shellState: status,
      shellNeedsInput: Boolean(snapshot.needsInput),
      command: snapshot.command,
      cwd: snapshot.cwd,
      ...(snapshot.description ? { title: `Invoke Shell: ${snapshot.description}` } : {})
    });

    const buildShellRunToolEvent = (snapshot: ShellRunSnapshot, patch: Partial<SystemEvent>): SystemEvent => ({
      id: snapshot.toolCallId || snapshot.runId,
      title: patch.title || (snapshot.description ? `Invoke Shell: ${snapshot.description}` : 'Invoke Shell'),
      status: shellEventStatus(snapshot, patch),
      providerId: snapshot.providerId,
      sessionId: snapshot.sessionId,
      toolName: ACP_UX_TOOL_NAMES.invokeShell,
      canonicalName: ACP_UX_TOOL_NAMES.invokeShell,
      mcpServer: 'AcpUI',
      mcpToolName: ACP_UX_TOOL_NAMES.invokeShell,
      isAcpUxTool: true,
      toolCategory: 'shell',
      isShellCommand: true,
      isFileOperation: false,
      titleSource: snapshot.description ? 'mcp_handler' : 'tool_handler',
      startTime: Date.now(),
      shellRunId: snapshot.runId,
      shellInteractive: true,
      shellState: snapshot.status,
      shellNeedsInput: Boolean(snapshot.needsInput),
      ...(snapshot.command ? { command: snapshot.command } : {}),
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      ...patch
    });

    const isShellToolEvent = (event: Partial<SystemEvent | StreamEventData>) => (
      isAcpUxShellToolEvent(event) || event.isShellCommand === true || event.toolCategory === 'shell'
    );

    const matchesShellDescription = (event: Partial<SystemEvent | StreamEventData>, snapshot?: ShellRunSnapshot) => {
      if (!snapshot?.description || !isShellToolEvent(event)) return false;
      return event.title === `Invoke Shell: ${snapshot.description}`;
    };

    const upsertQueuedShellRunToolEvent = (
      snapshot: ShellRunSnapshot,
      event: StreamEventData & Partial<SystemEvent>
    ) => {
      const queue = useStreamStore.getState().streamQueues[snapshot.sessionId] || [];
      const candidates = queue
        .map((item, index) => ({
          index,
          data: item?.data as (StreamEventData & Partial<SystemEvent>) | undefined,
          type: item?.type
        }))
        .filter(item => item.type === 'event' && item.data?.type === 'tool_start');
      const runMatch = candidates.find(item => item.data?.shellRunId === snapshot.runId);
      const toolCallMatch = candidates.find(item => !item.data?.shellRunId && snapshot.toolCallId && item.data?.id === snapshot.toolCallId);
      const descriptionMatches = candidates.filter(item => !item.data?.shellRunId && matchesShellDescription(item.data || {}, snapshot));
      const queuedIndex = runMatch?.index ?? toolCallMatch?.index ?? (descriptionMatches.length === 1 ? descriptionMatches[0].index : -1);

      if (queuedIndex === -1) return false;

      useStreamStore.setState(state => {
        const nextQueue = [...(state.streamQueues[snapshot.sessionId] || [])];
        const item = nextQueue[queuedIndex];
        if (!item?.data) return {};
        const existingData = item.data as StreamEventData & Partial<SystemEvent>;
        nextQueue[queuedIndex] = {
          ...item,
          data: {
            ...existingData,
            ...event,
            id: existingData.id || event.id,
            title: event.title || existingData.title,
            status: event.status || existingData.status,
            startTime: existingData.startTime || event.startTime,
            output: event.output ?? existingData.output,
            endTime: event.endTime ?? existingData.endTime
          }
        };
        return {
          isProcessActiveByAcp: { ...state.isProcessActiveByAcp, [snapshot.sessionId]: true },
          streamQueues: { ...state.streamQueues, [snapshot.sessionId]: nextQueue }
        };
      });
      return true;
    };

    const ensureShellRunToolStep = (snapshot: ShellRunSnapshot, patch: Partial<SystemEvent>) => {
      if (!snapshot.sessionId || !snapshot.runId) return;
      const event = {
        ...buildShellRunToolEvent(snapshot, patch),
        type: 'tool_start'
      } as StreamEventData & Partial<SystemEvent>;
      if (upsertQueuedShellRunToolEvent(snapshot, event)) return;
      useStreamStore.getState().onStreamEvent(event);
    };

    const patchShellRunToolStep = (runId: string, patch: Partial<SystemEvent>, snapshot?: ShellRunSnapshot) => {
      let matched = false;
      const activeMsgId = snapshot?.sessionId ? useStreamStore.getState().activeMsgIdByAcp[snapshot.sessionId] : undefined;
      useSessionLifecycleStore.setState(state => ({
        sessions: state.sessions.map(session => {
          if (snapshot?.sessionId && session.acpSessionId && session.acpSessionId !== snapshot.sessionId) return session;
          return {
            ...session,
            messages: session.messages.map(message => {
              const descriptionMatches = message.id === activeMsgId
                ? (message.timeline || []).filter(entry => entry.type === 'tool' && !entry.event.shellRunId && matchesShellDescription(entry.event, snapshot))
                : [];
              return {
                ...message,
                timeline: message.timeline?.map(entry => {
                  if (entry.type !== 'tool') return entry;
                  const sameRun = entry.event.shellRunId === runId;
                  const sameToolCall = !entry.event.shellRunId && snapshot?.toolCallId && entry.event.id === snapshot.toolCallId;
                  const sameDescription = descriptionMatches.length === 1 && descriptionMatches[0] === entry;
                  if (!sameRun && !sameToolCall && !sameDescription) return entry;
                  matched = true;
                  return { ...entry, event: { ...entry.event, ...patch, shellRunId: runId } };
                }) || message.timeline
              };
            })
          };
        })
      }));
      if (!matched && snapshot) ensureShellRunToolStep(snapshot, patch);
    };

    const syncShellInputStateForSession = (sessionId?: string | null) => {
      if (!sessionId) return;
      const runs = Object.values(useShellRunStore.getState().runs);
      const isAwaitingShellInput = runs.some(run =>
        run.sessionId === sessionId &&
        run.status !== 'exited' &&
        run.needsInput === true
      );
      useSessionLifecycleStore.setState(state => ({
        sessions: state.sessions.map(s =>
          s.acpSessionId === sessionId ? { ...s, isAwaitingShellInput } : s
        )
      }));
    };

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
          provider: pending.providerId,
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
      
      const agents = useSubAgentStore.getState().agents;
      const subAgent = agents.find(a => a.acpSessionId === data.sessionId);
      if (subAgent && (subAgent.status === 'spawning' || subAgent.status === 'prompting' || subAgent.status === 'waiting_permission')) {
        useSubAgentStore.getState().setStatus(data.sessionId, 'running');
      }

      origOnStreamToken(data);
    };

    socket.on('stats_push', (data: { providerId?: string; sessionId: string; usedTokens?: number; totalTokens?: number }) => {
      if (!data || !data.sessionId) return;
      const sessionProviderId = data.providerId || useSessionLifecycleStore.getState().sessions.find(s => s.acpSessionId === data.sessionId)?.provider || null;
      if (Number.isFinite(data.usedTokens) && Number.isFinite(data.totalTokens) && Number(data.totalTokens) > 0) {
        useSystemStore.getState().setContextUsage(sessionProviderId, data.sessionId, (Number(data.usedTokens) / Number(data.totalTokens)) * 100);
      }
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

    socket.on('shell_run_prepared', (snapshot: ShellRunSnapshot) => {
      if (!snapshot?.runId) return;
      useShellRunStore.getState().upsertSnapshot(snapshot);
      patchShellRunToolStep(snapshot.runId, shellRunSnapshotPatch(snapshot), snapshot);
      syncShellInputStateForSession(snapshot.sessionId);
    });

    socket.on('shell_run_snapshot', (snapshot: ShellRunSnapshot) => {
      if (!snapshot?.runId) return;
      useShellRunStore.getState().upsertSnapshot(snapshot);
      patchShellRunToolStep(snapshot.runId, shellRunSnapshotPatch(snapshot), snapshot);
      syncShellInputStateForSession(snapshot.sessionId);
    });

    socket.on('shell_run_started', (snapshot: ShellRunSnapshot) => {
      if (!snapshot?.runId) return;
      const started = { ...snapshot, status: snapshot.status || 'running' } as ShellRunSnapshot;
      useShellRunStore.getState().markStarted(started);
      patchShellRunToolStep(snapshot.runId, shellRunSnapshotPatch(started, started.status), started);
      syncShellInputStateForSession(started.sessionId);
    });

    socket.on('shell_run_output', (data: { providerId: string; sessionId: string; runId: string; chunk: string; maxLines?: number; needsInput?: boolean }) => {
      if (!data?.runId) return;
      useShellRunStore.getState().appendOutput(data);
      const snapshot = useShellRunStore.getState().runs[data.runId];
      // Ensure the step is updated if it wasn't already
      patchShellRunToolStep(data.runId, { shellState: 'running', shellNeedsInput: Boolean(snapshot?.needsInput) }, snapshot);
      syncShellInputStateForSession(data.sessionId);
    });

    socket.on('shell_run_exit', (data: { providerId: string; sessionId: string; runId: string; exitCode?: number | null; reason?: string | null; finalText?: string; needsInput?: boolean }) => {
      if (!data?.runId) return;
      useShellRunStore.getState().markExited(data);
      const snapshot = useShellRunStore.getState().runs[data.runId];
      const status: SystemEvent['status'] = data.reason === 'completed' || data.exitCode === 0 ? 'completed' : 'failed';
      patchShellRunToolStep(data.runId, {
        shellState: 'exited',
        shellNeedsInput: false,
        status,
        endTime: Date.now(),
        ...(data.finalText !== undefined ? { output: data.finalText } : {})
      }, snapshot);
      syncShellInputStateForSession(data.sessionId);
    });

    // Sub-agent events
    //
    // sub_agents_starting fires immediately when the sub-agent start tool begins (before the
    // 1-second stagger), so the UI clears stale sidebar sessions right away instead of
    // waiting for the first sub_agent_started event (fixes the "flash of old agents" bug).
    socket.on('sub_agents_starting', (data: { invocationId: string; parentAcpSessionId?: string | null; parentUiId: string | null; providerId: string; count: number; statusToolName?: string }) => {
      const parentUiId = data.parentUiId || 'unknown';
      const parentSession = useSessionLifecycleStore.getState().sessions.find(s => s.id === parentUiId);
      const parentSessionId = data.parentAcpSessionId || parentSession?.acpSessionId || 'unknown';

      useSubAgentStore.getState().clearForParent(parentSessionId);
      useSubAgentStore.getState().clearInvocationsForParent(parentUiId);
      useSubAgentStore.getState().startInvocation({
        invocationId: data.invocationId,
        providerId: data.providerId,
        parentUiId,
        parentSessionId,
        statusToolName: data.statusToolName || ACP_UX_TOOL_NAMES.checkSubagents,
        totalCount: data.count,
        status: 'spawning'
      });

      // This event only fires after the backend accepts a new invocation. It is safe
      // to remove old completed sub-agent sidebar sessions for this parent here.
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

    socket.on('sub_agent_started', (data: { providerId: string; acpSessionId: string; uiId: string; parentAcpSessionId?: string | null; parentUiId: string | null; index: number; name: string; prompt: string; agent: string; model?: string; invocationId: string }) => {
      const parentUiId = data.parentUiId || 'unknown';
      const parentSession = useSessionLifecycleStore.getState().sessions.find(s => s.id === parentUiId);
      const parentSessionId = data.parentAcpSessionId || parentSession?.acpSessionId || 'unknown';
      useSubAgentStore.getState().addAgent({ ...data, parentSessionId });
      pendingSubAgents.set(data.acpSessionId, { ...data, parentSessionId, parentUiId, model: data.model || 'balanced' });

      // Stamp the invocationId onto the in-progress sub-agent start ToolStep
      // on the first agent (index 0).  We defer to here rather than sub_agents_starting
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
                isAcpUxSubAgentStartToolEvent(entry.event)
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

    socket.on('sub_agent_snapshot', (data: {
      providerId: string; acpSessionId: string; uiId: string;
      parentAcpSessionId?: string | null; parentUiId: string | null; invocationId: string; index: number;
      name: string; prompt: string; agent: string; model?: string; status: string;
    }) => {
      const existing = useSubAgentStore.getState().agents.find(a => a.acpSessionId === data.acpSessionId);
      if (existing) return;

      const parentUiId = data.parentUiId || 'unknown';
      const parentSession = useSessionLifecycleStore.getState().sessions.find(s => s.id === parentUiId);
      const parentSessionId = data.parentAcpSessionId || parentSession?.acpSessionId || 'unknown';

      useSubAgentStore.getState().startInvocation({
        invocationId: data.invocationId,
        providerId: data.providerId,
        parentUiId,
        parentSessionId,
        statusToolName: ACP_UX_TOOL_NAMES.checkSubagents,
        totalCount: 1,
        status: data.status as 'spawning' | 'prompting' | 'running' | 'waiting_permission' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
      });
      useSubAgentStore.getState().addAgent({ ...data, parentSessionId });
      useSubAgentStore.getState().setStatus(data.acpSessionId, data.status as 'spawning' | 'prompting' | 'running' | 'waiting_permission' | 'cancelling' | 'completed' | 'failed' | 'cancelled');

      const sidebarExists = useSessionLifecycleStore.getState().sessions.some(s => s.id === data.uiId);
      if (!sidebarExists) {
        pendingSubAgents.set(data.acpSessionId, {
          ...data, parentSessionId, parentUiId, model: data.model || 'balanced'
        });
      }
    });

    socket.on('sub_agent_status', (data: { acpSessionId: string; invocationId?: string; status: string }) => {
      const status = data.status as 'spawning' | 'prompting' | 'running' | 'waiting_permission' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
      useSubAgentStore.getState().setStatus(data.acpSessionId, status);
      if (data.invocationId) useSubAgentStore.getState().setInvocationStatus(data.invocationId, status);
    });

    socket.on('sub_agent_invocation_status', (data: { invocationId: string; providerId: string; parentAcpSessionId?: string | null; parentUiId?: string | null; statusToolName?: string; totalCount?: number; status: string }) => {
      const status = data.status as 'spawning' | 'prompting' | 'running' | 'waiting_permission' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
      useSubAgentStore.getState().startInvocation({
        invocationId: data.invocationId,
        providerId: data.providerId,
        parentUiId: data.parentUiId || null,
        parentSessionId: data.parentAcpSessionId || null,
        statusToolName: data.statusToolName || ACP_UX_TOOL_NAMES.checkSubagents,
        totalCount: data.totalCount || 0,
        status
      });
      useSubAgentStore.getState().setInvocationStatus(data.invocationId, status);
    });

    socket.on('sub_agent_completed', (data: { acpSessionId: string; status?: string }) => {
      useSubAgentStore.getState().completeAgent(data.acpSessionId, (data.status || 'completed') as 'completed' | 'failed' | 'cancelled');
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
          provider: pending.providerId,
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
      socket.off('stats_push');
      socket.off('session_renamed');
      socket.off('merge_message');
      socket.off('thought');
      socket.off('token');
      socket.off('system_event');
      socket.off('permission_request');
      socket.off('token_done');
      socket.off('hooks_status');
      socket.off('shell_run_prepared');
      socket.off('shell_run_snapshot');
      socket.off('shell_run_started');
      socket.off('shell_run_output');
      socket.off('shell_run_exit');
      socket.off('sub_agents_starting');
      socket.off('sub_agent_started');
      socket.off('sub_agent_snapshot');
      socket.off('sub_agent_status');
      socket.off('sub_agent_invocation_status');
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
