import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatManager } from '../hooks/useChatManager';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useStreamStore } from '../store/useStreamStore';

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

  it('handles "tool_output_stream" with buffering', async () => {
    vi.useFakeTimers();
    act(() => {
      useSessionLifecycleStore.setState({ 
        activeSessionId: 's1',
        sessions: [{ 
          id: 's1', 
          messages: [{ role: 'assistant', timeline: [{ type: 'tool', event: { status: 'in_progress', output: '' } }] }] 
        } as any] 
      });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'tool_output_stream')[1];
    
    act(() => {
      handler({ chunk: 'Hello ' });
      handler({ chunk: 'World' });
    });

    // Should not have updated yet (waiting for 50ms flush if direct flush fails)
    // Actually, in useChatManager, it tries flushToolBuffer() immediately.
    // If it fails (e.g. no active tool), it sets an interval.
    
    vi.advanceTimersByTime(100);
    const sessions = useSessionLifecycleStore.getState().sessions;
    const output = (sessions[0].messages[0] as any).timeline[0].event.output;
    expect(output).toContain('Hello World');
    
    vi.useRealTimers();
  });

  it('handles "sub_agent_started" event', async () => {
    const { useSubAgentStore } = await import('../store/useSubAgentStore');
    const addAgent = vi.fn();
    act(() => {
      useSubAgentStore.setState({ addAgent, clearForParent: vi.fn() });
      useSessionLifecycleStore.setState({ sessions: [{ id: 'parent-ui', acpSessionId: 'parent-acp' } as any] });
    });

    renderHook(() => useChatManager(vi.fn()));
    const handler = mockSocket.on.mock.calls.find((c: any) => c[0] === 'sub_agent_started')[1];
    
    const data = { acpSessionId: 'sub-acp', uiId: 'sub-ui', parentUiId: 'parent-ui', index: 0, name: 'Agent', prompt: 'p', agent: 'a' };
    handler(data);
    
    expect(addAgent).toHaveBeenCalled();
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
    handler({ sessionId: 'acp-1', text: 'Merged' });
    
    expect(setState).toHaveBeenCalled();
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
