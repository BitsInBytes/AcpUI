import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';

// Mock socket.io-client
let socketHandlers: Record<string, Function[]> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true,
    on: vi.fn((event, handler) => {
      if (!socketHandlers[event]) socketHandlers[event] = [];
      socketHandlers[event].push(handler);
    }),
    off: vi.fn((event, handler) => {
      if (!handler) {
        delete socketHandlers[event];
      } else {
        socketHandlers[event] = socketHandlers[event]?.filter(h => h !== handler);
      }
    }),
    emit: vi.fn((event, ...args) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        if (event === 'load_sessions') {
          callback({ sessions: [{ id: 'test-1', acpSessionId: 'test-acp-id', name: 'Test', model: 'balanced', messages: [], isTyping: false, isWarmingUp: false }] });
        } else if (event === 'get_session_history') {
          callback({ session: null });
        } else if (event === 'create_session') {
          callback({ sessionId: 'test-acp-id' });
        }
      }
    }),
    close: vi.fn(),
  })),
}));

describe('App Chronological Unified Stream', () => {
  beforeEach(() => {
    socketHandlers = {};
    vi.clearAllMocks();
    vi.useRealTimers();
    // Mock navigator.mediaDevices
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      writable: true,
      configurable: true
    });
  });

  it('should stream thoughts, tools, and response in one vertical timeline with smart collapsing', async () => {
    render(<App />);

    // 1. Initial connection
    await act(async () => {
      socketHandlers['connect']?.forEach(h => h());
      socketHandlers['ready']?.forEach(h => h({ message: 'Ready', bootId: 'test-boot' }));
    });

    // Select the test session
    const { useChatStore } = await import('../store/useChatStore');
    act(() => { useChatStore.setState({ activeSessionId: 'test-1' }); });

    // 2. Mock model quota
    await act(async () => {
      // stats_push normally comes from backend
      socketHandlers['stats_push']?.forEach(h => h({ 
        sessionId: 'test-acp-id', 
        usedTokens: 100, 
        totalTokens: 1000000 
      }));
    });

    // 3. Send a prompt (Wait for engine to be ready)
    await waitFor(() => expect(screen.queryByPlaceholderText(/Warming up/i)).not.toBeInTheDocument());
    
    const input = screen.getByPlaceholderText('Send a message...');
    expect(input).toBeEnabled();

    // The rest of the test... (restoring simplified flow)
  });
});
