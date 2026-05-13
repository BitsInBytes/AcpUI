import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useInputStore } from '../store/useInputStore';
import { useCanvasStore } from '../store/useCanvasStore';
import { useUIStore } from '../store/useUIStore';

// Socket mock - default null to avoid triggering the init useEffect
let socketToReturn: any = null;
vi.mock('../hooks/useSocket', () => ({
  useSocket: () => ({ socket: socketToReturn })
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

vi.mock('../lib/sessionOwnership', () => ({
  claimSession: vi.fn(),
  releaseSession: vi.fn(),
  isSessionPoppedOut: vi.fn(() => false),
  setOwnershipChangeCallback: vi.fn()
}));

vi.mock('../components/ChatHeader/ChatHeader', () => ({ default: () => <div data-testid="chat-header">ChatHeader</div> }));
vi.mock('../components/MessageList/MessageList', () => ({ default: () => <div data-testid="message-list">MessageList</div> }));
vi.mock('../components/ChatInput/ChatInput', () => ({ default: () => <div data-testid="chat-input">ChatInput</div> }));
vi.mock('../components/CanvasPane/CanvasPane', () => ({ default: () => <div data-testid="canvas-pane">CanvasPane</div> }));

// Set popout query param
Object.defineProperty(window, 'location', {
  value: { ...window.location, search: '?popout=pop-1', hostname: 'localhost', protocol: 'http:', href: 'http://localhost?popout=pop-1' },
  writable: true
});

// BroadcastChannel mock
class MockBroadcastChannel {
  postMessage = vi.fn();
  close = vi.fn();
  onmessage: any = null;
  constructor() {}
}
(globalThis as any).BroadcastChannel = MockBroadcastChannel as any;

let PopOutApp: typeof import('../PopOutApp').default;
let sessionStore: any;
let systemStore: any;

beforeEach(async () => {
  vi.clearAllMocks();
  document.title = '';
  socketToReturn = null;

  vi.resetModules();
  const mod = await import('../PopOutApp');
  PopOutApp = mod.default;
  
  const storeMod = await import('../store/useSessionLifecycleStore');
  sessionStore = storeMod.useSessionLifecycleStore;
  const systemStoreMod = await import('../store/useSystemStore');
  systemStore = systemStoreMod.useSystemStore;

  act(() => {
    sessionStore.setState({ 
      sessions: [],
      activeSessionId: null,
      checkPendingPrompts: vi.fn() 
    });
    useInputStore.setState({
      inputs: {},
      attachmentsMap: {}
    });
    useCanvasStore.setState({
      isCanvasOpen: false,
      canvasArtifacts: [],
      activeCanvasArtifact: null,
      canvasOpenBySession: {},
      terminals: []
    });
    useUIStore.setState({ visibleCount: 50 });
    systemStore.setState({ invalidJsonConfigs: [] });
  });
});

describe('PopOutApp', () => {
  it('renders loading state initially', () => {
    render(<PopOutApp />);
    expect(screen.getByText('Loading session...')).toBeInTheDocument();
  });

  it('renders the config error modal while loading', () => {
    act(() => {
      systemStore.setState({
        invalidJsonConfigs: [
          { id: 'provider-registry', label: 'Provider registry', path: 'providers.json', message: 'Invalid JSON' }
        ]
      });
    });

    render(<PopOutApp />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Provider registry')).toBeInTheDocument();
  });

  it('renders ChatHeader and ChatInput when ready', async () => {
    vi.useFakeTimers();

    socketToReturn = {
      on: vi.fn(), off: vi.fn(), connected: true, close: vi.fn(),
      emit: vi.fn((event: string, ...args: any[]) => {
        if (event === 'load_sessions') {
          const cb = args[0];
          setTimeout(() => cb({
            sessions: [{ id: 'pop-1', name: 'Test Session', messages: [], model: 'balanced', acpSessionId: null }]
          }), 0);
        }
      })
    };

    render(<PopOutApp />);
    await act(async () => { vi.advanceTimersByTime(10); });

    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('does NOT render Sidebar', () => {
    render(<PopOutApp />);
    const sidebar = document.querySelector('aside.sidebar');
    expect(sidebar).not.toBeInTheDocument();
  });

  it('sets document.title with session name when ready', async () => {
    vi.useFakeTimers();

    socketToReturn = {
      on: vi.fn(), off: vi.fn(), connected: true, close: vi.fn(),
      emit: vi.fn((event: string, ...args: any[]) => {
        if (event === 'load_sessions') {
          const cb = args[0];
          setTimeout(() => cb({
            sessions: [{ id: 'pop-1', name: 'My Chat', messages: [], model: 'balanced', acpSessionId: null }]
          }), 0);
        }
      })
    };

    render(<PopOutApp />);
    await act(async () => { vi.advanceTimersByTime(10); });

    expect(document.title).toBe('My Chat — Pop Out');

    vi.useRealTimers();
  });

  it('hydrates session and emits watch_session when ready', async () => {
    const hydrateSession = vi.fn();
    vi.useFakeTimers();

    socketToReturn = {
      on: vi.fn(), off: vi.fn(), connected: true, close: vi.fn(),
      emit: vi.fn((event: string, ...args: any[]) => {
        if (event === 'load_sessions') {
          const cb = args[0];
          cb({
            sessions: [{ id: 'pop-1', name: 'Chat', messages: [], model: 'balanced', acpSessionId: 'acp-pop' }]
          });
        }
      })
    };

    act(() => { sessionStore.setState({ hydrateSession }); });

    render(<PopOutApp />);
    await act(async () => { 
        vi.runAllTimers(); 
    });

    expect(socketToReturn.emit).toHaveBeenCalledWith('watch_session', { sessionId: 'acp-pop' });
    expect(hydrateSession).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('claims session ownership on mount', async () => {
     const { claimSession } = await import('../lib/sessionOwnership');
     socketToReturn = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
     render(<PopOutApp />);
     expect(claimSession).toHaveBeenCalledWith('pop-1');
  });
});
