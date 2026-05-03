import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useStreamStore } from '../store/useStreamStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
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
