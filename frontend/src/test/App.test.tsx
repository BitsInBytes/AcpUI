import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Mock browser APIs
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: {
    enumerateDevices: vi.fn().mockResolvedValue([]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  configurable: true
});

// Mock components to simplify App testing - MUST be before App import
vi.mock('../components/Sidebar', () => ({ default: () => <div data-testid="sidebar">Sidebar</div> }));
vi.mock('../components/ChatHeader/ChatHeader', () => ({ default: () => <div data-testid="chat-header">ChatHeader</div> }));
vi.mock('../components/MessageList/MessageList', () => ({ default: () => <div data-testid="message-list">MessageList</div> }));
vi.mock('../components/ChatInput/ChatInput', () => ({ default: () => <div data-testid="chat-input">ChatInput</div> }));
vi.mock('../components/SessionSettingsModal', () => ({ default: () => null }));
vi.mock('../components/SystemSettingsModal', () => ({ default: () => null }));
vi.mock('../components/NotesModal', () => ({ default: () => null }));
vi.mock('../components/FileExplorer', () => ({ default: () => null }));
vi.mock('../components/CanvasPane/CanvasPane', () => ({ default: () => <div data-testid="canvas-pane">Canvas</div> }));

vi.mock('../hooks/useSocket', () => ({
  useSocket: () => ({ socket: useSystemStore.getState().socket })
}));

vi.mock('../hooks/useChatManager', () => ({ useChatManager: vi.fn() }));
vi.mock('../hooks/useScroll', () => ({
  useScroll: () => ({
    scrollRef: { current: null },
    showScrollButton: false,
    scrollToBottom: vi.fn(),
    handleScroll: vi.fn(),
    handleWheel: vi.fn()
  })
}));

import App from '../App';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useInputStore } from '../store/useInputStore';
import { useUIStore } from '../store/useUIStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { useCanvasStore } from '../store/useCanvasStore';

describe('App Component', () => {
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
      useSystemStore.setState({ socket: mockSocket as any, connected: true, isEngineReady: true, invalidJsonConfigs: [] });
      useSessionLifecycleStore.setState({ 
        sessions: [
          { id: 's1', name: 'Chat 1', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'a1' },
          { id: 's2', name: 'Chat 2', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'a2' }
        ],
        activeSessionId: 's1',
        checkPendingPrompts: vi.fn() 
      });
      useInputStore.setState({
        inputs: { s1: '', s2: '' },
        attachmentsMap: { s1: [], s2: [] }
      });
      useVoiceStore.setState({ isRecording: false, isProcessingVoice: false, availableAudioDevices: [], selectedAudioDevice: '' });
      useUIStore.setState({ isSidebarOpen: true, isModelDropdownOpen: false, isSidebarPinned: false });
      useCanvasStore.setState({ isCanvasOpen: false, canvasArtifacts: [], canvasOpenBySession: {}, terminals: [] });
    });
  });

  it('renders Sidebar and ChatInput', () => {
    render(<App />);
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  it('renders the config error modal from root state', () => {
    act(() => {
      useSystemStore.setState({
        invalidJsonConfigs: [
          { id: 'commands-config', label: 'Custom commands configuration', path: 'commands.json', message: 'Invalid JSON' }
        ]
      });
    });

    render(<App />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Custom commands configuration')).toBeInTheDocument();
  });

  it('switches between sessions and emits watch events', async () => {
    render(<App />);
    
    // Initial render should have watched a1
    expect(mockSocket.emit).toHaveBeenCalledWith('watch_session', { sessionId: 'a1' });

    await act(async () => {
      useSessionLifecycleStore.getState().setActiveSessionId('s2');
    });

    expect(mockSocket.emit).toHaveBeenCalledWith('unwatch_session', { sessionId: 'a1' });
    expect(mockSocket.emit).toHaveBeenCalledWith('watch_session', { sessionId: 'a2' });
  });

  it('toggles sidebar when clicking bubble', () => {
    act(() => {
      useUIStore.setState({ isSidebarOpen: false });
    });
    render(<App />);
    const openBtn = screen.getAllByTitle('Open Sidebar').find(el => el.className.includes('open-sidebar-bubble'))!;
    fireEvent.click(openBtn);
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
  });

  it('handles file drop', () => {
    const handleFileUpload = vi.fn();
    act(() => {
      useInputStore.setState({ handleFileUpload });
    });
    const { container } = render(<App />);
    const app = container.firstChild!;
    
    const file = new File(['test'], 'test.txt');
    const dropEvent = new CustomEvent('drop', { bubbles: true }) as any;
    dropEvent.dataTransfer = { files: [file] };
    dropEvent.preventDefault = vi.fn();
    
    fireEvent(app, dropEvent);
    expect(handleFileUpload).toHaveBeenCalledWith(expect.anything(), 's1');
  });

  describe('Canvas and Resizing', () => {
    it('persists canvas open state per session', async () => {
      const setIsCanvasOpen = vi.fn();
      act(() => { useCanvasStore.setState({ setIsCanvasOpen, canvasOpenBySession: { s1: true, s2: false } }); });
      
      render(<App />);

      // Switch to s2
      await act(async () => {
        useSessionLifecycleStore.getState().setActiveSessionId('s2');
      });

      // s2 had false in canvasOpenBySession
      expect(setIsCanvasOpen).toHaveBeenCalledWith(false);
    });

    it('auto-opens canvas for plans when awaiting permission', async () => {
      const setIsCanvasOpen = vi.fn();
      act(() => { 
        useCanvasStore.setState({ 
          setIsCanvasOpen, 
          isCanvasOpen: false,
          canvasArtifacts: [{ title: 'plan.md', content: '...', type: 'file' } as any]
        });
        useSessionLifecycleStore.setState({
            sessions: [{ id: 's1', isAwaitingPermission: true, acpSessionId: 'a1', messages: [], model: 'balanced', name: 'Chat', isTyping: false, isWarmingUp: false }],
            activeSessionId: 's1'
        });
      });

      render(<App />);
      expect(setIsCanvasOpen).toHaveBeenCalledWith(true);
    });

    it('handles resize handle mouse events', () => {
       act(() => { useCanvasStore.setState({ isCanvasOpen: true }); });
       const { container } = render(<App />);

       const handle = container.querySelector('.canvas-resize-handle')!;
       expect(handle).toBeInTheDocument();

       act(() => {
         fireEvent.mouseDown(handle, { clientX: 500 });

         const moveEvent = new MouseEvent('mousemove', { clientX: 600, bubbles: true });
         document.dispatchEvent(moveEvent);

         const upEvent = new MouseEvent('mouseup', { bubbles: true });
         document.dispatchEvent(upEvent);
       });

       // Success is just not throwing and exercising the event listeners
    });
  });
});
