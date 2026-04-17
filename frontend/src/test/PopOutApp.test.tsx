import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useChatStore } from '../store/useChatStore';
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

beforeEach(async () => {
  vi.clearAllMocks();
  document.title = '';
  socketToReturn = null;

  vi.resetModules();
  const mod = await import('../PopOutApp');
  PopOutApp = mod.default;

  act(() => {
    useChatStore.setState({
      sessions: [],
      activeSessionId: null,
      inputs: {},
      attachmentsMap: {},
      checkPendingPrompts: vi.fn()
    });
    useCanvasStore.setState({
      isCanvasOpen: false,
      canvasArtifacts: [],
      activeCanvasArtifact: null,
      canvasOpenBySession: {},
      terminals: []
    });
    useUIStore.setState({ visibleCount: 50 });
  });
});

describe('PopOutApp', () => {
  it('renders loading state initially', () => {
    render(<PopOutApp />);
    expect(screen.getByText('Loading session...')).toBeInTheDocument();
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
});
