 
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import NotesModal from '../components/NotesModal';
import { useSystemStore } from '../store/useSystemStore';
import { useUIStore } from '../store/useUIStore';
import { useChatStore } from '../store/useChatStore';

describe('NotesModal', () => {
  const mockSocket = {
    emit: vi.fn((event: string, ...args: any[]) => {
      if (event === 'get_notes') {
        const cb = args[1] || args[0];
        if (typeof cb === 'function') cb({ notes: '# Hello\nSome notes' });
      }
      if (event === 'save_notes') {
        const cb = args[1];
        if (typeof cb === 'function') cb({ success: true });
      }
    }),
    on: vi.fn(),
    off: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any });
      useChatStore.setState({ activeSessionId: 's1', sessionNotes: {} });
      useUIStore.setState({ isNotesOpen: true });
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it('renders when open', () => {
    render(<NotesModal />);
    expect(screen.getByText('Scratch Pad')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    act(() => { useUIStore.setState({ isNotesOpen: false }); });
    const { container } = render(<NotesModal />);
    expect(container.innerHTML).toBe('');
  });

  it('loads notes on open', () => {
    render(<NotesModal />);
    expect(mockSocket.emit).toHaveBeenCalledWith('get_notes', { sessionId: 's1' }, expect.any(Function));
  });

  it('shows raw tab with textarea by default', () => {
    render(<NotesModal />);
    expect(screen.getByPlaceholderText(/Write notes here/)).toBeInTheDocument();
  });

  it('switches to rendered tab and shows markdown', () => {
    render(<NotesModal />);
    fireEvent.click(screen.getByText('Rendered'));
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('auto-saves on change after debounce', () => {
    render(<NotesModal />);
    const textarea = screen.getByPlaceholderText(/Write notes here/);
    fireEvent.change(textarea, { target: { value: 'Updated notes' } });

    // Not saved yet
    expect(mockSocket.emit).not.toHaveBeenCalledWith('save_notes', expect.anything(), expect.anything());

    // After debounce
    act(() => { vi.advanceTimersByTime(600); });
    expect(mockSocket.emit).toHaveBeenCalledWith('save_notes', { sessionId: 's1', notes: 'Updated notes' });
  });

  it('updates sessionNotes on save', () => {
    render(<NotesModal />);
    const textarea = screen.getByPlaceholderText(/Write notes here/);
    fireEvent.change(textarea, { target: { value: 'Has content' } });
    act(() => { vi.advanceTimersByTime(600); });
    expect(useChatStore.getState().sessionNotes['s1']).toBe(true);
  });

  it('sets sessionNotes to false when cleared', () => {
    act(() => { useChatStore.setState({ sessionNotes: { s1: true } }); });
    render(<NotesModal />);
    const textarea = screen.getByPlaceholderText(/Write notes here/);
    fireEvent.change(textarea, { target: { value: '' } });
    act(() => { vi.advanceTimersByTime(600); });
    expect(useChatStore.getState().sessionNotes['s1']).toBe(false);
  });

  it('shows empty state in rendered tab when no notes', () => {
    mockSocket.emit.mockImplementation((event: string, ...args: any[]) => {
      if (event === 'get_notes') {
        const cb = args[1] || args[0];
        if (typeof cb === 'function') cb({ notes: '' });
      }
    });
    act(() => { useUIStore.setState({ isNotesOpen: false }); });
    act(() => { useUIStore.setState({ isNotesOpen: true }); });

    const { rerender } = render(<NotesModal />);
    rerender(<NotesModal />);
    fireEvent.click(screen.getByText('Rendered'));
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
  });
});



describe('NotesModal - additional', () => {
  const mockSocket = {
    emit: vi.fn((event: string, ...args: any[]) => {
      if (event === 'get_notes') {
        const cb = args[1] || args[0];
        if (typeof cb === 'function') cb({ notes: '```js\nconsole.log("hi")\n```' });
      }
    }),
    on: vi.fn(),
    off: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any });
      useChatStore.setState({ activeSessionId: 's1', sessionNotes: {} });
      useUIStore.setState({ isNotesOpen: true, setNotesOpen: vi.fn() });
    });
  });

  it('clicking outside the modal (on overlay) does NOT close it', () => {
    render(<NotesModal />);
    const overlay = document.querySelector('.modal-overlay')!;
    fireEvent.click(overlay);
    // Modal should still be visible — setNotesOpen(false) should NOT have been called
    expect(useUIStore.getState().setNotesOpen).not.toHaveBeenCalledWith(false);
    expect(screen.getByText('Scratch Pad')).toBeInTheDocument();
  });

  it('rendered tab shows syntax-highlighted code blocks', () => {
    render(<NotesModal />);
    fireEvent.click(screen.getByText('Rendered'));
    const highlighter = document.querySelector('.syntax-highlighter');
    expect(highlighter).toBeInTheDocument();
  });
});