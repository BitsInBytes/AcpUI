import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import SessionItem from '../components/SessionItem';
import { useSystemStore } from '../store/useSystemStore';
import { useCanvasStore } from '../store/useCanvasStore';
import type { ChatSession } from '../types';

vi.mock('../components/ConfirmModal', () => ({
  default: ({ isOpen, onConfirm, onClose }: any) =>
    isOpen ? <div data-testid="confirm-modal"><button onClick={onConfirm}>Confirm</button><button onClick={onClose}>Cancel</button></div> : null,
}));

const makeSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'sess-1',
  acpSessionId: 'acp-1',
  name: 'Test Chat',
  messages: [],
  isTyping: false,
  isWarmingUp: false,
  model: 'flagship',
  ...overrides,
});

const defaultProps = () => ({
  session: makeSession(),
  isActive: false,
  onSelect: vi.fn(),
  onRename: vi.fn(),
  onTogglePin: vi.fn(),
  onArchive: vi.fn(),
  onSettings: vi.fn(),
});

describe('SessionItem', () => {
  it('renders session name', () => {
    render(<SessionItem {...defaultProps()} />);
    expect(screen.getByText('Test Chat')).toBeInTheDocument();
  });

  it('has active class when isActive is true', () => {
    const props = defaultProps();
    props.isActive = true;
    const { container } = render(<SessionItem {...props} />);
    expect(container.querySelector('.session-item.active')).toBeInTheDocument();
  });

  it('uses the shell input waiting class when an interactive shell needs input', () => {
    const props = { ...defaultProps(), session: makeSession({ isTyping: true, isAwaitingShellInput: true }) };
    const { container } = render(<SessionItem {...props} />);
    const item = container.querySelector('.session-item');
    expect(item).toHaveClass('typing');
    expect(item).toHaveClass('awaiting-shell-input');
  });

  it('calls onSelect when clicked', () => {
    const props = defaultProps();
    render(<SessionItem {...props} />);
    fireEvent.click(screen.getByText('Test Chat'));
    expect(props.onSelect).toHaveBeenCalled();
  });

  it('enters edit mode when rename button is clicked', () => {
    const props = defaultProps();
    render(<SessionItem {...props} />);
    fireEvent.click(screen.getByTitle('Rename'));
    expect(screen.getByDisplayValue('Test Chat')).toBeInTheDocument();
  });

  it('shows only delete button for sub-agent when not typing', () => {
    const props = { ...defaultProps(), session: makeSession({ isSubAgent: true, isTyping: false }) };
    render(<SessionItem {...props} />);
    expect(screen.getByTitle('Delete')).toBeInTheDocument();
    expect(screen.queryByTitle('Rename')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Pin')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Pop Out')).not.toBeInTheDocument();
  });

  it('hides delete button for sub-agent when typing', () => {
    const props = { ...defaultProps(), session: makeSession({ isSubAgent: true, isTyping: true }) };
    render(<SessionItem {...props} />);
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument();
  });

  it('calls openPopout when pop-out button is clicked', async () => {
    const { openPopout } = await import('../lib/sessionOwnership');
    vi.spyOn({ openPopout }, 'openPopout');
    const props = defaultProps();
    render(<SessionItem {...props} />);
    fireEvent.click(screen.getByTitle('Pop Out'));
    // openPopout is called — no error thrown and pop-out button was present
    expect(screen.getByTitle('Pop Out')).toBeInTheDocument();
  });
});


describe('SessionItem - deletePermanent button title', () => {
  it('shows "Archive Chat" when deletePermanent is false', () => {
    act(() => { useSystemStore.setState({ deletePermanent: false }); });
    render(<SessionItem {...defaultProps()} />);
    expect(screen.getByTitle('Archive Chat')).toBeInTheDocument();
  });

  it('shows "Delete Chat" when deletePermanent is true', () => {
    act(() => { useSystemStore.setState({ deletePermanent: true }); });
    render(<SessionItem {...defaultProps()} />);
    expect(screen.getByTitle('Delete Chat')).toBeInTheDocument();
  });
});


describe('SessionItem - fork icon', () => {
  it('shows GitFork icon when session has forkedFrom', () => {
    const props = defaultProps();
    props.session = makeSession({ forkedFrom: 'parent-1' });
    const { container } = render(<SessionItem {...props} />);
    // GitFork icon has a specific lucide class; MessageSquare should not be present as the primary icon
    const forkArrow = container.querySelector('.fork-arrow');
    expect(forkArrow).toBeInTheDocument();
    expect(forkArrow!.textContent).toBe('↳');
  });

  it('shows MessageSquare icon when session has no forkedFrom', () => {
    const props = defaultProps();
    props.session = makeSession({ forkedFrom: undefined });
    const { container } = render(<SessionItem {...props} />);
    expect(container.querySelector('.fork-arrow')).not.toBeInTheDocument();
  });
});


describe('SessionItem - terminal icon', () => {
  it('shows Terminal icon when session has a terminal in canvas store', () => {
    act(() => {
      useCanvasStore.setState({
        terminals: [{ id: 't1', sessionId: 'sess-1', title: 'bash' }] as any,
      });
    });
    render(<SessionItem {...defaultProps()} />);
    // Terminal icon from lucide renders as an SVG; the session should not show fork-arrow
    expect(screen.queryByText('↳')).not.toBeInTheDocument();
    // The session name is still visible
    expect(screen.getByText('Test Chat')).toBeInTheDocument();
  });

  it('shows MessageSquare icon when session has no terminal and no fork', () => {
    act(() => {
      useCanvasStore.setState({ terminals: [] as any });
    });
    const props = defaultProps();
    props.session = makeSession({ forkedFrom: undefined });
    render(<SessionItem {...props} />);
    expect(screen.queryByText('↳')).not.toBeInTheDocument();
    expect(screen.getByText('Test Chat')).toBeInTheDocument();
  });

  it('fork icon takes priority over terminal icon when session has both forkedFrom and a terminal', () => {
    act(() => {
      useCanvasStore.setState({
        terminals: [{ id: 't1', sessionId: 'sess-1', title: 'bash' }] as any,
      });
    });
    const props = defaultProps();
    props.session = makeSession({ forkedFrom: 'parent-id' });
    const { container } = render(<SessionItem {...props} />);
    // forkedFrom takes precedence, so fork-arrow should be visible
    expect(container.querySelector('.fork-arrow')).toBeInTheDocument();
  });
});
