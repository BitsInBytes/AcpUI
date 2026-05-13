import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useStreamStore } from '../store/useStreamStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { useShellRunStore } from '../store/useShellRunStore';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { act } from 'react';

describe('useStreamStore (Pure Logic)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    act(() => {
      useStreamStore.setState({
        streamQueues: {},
        activeMsgIdByAcp: {},
        isProcessActiveByAcp: {},
        displayedContentByMsg: {},
        settledLengthByMsg: {},
        typewriterInterval: null
      });
      useSessionLifecycleStore.setState({
        sessions: [
          { id: 's1', acpSessionId: 'a1', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, provider: 'p1' } as any
        ],
        activeSessionId: 's1'
      });
      useSystemStore.setState({ compactingBySession: {}, branding: { models: {} } } as any);
      useShellRunStore.getState().reset();
      useSubAgentStore.getState().clear();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ensureAssistantMessage creates a placeholder message', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
    });
    
    const session = useSessionLifecycleStore.getState().sessions[0];
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('assistant');
    expect(useStreamStore.getState().activeMsgIdByAcp['a1']).toBe(session.messages[0].id);
  });

  it('onStreamToken queues text and triggers typewriter', () => {
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'a1', text: 'Hello' });
    });

    expect(useStreamStore.getState().streamQueues['a1']).toHaveLength(1);
    expect(useStreamStore.getState().streamQueues['a1'][0]).toEqual({ type: 'token', data: 'Hello' });
    
    // Typing indicator should be set
    expect(useSessionLifecycleStore.getState().sessions[0].isTyping).toBe(true);
  });

  it('onStreamToken injects RESPONSE_DIVIDER after tool processing', () => {
    const store = useStreamStore.getState();
    act(() => {
      // Simulate that a tool was just active
      useStreamStore.setState({ 
          isProcessActiveByAcp: { 'a1': true },
          activeMsgIdByAcp: { 'a1': 'm1' },
          displayedContentByMsg: { 'm1': 'Some existing text' }
      });
      store.onStreamToken({ sessionId: 'a1', text: 'Next part' });
    });

    const queueItem = useStreamStore.getState().streamQueues['a1'][0];
    expect(queueItem.data).toContain(':::RESPONSE_DIVIDER:::');
    expect(queueItem.data).toContain('Next part');
  });

  it('processBuffer drains queue into session messages with adaptive speed', () => {
    const scrollToBottom = vi.fn();
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'a1', text: 'This is a long piece of text that should be drained' });
      useStreamStore.getState().processBuffer(scrollToBottom);
    });

    const session = useSessionLifecycleStore.getState().sessions[0];
    const msg = session.messages[0];
    expect(msg.content.length).toBeGreaterThan(0);
    expect(msg.content.length).toBeLessThan('This is a long piece of text that should be drained'.length); // Adaptive drip
    expect(scrollToBottom).toHaveBeenCalled();

    // Check if interval is set
    expect(useStreamStore.getState().typewriterInterval).toBeDefined();
  });

  it('processBuffer flushes large buffers immediately', () => {
    const longText = 'a'.repeat(600);
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'a1', text: longText });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const msg = useSessionLifecycleStore.getState().sessions[0].messages[0];
    expect(msg.content).toBe(longText); // > 500 chars flushes immediately
  });

  it('onStreamEvent handles tool_start and collapses previous steps', () => {
    act(() => {
      // Setup: 1 message with 1 thought step
      useStreamStore.getState().ensureAssistantMessage('a1');
      const msgId = useStreamStore.getState().activeMsgIdByAcp['a1'];
      useSessionLifecycleStore.setState(state => ({
          sessions: state.sessions.map(s => ({
              ...s,
              messages: [{ id: msgId, role: 'assistant', timeline: [{ type: 'thought', content: 'thinking', isCollapsed: false }] }] as any
          }))
      }));

      useStreamStore.getState().onStreamEvent({ 
          sessionId: 'a1', 
          type: 'tool_start', 
          id: 't1', 
          title: 'Running tool' 
      });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline[0].isCollapsed).toBe(true); // Preceding thought collapsed
    expect(timeline[1].type).toBe('tool');
    expect((timeline[1] as any).event.id).toBe('t1');
    expect(timeline[1].isCollapsed).toBe(false); // Current tool open
  });

  it('keeps active sub-agent orchestration steps expanded when new timeline steps arrive', () => {
    act(() => {
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-active',
        providerId: 'p1',
        parentUiId: 's1',
        parentSessionId: 'a1',
        statusToolName: 'ux_check_subagents',
        totalCount: 1,
        status: 'running'
      });
      useStreamStore.getState().ensureAssistantMessage('a1');
      const msgId = useStreamStore.getState().activeMsgIdByAcp['a1'];
      useSessionLifecycleStore.setState(state => ({
        sessions: state.sessions.map(s => ({
          ...s,
          messages: [{
            id: msgId,
            role: 'assistant',
            timeline: [
              {
                type: 'tool',
                isCollapsed: false,
                event: {
                  id: 'subagent-tool',
                  title: 'Invoke Subagents',
                  toolName: 'ux_invoke_subagents',
                  canonicalName: 'ux_invoke_subagents',
                  invocationId: 'inv-active'
                }
              },
              { type: 'thought', content: 'thinking', isCollapsed: false }
            ]
          }] as any
        }))
      }));

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'next-tool',
        title: 'Next tool'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline[0].isCollapsed).toBe(false);
    expect(timeline[1].isCollapsed).toBe(true);
    expect(timeline[2].isCollapsed).toBe(false);
  });

  it('collapses inactive sub-agent orchestration steps when new timeline steps arrive', () => {
    act(() => {
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-complete',
        providerId: 'p1',
        parentUiId: 's1',
        parentSessionId: 'a1',
        statusToolName: 'ux_check_subagents',
        totalCount: 1,
        status: 'completed'
      });
      useStreamStore.getState().ensureAssistantMessage('a1');
      const msgId = useStreamStore.getState().activeMsgIdByAcp['a1'];
      useSessionLifecycleStore.setState(state => ({
        sessions: state.sessions.map(s => ({
          ...s,
          messages: [{
            id: msgId,
            role: 'assistant',
            timeline: [{
              type: 'tool',
              isCollapsed: false,
              event: {
                id: 'subagent-tool',
                title: 'Invoke Subagents',
                toolName: 'ux_invoke_subagents',
                canonicalName: 'ux_invoke_subagents',
                invocationId: 'inv-complete'
              }
            }]
          }] as any
        }))
      }));

      useStreamStore.getState().onStreamThought({ sessionId: 'a1', text: 'new thought' });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline[0].isCollapsed).toBe(true);
    expect(timeline[1].type).toBe('thought');
    expect(timeline[1].isCollapsed).toBe(false);
  });

  it('hydrates queued shell tool_start from an existing shell snapshot', () => {
    act(() => {
      useShellRunStore.getState().upsertSnapshot({
        providerId: 'gemini',
        sessionId: 'a1',
        runId: 'shell-run-1',
        status: 'running',
        description: 'Check git status',
        command: 'git status --short',
        cwd: 'D:\\Git\\AcpUI',
        transcript: ''
      });

      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 't1',
        title: 'Invoke Shell',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-1'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const tool = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline![0] as any;
    expect(tool.event.title).toBe('Invoke Shell: Check git status');
    expect(tool.event.command).toBe('git status --short');
    expect(tool.event.cwd).toBe('D:\\Git\\AcpUI');
    expect(tool.event.shellState).toBe('running');
  });

  it('keeps active parallel shell tool starts expanded while later shell steps arrive', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'shell-tool-1',
        title: 'Invoke Shell: Check Node.js version (1 of 3)',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-1'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'shell-tool-2',
        title: 'Invoke Shell: Check Node.js version (2 of 3)',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-2'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'shell-tool-3',
        title: 'Invoke Shell: Check Node.js version (3 of 3)',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-3'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline).toHaveLength(3);
    expect(timeline.map(step => step.isCollapsed)).toEqual([false, false, false]);
  });

  it('merges duplicate shell tool_start events by shellRunId', () => {
    act(() => {
      useShellRunStore.getState().upsertSnapshot({
        providerId: 'gemini',
        sessionId: 'a1',
        runId: 'shell-run-1',
        status: 'exited',
        description: 'Check working tree status',
        command: 'git status --short --branch',
        cwd: 'D:\\Git\\AcpUI',
        transcript: '$ git status --short --branch\n M file.ts\n'
      });

      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'mcp-tool-id',
        title: 'Invoke Shell: Check working tree status',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-1'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_end',
        id: 'mcp-tool-id',
        status: 'completed'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'provider-tool-id',
        title: 'Invoke Shell',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-1'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline).toHaveLength(1);
    const tool = timeline[0] as any;
    expect(tool.event.id).toBe('provider-tool-id');
    expect(tool.event.status).toBe('completed');
    expect(tool.event.title).toBe('Invoke Shell: Check working tree status');
    expect(tool.event.shellRunId).toBe('shell-run-1');
  });

  it('merges provider shell tool_start without run id into an existing shell run by description', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'shell-fallback-id',
        title: 'Invoke Shell: Check Node.js version',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-node-version',
        command: 'node --version'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'provider-tool-id',
        title: 'Invoke Shell: Check Node.js version',
        toolName: 'ux_invoke_shell'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline).toHaveLength(1);
    const tool = timeline[0] as any;
    expect(tool.event.id).toBe('provider-tool-id');
    expect(tool.event.shellRunId).toBe('shell-run-node-version');
    expect(tool.event.command).toBe('node --version');
  });

  it('does not merge same-title shell starts when description matching is ambiguous', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'shell-fallback-a',
        title: 'Invoke Shell: Run sync check',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-a',
        command: 'node --version'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'shell-fallback-b',
        title: 'Invoke Shell: Run sync check',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-b',
        command: 'npm --version'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'provider-tool-id',
        title: 'Invoke Shell: Run sync check',
        toolName: 'ux_invoke_shell'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline).toHaveLength(3);
    expect((timeline[0] as any).event.shellRunId).toBe('shell-run-a');
    expect((timeline[1] as any).event.shellRunId).toBe('shell-run-b');
    expect((timeline[2] as any).event.id).toBe('provider-tool-id');
    expect((timeline[2] as any).event.shellRunId).toBeUndefined();
  });

  it('merges duplicate provider shell tool_start events before a shell run id is attached', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'provider-tool-id',
        title: 'Invoke Shell: Check Node.js version (1 of 3)',
        toolName: 'ux_invoke_shell'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'provider-tool-id',
        title: 'Invoke Shell: Check Node.js version (1 of 3)',
        toolName: 'ux_invoke_shell'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'shell-fallback-id',
        title: 'Invoke Shell: Check Node.js version (1 of 3)',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-node-version',
        command: 'node --version'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline).toHaveLength(1);
    const tool = timeline[0] as any;
    expect(tool.event.id).toBe('shell-fallback-id');
    expect(tool.event.shellRunId).toBe('shell-run-node-version');
    expect(tool.event.command).toBe('node --version');
  });

  it('merges shell tool_end events by shellRunId when tool ids differ', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 'mcp-tool-id',
        title: 'Invoke Shell: Run tests',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-1'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_end',
        id: 'provider-tool-id',
        status: 'completed',
        shellRunId: 'shell-run-1'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline).toHaveLength(1);
    expect((timeline[0] as any).event.status).toBe('completed');
  });

  it('onStreamEvent merges tool titles correctly', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({ sessionId: 'a1', type: 'tool_start', id: 't1', title: 'Basic' });
      useStreamStore.getState().processBuffer(vi.fn());
      
      // Update with longer, more detailed title
      useStreamStore.getState().onStreamEvent({ sessionId: 'a1', type: 'tool_update', id: 't1', title: 'Detailed: file.ts' });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const tool = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline![0] as any;
    expect(tool.event.title).toBe('Detailed: file.ts');
  });

  it('prefers MCP handler titles over longer raw provider titles', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 't1',
        title: 'AcpUI/ux_grep_search: Find all project matches',
        toolName: 'ux_grep_search',
        isAcpUxTool: true
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_update',
        id: 't1',
        title: 'Search: Project matches',
        titleSource: 'mcp_handler',
        canonicalName: 'ux_grep_search'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_update',
        id: 't1',
        title: 'AcpUI/ux_grep_search: Later provider title',
        titleSource: 'provider',
        canonicalName: 'ux_grep_search'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const tool = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline![0] as any;
    expect(tool.event.title).toBe('Search: Project matches');
    expect(tool.event.titleSource).toBe('mcp_handler');
    expect(tool.event.isAcpUxTool).toBe(true);
  });

  it('prefers detailed AcpUI provider titles over raw tool headers', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 't1',
        title: 'AcpUI/ux_grep_search: Find hooks',
        toolName: 'ux_grep_search',
        isAcpUxTool: true
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_update',
        id: 't1',
        title: 'Search: Find hooks',
        titleSource: 'provider',
        canonicalName: 'ux_grep_search'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const tool = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline![0] as any;
    expect(tool.event.title).toBe('Search: Find hooks');
  });

  it('onStreamEvent handles tool_update and caches fallback output', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({ sessionId: 'a1', type: 'tool_start', id: 't1', title: 'Tool' });
      useStreamStore.getState().processBuffer(vi.fn());
      
      useStreamStore.getState().onStreamEvent({ sessionId: 'a1', type: 'tool_update', id: 't1', output: 'some progress' });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const tool = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline![0] as any;
    expect(tool.event._fallbackOutput).toBe('some progress');
  });

  it('preserves Shell V2 terminal output on tool_end by shellRunId', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 't1',
        title: 'Run shell',
        shellRunId: 'shell-run-1'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_end',
        id: 't1',
        status: 'completed',
        output: 'final MCP result'
      });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const tool = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline![0] as any;
    expect(tool.event.shellRunId).toBe('shell-run-1');
    expect(tool.event.output).toBeUndefined();
  });

  it('preserves Shell V2 description title over later command titles', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_start',
        id: 't1',
        title: 'Invoke Shell: Run test suite',
        toolName: 'ux_invoke_shell',
        shellRunId: 'shell-run-1'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());

      useStreamStore.getState().onStreamEvent({
        sessionId: 'a1',
        type: 'tool_end',
        id: 't1',
        status: 'completed',
        title: 'Run shell command: npm run test -- --coverage'
      } as any);
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const tool = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline![0] as any;
    expect(tool.event.title).toBe('Invoke Shell: Run test suite');
  });

  it('processBuffer removes Thinking placeholder when real thoughts or tokens arrive', () => {
    const scrollToBottom = vi.fn();
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      const msgId = useStreamStore.getState().activeMsgIdByAcp['a1'];
      useSessionLifecycleStore.setState(state => ({
          sessions: state.sessions.map(s => ({
              ...s,
              messages: [{ id: msgId, role: 'assistant', timeline: [{ type: 'thought', content: '_Thinking..._', isCollapsed: false }] }] as any
          }))
      }));

      useStreamStore.getState().onStreamToken({ sessionId: 'a1', text: 'Real token' });
      useStreamStore.getState().processBuffer(scrollToBottom);
      // Advance timers to let the typewriter finish the small token
      vi.advanceTimersByTime(500);
    });

    const timeline = useSessionLifecycleStore.getState().sessions[0].messages[0].timeline!;
    expect(timeline).toHaveLength(1);
    expect((timeline[0] as any).content).toBe('Real token'); // _Thinking..._ was shifted out
  });

  it('onStreamDone marks message as finished and saves snapshot', () => {
    const mockSocket = { emit: vi.fn() } as any;
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('a1');
      useStreamStore.getState().onStreamDone(mockSocket, { sessionId: 'a1' });
    });

    // It uses an interval to wait for queue to be empty
    act(() => { vi.advanceTimersByTime(100); });

    const msg = useSessionLifecycleStore.getState().sessions[0].messages[0];
    expect(msg.isStreaming).toBe(false);
    expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.anything());
  });
});
