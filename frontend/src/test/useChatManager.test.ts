import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useChatManager } from '../hooks/useChatManager';
import { useSystemStore } from '../store/useSystemStore';
import { useChatStore } from '../store/useChatStore';

// Mock stores
vi.mock('../store/useSystemStore', () => ({
  useSystemStore: vi.fn()
}));

vi.mock('../store/useChatStore', () => ({
  useChatStore: vi.fn()
}));

describe('useChatManager', () => {
  let mockSocket: any;
  const mockStoreActions = {
    handleInitialLoad: vi.fn(),
    onStreamThought: vi.fn(),
    onStreamToken: vi.fn(),
    onStreamEvent: vi.fn(),
    onStreamDone: vi.fn(),
    processBuffer: vi.fn(),
    setSessions: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn()
    };

    (useSystemStore as any).mockImplementation((selector: any) => {
      const state = { socket: mockSocket };
      return selector ? selector(state) : state;
    });

    (useChatStore as any).mockImplementation((selector: any) => {
      const state = {
        ...mockStoreActions,
        streamQueues: {},
        typewriterInterval: null
      };
      return selector ? selector(state) : state;
    });
  });

  it('registers socket listeners on mount', () => {
    renderHook(() => useChatManager(vi.fn()));

    expect(mockSocket.on).toHaveBeenCalledWith('thought', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('token', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('system_event', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('token_done', expect.any(Function));
  });

  it('calls handleInitialLoad if socket is present', () => {
    renderHook(() => useChatManager(vi.fn()));
    expect(mockStoreActions.handleInitialLoad).toHaveBeenCalledWith(mockSocket, expect.any(Function));
  });
});


describe('useChatManager socket listeners', () => {
  let mockSocket: any;
  const mockStoreActions = {
    handleInitialLoad: vi.fn(),
    onStreamThought: vi.fn(),
    onStreamToken: vi.fn(),
    onStreamEvent: vi.fn(),
    onStreamDone: vi.fn(),
    processBuffer: vi.fn(),
    setSessions: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
    (useSystemStore as any).mockImplementation((selector: any) => {
      const state = { socket: mockSocket };
      return selector ? selector(state) : state;
    });
    (useChatStore as any).mockImplementation((selector: any) => {
      const state = { ...mockStoreActions, streamQueues: {}, typewriterInterval: null };
      return selector ? selector(state) : state;
    });
  });

  it('registers permission_request listener', () => {
    renderHook(() => useChatManager(vi.fn()));
    expect(mockSocket.on).toHaveBeenCalledWith('permission_request', expect.any(Function));
  });

  it('registers stats_push listener', () => {
    renderHook(() => useChatManager(vi.fn()));
    expect(mockSocket.on).toHaveBeenCalledWith('stats_push', expect.any(Function));
  });

  it('registers session_renamed listener', () => {
    renderHook(() => useChatManager(vi.fn()));
    expect(mockSocket.on).toHaveBeenCalledWith('session_renamed', expect.any(Function));
  });

  it('registers hooks_status listener', () => {
    renderHook(() => useChatManager(vi.fn()));
    expect(mockSocket.on).toHaveBeenCalledWith('hooks_status', expect.any(Function));
  });

  it('cleans up listeners on unmount', () => {
    const { unmount } = renderHook(() => useChatManager(vi.fn()));
    unmount();
    expect(mockSocket.off).toHaveBeenCalledWith('stats_push');
    expect(mockSocket.off).toHaveBeenCalledWith('session_renamed');
    expect(mockSocket.off).toHaveBeenCalledWith('thought');
    expect(mockSocket.off).toHaveBeenCalledWith('token');
    expect(mockSocket.off).toHaveBeenCalledWith('system_event');
    expect(mockSocket.off).toHaveBeenCalledWith('permission_request');
    expect(mockSocket.off).toHaveBeenCalledWith('token_done');
    expect(mockSocket.off).toHaveBeenCalledWith('hooks_status');
  });

  it('does not register listeners when socket is null', () => {
    (useSystemStore as any).mockImplementation((selector: any) => {
      const state = { socket: null };
      return selector ? selector(state) : state;
    });
    renderHook(() => useChatManager(vi.fn()));
    expect(mockSocket.on).not.toHaveBeenCalled();
  });
});
