import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react';

describe('useSessionLifecycleStore (Active Session Sync)', () => {
  beforeEach(() => {
    act(() => {
      useSessionLifecycleStore.setState({ 
        sessions: [],
        activeSessionId: null,
        isUrlSyncReady: false
      });
      useSystemStore.setState({
        activeProviderId: 'p1',
        defaultProviderId: 'p1',
        branding: { providerId: 'p1', assistantName: 'test-provider', models: { default: 'balanced', quickAccess: [] } },
        providersById: {
          p1: {
            providerId: 'p1',
            label: 'Provider 1',
            branding: { providerId: 'p1', assistantName: 'test-provider', models: { default: 'balanced', quickAccess: [] } }
          }
        }
      } as any);
    });
  });

  it('syncs activeSessionId to URL when isUrlSyncReady is true', () => {
    // Mock window.history.replaceState
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    
    act(() => {
      useSessionLifecycleStore.setState({ isUrlSyncReady: true });
      useSessionLifecycleStore.getState().setActiveSessionId('test-id');
    });

    expect(replaceStateSpy).toHaveBeenCalled();
    const lastUrl = replaceStateSpy.mock.calls[0][2] as string;
    expect(lastUrl).toContain('s=test-id');

    act(() => {
        useSessionLifecycleStore.getState().setActiveSessionId(null);
    });
    const resetUrl = replaceStateSpy.mock.calls[1][2] as string;
    expect(resetUrl).not.toContain('s=');
    
    replaceStateSpy.mockRestore();
  });

  it('does NOT sync to URL if isUrlSyncReady is false', () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    
    act(() => {
      useSessionLifecycleStore.getState().setActiveSessionId('test-id');
    });

    expect(replaceStateSpy).not.toHaveBeenCalled();
    replaceStateSpy.mockRestore();
  });

  it('syncs URL when handleNewChat sets the active session', () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const mockSocket = {
      connected: true,
      emit: vi.fn((event: string, ...args: any[]) => {
        if (event === 'create_session') {
          const cb = args[1];
          cb({ sessionId: 'acp-1' });
        }
      })
    } as any;

    act(() => {
      useSessionLifecycleStore.setState({ isUrlSyncReady: true });
      useSessionLifecycleStore.getState().handleNewChat(mockSocket, 'new-ui');
    });

    expect(replaceStateSpy).toHaveBeenCalled();
    const lastUrl = replaceStateSpy.mock.calls.at(-1)?.[2] as string;
    expect(lastUrl).toContain('s=new-ui');
    replaceStateSpy.mockRestore();
  });

  it('syncs URL when handleSessionSelect changes active session', () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const mockSocket = { emit: vi.fn() } as any;

    act(() => {
      useSessionLifecycleStore.setState({
        isUrlSyncReady: true,
        sessions: [{ id: 's1', acpSessionId: 'a1', messages: [{ id: 'm1' }], isWarmingUp: false } as any]
      });
      useSystemStore.setState({
        hasContextUsage: vi.fn(() => true)
      } as any);
      useSessionLifecycleStore.getState().handleSessionSelect(mockSocket, 's1');
    });

    expect(replaceStateSpy).toHaveBeenCalled();
    const lastUrl = replaceStateSpy.mock.calls.at(-1)?.[2] as string;
    expect(lastUrl).toContain('s=s1');
    replaceStateSpy.mockRestore();
  });
});
