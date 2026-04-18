import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AssistantMessage from '../components/AssistantMessage';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';

// Mock child components
vi.mock('../components/MemoizedMarkdown', () => ({ default: ({ content }: any) => <div className="message-content">{content}</div> }));
vi.mock('../components/ToolStep', () => ({ default: ({ step, isCollapsed, onToggle }: any) => (
  <div data-testid="tool-step">
    {step.event.title}
    <button onClick={onToggle}>{isCollapsed ? 'Expand' : 'Collapse'}</button>
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

describe('AssistantMessage (Collapse logic)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ branding: { assistantName: 'Assistant' } } as any);
      useSessionLifecycleStore.setState({ activeSessionId: 's1', sessions: [{ id: 's1', acpSessionId: 'a1' } as any] });
    });
  });

  it('toggles thought step collapse when clicking header', () => {
    const toggleCollapse = vi.fn();
    const timeline: any[] = [{ type: 'thought', content: 'thinking' }];
    render(<AssistantMessage {...defaultProps({ timeline, toggleCollapse })} />);
    
    const header = screen.getByText('Thinking Process').closest('button')!;
    fireEvent.click(header);
    expect(toggleCollapse).toHaveBeenCalledWith(0);
  });

  it('renders collapsed thought step without content', () => {
    const timeline: any[] = [{ type: 'thought', content: 'thinking' }];
    render(<AssistantMessage {...defaultProps({ timeline, localCollapsed: { 0: true } })} />);
    expect(screen.queryByText('thinking')).not.toBeInTheDocument();
  });
});
