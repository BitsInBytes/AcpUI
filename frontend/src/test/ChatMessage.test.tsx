import { useChatStore } from '../store/useChatStore';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ChatMessage from '../components/ChatMessage';
import type { Message, TimelineStep } from '../types';
import { useCanvasStore } from '../store/useCanvasStore';
import { useSubAgentStore } from '../store/useSubAgentStore';


// More sophisticated mock to allow testing custom components
vi.mock('react-markdown', () => ({
  default: ({ children, components }: any) => {
    if (typeof children === 'string') {
      if (children.includes(':::RESPONSE_DIVIDER:::') || children.includes('---')) {
        const Hr = components?.hr || (() => <hr />);
        return <div><Hr /></div>;
      }
      if (children.includes('```')) {
        const codeContent = children.replace(/```\w*\n?/, '').replace(/```/, '');
        if (components && components.code) {
          const CodeComp = components.code;
          return <CodeComp className="language-javascript" inline={false}>{codeContent}</CodeComp>;
        }
      }
    }
    if (Array.isArray(children)) {
      return <div>{children}</div>;
    }
    return <div>{children}</div>;
  }
}));

vi.mock('../components/ShellToolTerminal', () => ({
  default: ({ event }: { event: { shellRunId?: string } }) => (
    <div data-testid="shell-tool-terminal" data-run-id={event.shellRunId ?? ''} />
  ),
}));

// Mock Lucide icons for easier testing if needed, though they render SVG by default
// The current environment handles SVGs fine via class selectors.

describe('ChatMessage', () => {
  beforeEach(() => {
    useCanvasStore.setState({ isCanvasOpen: false });
    useSubAgentStore.getState().clear();
  });

  const createTimeline = (count: number, type: 'tool' | 'thought'): TimelineStep[] => {
    return Array.from({ length: count }, (_, i) => ({
      type,
      [type === 'tool' ? 'event' : 'content']: type === 'tool' ? { id: `t${i}`, title: `${type} ${i}`, status: 'completed' } : `thought ${i}`
    } as any));
  };

  it('renders a user message correctly', () => {
    const userMessage: Message = {
      id: '1',
      role: 'user',
      content: 'Hello, world!',
    };

    render(<ChatMessage message={userMessage} />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
  });

  it('renders assistant message correctly with interleaved timeline', () => {
    const assistantMessage: Message = {
      id: '2',
      role: 'assistant',
      content: 'Hi there',
      timeline: [
        { type: 'thought', content: 'Thinking about tools...' },
        { type: 'tool', event: { id: 't1', title: 'Running tool', status: 'completed' } }
      ]
    };

    render(<ChatMessage message={assistantMessage} />);
    expect(screen.getByText('Assistant')).toBeInTheDocument();
    expect(screen.getByText('Thinking Process')).toBeInTheDocument();
    expect(screen.getByText('Running tool')).toBeInTheDocument();
  });

  it('collapses tool calls and thought bubbles when streaming is finished', () => {
    const message: Message = {
      id: '3',
      role: 'assistant',
      content: 'done',
      isStreaming: false,
      timeline: [
        { type: 'thought', content: 'thought 1' },
        { type: 'tool', event: { id: 't1', title: 'tool 1', status: 'completed' } }
      ]
    };

    render(<ChatMessage message={message} />);
    
    const headers = screen.getAllByRole('button').filter(btn => btn.className === 'timeline-step-header');
    expect(headers).toHaveLength(2);
    
    // Thought step (index 0) is collapsed
    expect(headers[0].querySelector('.lucide-chevron-right')).not.toBeNull();
    // Tool step (index 1) is collapsed (isCollapsed=true)
    expect(headers[1].querySelector('.lucide-chevron-right')).not.toBeNull();
  });

  it('auto-collapses completed shell tool steps after a short settling delay', () => {
    vi.useFakeTimers();
    try {
      const message: Message = {
        id: '3-shell',
        role: 'assistant',
        content: 'done',
        isStreaming: true,
        timeline: [
          {
            type: 'tool',
            isCollapsed: false,
            event: {
              id: 'shell-tool-1',
              title: 'Invoke Shell: Sync check',
              status: 'completed',
              shellRunId: 'shell-run-1',
              shellState: 'exited',
              output: 'sync'
            }
          }
        ]
      };

      render(<ChatMessage message={message} />);
      let header = screen.getByRole('button', { name: /Invoke Shell: Sync check/i });
      expect(header.querySelector('.lucide-chevron-down')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(950);
      });

      header = screen.getByRole('button', { name: /Invoke Shell: Sync check/i });
      expect(header.querySelector('.lucide-chevron-right')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps auto-collapsed terminal shell steps collapsed while later shell steps stream', () => {
    vi.useFakeTimers();
    try {
      const message: Message = {
        id: '3-shell-streaming',
        role: 'assistant',
        content: 'done',
        isStreaming: true,
        timeline: [
          {
            type: 'tool',
            isCollapsed: false,
            event: {
              id: 'shell-tool-1',
              title: 'Invoke Shell: Sync check',
              status: 'completed',
              shellRunId: 'shell-run-1',
              shellState: 'exited',
              output: 'sync'
            }
          }
        ]
      };

      const { rerender } = render(<ChatMessage message={message} />);
      let completedHeader = screen.getByRole('button', { name: /Invoke Shell: Sync check/i });
      expect(completedHeader.querySelector('.lucide-chevron-down')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(950);
      });

      completedHeader = screen.getByRole('button', { name: /Invoke Shell: Sync check/i });
      expect(completedHeader.querySelector('.lucide-chevron-right')).not.toBeNull();

      rerender(<ChatMessage message={{
        ...message,
        timeline: [
          ...(message.timeline || []),
          {
            type: 'tool',
            event: {
              id: 'shell-tool-2',
              title: 'Invoke Shell: Next check',
              status: 'in_progress',
              shellRunId: 'shell-run-2',
              shellState: 'running'
            }
          }
        ]
      }} />);

      completedHeader = screen.getByRole('button', { name: /Invoke Shell: Sync check/i });
      expect(completedHeader.querySelector('.lucide-chevron-right')).not.toBeNull();
      const activeHeader = screen.getByRole('button', { name: /Invoke Shell: Next check/i });
      expect(activeHeader.querySelector('.lucide-chevron-down')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-collapses the completed shell step, not a new preceding shell step, when indices shift before timeout', () => {
    vi.useFakeTimers();
    try {
      const message: Message = {
        id: '3-shell-index-shift',
        role: 'assistant',
        content: 'done',
        isStreaming: true,
        timeline: [
          {
            type: 'tool',
            isCollapsed: false,
            event: {
              id: 'shell-tool-old',
              title: 'Invoke Shell: Completed check',
              status: 'completed',
              shellRunId: 'shell-run-old',
              shellState: 'exited',
              output: 'done'
            }
          }
        ]
      };

      const { rerender } = render(<ChatMessage message={message} />);
      rerender(<ChatMessage message={{
        ...message,
        timeline: [
          {
            type: 'tool',
            isCollapsed: false,
            event: {
              id: 'shell-tool-new',
              title: 'Invoke Shell: Active check',
              status: 'in_progress',
              shellRunId: 'shell-run-new',
              shellState: 'running'
            }
          },
          ...(message.timeline || [])
        ]
      }} />);

      act(() => {
        vi.advanceTimersByTime(950);
      });

      const activeHeader = screen.getByRole('button', { name: /Invoke Shell: Active check/i });
      const completedHeader = screen.getByRole('button', { name: /Invoke Shell: Completed check/i });
      expect(activeHeader.querySelector('.lucide-chevron-down')).not.toBeNull();
      expect(completedHeader.querySelector('.lucide-chevron-right')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects explicit thought collapse state from the streaming timeline', () => {
    const message: Message = {
      id: '3b',
      role: 'assistant',
      content: 'still streaming',
      isStreaming: true,
      timeline: [
        { type: 'thought', content: 'old thought', isCollapsed: true },
        { type: 'thought', content: 'current thought', isCollapsed: false }
      ]
    };

    render(<ChatMessage message={message} />);

    expect(screen.queryByText('old thought')).not.toBeInTheDocument();
    expect(screen.getByText('current thought')).toBeInTheDocument();
  });

  it('expands an explicitly collapsed thought with one click', () => {
    const message: Message = {
      id: '3c',
      role: 'assistant',
      content: 'streaming',
      isStreaming: true,
      timeline: [
        { type: 'thought', content: 'collapsed thought', isCollapsed: true }
      ]
    };

    render(<ChatMessage message={message} />);

    expect(screen.queryByText('collapsed thought')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Thinking Process'));
    expect(screen.getByText('collapsed thought')).toBeInTheDocument();
  });

  it('keeps only the last 3 tool calls and last 3 thought bubbles expanded while streaming', () => {
    const timeline: TimelineStep[] = [
      ...createTimeline(4, 'thought'),
      ...createTimeline(4, 'tool')
    ];

    const message: Message = {
      id: '4',
      role: 'assistant',
      content: 'working',
      isStreaming: true,
      timeline
    };

    render(<ChatMessage message={message} />);

    const headers = screen.getAllByRole('button').filter(btn => btn.className === 'timeline-step-header');
    expect(headers).toHaveLength(8);

    // Thought 0 (index 0) should be collapsed
    expect(headers[0].querySelector('.lucide-chevron-right')).not.toBeNull();
    // Thoughts 1, 2, 3 should be expanded
    expect(headers[1].querySelector('.lucide-chevron-down')).not.toBeNull();
    expect(headers[2].querySelector('.lucide-chevron-down')).not.toBeNull();
    expect(headers[3].querySelector('.lucide-chevron-down')).not.toBeNull();

    // Tool 0 (index 4) should be collapsed
    expect(headers[4].querySelector('.lucide-chevron-right')).not.toBeNull();
    // Tools 1, 2, 3 should be expanded
    expect(headers[5].querySelector('.lucide-chevron-down')).not.toBeNull();
    expect(headers[6].querySelector('.lucide-chevron-down')).not.toBeNull();
    expect(headers[7].querySelector('.lucide-chevron-down')).not.toBeNull();
  });

  it('renders a divider message correctly', () => {
    const dividerMessage: Message = {
      id: '5',
      role: 'divider',
      content: '',
    };

    render(<ChatMessage message={dividerMessage} />);
    expect(screen.getByText('Context Compressed')).toBeInTheDocument();
  });

  it('renders Open in Canvas button on code blocks and calls callback', () => {
    const codeMessage: Message = {
      id: '6',
      role: 'assistant',
      content: '```javascript\nconst a = 1;\n```',
      timeline: [{ type: 'text', content: '```javascript\nconst a = 1;\n```' }]
    };

    const mockOnOpenInCanvas = vi.fn();
    useCanvasStore.setState({ isCanvasOpen: true, handleOpenInCanvas: mockOnOpenInCanvas });

    render(<ChatMessage message={codeMessage} />);
    
    const canvasBtn = screen.getByTitle('Open in Canvas');
    expect(canvasBtn).toBeInTheDocument();
    
    fireEvent.click(canvasBtn);
    expect(mockOnOpenInCanvas).toHaveBeenCalledWith(null, null, expect.objectContaining({
      language: 'javascript',
      content: 'const a = 1;'
    }));
  });

  it('does not render Open in Canvas button for truncated paths with ellipses', () => {
    const message: Message = {
      id: '7',
      role: 'assistant',
      content: 'done',
      timeline: [
        { type: 'tool', event: { id: 't1', title: 'Running replace: D:\\Git\\...\\Sidebar.test.tsx', status: 'completed' } }
      ]
    };

    render(<ChatMessage message={message} />);
    
    const canvasHoistBtn = screen.queryByTitle('Open current file state in Canvas');
    expect(canvasHoistBtn).toBeNull();
  });

  it('renders Open in Canvas button for valid full paths', () => {
    const message: Message = {
      id: '8',
      role: 'assistant',
      content: 'done',
      timeline: [
        { type: 'tool', event: { id: 't1', title: 'Running replace: C:\\repos\\demo-project\\Sidebar.test.tsx', status: 'completed' } }
      ]
    };

    render(<ChatMessage message={message} />);
    
    const canvasHoistBtn = screen.getByTitle('Open current file state in Canvas');
    expect(canvasHoistBtn).toBeInTheDocument();
  });

  it('renders permission requests and allows response', () => {
    const mockRespond = vi.fn();
    useChatStore.setState({ handleRespondPermission: mockRespond });
    
    const message: Message = {
      id: '9',
      role: 'assistant',
      content: '',
      timeline: [
        { 
          type: 'permission', 
          request: { id: 123, toolCall: { title: 'Delete everything' }, options: [{ name: 'Allow', optionId: 'allow', kind: 'primary' }] }
        } as any
      ]
    };

    render(<ChatMessage message={message} />);
    
    expect(screen.getByText('Permission Requested')).toBeInTheDocument();
    expect(screen.getByText('Delete everything')).toBeInTheDocument();
    
    const allowBtn = screen.getByText('Allow');
    fireEvent.click(allowBtn);
    
    expect(mockRespond).toHaveBeenCalledWith(null, 123, 'allow', undefined, undefined);
  });

  it('renders error message boxes', () => {
    const message: Message = {
      id: '10',
      role: 'assistant',
      content: '',
      timeline: [
        { type: 'text', content: ':::ERROR::: Something went wrong :::END_ERROR:::' }
      ]
    };

    render(<ChatMessage message={message} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders response dividers', () => {
    const message: Message = {
      id: '11',
      role: 'assistant',
      content: '',
      timeline: [
        { type: 'text', content: 'Part 1 :::RESPONSE_DIVIDER::: Part 2' }
      ]
    };

    const { container } = render(<ChatMessage message={message} />);
    expect(container.querySelector('.response-divider')).toBeInTheDocument();
  });

  it('renders user message with image attachment thumbnail', () => {
    const message: Message = {
      id: '20',
      role: 'user',
      content: 'See this image',
      attachments: [{ name: 'photo.png', size: 1000, mimeType: 'image/png', data: 'abc123' }]
    };
    const { container } = render(<ChatMessage message={message} />);
    const img = container.querySelector('.user-attachment-img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toContain('data:image/png;base64,abc123');
  });

  it('renders user message with file attachment pill', () => {
    const message: Message = {
      id: '21',
      role: 'user',
      content: 'See this file',
      attachments: [{ name: 'report.pdf', size: 2000, mimeType: 'application/pdf' }]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText('📎 report.pdf')).toBeInTheDocument();
  });

  it('copy button calls clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const message: Message = {
      id: '22',
      role: 'assistant',
      content: 'Copy me',
      timeline: [{ type: 'text', content: 'Copy me' }]
    };
    render(<ChatMessage message={message} />);
    const copyBtn = screen.getByTitle('Copy full response');
    await act(async () => {
      fireEvent.click(copyBtn);
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('Copy me');
  });

  it('permission request renders with options buttons', () => {
    const mockRespond = vi.fn();
    useChatStore.setState({ handleRespondPermission: mockRespond });

    const message: Message = {
      id: '23',
      role: 'assistant',
      content: '',
      timeline: [
        {
          type: 'permission',
          request: { id: 456, toolCall: { title: 'Run dangerous command' }, options: [{ name: 'Allow', optionId: 'allow', kind: 'primary' }, { name: 'Deny', optionId: 'deny', kind: 'secondary' }] }
        } as any
      ]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText('Allow')).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Deny'));
    expect(mockRespond).toHaveBeenCalledWith(null, 456, 'deny', undefined, undefined);
  });

  it('tool timeline step renders with title', () => {
    const message: Message = {
      id: '24',
      role: 'assistant',
      content: '',
      isStreaming: true,
      timeline: [
        { type: 'tool', event: { id: 't1', title: 'Searching files', status: 'in_progress' } }
      ]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText('Searching files')).toBeInTheDocument();
  });

  it('collapsed tool steps are hidden', () => {
    const message: Message = {
      id: '25',
      role: 'assistant',
      content: 'done',
      isStreaming: false,
      timeline: [
        { type: 'tool', event: { id: 't1', title: 'Tool A', status: 'completed', output: 'secret output' } }
      ]
    };
    render(<ChatMessage message={message} />);
    // When not streaming, tools are collapsed — chevron-right indicates collapsed state
    const headers = screen.getAllByRole('button').filter(btn => btn.className === 'timeline-step-header');
    expect(headers[0].querySelector('.lucide-chevron-right')).not.toBeNull();
  });

  it('returns null when message is null or undefined', () => {
    const { container } = render(<ChatMessage message={null as any} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders divider with compression-divider class', () => {
    const dividerMessage: Message = { id: 'd1', role: 'divider', content: '' };
    const { container } = render(<ChatMessage message={dividerMessage} />);
    expect(container.querySelector('.compression-divider')).toBeInTheDocument();
  });

  it('renders Agent role label for assistant messages', () => {
    const msg: Message = { id: 'a1', role: 'assistant', content: 'hi', timeline: [{ type: 'text', content: 'hi' }] };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Assistant')).toBeInTheDocument();
  });

  it('delegates user messages to UserMessage component', () => {
    const msg: Message = { id: 'u1', role: 'user', content: 'test input' };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('test input')).toBeInTheDocument();
  });

  it('renders diff output for tool calls', () => {
    const message: Message = {
      id: '12',
      role: 'assistant',
      content: '',
      timeline: [
        { 
          type: 'tool', 
          event: { 
            id: 't1', 
            title: 'File Change', 
            status: 'completed', 
            output: '--- old\n+++ new\n- removed\n+ added' 
          } 
        }
      ]
    };

    render(<ChatMessage message={message} />);
    
    // Toggle to see output
    const header = screen.getByText('File Change');
    fireEvent.click(header);
    
    expect(screen.getByText('- removed')).toHaveClass('diff-remove');
    expect(screen.getByText('+ added')).toHaveClass('diff-add');
  });
});



describe('ChatMessage - additional coverage', () => {
  beforeEach(() => {
    useCanvasStore.setState({ isCanvasOpen: false });
    useSubAgentStore.getState().clear();
  });

  it('code block renders language badge', () => {
    const message: Message = {
      id: 'cb1',
      role: 'assistant',
      content: '```javascript\nconst x = 1;\n```',
      timeline: [{ type: 'text', content: '```javascript\nconst x = 1;\n```' }]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText('javascript')).toBeInTheDocument();
  });

  it('code block copy button copies code to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const message: Message = {
      id: 'cb2',
      role: 'assistant',
      content: '```python\nprint("hi")\n```',
      timeline: [{ type: 'text', content: '```python\nprint("hi")\n```' }]
    };
    render(<ChatMessage message={message} />);
    const copyBtns = screen.getAllByText('Copy');
    await act(async () => {
      fireEvent.click(copyBtns[0]);
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalled();
  });

  it('code block shows "Copied" after clicking copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const message: Message = {
      id: 'cb3',
      role: 'assistant',
      content: '```js\nlet a = 1;\n```',
      timeline: [{ type: 'text', content: '```js\nlet a = 1;\n```' }]
    };
    render(<ChatMessage message={message} />);
    const copyBtns = screen.getAllByText('Copy');
    fireEvent.click(copyBtns[0]);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('code block shows Canvas button when canvas is open', () => {
    useCanvasStore.setState({ isCanvasOpen: true, handleOpenInCanvas: vi.fn() });
    const message: Message = {
      id: 'cb4',
      role: 'assistant',
      content: '```typescript\nconst y = 2;\n```',
      timeline: [{ type: 'text', content: '```typescript\nconst y = 2;\n```' }]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByTitle('Open in Canvas')).toBeInTheDocument();
  });

  it('code block does NOT show Canvas button when canvas is closed', () => {
    useCanvasStore.setState({ isCanvasOpen: false });
    const message: Message = {
      id: 'cb5',
      role: 'assistant',
      content: '```typescript\nconst y = 2;\n```',
      timeline: [{ type: 'text', content: '```typescript\nconst y = 2;\n```' }]
    };
    render(<ChatMessage message={message} />);
    expect(screen.queryByTitle('Open in Canvas')).not.toBeInTheDocument();
  });

  it('thought step renders with Thinking Process header', () => {
    const message: Message = {
      id: 'th1',
      role: 'assistant',
      content: 'result',
      isStreaming: true,
      timeline: [{ type: 'thought', content: 'Let me think about this...' }]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText('Thinking Process')).toBeInTheDocument();
  });

  it('tool step renders title and can be toggled', () => {
    const message: Message = {
      id: 'ts1',
      role: 'assistant',
      content: 'done',
      isStreaming: true,
      timeline: [
        { type: 'tool', event: { id: 't1', title: 'Reading config.json', status: 'completed', output: 'config data' } }
      ]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText('Reading config.json')).toBeInTheDocument();
    // Click to collapse
    fireEvent.click(screen.getByText('Reading config.json'));
    // Click again to expand
    fireEvent.click(screen.getByText('Reading config.json'));
  });

  it('multiple text segments render without collapse', () => {
    const message: Message = {
      id: 'mt1',
      role: 'assistant',
      content: 'final',
      timeline: [
        { type: 'text', content: 'Part one' },
        { type: 'text', content: 'Part two' },
      ]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText('Part one')).toBeInTheDocument();
    expect(screen.getByText('Part two')).toBeInTheDocument();
  });

  it('inline code renders as code element', () => {
    const message: Message = {
      id: 'ic1',
      role: 'assistant',
      content: 'Use `npm install`',
      timeline: [{ type: 'text', content: 'Use `npm install`' }]
    };
    render(<ChatMessage message={message} />);
    // The mock renders children as-is, so the backtick content appears
    expect(screen.getByText(/npm install/)).toBeInTheDocument();
  });

  it('permission step stays expanded while streaming', () => {
    const mockRespond = vi.fn();
    useChatStore.setState({ handleRespondPermission: mockRespond });

    const message: Message = {
      id: 'perm1',
      role: 'assistant',
      content: '',
      isStreaming: true,
      timeline: [
        { type: 'permission', request: { id: 789, toolCall: { title: 'Write file' }, options: [{ name: 'Allow', optionId: 'allow', kind: 'primary' }] } } as any
      ]
    };
    render(<ChatMessage message={message} />);
    expect(screen.getByText('Permission Requested')).toBeInTheDocument();
    expect(screen.getByText('Allow')).toBeInTheDocument();
  });
});

describe('ChatMessage - Collapse Fix (Regression)', () => {
  beforeEach(() => {
    useSubAgentStore.getState().clear();
  });

  it('respects manual toggle during timeline updates while streaming', async () => {
    const initialTimeline: TimelineStep[] = [
      { type: 'thought', content: 'thinking 1', isCollapsed: true },
      { type: 'thought', content: 'thinking 2', isCollapsed: false }
    ];

    const message: Message = {
      id: 'msg-1',
      role: 'assistant',
      content: '',
      isStreaming: true,
      timeline: initialTimeline
    };

    const { rerender } = render(<ChatMessage message={message} />);

    // Initially, step 0 is collapsed (content not visible), step 1 is open
    expect(screen.queryByText('thinking 1')).not.toBeInTheDocument();
    expect(screen.getByText('thinking 2')).toBeInTheDocument();

    // Manually toggle step 0 to expand it
    fireEvent.click(screen.getAllByText('Thinking Process')[0]);
    expect(screen.getByText('thinking 1')).toBeInTheDocument();

    // Simulate a timeline update (streaming continues)
    const updatedTimeline: TimelineStep[] = [
      { type: 'thought', content: 'thinking 1', isCollapsed: true },
      { type: 'thought', content: 'thinking 2', isCollapsed: true },
      { type: 'thought', content: 'thinking 3', isCollapsed: false }
    ];

    const updatedMessage: Message = {
      ...message,
      timeline: updatedTimeline
    };

    rerender(<ChatMessage message={updatedMessage} />);

    // Step 0 should STAY expanded because it was manually toggled, 
    // even though the incoming store data says isCollapsed: true
    expect(screen.getByText('thinking 1')).toBeInTheDocument();
    
    // Step 1 should be collapsed as per the store update (it wasn't manually toggled)
    await waitFor(() => expect(screen.queryByText('thinking 2')).not.toBeInTheDocument());
    
    // Step 2 should be open as it's the new active step
    expect(screen.getByText('thinking 3')).toBeInTheDocument();
  });

  it('respects manual toggle after streaming stops', async () => {
    const timeline: TimelineStep[] = [
      { type: 'thought', content: 'thinking 1', isCollapsed: true },
      { type: 'text', content: 'final response' }
    ];

    const message: Message = {
      id: 'msg-1',
      role: 'assistant',
      content: 'final response',
      isStreaming: true,
      timeline: timeline
    };

    const { rerender } = render(<ChatMessage message={message} />);

    // Manually expand the thought bubble
    fireEvent.click(screen.getByText('Thinking Process'));
    expect(screen.getByText('thinking 1')).toBeInTheDocument();

    // Stop streaming
    const stoppedMessage: Message = {
      ...message,
      isStreaming: false
    };

    rerender(<ChatMessage message={stoppedMessage} />);

    // It should STILL be expanded, even though the default for non-streaming is to collapse thoughts
    expect(screen.getByText('thinking 1')).toBeInTheDocument();
  });

  it('pins active sub-agent orchestration to the bottom after later parent work', () => {
    useSubAgentStore.getState().startInvocation({
      invocationId: 'inv-pinned',
      providerId: 'test-provider',
      parentUiId: 'parent-ui',
      parentSessionId: 'parent-acp',
      statusToolName: 'ux_check_subagents',
      totalCount: 1,
      status: 'running'
    });
    useSubAgentStore.getState().addAgent({
      providerId: 'test-provider',
      acpSessionId: 'sub-acp-1',
      parentSessionId: 'parent-acp',
      invocationId: 'inv-pinned',
      index: 0,
      name: 'Research',
      prompt: 'Inspect the issue',
      agent: 'test-agent'
    });
    useSubAgentStore.getState().setStatus('sub-acp-1', 'running');

    const message: Message = {
      id: 'msg-pinned-subagents',
      role: 'assistant',
      content: 'Parent continued after spawning agents',
      isStreaming: true,
      timeline: [
        {
          type: 'tool',
          event: {
            id: 'tool-subagents',
            title: 'Invoke Subagents',
            toolName: 'ux_invoke_subagents',
            canonicalName: 'ux_invoke_subagents',
            invocationId: 'inv-pinned',
            status: 'in_progress',
            isAcpUxTool: true
          }
        } as TimelineStep,
        { type: 'text', content: 'Parent continued after spawning agents' },
        { type: 'tool', event: { id: 'tool-parent-work', title: 'Parent follow-up tool', status: 'completed' } }
      ]
    };

    const { container } = render(<ChatMessage message={message} />);

    const pinnedPanel = container.querySelector('.sub-agent-pinned-panels');
    expect(pinnedPanel).toBeInTheDocument();
    expect(screen.getByText(/1: Research/)).toBeInTheDocument();
    expect(screen.getByText('Invoke Subagents').closest('.timeline-step')?.querySelector('.sub-agent-panel')).toBeNull();

    const followUpTool = screen.getByText('Parent follow-up tool').closest('.timeline-step');
    expect(followUpTool).not.toBeNull();
    expect(Boolean(followUpTool!.compareDocumentPosition(pinnedPanel!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('auto-collapses bottom-pinned sub-agent orchestration two seconds after completion', () => {
    vi.useFakeTimers();
    try {
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-auto-collapse',
        providerId: 'test-provider',
        parentUiId: 'parent-ui',
        parentSessionId: 'parent-acp',
        statusToolName: 'ux_check_subagents',
        totalCount: 1,
        status: 'running'
      });
      useSubAgentStore.getState().addAgent({
        providerId: 'test-provider',
        acpSessionId: 'sub-acp-auto',
        parentSessionId: 'parent-acp',
        invocationId: 'inv-auto-collapse',
        index: 0,
        name: 'Research',
        prompt: 'Inspect the issue',
        agent: 'test-agent'
      });
      useSubAgentStore.getState().setStatus('sub-acp-auto', 'running');

      const message: Message = {
        id: 'msg-auto-collapse-subagents',
        role: 'assistant',
        content: 'Parent continued after spawning agents',
        isStreaming: true,
        timeline: [
          {
            type: 'tool',
            event: {
              id: 'tool-subagents-auto',
              title: 'Invoke Subagents',
              toolName: 'ux_invoke_subagents',
              canonicalName: 'ux_invoke_subagents',
              invocationId: 'inv-auto-collapse',
              status: 'in_progress',
              isAcpUxTool: true
            }
          } as TimelineStep
        ]
      };

      render(<ChatMessage message={message} />);
      expect(screen.getByText(/1: Research/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /hide sub-agents/i })).toHaveAttribute('aria-expanded', 'true');

      act(() => {
        useSubAgentStore.getState().completeAgent('sub-acp-auto', 'completed');
      });
      expect(screen.getByText(/1: Research/)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1999);
      });
      expect(screen.getByRole('button', { name: /hide sub-agents/i })).toHaveAttribute('aria-expanded', 'true');

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole('button', { name: /show sub-agents/i })).toHaveAttribute('aria-expanded', 'false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps completed bottom-pinned sub-agent orchestration collapsed when terminal agents hydrate after render', () => {
    const message: Message = {
      id: 'msg-loaded-completed-subagents',
      role: 'assistant',
      content: 'Parent finished after spawning agents',
      isStreaming: false,
      timeline: [
        {
          type: 'tool',
          event: {
            id: 'tool-subagents-loaded',
            title: 'Invoke Subagents',
            toolName: 'ux_invoke_subagents',
            canonicalName: 'ux_invoke_subagents',
            invocationId: 'inv-loaded-completed',
            status: 'completed',
            isAcpUxTool: true
          }
        } as TimelineStep
      ]
    };

    const { container } = render(<ChatMessage message={message} />);
    expect(container.querySelector('.sub-agent-pinned-panel')).toBeNull();

    act(() => {
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-loaded-completed',
        providerId: 'test-provider',
        parentUiId: 'parent-ui',
        parentSessionId: 'parent-acp',
        statusToolName: 'ux_check_subagents',
        totalCount: 1,
        status: 'completed'
      });
      useSubAgentStore.getState().addAgent({
        providerId: 'test-provider',
        acpSessionId: 'sub-acp-loaded-completed',
        parentSessionId: 'parent-acp',
        invocationId: 'inv-loaded-completed',
        index: 0,
        name: 'Research',
        prompt: 'Inspect the issue',
        agent: 'test-agent'
      });
      useSubAgentStore.getState().setStatus('sub-acp-loaded-completed', 'completed');
    });

    expect(screen.getByRole('button', { name: /show sub-agents/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/1: Research/)).not.toBeInTheDocument();
  });

  it('allows the bottom-pinned sub-agent orchestration to be manually opened and closed', () => {
    useSubAgentStore.getState().startInvocation({
      invocationId: 'inv-manual-toggle',
      providerId: 'test-provider',
      parentUiId: 'parent-ui',
      parentSessionId: 'parent-acp',
      statusToolName: 'ux_check_subagents',
      totalCount: 1,
      status: 'running'
    });
    useSubAgentStore.getState().addAgent({
      providerId: 'test-provider',
      acpSessionId: 'sub-acp-manual',
      parentSessionId: 'parent-acp',
      invocationId: 'inv-manual-toggle',
      index: 0,
      name: 'Research',
      prompt: 'Inspect the issue',
      agent: 'test-agent'
    });
    useSubAgentStore.getState().setStatus('sub-acp-manual', 'running');

    const message: Message = {
      id: 'msg-manual-toggle-subagents',
      role: 'assistant',
      content: 'Parent continued after spawning agents',
      isStreaming: true,
      timeline: [
        {
          type: 'tool',
          event: {
            id: 'tool-subagents-manual',
            title: 'Invoke Subagents',
            toolName: 'ux_invoke_subagents',
            canonicalName: 'ux_invoke_subagents',
            invocationId: 'inv-manual-toggle',
            status: 'in_progress',
            isAcpUxTool: true
          }
        } as TimelineStep
      ]
    };

    render(<ChatMessage message={message} />);

    fireEvent.click(screen.getByRole('button', { name: /hide sub-agents/i }));
    expect(screen.getByRole('button', { name: /show sub-agents/i })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: /show sub-agents/i }));
    expect(screen.getByRole('button', { name: /hide sub-agents/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/1: Research/)).toBeInTheDocument();
  });

  it('keeps active sub-agent orchestration expanded after remount', () => {
    useSubAgentStore.getState().startInvocation({
      invocationId: 'inv-active',
      providerId: 'test-provider',
      parentUiId: 'parent-ui',
      parentSessionId: 'parent-acp',
      statusToolName: 'ux_check_subagents',
      totalCount: 1,
      status: 'prompting'
    });

    const message: Message = {
      id: 'msg-subagents',
      role: 'assistant',
      content: '',
      isStreaming: false,
      timeline: [
        {
          type: 'tool',
          isCollapsed: true,
          event: {
            id: 'tool-subagents',
            title: 'Invoke Subagents',
            toolName: 'ux_invoke_subagents',
            canonicalName: 'ux_invoke_subagents',
            invocationId: 'inv-active',
            status: 'in_progress',
            isAcpUxTool: true
          }
        } as TimelineStep
      ]
    };

    const { unmount } = render(<ChatMessage message={message} />);
    let header = screen.getByText('Invoke Subagents').closest('button');
    expect(header?.querySelector('.lucide-chevron-down')).not.toBeNull();

    unmount();
    render(<ChatMessage message={message} />);
    header = screen.getByText('Invoke Subagents').closest('button');
    expect(header?.querySelector('.lucide-chevron-down')).not.toBeNull();
  });
});


