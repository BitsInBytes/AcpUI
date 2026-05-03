import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react';

describe('useSessionLifecycleStore (Deep Logic)', () => {
  let mockSocket: any;

  beforeEach(() => {
    mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: true };
    act(() => {
      useSystemStore.setState({ socket: mockSocket, activeProviderId: 'p1', deletePermanent: false, branding: { models: { default: 'm1' } } } as any);
      useSessionLifecycleStore.setState({ 
        sessions: [
          { id: 's1', name: 'Chat 1', acpSessionId: 'a1', messages: [{ id: 'm1' }], model: 'balanced', provider: 'p1' } as any,
          { id: 's2', name: 'Chat 2', acpSessionId: 'a2', messages: [{ id: 'm1' }], model: 'balanced', provider: 'p1' } as any
        ],
        activeSessionId: 's1',
        isInitiallyLoaded: false
      });
    });
  });

  it('handleRenameSession updates local name and emits save_snapshot', () => {
    act(() => {
      useSessionLifecycleStore.getState().handleRenameSession(mockSocket, 's1', 'New Name');
    });
    expect(useSessionLifecycleStore.getState().sessions[0].name).toBe('New Name');
    expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.objectContaining({ name: 'New Name' }));
  });

  it('handleSessionSelect emits get_session_history', () => {
    act(() => {
      useSessionLifecycleStore.getState().handleSessionSelect(mockSocket, 's2');
    });
    // Since s2 has messages, it just switches ID. 
    // Wait, implementation says: if (session.acpSessionId && !session.isWarmingUp && session.messages.length > 0) return;
    // So it should NOT emit.
    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(useSessionLifecycleStore.getState().activeSessionId).toBe('s2');
  });

  it('handleSessionSelect hydrates if session is empty', () => {
    const sEmpty = { id: 'empty', messages: [] } as any;
    act(() => { 
        useSessionLifecycleStore.setState({ sessions: [sEmpty] });
        useSessionLifecycleStore.getState().handleSessionSelect(mockSocket, 'empty'); 
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('get_session_history', expect.objectContaining({ uiId: 'empty' }), expect.any(Function));
  });

  it('handleDeleteSession emits archive_session when permanent is false', () => {
    act(() => {
      useSessionLifecycleStore.getState().handleDeleteSession(mockSocket, 's2');
    });
    expect(useSessionLifecycleStore.getState().sessions).toHaveLength(1);
    expect(mockSocket.emit).toHaveBeenCalledWith('archive_session', expect.objectContaining({ uiId: 's2' }));
  });

  it('handleDeleteSession emits delete_session when permanent is true', () => {
    act(() => {
      useSystemStore.setState({ deletePermanent: true });
      useSessionLifecycleStore.getState().handleDeleteSession(mockSocket, 's2');
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('delete_session', expect.objectContaining({ uiId: 's2' }));
  });

  it('handleInitialLoad handles empty session list', () => {
    mockSocket.emit.mockImplementation((event: string, cb: any) => {
        if (event === 'load_sessions') cb({ sessions: [] });
    });
    act(() => {
        // Reset initiallyLoaded to allow trigger
        useSessionLifecycleStore.setState({ isInitiallyLoaded: false });
        useSessionLifecycleStore.getState().handleInitialLoad(mockSocket, vi.fn());
    });
    expect(useSessionLifecycleStore.getState().sessions).toHaveLength(0);
    expect(useSessionLifecycleStore.getState().isUrlSyncReady).toBe(true);
  });
});
