import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react';

describe('useSessionLifecycleStore (extended)', () => {
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

  it('handleActiveSessionModelChange calls handleSessionModelChange', () => {
    const s1 = { id: 's1', provider: 'p1', model: 'm1' } as any;
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [s1], activeSessionId: 's1' });
      useSessionLifecycleStore.getState().handleActiveSessionModelChange(mockSocket, 'm2');
    });

    const session = useSessionLifecycleStore.getState().sessions[0];
    expect(session.model).toBe('m2');
    expect(mockSocket.emit).toHaveBeenCalledWith('set_session_model', expect.objectContaining({ uiId: 's1', model: 'm2' }), expect.any(Function));
  });

  it('handleUpdateModel updates session model locally without socket emit', () => {
    const s1 = { id: 's1', provider: 'p1', model: 'm1' } as any;
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [s1] });
      useSessionLifecycleStore.getState().handleUpdateModel('s1', 'm3');
    });

    const session = useSessionLifecycleStore.getState().sessions[0];
    expect(session.model).toBe('m3');
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('handleSetSessionOption handles missing session gracefully', () => {
    act(() => {
      useSessionLifecycleStore.getState().handleSetSessionOption(mockSocket, 'non-existent', 'opt', 'val');
    });
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('handleSaveSession emits save_snapshot for active session', () => {
    const s1 = { id: 's1', name: 'Active' } as any;
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [s1], activeSessionId: 's1' });
      useSessionLifecycleStore.getState().handleSaveSession(mockSocket);
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', s1);
  });

  it('handleRenameSession handles missing session gracefully', () => {
    act(() => {
      useSessionLifecycleStore.getState().handleRenameSession(mockSocket, 'missing', 'New');
    });
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('checkPendingPrompts is a no-op currently', () => {
    expect(() => useSessionLifecycleStore.getState().checkPendingPrompts(mockSocket)).not.toThrow();
  });

  it('handleNewChat does not create if uiId already exists', () => {
    const s1 = { id: 'existing' } as any;
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [s1] });
      useSessionLifecycleStore.getState().handleNewChat(mockSocket, 'existing');
    });
    expect(useSessionLifecycleStore.getState().sessions).toHaveLength(1);
    expect(mockSocket.emit).not.toHaveBeenCalledWith('create_session', expect.anything(), expect.anything());
  });
});
