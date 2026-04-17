 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FileExplorer from '../components/FileExplorer';
import { useSystemStore } from '../store/useSystemStore';
import { useUIStore } from '../store/useUIStore';

describe('FileExplorer', () => {
  const mockSocket = {
    emit: vi.fn((event: string, ...args: any[]) => {
      if (event === 'explorer_root') {
        const cb = args[0];
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
    expect(mockSocket.emit).toHaveBeenCalledWith('explorer_read', { filePath: 'settings.json' }, expect.any(Function));
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
    expect(mockSocket.emit).toHaveBeenCalledWith('explorer_list', { dirPath: 'agents' }, expect.any(Function));
  });

  it('closes on overlay click', () => {
    render(<FileExplorer />);
    fireEvent.click(document.querySelector('.file-explorer-overlay')!);
    expect(useUIStore.getState().isFileExplorerOpen).toBe(false);
  });
});
