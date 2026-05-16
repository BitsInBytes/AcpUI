import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatManager } from '../hooks/useChatManager';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useStreamStore } from '../store/useStreamStore';
import { useShellRunStore } from '../store/useShellRunStore';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { isSessionPoppedOut } from '../lib/sessionOwnership';

vi.mock('../lib/sessionOwnership', () => ({
  isSessionPoppedOut: vi.fn(() => false)
}));

describe('useChatManager hook', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isSessionPoppedOut).mockReturnValue(false);
    mockSocket = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      connected: true
    };
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any, connected: true });
      useSessionLifecycleStore.setState({ sessions: [], activeSessionId: null, handleInitialLoad: vi.fn() });
      useStreamStore.setState({
        streamQueues: {},
        activeMsgIdByAcp: {},
        isProcessActiveByAcp: {},
        displayedContentByMsg: {},
        settledLengthByMsg: {},
        typewriterInterval: null
      });
      useShellRunStore.getState().reset();
      useSubAgentStore.getState().clear();
    });
  });

  const flushStreamBuffer = () => {
    act(() => {
      useStreamStore.getState().processBuffer(vi.fn());
    });
    const interval = useStreamStore.getState().typewriterInterval;
    if (interval) {
      clearTimeout(interval);
      act(() => useStreamStore.setState({ typewriterInterval: null }));
    }
  };

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

  it('skips initial load when configured', () => {
    const handleInitialLoad = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleInitialLoad });
    });

    renderHook(() => useChatManager(vi.fn(), vi.fn(), vi.fn(), { skipInitialLoad: true }));

    expect(handleInitialLoad).not.toHaveBeenCalled();
    expect(mockSocket.on).toHaveBeenCalled();
  });

  it('handles "stats_push" event', () => {
    const setSessions = vi.fn();
    act(() => {
      useSystemStore.setState({ contextUsageBySession: {} });
      useSessionLifecycleStore.setState({
        setSessions,
        sessions: [{ id: 's1', acpSessionId: 'acp-1', provider: 'provider-a', messages: [] } as any]
      });
    });
    renderHook(() => useChatManager(vi.fn()));

    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'stats_push')[1];
    handler({ sessionId: 'acp-1', usedTokens: 100, totalTokens: 1000 });

    expect(useSystemStore.getState().getContextUsage('provider-a', 'acp-1')).toBe(10);
    expect(setSessions).toHaveBeenCalled();
  });

  it('ignores stream events for sessions owned by a pop-out window', () => {
    vi.mocked(isSessionPoppedOut).mockReturnValue(true);
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{ id: 's1', acpSessionId: 'acp-1', provider: 'provider-a', messages: [] } as any],
        activeSessionId: 's1'
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const tokenHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'token')[1];
    const thoughtHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'thought')[1];
    const eventHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'system_event')[1];
    const doneHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'token_done')[1];

    act(() => {
      thoughtHandler({ sessionId: 'acp-1', text: 'thinking' });
      tokenHandler({ sessionId: 'acp-1', text: 'hello' });
      eventHandler({ sessionId: 'acp-1', type: 'tool_start', id: 't1', title: 'Tool', status: 'in_progress' });
      doneHandler({ sessionId: 'acp-1' });
    });

    const queue = useStreamStore.getState().streamQueues['acp-1'];
    expect(queue).toBeUndefined();
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

  it('applies stream resume snapshots and seeds active stream state', () => {
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          provider: 'provider-a',
          messages: [{ id: 'a1', role: 'assistant', content: 'old', timeline: [{ type: 'text', content: 'old' }], isStreaming: true }],
          isTyping: false
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'stream_resume_snapshot')[1];

    act(() => {
      handler({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        uiId: 's1',
        message: { id: 'a1', role: 'assistant', content: 'old fresh', timeline: [{ type: 'text', content: 'old fresh' }], isStreaming: true }
      });
    });

    const session = useSessionLifecycleStore.getState().sessions[0];
    expect(session.isTyping).toBe(true);
    expect(session.messages[0].content).toBe('old fresh');
    expect(useStreamStore.getState().activeMsgIdByAcp['acp-1']).toBe('a1');
    expect(useStreamStore.getState().displayedContentByMsg.a1).toBe('old fresh');
    expect(useStreamStore.getState().settledLengthByMsg.a1).toBe('old fresh'.length);
  });

  it('stamps parent sub-agent tool steps from reconnect snapshots even when agent already exists', () => {
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          provider: 'provider-a',
          messages: [{
            id: 'a1',
            role: 'assistant',
            content: '',
            timeline: [{
              type: 'tool',
              event: {
                id: 'tool-1',
                title: 'Invoke Subagents',
                status: 'in_progress',
                toolName: 'ux_invoke_subagents',
                canonicalName: 'ux_invoke_subagents'
              }
            }],
            isStreaming: true
          }]
        } as any]
      });
      useSubAgentStore.setState({ agents: [{ acpSessionId: 'sub-acp-1', invocationId: 'inv-1' } as any] });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_snapshot')[1];

    act(() => {
      handler({
        providerId: 'provider-a',
        acpSessionId: 'sub-acp-1',
        uiId: 'sub-ui-1',
        parentAcpSessionId: 'parent-acp',
        parentUiId: 'parent-ui',
        invocationId: 'inv-1',
        index: 0,
        name: 'Agent 1',
        prompt: 'Check node',
        agent: 'default',
        status: 'running'
      });
    });

    const step = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline?.[0] as any;
    expect(step.event.invocationId).toBe('inv-1');
  });

  it('creates a recovered parent sub-agent ToolStep from reconnect snapshots when history missed the start event', () => {
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          provider: 'provider-a',
          messages: [{ id: 'a1', role: 'assistant', content: 'Working', timeline: [{ type: 'text', content: 'Working' }], isStreaming: true }]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_snapshot')[1];

    act(() => {
      handler({
        providerId: 'provider-a',
        acpSessionId: 'sub-acp-1',
        uiId: 'sub-ui-1',
        parentAcpSessionId: 'parent-acp',
        parentUiId: 'parent-ui',
        invocationId: 'inv-1',
        index: 0,
        name: 'Agent 1',
        prompt: 'Check node',
        agent: 'default',
        status: 'running',
        invocationStatus: 'running',
        totalCount: 1
      });
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline.some(step => step.type === 'tool' && step.event.invocationId === 'inv-1')).toBe(true);
    expect(useSubAgentStore.getState().agents.some(agent => agent.invocationId === 'inv-1')).toBe(true);
  });

  it('replays reconnect sub-agent stamps after parent history hydrates', () => {
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          provider: 'provider-a',
          messages: []
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_snapshot')[1];

    act(() => {
      handler({
        providerId: 'provider-a',
        acpSessionId: 'sub-acp-1',
        uiId: 'sub-ui-1',
        parentAcpSessionId: 'parent-acp',
        parentUiId: 'parent-ui',
        invocationId: 'inv-1',
        index: 0,
        name: 'Agent 1',
        prompt: 'Check node',
        agent: 'default',
        status: 'running',
        invocationStatus: 'running',
        totalCount: 1
      });
    });

    expect(useSubAgentStore.getState().agents.some(agent => agent.invocationId === 'inv-1')).toBe(true);
    expect(useSessionLifecycleStore.getState().sessions[0].messages).toHaveLength(0);

    act(() => {
      useSessionLifecycleStore.setState(state => ({
        sessions: state.sessions.map(session => session.id === 'parent-ui'
          ? {
              ...session,
              messages: [{
                id: 'a1',
                role: 'assistant',
                content: 'Working',
                timeline: [{ type: 'text', content: 'Working' }],
                isStreaming: true
              }]
            } as any
          : session)
      }));
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline.some(step => step.type === 'tool' && step.event.invocationId === 'inv-1')).toBe(true);
  });

  it('keeps reconnect sub-agent stamps after stream resume refreshes the parent message', () => {
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          provider: 'provider-a',
          messages: [{ id: 'a1', role: 'assistant', content: 'Working', timeline: [{ type: 'text', content: 'Working' }], isStreaming: true }]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const snapshotHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_snapshot')[1];
    const resumeHandler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'stream_resume_snapshot')[1];

    act(() => {
      snapshotHandler({
        providerId: 'provider-a',
        acpSessionId: 'sub-acp-1',
        uiId: 'sub-ui-1',
        parentAcpSessionId: 'parent-acp',
        parentUiId: 'parent-ui',
        invocationId: 'inv-1',
        index: 0,
        name: 'Agent 1',
        prompt: 'Check node',
        agent: 'default',
        status: 'running',
        invocationStatus: 'running',
        totalCount: 1
      });
      resumeHandler({
        providerId: 'provider-a',
        sessionId: 'parent-acp',
        uiId: 'parent-ui',
        message: { id: 'a1', role: 'assistant', content: 'Working longer', timeline: [{ type: 'text', content: 'Working longer' }], isStreaming: true }
      });
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline.some(step => step.type === 'tool' && step.event.invocationId === 'inv-1')).toBe(true);
  });

  it('recovers a parent sub-agent ToolStep from terminal reconnect snapshots', () => {
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          provider: 'provider-a',
          messages: [{ id: 'a1', role: 'assistant', content: 'Done', timeline: [{ type: 'text', content: 'Done' }], isStreaming: false }]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_snapshot')[1];

    act(() => {
      handler({
        providerId: 'provider-a',
        acpSessionId: 'sub-acp-1',
        uiId: 'sub-ui-1',
        parentAcpSessionId: 'parent-acp',
        parentUiId: 'parent-ui',
        invocationId: 'inv-1',
        index: 0,
        name: 'Agent 1',
        prompt: 'Check node',
        agent: 'default',
        status: 'completed',
        invocationStatus: 'completed',
        totalCount: 1
      });
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline.some(step => step.type === 'tool' && step.event.invocationId === 'inv-1')).toBe(true);
    expect(useSubAgentStore.getState().agents.some(agent => agent.invocationId === 'inv-1')).toBe(true);
  });

  it('resolves parent ui id from parent acp id for reconnect snapshots', () => {
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          provider: 'provider-a',
          messages: [{ id: 'a1', role: 'assistant', content: 'Working', timeline: [{ type: 'text', content: 'Working' }], isStreaming: true }]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_snapshot')[1];

    act(() => {
      handler({
        providerId: 'provider-a',
        acpSessionId: 'sub-acp-1',
        uiId: 'sub-ui-1',
        parentAcpSessionId: 'parent-acp',
        parentUiId: null,
        invocationId: 'inv-1',
        index: 0,
        name: 'Agent 1',
        prompt: 'Check node',
        agent: 'default',
        status: 'running',
        invocationStatus: 'running',
        totalCount: 1
      });
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline.some(step => step.type === 'tool' && step.event.invocationId === 'inv-1')).toBe(true);
    expect(useSubAgentStore.getState().invocations[0].parentUiId).toBe('parent-ui');
  });

  it('stamps only the best matching parent sub-agent tool step', () => {
    act(() => {
      useSessionLifecycleStore.setState({
        sessions: [{
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          provider: 'provider-a',
          messages: [
            {
              id: 'old-assistant',
              role: 'assistant',
              content: '',
              isStreaming: false,
              timeline: [{
                type: 'tool',
                event: { id: 'old-tool', title: 'Invoke Subagents', status: 'completed', toolName: 'ux_invoke_subagents' }
              }]
            },
            {
              id: 'active-assistant',
              role: 'assistant',
              content: '',
              isStreaming: true,
              timeline: [{
                type: 'tool',
                event: { id: 'active-tool', title: 'Invoke Subagents', status: 'in_progress', toolName: 'ux_invoke_subagents' }
              }]
            }
          ]
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_snapshot')[1];

    act(() => {
      handler({
        providerId: 'provider-a',
        acpSessionId: 'sub-acp-1',
        uiId: 'sub-ui-1',
        parentAcpSessionId: 'parent-acp',
        parentUiId: 'parent-ui',
        invocationId: 'inv-1',
        index: 0,
        name: 'Agent 1',
        prompt: 'Check node',
        agent: 'default',
        status: 'running',
        invocationStatus: 'running',
        totalCount: 1
      });
    });

    const [oldMessage, activeMessage] = useSessionLifecycleStore.getState().sessions[0].messages;
    expect((oldMessage.timeline?.[0] as any).event.invocationId).toBeUndefined();
    expect((activeMessage.timeline?.[0] as any).event.invocationId).toBe('inv-1');
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
    expect(toolStep.event.status).toBe('completed');
    expect(toolStep.event.title).toBe('Invoke Shell: Run test suite');
    expect(toolStep.event.command).toBe('npm test');
    expect(toolStep.event.cwd).toBe('D:/repo');
    expect(toolStep.event.output).toBe('PASS');
    expect(toolStep.event.endTime).toBeDefined();
  });

  it('marks the session as awaiting shell input from shell output and clears it on exit', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          name: 'Session',
          messages: [{
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            timeline: [{
              type: 'tool',
              event: {
                id: 'tool-1',
                title: 'Invoke Shell: Install deps',
                status: 'in_progress',
                toolName: 'ux_invoke_shell',
                shellRunId: 'shell-run-1',
                shellState: 'running'
              }
            }],
            isStreaming: true
          }],
          isTyping: true,
          isWarmingUp: false,
          model: 'balanced',
          provider: 'provider-a'
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_output({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-1',
        chunk: 'Ok to proceed? (y) ',
        needsInput: true
      });
    });

    let session = useSessionLifecycleStore.getState().sessions[0];
    expect(session.isAwaitingShellInput).toBe(true);
    expect((session.messages[0].timeline?.[0] as any).event.shellNeedsInput).toBe(true);

    act(() => {
      handlers.shell_run_exit({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-1',
        exitCode: 0,
        reason: 'completed',
        finalText: 'done'
      });
    });

    session = useSessionLifecycleStore.getState().sessions[0];
    expect(session.isAwaitingShellInput).toBe(false);
    expect((session.messages[0].timeline?.[0] as any).event.shellNeedsInput).toBe(false);
  });

  it('keeps shell input waiting state while another run in the same session still needs input', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          name: 'Session',
          messages: [],
          isTyping: true,
          isWarmingUp: false,
          model: 'balanced',
          provider: 'provider-a'
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_output({ providerId: 'provider-a', sessionId: 'acp-1', runId: 'shell-run-1', chunk: 'Password: ', needsInput: true });
      handlers.shell_run_output({ providerId: 'provider-a', sessionId: 'acp-1', runId: 'shell-run-2', chunk: 'Continue? ', needsInput: true });
      handlers.shell_run_exit({ providerId: 'provider-a', sessionId: 'acp-1', runId: 'shell-run-1', exitCode: 0, reason: 'completed' });
    });

    expect(useSessionLifecycleStore.getState().sessions[0].isAwaitingShellInput).toBe(true);

    act(() => {
      handlers.shell_run_exit({ providerId: 'provider-a', sessionId: 'acp-1', runId: 'shell-run-2', exitCode: 0, reason: 'completed' });
    });

    expect(useSessionLifecycleStore.getState().sessions[0].isAwaitingShellInput).toBe(false);
  });

  it('creates a Shell V2 tool step from shell lifecycle events when provider tool_start is missing', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          name: 'Session',
          messages: [],
          isTyping: true,
          isWarmingUp: false,
          model: 'balanced',
          provider: 'provider-a'
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_started({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-missing-start',
        status: 'running',
        description: 'Sync check',
        command: 'node -p "sync"',
        cwd: 'D:/repo',
        transcript: '$ node -p "sync"\n'
      });
      handlers.shell_run_output({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-missing-start',
        chunk: 'sync\n'
      });
      handlers.shell_run_exit({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-missing-start',
        exitCode: 0,
        reason: 'completed',
        finalText: 'sync'
      });
    });
    flushStreamBuffer();

    const session = useSessionLifecycleStore.getState().sessions[0];
    expect(session.messages).toHaveLength(1);
    const toolStep = session.messages[0].timeline?.[0] as any;
    expect(toolStep.type).toBe('tool');
    expect(toolStep.event.shellRunId).toBe('shell-run-missing-start');
    expect(toolStep.event.status).toBe('completed');
    expect(toolStep.event.title).toBe('Invoke Shell: Sync check');
    expect(toolStep.event.output).toBe('sync');
  });

  it('attaches shell lifecycle to a queued provider shell start instead of adding a duplicate', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          name: 'Session',
          messages: [{ id: 'assistant-1', role: 'assistant', content: '', timeline: [], isStreaming: true }],
          isTyping: true,
          isWarmingUp: false,
          model: 'balanced',
          provider: 'provider-a'
        } as any]
      });
      useStreamStore.setState({
        activeMsgIdByAcp: { 'acp-1': 'assistant-1' },
        streamQueues: {
          'acp-1': [{
            type: 'event',
            data: {
              sessionId: 'acp-1',
              type: 'tool_start',
              id: 'provider-tool-1',
              title: 'Invoke Shell: Check Node.js version',
              status: 'in_progress',
              toolName: 'ux_invoke_shell',
              canonicalName: 'ux_invoke_shell'
            }
          }]
        }
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_started({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-node-version',
        status: 'running',
        description: 'Check Node.js version',
        command: 'node --version',
        cwd: 'D:/repo'
      });
    });

    flushStreamBuffer();

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event.shellRunId).toBe('shell-run-node-version');
    expect(timeline[0].event.command).toBe('node --version');
  });

  it('does not attach shell lifecycle to ambiguous queued provider shell starts with the same description', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          name: 'Session',
          messages: [{ id: 'assistant-1', role: 'assistant', content: '', timeline: [], isStreaming: true }],
          isTyping: true,
          isWarmingUp: false,
          model: 'balanced',
          provider: 'provider-a'
        } as any]
      });
      useStreamStore.setState({
        activeMsgIdByAcp: { 'acp-1': 'assistant-1' },
        streamQueues: {
          'acp-1': [
            {
              type: 'event',
              data: {
                sessionId: 'acp-1',
                type: 'tool_start',
                id: 'provider-tool-1',
                title: 'Invoke Shell: Run sync check',
                status: 'in_progress',
                toolName: 'ux_invoke_shell',
                canonicalName: 'ux_invoke_shell'
              }
            },
            {
              type: 'event',
              data: {
                sessionId: 'acp-1',
                type: 'tool_start',
                id: 'provider-tool-2',
                title: 'Invoke Shell: Run sync check',
                status: 'in_progress',
                toolName: 'ux_invoke_shell',
                canonicalName: 'ux_invoke_shell'
              }
            }
          ]
        }
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_started({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-ambiguous',
        status: 'running',
        description: 'Run sync check',
        command: 'node --version',
        cwd: 'D:/repo'
      });
    });

    flushStreamBuffer();

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline).toHaveLength(3);
    expect(timeline[0].event.shellRunId).toBeUndefined();
    expect(timeline[1].event.shellRunId).toBeUndefined();
    expect(timeline[2].event.shellRunId).toBe('shell-run-ambiguous');
  });

  it('attaches shell lifecycle to an existing provider shell step by description', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          name: 'Session',
          messages: [{
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            timeline: [{
              type: 'tool',
              event: {
                id: 'provider-tool-1',
                title: 'Invoke Shell: Check Node.js version',
                status: 'in_progress',
                toolName: 'ux_invoke_shell',
                canonicalName: 'ux_invoke_shell'
              }
            }],
            isStreaming: true
          }],
          isTyping: true,
          isWarmingUp: false,
          model: 'balanced',
          provider: 'provider-a'
        } as any]
      });
      useStreamStore.setState({ activeMsgIdByAcp: { 'acp-1': 'assistant-1' } });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_started({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-existing-step',
        status: 'running',
        description: 'Check Node.js version',
        command: 'node --version',
        cwd: 'D:/repo'
      });
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event.shellRunId).toBe('shell-run-existing-step');
    expect(timeline[0].event.command).toBe('node --version');
    expect(useStreamStore.getState().streamQueues['acp-1']).toBeUndefined();
  });

  it('queues fallback shell starts without splitting an active thought step', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          name: 'Session',
          messages: [{
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            timeline: [{ type: 'thought', content: 'nod', isCollapsed: false }],
            isStreaming: true
          }],
          isTyping: true,
          isWarmingUp: false,
          model: 'balanced',
          provider: 'provider-a'
        } as any]
      });
      useStreamStore.setState({
        activeMsgIdByAcp: { 'acp-1': 'assistant-1' },
        streamQueues: { 'acp-1': [{ type: 'thought', data: 'e -v`.' }] }
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_started({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-with-thought',
        status: 'running',
        description: 'Check Node.js version',
        command: 'node --version',
        cwd: 'D:/repo'
      });
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline as any[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].type).toBe('thought');
    const queue = useStreamStore.getState().streamQueues['acp-1'];
    expect(queue.map(item => item.type)).toEqual(['thought', 'event']);
    expect(queue[1].data.shellRunId).toBe('shell-run-with-thought');
  });

  it('marks Shell V2 tool steps failed on non-zero shell exits', async () => {
    act(() => {
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          acpSessionId: 'acp-1',
          name: 'Session',
          messages: [],
          isTyping: true,
          isWarmingUp: false,
          model: 'balanced',
          provider: 'provider-a'
        } as any]
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handlers = Object.fromEntries(mockSocket.on.mock.calls.map((call: any) => [call[0], call[1]]));

    act(() => {
      handlers.shell_run_started({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-failed',
        status: 'running',
        description: 'Failing command',
        command: 'exit 1',
        cwd: 'D:/repo'
      });
      handlers.shell_run_exit({
        providerId: 'provider-a',
        sessionId: 'acp-1',
        runId: 'shell-run-failed',
        exitCode: 1,
        reason: 'failed',
        finalText: 'failed'
      });
    });
    flushStreamBuffer();

    const toolStep = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline?.[0] as any;
    expect(toolStep.event.status).toBe('failed');
    expect(toolStep.event.shellState).toBe('exited');
    expect(toolStep.event.endTime).toBeDefined();
    expect(toolStep.event.output).toBe('failed');
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
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    const setState = vi.spyOn(useSessionLifecycleStore, 'setState');
    act(() => {
      useSubAgentStore.getState().clear();
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
      handler({ invocationId: 'inv-abc', parentAcpSessionId: 'parent-acp', parentUiId: 'parent-ui', providerId: 'provider-a', count: 2, statusToolName: 'ux_check_subagents' });
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
    expect(useSubAgentStore.getState().invocations[0]).toEqual(expect.objectContaining({
      invocationId: 'inv-abc',
      providerId: 'provider-a',
      parentUiId: 'parent-ui',
      parentSessionId: 'parent-acp',
      statusToolName: 'ux_check_subagents',
      totalCount: 2,
      status: 'spawning'
    }));
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
      useSystemStore.setState({
        providersById: {
          'provider-a': {
            providerId: 'provider-a',
            branding: {
              ...useSystemStore.getState().branding,
              providerId: 'provider-a',
              models: {
                default: 'test-default-model',
                subAgent: 'test-subagent-model',
                quickAccess: [{ id: 'test-subagent-model', displayName: 'Sub Agent Model' }]
              }
            }
          } as any
        }
      });
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
    expect(created.model).toBe('test-subagent-model');
    expect(created.currentModelId).toBe('test-subagent-model');
    expect(created.modelOptions).toEqual([{ id: 'test-subagent-model', name: 'Sub Agent Model' }]);
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
        model: 'explicit-subagent-model',
        invocationId: 'inv-event'
      });
      for (const h of systemHandlers) h({ sessionId: 'sub-acp-event', type: 'noop', id: 't1', title: 'Tool' });
    });

    const created = useSessionLifecycleStore.getState().sessions.find((s: any) => s.id === 'sub-ui-event') as any;
    expect(created).toBeDefined();
    expect(created.provider).toBe('provider-b');
    expect(created.name).toBe('Event Agent');
    expect(created.model).toBe('explicit-subagent-model');
    expect(created.currentModelId).toBe('explicit-subagent-model');
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

  it('handles "sub_agent_invocation_status" event', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    act(() => {
      useSubAgentStore.getState().clear();
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_invocation_status')[1];

    act(() => {
      handler({
        invocationId: 'inv-status',
        providerId: 'provider-a',
        parentAcpSessionId: 'parent-acp',
        parentUiId: 'parent-ui',
        statusToolName: 'ux_check_subagents',
        totalCount: 3,
        status: 'running'
      });
    });

    expect(useSubAgentStore.getState().invocations[0]).toEqual(expect.objectContaining({
      invocationId: 'inv-status',
      providerId: 'provider-a',
      parentUiId: 'parent-ui',
      parentSessionId: 'parent-acp',
      totalCount: 3,
      status: 'running'
    }));

    act(() => {
      handler({
        invocationId: 'inv-status',
        providerId: 'provider-a',
        parentAcpSessionId: 'parent-acp',
        parentUiId: 'parent-ui',
        status: 'completed'
      });
    });

    expect(useSubAgentStore.getState().invocations[0].status).toBe('completed');
    expect(useSubAgentStore.getState().isInvocationActive('inv-status')).toBe(false);
  });

  it('handles "sub_agent_status" with invocationId by updating agent and invocation state', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    act(() => {
      useSubAgentStore.setState({
        invocations: [{
          invocationId: 'inv-agent-status',
          providerId: 'provider-a',
          parentUiId: 'parent-ui',
          parentSessionId: 'parent-acp',
          statusToolName: 'ux_check_subagents',
          totalCount: 1,
          status: 'running',
          startedAt: Date.now(),
          completedAt: null
        }],
        agents: [{
          providerId: 'provider-a',
          acpSessionId: 'sub-acp-status',
          parentSessionId: 'parent-acp',
          invocationId: 'inv-agent-status',
          index: 0,
          name: 'Agent',
          prompt: 'p',
          agent: 'a',
          status: 'running',
          tokens: '',
          thoughts: '',
          toolSteps: [],
          permission: null
        }]
      } as any);
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_status')[1];

    act(() => {
      handler({ acpSessionId: 'sub-acp-status', invocationId: 'inv-agent-status', status: 'completed' });
    });

    expect(useSubAgentStore.getState().agents[0].status).toBe('completed');
    expect(useSubAgentStore.getState().invocations[0].status).toBe('completed');
  });

  it('moves waiting sub-agents back to running on token events', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    act(() => {
      useSubAgentStore.setState({
        agents: [{
          providerId: 'provider-a',
          acpSessionId: 'sub-waiting',
          parentSessionId: 'parent-acp',
          invocationId: 'inv-waiting',
          index: 0,
          name: 'Agent',
          prompt: 'p',
          agent: 'a',
          status: 'waiting_permission',
          tokens: '',
          thoughts: '',
          toolSteps: [],
          permission: null
        }]
      } as any);
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'token')[1];

    act(() => {
      handler({ sessionId: 'sub-waiting', text: 'continuing' });
    });

    expect(useSubAgentStore.getState().agents[0].status).toBe('running');
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

    expect(completeAgent).toHaveBeenCalledWith('sub-acp', 'completed');
    const session = useSessionLifecycleStore.getState().sessions.find((s: any) => s.acpSessionId === 'sub-acp') as any;
    expect(session.isTyping).toBe(false);
    expect(session.messages[0].isStreaming).toBe(false);
  });

  it('passes terminal sub-agent completion statuses through to the store', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    const completeAgent = vi.fn();
    act(() => {
      useSubAgentStore.setState({ completeAgent });
      useSessionLifecycleStore.setState({ sessions: [] });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_completed')[1];
    act(() => { handler({ acpSessionId: 'sub-acp-failed', status: 'failed' }); });

    expect(completeAgent).toHaveBeenCalledWith('sub-acp-failed', 'failed');
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

  it('plays completion sound once for a background token_done event', () => {
    const play = vi.fn(() => Promise.resolve());
    const audioCtor = vi.fn(function MockAudio() { return { play }; });
    const originalAudio = globalThis.Audio;
    // @ts-expect-error test stub
    globalThis.Audio = audioCtor;

    const onStreamDone = vi.fn(() => {
      try { new Audio('/memory-sound.mp3').play()?.catch(() => {}); }
      catch { /* test env fallback */ }
    });

    act(() => {
      useStreamStore.setState({ onStreamDone });
      useSystemStore.setState({ notificationSound: true, notificationDesktop: false } as any);
      useSessionLifecycleStore.setState({
        activeSessionId: 's1',
        sessions: [
          { id: 's1', acpSessionId: 'acp-active', name: 'Active', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, provider: 'provider-a' } as any,
          { id: 's2', acpSessionId: 'acp-background', name: 'Background', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, provider: 'provider-a' } as any,
        ]
      });
    });

    renderHook(() => useChatManager(vi.fn()));

    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'token_done')[1];
    act(() => {
      handler({ sessionId: 'acp-background' });
    });

    expect(onStreamDone).toHaveBeenCalledTimes(1);
    expect(audioCtor).toHaveBeenCalledTimes(1);

    globalThis.Audio = originalAudio;
  });
});
