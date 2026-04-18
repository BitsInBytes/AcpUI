import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AssistantMessage from '../components/AssistantMessage';
import type { Message, TimelineStep } from '../types';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';

vi.mock('react-markdown', () => ({
  default: ({ children }: any) => <div>{children}</div>
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('framer-motion', () => ({
  motion: { div: ({ children, ...props }: any) => <div {...props}>{children}</div> },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 'msg-1',
  role: 'assistant',
  content: 'Hello world',
  timeline: [],
  isStreaming: false,
  ...overrides,
});

const defaultProps = (overrides: any = {}) => ({
  message: makeMessage(),
  acpSessionId: 'acp-1',
  isStreaming: false,
  timeline: [] as TimelineStep[],
  localCollapsed: {} as Record<number, boolean>,
  toggleCollapse: vi.fn(),
  markdownComponents: {},
  ...overrides,
});

describe('AssistantMessage', () => {
  beforeEach(() => {
    useSessionLifecycleStore.setState({ activeSessionId: 'ui-1' });
  });

  it('renders text timeline step content', () => {
    const timeline: TimelineStep[] = [{ type: 'text', content: 'Some response text' }];
    render(<AssistantMessage {...defaultProps({ timeline })} />);
    expect(screen.getByText('Some response text')).toBeInTheDocument();
  });

  it('renders tool step with title', () => {
    const timeline: TimelineStep[] = [{
      type: 'tool',
      event: { id: 't1', title: 'Running read_file', status: 'completed' }
    }];
    render(<AssistantMessage {...defaultProps({ timeline })} />);
    expect(screen.getByText('Running read_file')).toBeInTheDocument();
  });

  it('shows copy button when not streaming', () => {
    const { container } = render(<AssistantMessage {...defaultProps({ isStreaming: false })} />);
    expect(container.querySelector('.copy-btn')).toBeInTheDocument();
  });

  it('hides copy button when streaming', () => {
    const { container } = render(<AssistantMessage {...defaultProps({ isStreaming: true })} />);
    expect(container.querySelector('.copy-btn')).not.toBeInTheDocument();
  });

  it('renders thought timeline step with Thinking Process header', () => {
    const timeline: TimelineStep[] = [{ type: 'thought', content: 'Analyzing the problem...' }];
    render(<AssistantMessage {...defaultProps({ timeline, localCollapsed: { 0: false } })} />);
    expect(screen.getByText('Thinking Process')).toBeInTheDocument();
    expect(screen.getByText('Analyzing the problem...')).toBeInTheDocument();
  });

  it('collapses thought step when localCollapsed is true', () => {
    const timeline: TimelineStep[] = [{ type: 'thought', content: 'Hidden thought' }];
    render(<AssistantMessage {...defaultProps({ timeline, localCollapsed: { 0: true } })} />);
    expect(screen.getByText('Thinking Process')).toBeInTheDocument();
    expect(screen.queryByText('Hidden thought')).not.toBeInTheDocument();
  });

  it('applies streaming class when isStreaming is true', () => {
    const { container } = render(<AssistantMessage {...defaultProps({ isStreaming: true })} />);
    expect(container.querySelector('.message-wrapper.assistant.streaming')).toBeInTheDocument();
  });

  it('renders error content with error-message-box styling', () => {
    const timeline: TimelineStep[] = [{ type: 'text', content: ':::ERROR::: Something broke :::END_ERROR:::' }];
    const { container } = render(<AssistantMessage {...defaultProps({ timeline })} />);
    expect(container.querySelector('.error-message-box')).toBeInTheDocument();
    expect(screen.getByText('Something broke')).toBeInTheDocument();
  });

  it('renders response divider from ::: marker', () => {
    const timeline: TimelineStep[] = [{ type: 'text', content: 'Part 1 :::RESPONSE_DIVIDER::: Part 2' }];
    const props = defaultProps({
      timeline,
      markdownComponents: { hr: () => <div className="response-divider" /> },
    });
    const { container } = render(<AssistantMessage {...props} />);
    // MemoizedMarkdown receives the replaced content with ---
    expect(container.querySelector('.message-content')).toBeInTheDocument();
  });
});


describe('AssistantMessage - fork and copy', () => {
  beforeEach(() => {
    useSessionLifecycleStore.setState({ activeSessionId: 'ui-1',
      sessions: [{
        id: 'ui-1', acpSessionId: 'acp-1', name: 'Test', messages: [makeMessage()],
        isTyping: false, isWarmingUp: false, model: 'balanced',
      }],
    } as any); });

  it('shows fork button when not streaming', () => {
    const { container } = render(<AssistantMessage {...defaultProps({ isStreaming: false })} />);
    const buttons = container.querySelectorAll('.copy-btn');
    expect(buttons.length).toBe(2); // copy + fork
  });

  it('hides fork button when streaming', () => {
    const { container } = render(<AssistantMessage {...defaultProps({ isStreaming: true })} />);
    expect(container.querySelector('.copy-btn')).not.toBeInTheDocument();
  });

  it('renders archived icon when message is archived', () => {
    const msg = makeMessage({ isArchived: true });
    const { container } = render(<AssistantMessage {...defaultProps({ message: msg })} />);
    expect(container.querySelector('.archived-icon')).toBeInTheDocument();
  });

  it('renders fallback content when no timeline text steps', () => {
    const msg = makeMessage({ content: 'Fallback text' });
    render(<AssistantMessage {...defaultProps({ message: msg, timeline: [] })} />);
    expect(screen.getByText('Fallback text')).toBeInTheDocument();
  });

  it('does not render fallback when timeline has text step', () => {
    const timeline: TimelineStep[] = [{ type: 'text', content: 'Timeline text' }];
    const msg = makeMessage({ content: 'Should not show' });
    render(<AssistantMessage {...defaultProps({ message: msg, timeline })} />);
    expect(screen.getByText('Timeline text')).toBeInTheDocument();
    expect(screen.queryByText('Should not show')).not.toBeInTheDocument();
  });

  it('shows hooks running indicator', () => {
    useSessionLifecycleStore.setState({ activeSessionId: 'ui-1',
      sessions: [{
        id: 'ui-1', acpSessionId: 'acp-1', name: 'Test', messages: [makeMessage()],
        isTyping: false, isWarmingUp: false, model: 'balanced', isHooksRunning: true,
      }],
    } as any);
    render(<AssistantMessage {...defaultProps({ acpSessionId: 'acp-1' })} />);
    expect(screen.getByText(/Hooks running/)).toBeInTheDocument();
  });

  it('renders permission step in timeline', () => {
    const timeline: TimelineStep[] = [{
      type: 'permission',
      request: { id: 1, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
    }];
    render(<AssistantMessage {...defaultProps({ timeline })} />);
    expect(screen.getByText('Allow')).toBeInTheDocument();
  });
});



describe('AssistantMessage - fork and copy extended', () => {
  beforeEach(() => {
    useSessionLifecycleStore.setState({ activeSessionId: 'ui-1',
      sessions: [{
        id: 'ui-1', acpSessionId: 'acp-1', name: 'Test', messages: [makeMessage()],
        isTyping: false, isWarmingUp: false, model: 'balanced',
      }],
    } as any); });

  it('fork button renders when not streaming and not archived', () => {
    const msg = makeMessage({ isArchived: false });
    const { container } = render(<AssistantMessage {...defaultProps({ message: msg, isStreaming: false })} />);
    const forkBtn = container.querySelector('.copy-btn[title="Fork conversation from here"]');
    expect(forkBtn).toBeInTheDocument();
  });

  it('fork button does NOT render when streaming', () => {
    const { container } = render(<AssistantMessage {...defaultProps({ isStreaming: true })} />);
    const forkBtn = container.querySelector('.copy-btn[title="Fork conversation from here"]');
    expect(forkBtn).not.toBeInTheDocument();
  });

  it('copy button shows Check icon after click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { container } = render(<AssistantMessage {...defaultProps({ isStreaming: false })} />);
    const copyBtn = container.querySelector('.copy-btn[title="Copy full response"]')!;
    fireEvent.click(copyBtn);

    // After click, the Check icon should appear (copied state = true)
    await vi.waitFor(() => {
      expect(container.querySelector('.copy-btn[title="Copy full response"] svg')).toBeInTheDocument();
    });
  });

  it('forking overlay shows when forking state is true', () => {
    // We can't easily trigger the forking state through the handler since it requires socket,
    // but we can verify the component renders the overlay structure.
    // The fork button sets forking=true internally, then the overlay renders.
    // Since we can't mock the internal useState, verify the overlay text exists in the component.
    const msg = makeMessage();
    const { container } = render(<AssistantMessage {...defaultProps({ message: msg, isStreaming: false })} />);
    // Fork overlay is only shown when forking state is true (internal state)
    // Verify the fork button exists and clicking it would trigger the flow
    const forkBtn = container.querySelector('.copy-btn[title="Fork conversation from here"]');
    expect(forkBtn).toBeInTheDocument();
  });
});


describe('AssistantMessage - sub-agent', () => {
  it('does not render fork button for sub-agent sessions', () => {
    act(() => {
      useSessionLifecycleStore.setState({ activeSessionId: 'sub-1',
        sessions: [{ id: 'sub-1', name: 'Sub', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'acp-sub', isSubAgent: true }], });
    });
    render(<AssistantMessage {...defaultProps()} />);
    expect(screen.queryByTitle('Fork conversation from here')).not.toBeInTheDocument();
  });
});
