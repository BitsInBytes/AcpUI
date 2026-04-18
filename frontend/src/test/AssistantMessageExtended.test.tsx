import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AssistantMessage from '../components/AssistantMessage';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useChatStore } from '../store/useChatStore';

// Mock child components
vi.mock('../components/MemoizedMarkdown', () => ({ default: ({ content }: any) => <div className="message-content">{content}</div> }));
vi.mock('../components/ToolStep', () => ({ default: ({ step, isCollapsed, onToggle }: any) => (
  <div data-testid="tool-step">
    {step.event.title}
    <button onClick={onToggle}>{isCollapsed ? 'Expand' : 'Collapse'}</button>
  </div>
) }));
vi.mock('../components/PermissionStep', () => ({ default: ({ step, onRespond }: any) => (
  <div data-testid="permission-step">
    Permission: {step.request.id}
    <button onClick={() => onRespond(step.request.id, 'allow', step.request.toolCall.toolCallId)}>Allow</button>
  </div>
) }));

const makeMessage = (overrides = {}) => ({
  id: 'm1',
  role: 'assistant' as const,
  content: 'Hello',
  ...overrides
});

const defaultProps = (overrides = {}) => ({
  message: makeMessage(),
  acpSessionId: 'a1',
  isStreaming: false,
  timeline: [],
  localCollapsed: {},
  toggleCollapse: vi.fn(),
  markdownComponents: {},
  ...overrides
});

describe('AssistantMessage Component (extended)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ 
        socket: { emit: vi.fn() } as any,
        branding: { assistantName: 'Assistant' } 
      } as any);
      useSessionLifecycleStore.setState({ activeSessionId: 's1', sessions: [{ id: 's1', acpSessionId: 'a1', messages: [makeMessage()] } as any] });
    });
  });

  it('renders correctly with multiple timeline steps', () => {
    const timeline: any[] = [
      { type: 'thought', content: 'thinking' },
      { type: 'tool', event: { title: 'tool 1' } },
      { type: 'text', content: 'actual text' }
    ];
    render(<AssistantMessage {...defaultProps({ timeline })} />);
    expect(screen.getByText('Thinking Process')).toBeInTheDocument();
    expect(screen.getByTestId('tool-step')).toBeInTheDocument();
    expect(screen.getByText('actual text')).toBeInTheDocument();
  });

  it('handles copy button click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    });

    render(<AssistantMessage {...defaultProps({ message: makeMessage({ content: 'Copy me' }) })} />);
    const copyBtn = screen.getByTitle('Copy full response');
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(writeText).toHaveBeenCalledWith('Copy me');
  });

  it('handles fork button click', () => {
    const handleFork = vi.fn();
    act(() => {
      useChatStore.setState({ handleForkSession: handleFork });
    });

    render(<AssistantMessage {...defaultProps({ message: makeMessage({ id: 'm1' }) })} />);
    const forkBtn = screen.getByTitle('Fork conversation from here');
    fireEvent.click(forkBtn);
    expect(handleFork).toHaveBeenCalled();
  });

  it('renders permission step and handles response', () => {
    const handleRespond = vi.fn();
    act(() => {
      useChatStore.setState({ handleRespondPermission: handleRespond });
    });

    const timeline: any[] = [{ type: 'permission', request: { id: 42, toolCall: { toolCallId: 't1' } } }];
    render(<AssistantMessage {...defaultProps({ timeline })} />);
    
    expect(screen.getByTestId('permission-step')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Allow'));
    expect(handleRespond).toHaveBeenCalledWith(expect.anything(), 42, 'allow', 't1', 'a1');
  });

  it('shows error messages with special box', () => {
    const content = ':::ERROR:::\nSomething went wrong\n:::END_ERROR:::';
    render(<AssistantMessage {...defaultProps({ message: makeMessage({ content }), timeline: [{ type: 'text', content }] as any })} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(document.querySelector('.error-message-box')).toBeInTheDocument();
  });

  it('hides fork button for sub-agents', () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ id: 's1', isSubAgent: true } as any] });
    });
    render(<AssistantMessage {...defaultProps()} />);
    expect(screen.queryByTitle('Fork conversation from here')).not.toBeInTheDocument();
  });
});
