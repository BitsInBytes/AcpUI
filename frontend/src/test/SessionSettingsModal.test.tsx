import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import SessionSettingsModal from '../components/SessionSettingsModal';
import { useUIStore } from '../store/useUIStore';
import { useChatStore } from '../store/useChatStore';
import { useSystemStore } from '../store/useSystemStore';

vi.mock('framer-motion', () => ({
  motion: { div: ({ children, ...props }: any) => <div {...props}>{children}</div> },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

const mockSession = {
  id: 'ui-1',
  acpSessionId: 'acp-1',
  name: 'Test Session',
  messages: [],
  isTyping: false,
  isWarmingUp: false,
  model: 'balanced' as const,
};

describe('SessionSettingsModal', () => {
  beforeEach(() => {
    const mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any });
      useChatStore.setState({
        sessions: [mockSession],
        handleDeleteSession: vi.fn(),
        handleUpdateModel: vi.fn(),
      } as any);
      useUIStore.setState({ isSettingsOpen: true, settingsSessionId: 'ui-1' });
    });
  });

  it('renders when open with session', () => {
    render(<SessionSettingsModal />);
    expect(screen.getByText('Session Settings')).toBeInTheDocument();
  });

  it('shows session info tab by default', () => {
    render(<SessionSettingsModal />);
    expect(screen.getByText('System Discovery')).toBeInTheDocument();
    expect(screen.getByText('Context Usage')).toBeInTheDocument();
  });

  it('shows ACP session ID', () => {
    render(<SessionSettingsModal />);
    expect(screen.getByText('acp-1')).toBeInTheDocument();
  });

  it('switches to export tab', () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Export'));
    expect(screen.getByText('Export Session')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/exports/i)).toBeInTheDocument();
  });

  it('switches to rehydrate tab', () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Rehydrate'));
    expect(screen.getByText('Rehydrate from JSONL')).toBeInTheDocument();
    expect(screen.getByText('Rebuild from JSONL')).toBeInTheDocument();
  });

  it('switches to config tab and shows model selector', () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Config'));
    expect(screen.getByText('Model Selection')).toBeInTheDocument();
  });

  it('switches to danger tab and shows delete button', () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
    expect(screen.getByText('Delete Chat')).toBeInTheDocument();
  });

  it('shows confirm delete after clicking Delete Chat', () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Delete Chat'));
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    expect(screen.getByText('Yes, Delete')).toBeInTheDocument();
  });

  it('closes modal when Done clicked', () => {
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Done'));
    expect(useUIStore.getState().isSettingsOpen).toBe(false);
  });

  it('closes modal when overlay clicked', () => {
    const { container } = render(<SessionSettingsModal />);
    fireEvent.click(container.querySelector('.modal-overlay')!);
    expect(useUIStore.getState().isSettingsOpen).toBe(false);
  });

  it('returns null when no session found', () => {
    act(() => { useUIStore.setState({ settingsSessionId: 'nonexistent' }); });
    const { container } = render(<SessionSettingsModal />);
    expect(container.innerHTML).toBe('');
  });

  it('export action button is disabled when path is empty', () => {
    const { container } = render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Export'));
    const exportBtn = container.querySelector('.modal-body .done-button') as HTMLButtonElement;
    expect(exportBtn).toBeDisabled();
  });

  it('export action button is enabled when path is provided', () => {
    const { container } = render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Export'));
    fireEvent.change(screen.getByPlaceholderText(/exports/i), { target: { value: 'C:\\exports' } });
    const exportBtn = container.querySelector('.modal-body .done-button') as HTMLButtonElement;
    expect(exportBtn).not.toBeDisabled();
  });

  it('rehydrate button calls socket emit', () => {
    const mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    act(() => { useSystemStore.setState({ socket: mockSocket as any }); });
    render(<SessionSettingsModal />);
    fireEvent.click(screen.getByText('Rehydrate'));
    fireEvent.click(screen.getByText('Rebuild from JSONL'));
    expect(mockSocket.emit).toHaveBeenCalledWith('rehydrate_session', { uiId: 'ui-1' }, expect.any(Function));
  });
});
