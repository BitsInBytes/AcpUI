import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatManager } from '../hooks/useChatManager';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useStreamStore } from '../store/useStreamStore';
import { useShellRunStore } from '../store/useShellRunStore';

describe('useChatManager hook', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      connected: true
    };
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any, connected: true });
      useSessionLifecycleStore.setState({ sessions: [], activeSessionId: null, handleInitialLoad: vi.fn() });
      useShellRunStore.getState().reset();
    });
  });

  it('sets up listeners and calls handleInitialLoad', () => {
    const handleInitialLoad = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleInitialLoad });
    });

    renderHook(() => useChatManager(vi.fn(), vi.fn(), vi.fn()));
    
    expect(handleInitialLoad).toHaveBeenCalled();
    // Verify at least some listeners are registered
    expect(mockSocket.on).toHaveBeenCalled();
  });

  it('handles "stats_push" event', () => {
    const setSessions = vi.fn();
    act(() => { useSessionLifecycleStore.setState({ setSessions, sessions: [{ id: 's1', acpSessionId: 'acp-1', messages: [] } as any] }); });
    renderHook(() => useChatManager(vi.fn()));
    
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'stats_push')[1];
    handler({ sessionId: 'acp-1', usedTokens: 100, totalTokens: 1000 });
    
    expect(setSessions).toHaveBeenCalled();
  });

  it('handles "permission_request" for sub-agent', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    const setPermission = vi.fn();
    act(() => {
      useSubAgentStore.setState({ 
        agents: [{ acpSessionId: 'sub-1', name: 'Agent' } as any],
        setPermission
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'permission_request')[1];
    
    handler({ sessionId: 'sub-1', id: 42, options: [], toolCall: { title: 'Tool' } });
    expect(setPermission).toHaveBeenCalledWith('sub-1', expect.objectContaining({ id: 42 }));
  });

  it('handles Shell V2 socket events by explicit shellRunId', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          messages: [{
            role: 'assistant',
            timeline: [{
              type: 'tool',
              event: {
                id: 'tool-1',
                status: 'in_progress',
                toolName: 'ux_invoke_shell',
                shellRunId: 'shell-run-1',
                shellState: 'pending',
                output: ''
              }
            }]
          }]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_snapshot({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-1',
        status: 'running',
        description: 'Run test suite',
        command: 'npm test',
        cwd: 'D:/repo',
        transcript: '$ npm test\n'
      });
      handlers.shell_run_output({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-1',
        chunk: 'PASS\n',
        maxLines: 10
      });
      handlers.shell_run_exit({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-1',
        exitCode: 0,
        reason: 'completed',
        finalText: 'PASS'
      });
    });

    const run = useShellRunStore.getState().runs['shell-run-1'];
    expect(run.transcript).toBe('$ npm test\nPASS\n');
    expect(run.status).toBe('exited');

    const toolStep = (useSessionLifecycleStore.getState().sessions[0].messages[0] as any).timeline[0];
    expect(toolStep.event.shellState).toBe('exited');
    expect(toolStep.event.title).toBe('Invoke Shell: Run test suite');
    expect(toolStep.event.command).toBe('npm test');
    expect(toolStep.event.cwd).toBe('D:/repo');
    expect(toolStep.event.output).toBe('PASS');
  });

  it('routes parallel Shell V2 output by shellRunId without claiming legacy shell steps', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          messages: [{
            role: 'assistant',
            timeline: [
              { type: 'tool', event: { id: 'a', status: 'in_progress', toolName: 'ux_invoke_shell', shellRunId: 'run-a' } },
              { type: 'tool', event: { id: 'b', status: 'in_progress', toolName: 'ux_invoke_shell', shellRunId: 'run-b' } },
            ]
          }]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const outputHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'shell_run_output')[1];

    act(() => {
      outputHandler({ providerId: 'provider-a', sessionId: 'acp-1', runId: 'run-b', chunk: 'B' });
      outputHandler({ providerId: 'provider-a', sessionId: 'acp-1', runId: 'run-a', chunk: 'A' });
    });

    expect(useShellRunStore.getState().runs['run-a'].transcript).toBe('A');
    expect(useShellRunStore.getState().runs['run-b'].transcript).toBe('B');
  });

  it('handles "sub_agents_starting" — clears old sidebar sessions immediately', async () => {
    const setState = vi.spyOn(useSessionLifecycleStore, 'setState');
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [
          {
            id: 'parent-ui', acpSessionId: 'parent-acp',
            messages: [{
              role: 'assistant',
              timeline: [{
                type: 'tool',
                event: { id: 'tc-1', title: 'Spawning agents', status: 'in_progress', toolName: 'ux_invoke_subagents' }
              }]
            }]
          } as any,
          { id: 'sub-old', acpSessionId: 'sub-acp-old', isSubAgent: true, forkedFrom: 'parent-ui', messages: [] } as any,
        ]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agents_starting')[1];

    act(() => {
      handler({ invocationId: 'inv-abc', parentUiId: 'parent-ui', providerId: 'provider-a', count: 2 });
    });

    // Old sidebar sub-agent session should be deleted
    expect(mockSocket.emit).toHaveBeenCalledWith('delete_session', { uiId: 'sub-old' });
    // setState called to remove old sessions from the store
    expect(setState).toHaveBeenCalled();
    // The sub-old session should be gone from the store
    const sessions = useSessionLifecycleStore.getState().sessions;
    expect(sessions.find((s: any) => s.id === 'sub-old')).toBeUndefined();
    // The parent session should still be there (only sub-agents are removed)
    expect(sessions.find((s: any) => s.id === 'parent-ui')).toBeDefined();
  });

  it('handles "sub_agent_started" event and stamps invocationId on in-progress ToolStep at index 0', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    const addAgent = vi.fn();
    act(() => {
      useSubAgentStore.setState({ addAgent });
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          messages: [{
            role: 'assistant',
            timeline: [{
              type: 'tool',
              event: { id: 'tc-1', title: 'Spawning agents', status: 'in_progress', toolName: 'ux_invoke_subagents' }
            }]
          }]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_started')[1];

    const data = { providerId: 'provider-a', acpSessionId: 'sub-acp', uiId: 'sub-ui', parentUiId: 'parent-ui', index: 0, name: 'Agent', prompt: 'p', agent: 'a', invocationId: 'inv-abc' };
    act(() => { handler(data); });

    expect(addAgent).toHaveBeenCalled();

    // invocationId should be stamped onto the in-progress ux_invoke_subagents ToolStep
    const sessions = useSessionLifecycleStore.getState().sessions;
    const parentSession = sessions.find((s: any) => s.id === 'parent-ui') as any;
    const toolStep = parentSession?.messages?.[0]?.timeline?.[0];
    expect(toolStep?.event?.invocationId).toBe('inv-abc');
  });

  it('creates lazy sub-agent session with provider on first token', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    act(() => {
      useSubAgentStore.setState({ addAgent: vi.fn() as any });
      useSessionLifecycleStore.setState({
        sessions: [{ id: 'parent-ui', acpSessionId: 'parent-acp', messages: [] } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const startedHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_started')[1];
    const tokenHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'token')[1];

    act(() => {
      startedHandler({
        providerId: 'provider-a',
        acpSessionId: 'sub-acp-token',
        uiId: 'sub-ui-token',
        parentUiId: 'parent-ui',
        index: 0,
        name: 'Token Agent',
        prompt: 'p',
        agent: 'a',
        invocationId: 'inv-token'
      });
      tokenHandler({ sessionId: 'sub-acp-token', text: 'hello' });
    });

    const created = useSessionLifecycleStore.getState().sessions.find((s: any) => s.id === 'sub-ui-token') as any;
    expect(created).toBeDefined();
    expect(created.provider).toBe('provider-a');
    expect(created.name).toBe('Token Agent');
  });

  it('creates lazy sub-agent session with provider on first system_event', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    act(() => {
      useSubAgentStore.setState({
        agents: [],
        addAgent: vi.fn() as any,
      });
      useSessionLifecycleStore.setState({
        sessions: [{ id: 'parent-ui', acpSessionId: 'parent-acp', messages: [] } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const startedHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_started')[1];
    const systemHandlers = mockSocket.on.mock.calls.filter((c: any) => c[0] === 'system_event').map((c: any) => c[1]);

    act(() => {
      startedHandler({
        providerId: 'provider-b',
        acpSessionId: 'sub-acp-event',
        uiId: 'sub-ui-event',
        parentUiId: 'parent-ui',
        index: 0,
        name: 'Event Agent',
        prompt: 'p',
        agent: 'a',
        invocationId: 'inv-event'
      });
      for (const h of systemHandlers) h({ sessionId: 'sub-acp-event', type: 'noop', id: 't1', title: 'Tool' });
    });

    const created = useSessionLifecycleStore.getState().sessions.find((s: any) => s.id === 'sub-ui-event') as any;
    expect(created).toBeDefined();
    expect(created.provider).toBe('provider-b');
    expect(created.name).toBe('Event Agent');
  });

  it('handles "session_renamed" event', () => {
    const setSessions = vi.fn();
    act(() => { useSessionLifecycleStore.setState({ setSessions, sessions: [{ id: 's1', name: 'Old' } as any] }); });
    renderHook(() => useChatManager(vi.fn()));
    
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'session_renamed')[1];
    handler({ uiId: 's1', newName: 'New' });
    
    expect(setSessions).toHaveBeenCalled();
  });

  it('handles "merge_message" event', () => {
    const setState = vi.spyOn(useSessionLifecycleStore, 'setState');
    act(() => { useSessionLifecycleStore.setState({ sessions: [{ acpSessionId: 'acp-1', messages: [] } as any] }); });
    renderHook(() => useChatManager(vi.fn()));
    
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'merge_message')[1];
    act(() => {
      handler({ sessionId: 'acp-1', text: 'Merged' });
    });
    
    expect(setState).toHaveBeenCalled();
  });

  it('handles "sub_agent_completed" event', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    const completeAgent = vi.fn();
    act(() => {
      useSubAgentStore.setState({ completeAgent });
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 's1', acpSessionId: 'sub-acp',
          isTyping: true,
          messages: [{ role: 'assistant', isStreaming: true, content: '' } as any]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_completed')[1];
    act(() => { handler({ acpSessionId: 'sub-acp' }); });

    expect(completeAgent).toHaveBeenCalledWith('sub-acp');
    const session = useSessionLifecycleStore.getState().sessions.find((s: any) => s.acpSessionId === 'sub-acp') as any;
    expect(session.isTyping).toBe(false);
    expect(session.messages[0].isStreaming).toBe(false);
  });

  it('routes system_event tool_start/tool_end to sub-agent store', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    const addToolStep = vi.fn();
    const updateToolStep = vi.fn();
    act(() => {
      useSubAgentStore.setState({
        agents: [{ acpSessionId: 'sub-acp' } as any],
        addToolStep,
        updateToolStep,
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    // system_event is registered twice (onStreamEvent + subAgentSystemHandler)
    const handlers = mockSocket.on.mock.calls.filter((c: any) => c[0] === 'system_event').map((c: any) => c[1]);

    act(() => {
      for (const h of handlers) h({ sessionId: 'sub-acp', type: 'tool_start', id: 't1', title: 'Tool' });
    });
    expect(addToolStep).toHaveBeenCalledWith('sub-acp', 't1', 'Tool');

    act(() => {
      for (const h of handlers) h({ sessionId: 'sub-acp', type: 'tool_end', id: 't1', title: 'Tool', status: 'success', output: 'done' });
    });
    expect(updateToolStep).toHaveBeenCalledWith('sub-acp', 't1', 'success', 'done');
  });

  it('handles "token_done" event', async () => {
    const onStreamDone = vi.fn();
    act(() => { 
      useStreamStore.setState({ onStreamDone });
      useSystemStore.setState({ notificationSound: false, notificationDesktop: false });
    });
    renderHook(() => useChatManager(vi.fn()));
    
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'token_done')[1];
    handler({ sessionId: 's1' });
    
    expect(onStreamDone).toHaveBeenCalled();
  });
});
