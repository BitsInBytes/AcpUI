 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FileExplorer from '../components/FileExplorer';
import { useSystemStore } from '../store/useSystemStore';
import { useUIStore } from '../store/useUIStore';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea data-testid="monaco-mock" value={value} onChange={(e) => onChange?.(e.target.value)} />
  )
}));

describe('FileExplorer', () => {
  const mockSocket = {
    emit: vi.fn((event: string, ...args: any[]) => {
      if (event === 'explorer_root') {
        const cb = typeof args[0] === 'function' ? args[0] : args[1];
        cb({ root: '~/.agent-data' });
      }
      if (event === 'explorer_list') {
        const cb = args[1];
        cb({ items: [
          { name: 'agents', isDirectory: true },
          { name: 'settings.json', isDirectory: false },
          { name: 'notes.md', isDirectory: false },
        ]});
      }
      if (event === 'explorer_read') {
        const cb = args[1];
        const path = args[0]?.filePath;
        if (path?.endsWith('.md')) cb({ content: '# Hello\nWorld', filePath: path });
        else cb({ content: '{"key": "value"}', filePath: path });
      }
      if (event === 'explorer_write') {
        const cb = args[1];
        cb({ success: true });
      }
    }),
    on: vi.fn(),
    off: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: mockSocket as any });
      useSystemStore.setState({ defaultProviderId: 'test-provider', activeProviderId: 'test-provider' });
      useUIStore.setState({ isFileExplorerOpen: true });
    });
  });

  it('renders when open', () => {
    render(<FileExplorer />);
    expect(screen.getByText('~/.agent-data')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    act(() => { useUIStore.setState({ isFileExplorerOpen: false }); });
    const { container } = render(<FileExplorer />);
    expect(container.innerHTML).toBe('');
  });

  it('loads and displays root directory', () => {
    render(<FileExplorer />);
    expect(screen.getByText('agents')).toBeInTheDocument();
    expect(screen.getByText('settings.json')).toBeInTheDocument();
    expect(screen.getByText('notes.md')).toBeInTheDocument();
  });

  it('shows empty state when no file selected', () => {
    render(<FileExplorer />);
    expect(screen.getByText('Select a file to view or edit')).toBeInTheDocument();
  });

  it('opens a file on click', () => {
    render(<FileExplorer />);
    fireEvent.click(screen.getByText('settings.json'));
    expect(mockSocket.emit).toHaveBeenCalledWith('explorer_read', expect.objectContaining({ providerId: 'test-provider', filePath: 'settings.json' }), expect.any(Function));
    // File path shown in editor header
    expect(screen.getByText('settings.json', { selector: '.fe-file-path' })).toBeInTheDocument();
  });

  it('opens MD file with preview mode', () => {
    render(<FileExplorer />);
    fireEvent.click(screen.getByText('notes.md'));
    // MD files open in preview mode by default
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('toggles between preview and edit for MD files', () => {
    render(<FileExplorer />);
    fireEvent.click(screen.getByText('notes.md'));
    // MD files open in preview mode — shows rendered markdown
    expect(screen.getByText('Hello')).toBeInTheDocument();
    // Click toggle to switch to edit (Monaco) — just verify preview disappears
    const toggleBtn = screen.getByTitle('Edit');
    fireEvent.click(toggleBtn);
    expect(screen.queryByText('Hello')).not.toBeInTheDocument();
  });

  it('expands directory on click', () => {
    render(<FileExplorer />);
    fireEvent.click(screen.getByText('agents'));
    expect(mockSocket.emit).toHaveBeenCalledWith('explorer_list', expect.objectContaining({ providerId: 'test-provider', dirPath: 'agents' }), expect.any(Function));
  });

  it('closes on overlay click', () => {
    render(<FileExplorer />);
    fireEvent.click(document.querySelector('.file-explorer-overlay')!);
    expect(useUIStore.getState().isFileExplorerOpen).toBe(false);
  });

  it('keeps dirty state and shows error when manual save fails', () => {
    mockSocket.emit.mockImplementation((event: string, ...args: any[]) => {
      if (event === 'explorer_root') {
        const cb = typeof args[0] === 'function' ? args[0] : args[1];
        cb({ root: '~/.agent-data' });
      }
      if (event === 'explorer_list') {
        const cb = args[1];
        cb({ items: [{ name: 'settings.json', isDirectory: false }] });
      }
      if (event === 'explorer_read') {
        const cb = args[1];
        cb({ content: '{"key":"value"}', filePath: 'settings.json' });
      }
      if (event === 'explorer_write') {
        const cb = args[1];
        cb({ error: 'write failed' });
      }
    });

    render(<FileExplorer />);
    fireEvent.click(screen.getByText('settings.json'));
    fireEvent.change(screen.getByTestId('monaco-mock'), { target: { value: '{"key":"changed"}' } });
    fireEvent.click(screen.getByText('Save'));

    expect(screen.getByRole('alert')).toHaveTextContent('write failed');
    expect(screen.getByText('●')).toBeInTheDocument();
  });

  it('clears dirty state only after autosave callback success', () => {
    vi.useFakeTimers();
    mockSocket.emit.mockImplementation((event: string, ...args: any[]) => {
      if (event === 'explorer_root') {
        const cb = typeof args[0] === 'function' ? args[0] : args[1];
        cb({ root: '~/.agent-data' });
      }
      if (event === 'explorer_list') {
        const cb = args[1];
        cb({ items: [{ name: 'settings.json', isDirectory: false }] });
      }
      if (event === 'explorer_read') {
        const cb = args[1];
        cb({ content: '{"key":"value"}', filePath: 'settings.json' });
      }
      if (event === 'explorer_write') {
        const cb = args[1];
        cb({ success: true });
      }
    });

    render(<FileExplorer />);
    fireEvent.click(screen.getByText('settings.json'));
    fireEvent.change(screen.getByTestId('monaco-mock'), { target: { value: '{"key":"changed"}' } });

    expect(screen.getByText('●')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText('●')).not.toBeInTheDocument();

    vi.useRealTimers();
  });
});
