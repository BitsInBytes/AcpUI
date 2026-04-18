import { useChatStore } from '../store/useChatStore';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ChatMessage from '../components/ChatMessage';
import type { Message, TimelineStep } from '../types';
import { useCanvasStore } from '../store/useCanvasStore';


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

// Mock Lucide icons for easier testing if needed, though they render SVG by default
// The current environment handles SVGs fine via class selectors.

describe('ChatMessage', () => {
  beforeEach(() => {
    useCanvasStore.setState({ isCanvasOpen: false });
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
    fireEvent.click(copyBtn);
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
    fireEvent.click(copyBtns[0]);
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
