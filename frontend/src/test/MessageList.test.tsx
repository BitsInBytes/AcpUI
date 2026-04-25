import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MessageList from '../components/MessageList/MessageList';
import { useChatStore } from '../store/useChatStore';
import { useUIStore } from '../store/useUIStore';

describe('MessageList', () => {
  const mockActiveSession = {
    id: '1',
    acpSessionId: 'acp-1',
    name: 'Test Chat',
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    isTyping: false,
    isWarmingUp: false,
    model: 'balanced'
  };

  const defaultProps = {
    scrollRef: { current: null } as any,
    handleScroll: vi.fn(),
    handleWheel: vi.fn(),
    showScrollButton: false,
    handleBackToBottom: vi.fn()
  };

  beforeEach(() => {
    useChatStore.setState({
      sessions: [mockActiveSession] as any,
      activeSessionId: '1'
    });
    useUIStore.setState({
      visibleCount: 3
    });
  });

  it('renders empty state when no messages', () => {
    useChatStore.setState({
      sessions: [{ ...mockActiveSession, messages: [] }] as any
    });
    render(<MessageList {...defaultProps} />);
    expect(screen.getByText('New Conversation')).toBeInTheDocument();
  });

  it('renders messages via HistoryList when available', () => {
    render(<MessageList {...defaultProps} />);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('shows load more button when hasMoreMessages is true', () => {
    // Session has 5 messages, visible count is 3. 5 > 3 should be true.
    useChatStore.setState({
      sessions: [{ 
        ...mockActiveSession, 
        messages: [
          {id: '1', role: 'user', content: 'a'},
          {id: '2', role: 'user', content: 'b'},
          {id: '3', role: 'user', content: 'c'},
          {id: '4', role: 'user', content: 'd'},
          {id: '5', role: 'user', content: 'e'}
        ] 
      }] as any
    });
    useUIStore.setState({ visibleCount: 3 });

    render(<MessageList {...defaultProps} />);
    expect(screen.getByText('Load previous messages...')).toBeInTheDocument();
  });

  it('increments visible count when load more is clicked', () => {
    useChatStore.setState({
      sessions: [{ 
        ...mockActiveSession, 
        messages: new Array(10).fill(0).map((_, i) => ({ id: `m${i}`, role: 'user', content: `m${i}` }))
      }] as any
    });
    useUIStore.setState({ visibleCount: 3 });

    render(<MessageList {...defaultProps} />);
    fireEvent.click(screen.getByText('Load previous messages...'));
    expect(useUIStore.getState().visibleCount).toBe(13);
  });

  it('shows scroll to bottom button when showScrollButton is true', () => {
    render(<MessageList {...defaultProps} showScrollButton={true} />);
    expect(screen.getByTitle('Scroll to bottom')).toBeInTheDocument();
  });

  it('calls handleBackToBottom when scroll button is clicked', () => {
    render(<MessageList {...defaultProps} showScrollButton={true} />);
    fireEvent.click(screen.getByTitle('Scroll to bottom'));
    expect(defaultProps.handleBackToBottom).toHaveBeenCalled();
  });

  it('renders null when there is no active session', () => {
    useChatStore.setState({ sessions: [], activeSessionId: null });
    const { container } = render(<MessageList {...defaultProps} />);
    expect(container.firstChild).toBeNull();
  });
});
