 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FolderItem from '../components/FolderItem';
import { useFolderStore } from '../store/useFolderStore';
import type { Folder, ChatSession } from '../types';

const folders: Folder[] = [
  { id: 'f1', name: 'Work', parentId: null, position: 0 },
  { id: 'f2', name: 'Sub', parentId: 'f1', position: 0 },
];

const sessions: ChatSession[] = [
  { id: 's1', name: 'Chat 1', folderId: 'f1', acpSessionId: null, messages: [], isTyping: false, isWarmingUp: false, model: 'flagship' },
  { id: 's2', name: 'Chat 2', folderId: 'f2', acpSessionId: null, messages: [], isTyping: false, isWarmingUp: false, model: 'flagship' },
];

const defaultProps = {
  folders,
  sessions,
  activeSessionId: null,
  depth: 0,
  onSelectSession: vi.fn(),
  onRenameSession: vi.fn(),
  onTogglePin: vi.fn(),
  onArchiveSession: vi.fn(),
  onSettingsSession: vi.fn(),
  onDropSession: vi.fn(),
  onDropFolder: vi.fn(),
};

describe('FolderItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useFolderStore.setState({ folders, expandedFolderIds: new Set() });
    });
  });

  it('renders folder name', () => {
    render(<FolderItem folder={folders[0]} {...defaultProps} />);
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('shows child count', () => {
    render(<FolderItem folder={folders[0]} {...defaultProps} />);
    // f1 has 1 child folder (f2) + 1 session (s1) = 2
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('expands on click to show children', () => {
    render(<FolderItem folder={folders[0]} {...defaultProps} />);
    expect(screen.queryByText('Chat 1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Work'));
    expect(screen.getByText('Chat 1')).toBeInTheDocument();
    expect(screen.getByText('Sub')).toBeInTheDocument();
  });

  it('enters rename mode on right-click', () => {
    render(<FolderItem folder={folders[0]} {...defaultProps} />);
    fireEvent.contextMenu(screen.getByText('Work'));
    expect(screen.getByDisplayValue('Work')).toBeInTheDocument();
  });

  it('saves rename on Enter', () => {
    const renameFolder = vi.fn();
    act(() => { useFolderStore.setState({ renameFolder } as any); });

    render(<FolderItem folder={folders[0]} {...defaultProps} />);
    fireEvent.contextMenu(screen.getByText('Work'));

    const input = screen.getByDisplayValue('Work');
    fireEvent.change(input, { target: { value: 'Projects' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(renameFolder).toHaveBeenCalledWith('f1', 'Projects');
  });

  it('cancels rename on Escape', () => {
    render(<FolderItem folder={folders[0]} {...defaultProps} />);
    fireEvent.contextMenu(screen.getByText('Work'));

    const input = screen.getByDisplayValue('Work');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Work')).not.toBeInTheDocument();
  });

  it('handles drop of session onto folder', () => {
    render(<FolderItem folder={folders[0]} {...defaultProps} />);
    const folderRow = screen.getByText('Work').closest('.folder-row')!;

    fireEvent.dragEnter(folderRow, { dataTransfer: { getData: () => '', setData: () => {} } });
    fireEvent.drop(folderRow, {
      dataTransfer: {
        getData: (type: string) => type === 'session-id' ? 's3' : '',
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(defaultProps.onDropSession).toHaveBeenCalledWith('s3', 'f1');
  });

  it('handles drop of folder onto folder', () => {
    render(<FolderItem folder={folders[0]} {...defaultProps} />);
    const folderRow = screen.getByText('Work').closest('.folder-row')!;

    fireEvent.drop(folderRow, {
      dataTransfer: {
        getData: (type: string) => type === 'folder-id' ? 'f-other' : '',
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(defaultProps.onDropFolder).toHaveBeenCalledWith('f-other', 'f1');
  });
});



describe('FolderItem - fork rendering', () => {
  const forkFolders: Folder[] = [
    { id: 'f1', name: 'Work', parentId: null, position: 0 },
  ];

  const forkSessions: ChatSession[] = [
    { id: 's1', name: 'Parent Chat', folderId: 'f1', acpSessionId: null, messages: [], isTyping: false, isWarmingUp: false, model: 'flagship' },
    { id: 's-fork', name: 'Parent Chat (fork)', folderId: 'f1', acpSessionId: null, messages: [], isTyping: false, isWarmingUp: false, model: 'flagship', forkedFrom: 's1', forkPoint: 2 },
  ];

  const forkProps = {
    ...defaultProps,
    folders: forkFolders,
    sessions: forkSessions,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useFolderStore.setState({ folders: forkFolders, expandedFolderIds: new Set(['f1']) });
    });
  });

  it('renders fork-indent for forked sessions inside folders', () => {
    const { container } = render(<FolderItem folder={forkFolders[0]} {...forkProps} />);
    const forkIndent = container.querySelector('.fork-indent');
    expect(forkIndent).toBeInTheDocument();
    expect(forkIndent!.textContent).toContain('Parent Chat (fork)');
  });

  it('shows fork arrow for forked sessions', () => {
    const { container } = render(<FolderItem folder={forkFolders[0]} {...forkProps} />);
    const forkArrow = container.querySelector('.fork-arrow');
    expect(forkArrow).toBeInTheDocument();
    expect(forkArrow!.textContent).toBe('↳');
  });
});
