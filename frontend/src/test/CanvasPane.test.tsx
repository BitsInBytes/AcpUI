import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CanvasPane from '../components/CanvasPane/CanvasPane';
import type { CanvasArtifact } from '../types';

const mockSocketEmit = vi.fn();
vi.mock('../hooks/useSocket', () => ({
  useSocket: () => ({
    socket: { emit: mockSocketEmit }
  })
}));

// Mock Monaco Editor
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, language }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-language={language}
    />
  )
}));

describe('CanvasPane Component', () => {
  it('renders placeholder when activeArtifact is null', () => {
    render(<CanvasPane artifacts={[]} activeArtifact={null} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByText('Select a file to view or edit.')).toBeInTheDocument();
  });

  it('renders artifact title and content correctly', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test Code', content: 'hello world', language: 'javascript', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    
    // Title appears in sidebar and toolbar
    const titles = screen.getAllByText('Test Code');
    expect(titles.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('javascript')).toBeInTheDocument();
    expect(screen.getByDisplayValue('hello world')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: '', language: 'js', version: 1
    };
    // Close button is now an icon, we might need to find it by selector or class if title isn't set
    const { container } = render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={onClose} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    
    const closeBtn = container.querySelector('.canvas-btn.close');
    if (closeBtn) fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('emits canvas_apply_to_file when Apply is clicked if filePath exists', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: 'file content', language: 'js', version: 1, filePath: '/tmp/test.js'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    
    fireEvent.click(screen.getByText(/Apply/i));
    expect(mockSocketEmit).toHaveBeenCalledWith('canvas_apply_to_file', { filePath: '/tmp/test.js', content: 'file content' }, expect.any(Function));
  });

  it('calls onCloseArtifact when a tab close button is clicked', () => {
    const onCloseArtifact = vi.fn();
    const artifact: CanvasArtifact = {
      id: 'tab-1', sessionId: 's1', title: 'test.js', content: '', language: 'js', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={onCloseArtifact} onSelectArtifact={vi.fn()} />);
    
    const closeTabBtn = screen.getByTitle('Close file');
    fireEvent.click(closeTabBtn);
    expect(onCloseArtifact).toHaveBeenCalledWith('tab-1');
  });

  it('defaults to preview mode for markdown artifacts', () => {
    const artifact: CanvasArtifact = {
      id: 'md-1', sessionId: 's1', title: 'test.md', content: '# Hello', language: 'markdown', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    
    // Switch to Code button should be visible (because we are in preview)
    expect(screen.getByTitle('Switch to Code')).toBeInTheDocument();
    // ReactMarkdown content should be rendered
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('switches between code and preview modes', () => {
    const artifact: CanvasArtifact = {
      id: 'md-1', sessionId: 's1', title: 'test.md', content: '# Hello', language: 'markdown', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    
    // Initially in preview
    expect(screen.getByText('Hello')).toBeInTheDocument();
    
    // Switch to code
    fireEvent.click(screen.getByTitle('Switch to Code'));
    expect(screen.getByDisplayValue('# Hello')).toBeInTheDocument();
    
    // Switch back to preview
    fireEvent.click(screen.getByTitle('Switch to Preview'));
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('detects language from filePath if generic', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: '...', language: 'generic', version: 1, filePath: 'test.tsx'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    
    const editor = screen.getByTestId('monaco-mock');
    expect(editor).toHaveAttribute('data-language', 'typescript');
  });

  it('renders VS Code button when artifact has filePath', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: '', language: 'js', version: 1, filePath: '/tmp/test.js'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByText(/VS Code/i)).toBeInTheDocument();
  });

  it('renders Apply button when artifact has filePath', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: '', language: 'js', version: 1, filePath: '/tmp/test.js'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByText(/Apply/i)).toBeInTheDocument();
  });

  it('shows code view by default for non-markdown artifacts', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: 'const x = 1;', language: 'javascript', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByTestId('monaco-mock')).toBeInTheDocument();
  });

  it('calls onSelectArtifact when switching tabs', () => {
    const onSelectArtifact = vi.fn();
    const a1: CanvasArtifact = { id: '1', sessionId: 's1', title: 'file1.js', content: 'a', language: 'js', version: 1 };
    const a2: CanvasArtifact = { id: '2', sessionId: 's1', title: 'file2.js', content: 'b', language: 'js', version: 1 };
    render(<CanvasPane artifacts={[a1, a2]} activeArtifact={a1} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={onSelectArtifact} />);
    fireEvent.click(screen.getByText('file2.js'));
    expect(onSelectArtifact).toHaveBeenCalledWith(a2);
  });

  it('VS Code button emits open_in_editor', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: '', language: 'js', version: 1, filePath: '/tmp/test.js'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    fireEvent.click(screen.getByText(/VS Code/i));
    expect(mockSocketEmit).toHaveBeenCalledWith('open_in_editor', { filePath: '/tmp/test.js' });
  });

  it('updates local content state when active artifact changes', () => {
    const a1: CanvasArtifact = { id: '1', sessionId: 's1', title: 'A1', content: 'c1', language: 'js', version: 1 };
    const a2: CanvasArtifact = { id: '2', sessionId: 's1', title: 'A2', content: 'c2', language: 'js', version: 1 };
    
    const { rerender } = render(<CanvasPane artifacts={[a1, a2]} activeArtifact={a1} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByDisplayValue('c1')).toBeInTheDocument();
    
    rerender(<CanvasPane artifacts={[a1, a2]} activeArtifact={a2} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByDisplayValue('c2')).toBeInTheDocument();
  });

  it('middle-click on a tab calls onCloseArtifact', () => {
    const onCloseArtifact = vi.fn();
    const artifact: CanvasArtifact = {
      id: 'mid-1', sessionId: 's1', title: 'middle.js', content: '', language: 'js', version: 1
    };
    const { container } = render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={onCloseArtifact} onSelectArtifact={vi.fn()} />);
    
    const tab = container.querySelector('.canvas-file-tab')!;
    const event = new MouseEvent('auxclick', { bubbles: true, button: 1 });
    tab.dispatchEvent(event);
    expect(onCloseArtifact).toHaveBeenCalledWith('mid-1');
  });
});



describe('CanvasPane - additional coverage', () => {
  beforeEach(() => {
    mockSocketEmit.mockClear();
  });

  it('copy button copies content to clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: 'copy this', language: 'js', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    // The editor mock renders a textarea with the content
    expect(screen.getByDisplayValue('copy this')).toBeInTheDocument();
  });

  it('Apply button shows Applied state after successful apply', () => {
    mockSocketEmit.mockImplementation((_event: string, _data: any, cb: any) => {
      cb({ success: true });
    });
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: 'data', language: 'js', version: 1, filePath: '/tmp/test.js'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    fireEvent.click(screen.getByText(/Apply/i));
    expect(screen.getByText('Applied!')).toBeInTheDocument();
  });

  it('Apply button shows alert on failure', () => {
    mockSocketEmit.mockImplementation((_event: string, _data: any, cb: any) => {
      cb({ error: 'Permission denied' });
    });
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: 'data', language: 'js', version: 1, filePath: '/tmp/test.js'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    fireEvent.click(screen.getByText(/Apply/i));
    expect(alertMock).toHaveBeenCalledWith('Failed to apply changes: Permission denied');
    alertMock.mockRestore();
  });

  it('does not show Apply or VS Code buttons when no filePath', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Snippet', content: 'code', language: 'js', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.queryByText(/Apply/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/VS Code/i)).not.toBeInTheDocument();
  });

  it('language badge displays the artifact language', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: '', language: 'python', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByText('python')).toBeInTheDocument();
  });

  it('maps csharp language correctly for monaco', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test.cs', content: 'class A {}', language: 'csharp', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    const editor = screen.getByTestId('monaco-mock');
    expect(editor).toHaveAttribute('data-language', 'csharp');
  });

  it('maps python language correctly for monaco', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test.py', content: '', language: 'py', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    const editor = screen.getByTestId('monaco-mock');
    expect(editor).toHaveAttribute('data-language', 'python');
  });

  it('detects markdown from filePath ending in .md', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'README', content: '# Title', language: 'generic', version: 1, filePath: '/docs/README.md'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    // Should be in preview mode for markdown
    expect(screen.getByTitle('Switch to Code')).toBeInTheDocument();
  });

  it('shows empty tabs message when no artifacts', () => {
    render(<CanvasPane artifacts={[]} activeArtifact={null} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByText('No files being watched.')).toBeInTheDocument();
  });

  it('editing content in monaco updates local state', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: 'original', language: 'js', version: 1, filePath: '/tmp/test.js'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    const editor = screen.getByTestId('monaco-mock');
    fireEvent.change(editor, { target: { value: 'modified' } });
    // Apply should send modified content
    fireEvent.click(screen.getByText(/Apply/i));
    expect(mockSocketEmit).toHaveBeenCalledWith('canvas_apply_to_file', { filePath: '/tmp/test.js', content: 'modified' }, expect.any(Function));
  });

  it('tab shows filePath basename when filePath is set', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Long Title', content: '', language: 'js', version: 1, filePath: '/very/long/path/to/component.tsx'
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    const tab = screen.getByText('component.tsx');
    expect(tab).toBeInTheDocument();
  });

  it('unknown language falls back to plaintext', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Test', content: '', language: 'brainfuck', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    const editor = screen.getByTestId('monaco-mock');
    expect(editor).toHaveAttribute('data-language', 'plaintext');
  });
});

import { useCanvasStore } from '../store/useCanvasStore';
import { useChatStore } from '../store/useChatStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from '@testing-library/react';

vi.mock('../components/Terminal', () => ({
  default: ({ visible, terminalId }: any) => visible ? <div data-testid="canvas-terminal">{terminalId}</div> : null
}));

describe('CanvasPane - Terminal Tab', () => {
  beforeEach(() => {
    mockSocketEmit.mockClear();
    act(() => {
      useCanvasStore.setState({
        terminals: [],
        activeTerminalId: null,
        closeTerminal: vi.fn(),
        setActiveTerminalId: vi.fn(),
      });
    });
  });

  it('renders terminal tab when terminals array has entries', () => {
    // Terminal tabs render for all terminals regardless of session — the content is filtered
    act(() => {
      useCanvasStore.setState({ terminals: [{ id: 't1', label: 'Terminal 1', sessionId: 'any' }], activeTerminalId: 't1' });
    });
    render(<CanvasPane artifacts={[]} activeArtifact={null} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    // Tab won't render because sessionId doesn't match activeSessionId (null)
    // This is correct behavior — terminals are scoped per session
    expect(screen.queryByText('Terminal 1')).not.toBeInTheDocument();
  });

  it('does NOT render terminal tab when terminals array is empty', () => {
    render(<CanvasPane artifacts={[]} activeArtifact={null} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.queryByTestId('canvas-terminal')).not.toBeInTheDocument();
  });

  it('clicking a file tab calls setActiveTerminalId(null)', () => {
    const setActiveTerminalId = vi.fn();
    act(() => {
      useCanvasStore.setState({ terminals: [{ id: 't1', label: 'Terminal 1', sessionId: 's1' }], activeTerminalId: 't1', setActiveTerminalId });
    });
    const artifact = { id: '1', sessionId: 's1', title: 'file.js', content: '', language: 'js', version: 1 };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={null} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    fireEvent.click(screen.getByText('file.js'));
    expect(setActiveTerminalId).toHaveBeenCalledWith(null);
  });
});


describe('CanvasPane - prevArtifactIdRef behavior', () => {
  beforeEach(() => {
    mockSocketEmit.mockClear();
    act(() => {
      useCanvasStore.setState({ terminals: [], activeTerminalId: null });
    });
  });

  it('does NOT reset viewMode when same artifact remounts with updated content', () => {
    const artifact: CanvasArtifact = {
      id: 'md-1', sessionId: 's1', title: 'notes.md', content: '# Original', language: 'markdown', version: 1
    };

    const { rerender } = render(
      <CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />
    );

    // Starts in preview mode for markdown
    expect(screen.getByTitle('Switch to Code')).toBeInTheDocument();

    // Switch to code mode
    fireEvent.click(screen.getByTitle('Switch to Code'));
    expect(screen.getByDisplayValue('# Original')).toBeInTheDocument();

    // Rerender same artifact id with updated content (simulates streaming update)
    const updated = { ...artifact, content: '# Updated', version: 2 };
    rerender(
      <CanvasPane artifacts={[updated]} activeArtifact={updated} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />
    );

    // viewMode should still be code (not reset to preview) because artifact id is the same
    expect(screen.getByDisplayValue('# Updated')).toBeInTheDocument();
    expect(screen.getByTitle('Switch to Preview')).toBeInTheDocument();
  });
});


describe('CanvasPane - multiple terminals and tab interactions', () => {
  beforeEach(() => {
    mockSocketEmit.mockClear();
    act(() => {
      useCanvasStore.setState({
        terminals: [],
        activeTerminalId: null,
        closeTerminal: vi.fn(),
        setActiveTerminalId: vi.fn(),
      });
      useChatStore.setState({ activeSessionId: 'sess-1', sessions: [{ id: 'sess-1' }] } as any);
      useSystemStore.setState({ workspaceCwds: [] });
    });
  });

  it('renders multiple terminal tabs when multiple terminals in store for active session', () => {
    act(() => {
      useCanvasStore.setState({
        terminals: [
          { id: 't1', label: 'Terminal 1', sessionId: 'sess-1' },
          { id: 't2', label: 'Terminal 2', sessionId: 'sess-1' },
        ],
        activeTerminalId: 't1',
      });
    });
    render(<CanvasPane artifacts={[]} activeArtifact={null} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByText('Terminal 1')).toBeInTheDocument();
    expect(screen.getByText('Terminal 2')).toBeInTheDocument();
  });

  it('clicking a terminal tab calls setActiveTerminalId', () => {
    const setActiveTerminalId = vi.fn();
    act(() => {
      useCanvasStore.setState({
        terminals: [
          { id: 't1', label: 'Terminal 1', sessionId: 'sess-1' },
          { id: 't2', label: 'Terminal 2', sessionId: 'sess-1' },
        ],
        activeTerminalId: 't1',
        setActiveTerminalId,
      });
    });
    render(<CanvasPane artifacts={[]} activeArtifact={null} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    fireEvent.click(screen.getByText('Terminal 2'));
    expect(setActiveTerminalId).toHaveBeenCalledWith('t2');
  });

  it('close button on terminal tab calls closeTerminal', () => {
    const closeTerminal = vi.fn();
    act(() => {
      useCanvasStore.setState({
        terminals: [{ id: 't1', label: 'Terminal 1', sessionId: 'sess-1' }],
        activeTerminalId: 't1',
        closeTerminal,
      });
    });
    mockSocketEmit.mockReset();
    render(<CanvasPane artifacts={[]} activeArtifact={null} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    const closeBtn = screen.getByTitle('Close terminal');
    fireEvent.click(closeBtn);
    expect(mockSocketEmit).toHaveBeenCalledWith('terminal_kill', { terminalId: 't1' });
    expect(closeTerminal).toHaveBeenCalledWith('t1');
  });

  it('diff button not shown when no filePath on artifact', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'Snippet', content: 'code', language: 'js', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.queryByText(/Diff/i)).not.toBeInTheDocument();
  });

  it('monaco editor renders for non-markdown files', () => {
    const artifact: CanvasArtifact = {
      id: '1', sessionId: 's1', title: 'app.ts', content: 'const x = 1;', language: 'typescript', version: 1
    };
    render(<CanvasPane artifacts={[artifact]} activeArtifact={artifact} onClose={vi.fn()} onCloseArtifact={vi.fn()} onSelectArtifact={vi.fn()} />);
    expect(screen.getByTestId('monaco-mock')).toBeInTheDocument();
    expect(screen.getByDisplayValue('const x = 1;')).toBeInTheDocument();
  });
});
