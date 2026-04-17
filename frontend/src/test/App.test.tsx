import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import App from '../App';
import { useSystemStore } from '../store/useSystemStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { useChatStore } from '../store/useChatStore';
import { useUIStore } from '../store/useUIStore';

const mockEmit = vi.fn();
vi.mock('../hooks/useSocket', () => ({
  useSocket: () => ({
    socket: { on: vi.fn(), off: vi.fn(), emit: mockEmit, connected: true, close: vi.fn() },
    socketRef: { current: null },
    connected: true,
    isEngineReady: true,
    backendBootId: null,
    sslError: false,
    backendBootIdRef: { current: null }
  })
}));

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    localStorage.clear();

    const mockSocket = {
      connected: true,
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      close: vi.fn(),
    };

    act(() => {
      useSystemStore.setState({ socket: mockSocket as any, connected: true, isEngineReady: true });
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'New Chat', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
        activeSessionId: 's1',
        inputs: { s1: '' },
        attachmentsMap: { s1: [] },
        handleSessionSelect: vi.fn(),
        checkPendingPrompts: vi.fn()
      });
      useVoiceStore.setState({ isRecording: false, isProcessingVoice: false, availableAudioDevices: [], selectedAudioDevice: '' });
      useUIStore.setState({ isSidebarOpen: true, isModelDropdownOpen: false, isSidebarPinned: false });
    });

    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          enumerateDevices: vi.fn().mockResolvedValue([]),
          getUserMedia: vi.fn().mockResolvedValue({}),
        },
        writable: true
      });
    }
  });

  it('renders Sidebar and ChatInput', async () => {
    render(<App />);
    expect(screen.getByPlaceholderText(/Send a message/i)).toBeInTheDocument();
    // In Sidebar it shows 'New Chat', in ChatHeader it shows 'New Chat'
    expect(screen.getAllByText(/New Chat/i).length).toBeGreaterThan(0);
  });

  it('switches between sessions', async () => {
    const mockHandleSessionSelect = vi.fn();
    act(() => {
      useChatStore.setState({
        sessions: [
          { id: 's1', name: 'Chat 1', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null },
          { id: 's2', name: 'Chat 2', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }
        ],
        activeSessionId: 's1',
        inputs: { s1: '', s2: '' },
        attachmentsMap: { s1: [], s2: [] },
        handleSessionSelect: mockHandleSessionSelect
      });
    });

    render(<App />);
    
    const chat2Link = screen.getAllByText('Chat 2')[0];
    fireEvent.click(chat2Link);

    expect(mockHandleSessionSelect).toHaveBeenCalled();
  });

  it('renders sidebar', () => {
    render(<App />);
    const sidebar = document.querySelector('aside.sidebar');
    expect(sidebar).toBeInTheDocument();
  });

  it('renders chat header', () => {
    render(<App />);
    expect(document.querySelector('header.header')).toBeInTheDocument();
  });

  it('renders message list', () => {
    render(<App />);
    expect(document.querySelector('.message-list-wrapper')).toBeInTheDocument();
  });

  it('renders chat input', () => {
    render(<App />);
    expect(screen.getByPlaceholderText(/Send a message/i)).toBeInTheDocument();
  });

  it('has drag and drop handler on app container', () => {
    const { container } = render(<App />);
    const appContainer = container.querySelector('.app-container');
    expect(appContainer).toBeInTheDocument();
    // Verify drop handler works by firing a drop event
    const dropEvent = new Event('drop', { bubbles: true });
    Object.defineProperty(dropEvent, 'preventDefault', { value: vi.fn() });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: { files: [] } });
    appContainer!.dispatchEvent(dropEvent);
  });

  it('emits watch_session when activeSessionId changes', () => {
    act(() => {
      useChatStore.setState({
        sessions: [
          { id: 's1', name: 'Chat 1', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'acp-1' },
          { id: 's2', name: 'Chat 2', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'acp-2' }
        ],
        activeSessionId: 's1',
        inputs: { s1: '', s2: '' },
        attachmentsMap: { s1: [], s2: [] },
        handleSessionSelect: vi.fn(),
        checkPendingPrompts: vi.fn()
      });
    });

    render(<App />);
    mockEmit.mockClear();

    act(() => { useChatStore.setState({ activeSessionId: 's2' }); });

    const watchCalls = mockEmit.mock.calls.filter(([e]: any) => e === 'watch_session');
    expect(watchCalls.some(([, arg]: any) => arg.sessionId === 'acp-2')).toBe(true);
  });

  it('emits unwatch_session for previous session on switch', () => {
    act(() => {
      useChatStore.setState({
        sessions: [
          { id: 's1', name: 'Chat 1', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'acp-1' },
          { id: 's2', name: 'Chat 2', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'acp-2' }
        ],
        activeSessionId: 's1',
        inputs: { s1: '', s2: '' },
        attachmentsMap: { s1: [], s2: [] },
        handleSessionSelect: vi.fn(),
        checkPendingPrompts: vi.fn()
      });
    });

    render(<App />);
    mockEmit.mockClear();

    act(() => { useChatStore.setState({ activeSessionId: 's2' }); });

    const unwatchCalls = mockEmit.mock.calls.filter(([e]: any) => e === 'unwatch_session');
    expect(unwatchCalls.some(([, arg]: any) => arg.sessionId === 'acp-1')).toBe(true);
  });

  it('shows empty state when no session is selected', () => {
    act(() => {
      useChatStore.setState({ activeSessionId: null, sessions: [] });
    });
    const { container } = render(<App />);
    expect(container.querySelector('.empty-state')).toBeInTheDocument();
    expect(container.textContent).toContain('Select a chat or start a new one');
  });

  it('clicking main-content closes sidebar when sidebar is open and not pinned', () => {
    const setSidebarOpen = vi.fn();
    act(() => {
      useUIStore.setState({ isSidebarOpen: true, isSidebarPinned: false, setSidebarOpen });
    });
    const { container } = render(<App />);
    const mainContent = container.querySelector('.main-content')!;
    fireEvent.click(mainContent);
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('clicking main-content does NOT close sidebar when it is pinned', () => {
    const setSidebarOpen = vi.fn();
    act(() => {
      useUIStore.setState({ isSidebarOpen: true, isSidebarPinned: true, setSidebarOpen });
    });
    const { container } = render(<App />);
    const mainContent = container.querySelector('.main-content')!;
    fireEvent.click(mainContent);
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});
