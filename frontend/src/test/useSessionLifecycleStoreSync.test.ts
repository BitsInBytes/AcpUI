import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { act } from 'react-dom/test-utils';

describe('useSessionLifecycleStore (Active Session Sync)', () => {
  beforeEach(() => {
    act(() => {
      useSessionLifecycleStore.setState({ 
        sessions: [],
        activeSessionId: null,
        isUrlSyncReady: false
      });
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
});
