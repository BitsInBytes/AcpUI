import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react';

describe('useSessionLifecycleStore', () => {
  let mockSocket: any;

  beforeEach(() => {
    mockSocket = {
      connected: true,
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    };

    act(() => {
      useSystemStore.setState({ 
        socket: mockSocket, 
        activeProviderId: 'p1',
        workspaceCwds: [],
        providersById: {
          p1: { providerId: 'p1', label: 'P1', branding: { models: { default: 'm1', quickAccess: [] } } }
        }
      } as any);
      useSessionLifecycleStore.setState({ 
        sessions: [],
        activeSessionId: null,
        isInitiallyLoaded: false,
        isUrlSyncReady: false,
        lastStatsFetchByAcp: {},
        sessionNotes: {}
      });
    });
  });

  it('initializes with default state', () => {
    const state = useSessionLifecycleStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.activeSessionId).toBeNull();
  });

  it('handleInitialLoad loads sessions and syncs URL', () => {
    const sessions = [{ id: 's1', name: 'S1' }];
    mockSocket.emit.mockImplementation((event: string, ...args: any[]) => {
      const cb = args[args.length - 1];
      if (event === 'load_sessions') cb({ sessions });
    });

    act(() => {
      useSessionLifecycleStore.getState().handleInitialLoad(mockSocket, vi.fn());
    });

    const state = useSessionLifecycleStore.getState();
    expect(state.isInitiallyLoaded).toBe(true);
    expect(state.sessions).toHaveLength(1);
    expect(state.isUrlSyncReady).toBe(true);
  });

  it('fetchStats updates session with stats', async () => {
    const acpId = 'a1';
    const stats = { usedTokens: 50 };
    mockSocket.emit.mockImplementation((event: string, ...args: any[]) => {
      const cb = args[args.length - 1];
      if (event === 'get_stats') cb({ stats });
    });

    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ id: 's1', acpSessionId: acpId } as any] });
    });

    await act(async () => {
      await useSessionLifecycleStore.getState().fetchStats(mockSocket, acpId);
    });

    expect(useSessionLifecycleStore.getState().sessions[0].stats).toEqual(stats);
  });

  it('handleNewChat creates session and retries if daemon not ready', () => {
    vi.useFakeTimers();
    let callCount = 0;
    mockSocket.emit.mockImplementation((event: string, ...args: any[]) => {
      const cb = args[args.length - 1];
      if (event === 'create_session') {
        callCount++;
        if (callCount === 1) cb({ error: 'Daemon not ready' });
        else cb({ sessionId: 'a1' });
      }
    });

    act(() => {
      useSessionLifecycleStore.getState().handleNewChat(mockSocket);
    });

    expect(callCount).toBe(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(callCount).toBe(2);
    expect(useSessionLifecycleStore.getState().sessions[0].acpSessionId).toBe('a1');
    vi.useRealTimers();
  });

  it('hydrateSession cleans timeline and resumes on backend', async () => {
    const history = {
      messages: [{
        id: 'm1',
        role: 'assistant',
        timeline: [
          { type: 'thought', content: 'thinking' },
          { type: 'tool', event: { title: 'tool' } }
        ]
      }],
      provider: 'p1',
      acpSessionId: 'old-acp'
    };

    mockSocket.emit.mockImplementation((event: string, ...args: any[]) => {
      const cb = args[args.length - 1];
      if (event === 'get_session_history') {
         cb({ session: history });
      }
      if (event === 'create_session') {
         cb({ sessionId: 'a-resumed' });
      }
    });

    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ id: 's1', acpSessionId: 'old' } as any] });
      useSessionLifecycleStore.getState().hydrateSession(mockSocket, 's1');
    });

    // Hydration chain should complete since we auto-respond in the mock
    const session = useSessionLifecycleStore.getState().sessions[0];
    expect(session.messages[0].timeline).toHaveLength(1);
    expect(session.messages[0].timeline![0].type).toBe('tool');
    expect(session.acpSessionId).toBe('a-resumed');
  });

  it('handleDeleteSession removes session and emits archive_session by default', () => {
    const s1 = { id: 's1', name: 'S1', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'a1', provider: 'p1' };
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [s1], activeSessionId: 's1' });
      useSessionLifecycleStore.getState().handleDeleteSession(mockSocket, 's1');
    });

    expect(useSessionLifecycleStore.getState().sessions).toHaveLength(0);
    expect(mockSocket.emit).toHaveBeenCalledWith('archive_session', expect.objectContaining({ uiId: 's1' }));
  });

  it('handleSetSessionOption updates local state and emits', () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ id: 's1', configOptions: [{ id: 'opt1', currentValue: 'v1' }] } as any] });
      useSessionLifecycleStore.getState().handleSetSessionOption(mockSocket, 's1', 'opt1', 'v2');
    });

    expect(useSessionLifecycleStore.getState().sessions[0].configOptions![0].currentValue).toBe('v2');
    expect(mockSocket.emit).toHaveBeenCalledWith('set_session_option', expect.objectContaining({ optionId: 'opt1', value: 'v2' }));
  });

  it('handleSessionSelect updates activeSessionId and clears unread flag', () => {
    const s1 = { id: 's1', hasUnreadResponse: true, messages: [{ id: 'm1' }] } as any;
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [s1] });
      useSessionLifecycleStore.getState().handleSessionSelect(mockSocket, 's1');
    });

    const state = useSessionLifecycleStore.getState();
    expect(state.activeSessionId).toBe('s1');
    expect(state.sessions[0].hasUnreadResponse).toBe(false);
  });

  it('handleTogglePin sorts sessions with pins first', () => {
    const s1 = { id: 's1', isPinned: false } as any;
    const s2 = { id: 's2', isPinned: false } as any;
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [s1, s2] });
      useSessionLifecycleStore.getState().handleTogglePin(mockSocket, 's2');
    });

    const sessions = useSessionLifecycleStore.getState().sessions;
    expect(sessions[0].id).toBe('s2');
    expect(sessions[0].isPinned).toBe(true);
  });

  it('handleRestartProcess emits restart_process', () => {
    useSessionLifecycleStore.getState().handleRestartProcess(mockSocket);
    expect(mockSocket.emit).toHaveBeenCalledWith('restart_process');
  });
});
