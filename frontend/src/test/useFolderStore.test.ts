import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { useFolderStore } from '../store/useFolderStore';
import { useSystemStore } from '../store/useSystemStore';
import { useChatStore } from '../store/useChatStore';
import type { Folder } from '../types';

const mockSocket = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn()
};

const testFolders: Folder[] = [
  { id: 'f1', name: 'Work', parentId: null, position: 0 },
  { id: 'f2', name: 'Personal', parentId: null, position: 1 },
  { id: 'f3', name: 'Sub', parentId: 'f1', position: 0 },
];

describe('useFolderStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    act(() => {
       
      useSystemStore.setState({ socket: mockSocket as any });
      useFolderStore.setState({ folders: [], expandedFolderIds: new Set() });
      useChatStore.setState({ sessions: [] });
    });
  });

  it('setFolders updates folder list', () => {
    act(() => { useFolderStore.getState().setFolders(testFolders); });
    expect(useFolderStore.getState().folders).toHaveLength(3);
  });

  it('toggleFolder expands and collapses', () => {
    act(() => { useFolderStore.getState().toggleFolder('f1'); });
    expect(useFolderStore.getState().expandedFolderIds.has('f1')).toBe(true);
    act(() => { useFolderStore.getState().toggleFolder('f1'); });
    expect(useFolderStore.getState().expandedFolderIds.has('f1')).toBe(false);
  });

  it('loadFolders emits socket event and sets folders', () => {
    mockSocket.emit.mockImplementation((event: string, cb: (res: { folders: Folder[] }) => void) => {
      if (event === 'load_folders') cb({ folders: testFolders });
    });
    act(() => { useFolderStore.getState().loadFolders(); });
    expect(mockSocket.emit).toHaveBeenCalledWith('load_folders', expect.any(Function));
    expect(useFolderStore.getState().folders).toHaveLength(3);
  });

  it('createFolder emits and adds to state', () => {
    mockSocket.emit.mockImplementation((event: string, _data: unknown, cb: (res: { folder: Folder }) => void) => {
      if (event === 'create_folder') cb({ folder: { id: 'f4', name: 'New', parentId: null, position: 0 } });
    });
    act(() => { useFolderStore.getState().createFolder('New'); });
    expect(useFolderStore.getState().folders).toHaveLength(1);
    expect(useFolderStore.getState().folders[0].name).toBe('New');
  });

  it('createFolder with parentId auto-expands parent', () => {
    mockSocket.emit.mockImplementation((event: string, _data: unknown, cb: (res: { folder: Folder }) => void) => {
      if (event === 'create_folder') cb({ folder: { id: 'f5', name: 'Child', parentId: 'f1', position: 0 } });
    });
    act(() => { useFolderStore.getState().createFolder('Child', 'f1'); });
    expect(useFolderStore.getState().expandedFolderIds.has('f1')).toBe(true);
  });

  it('renameFolder updates name optimistically', () => {
    act(() => { useFolderStore.setState({ folders: [...testFolders] }); });
    act(() => { useFolderStore.getState().renameFolder('f1', 'Renamed'); });
    expect(mockSocket.emit).toHaveBeenCalledWith('rename_folder', { id: 'f1', name: 'Renamed' });
    expect(useFolderStore.getState().folders.find(f => f.id === 'f1')?.name).toBe('Renamed');
  });

  it('deleteFolder reparents child folders and sessions', () => {
    act(() => {
      useFolderStore.setState({ folders: [...testFolders] });
      useChatStore.setState({
        sessions: [
          { id: 's1', name: 'Chat', folderId: 'f1', acpSessionId: null, messages: [], isTyping: false, isWarmingUp: false, model: 'flagship' },
          { id: 's2', name: 'Other', folderId: 'f3', acpSessionId: null, messages: [], isTyping: false, isWarmingUp: false, model: 'flagship' },
        ]
      });
    });

    act(() => { useFolderStore.getState().deleteFolder('f1'); });

    // f1 removed, f3 reparented to null (f1's parent)
    const folders = useFolderStore.getState().folders;
    expect(folders.find(f => f.id === 'f1')).toBeUndefined();
    expect(folders.find(f => f.id === 'f3')?.parentId).toBeNull();

    // s1 reparented to null, s2 unchanged (was in f3, not f1)
    const sessions = useChatStore.getState().sessions;
    expect(sessions.find(s => s.id === 's1')?.folderId).toBeNull();
    expect(sessions.find(s => s.id === 's2')?.folderId).toBe('f3');
  });

  it('moveFolder updates parentId optimistically', () => {
    act(() => { useFolderStore.setState({ folders: [...testFolders] }); });
    act(() => { useFolderStore.getState().moveFolder('f2', 'f1'); });
    expect(mockSocket.emit).toHaveBeenCalledWith('move_folder', { id: 'f2', newParentId: 'f1' });
    expect(useFolderStore.getState().folders.find(f => f.id === 'f2')?.parentId).toBe('f1');
  });

  it('moveSessionToFolder emits socket event', () => {
    act(() => { useFolderStore.getState().moveSessionToFolder('s1', 'f1'); });
    expect(mockSocket.emit).toHaveBeenCalledWith('move_session_to_folder', { sessionId: 's1', folderId: 'f1' });
  });

  describe('localStorage persistence', () => {
    it('toggleFolder saves expanded state to localStorage', () => {
      act(() => { useFolderStore.getState().toggleFolder('f1'); });
      const stored = JSON.parse(localStorage.getItem('acpui-expanded-folders') || '[]');
      expect(stored).toContain('f1');
    });

    it('toggleFolder removes from localStorage on collapse', () => {
      act(() => { useFolderStore.getState().toggleFolder('f1'); });
      act(() => { useFolderStore.getState().toggleFolder('f1'); });
      const stored = JSON.parse(localStorage.getItem('acpui-expanded-folders') || '[]');
      expect(stored).not.toContain('f1');
    });

    it('createFolder with parentId saves expanded parent to localStorage', () => {
      mockSocket.emit.mockImplementation((event: string, _data: unknown, cb: (res: { folder: Folder }) => void) => {
        if (event === 'create_folder') cb({ folder: { id: 'f5', name: 'Child', parentId: 'f1', position: 0 } });
      });
      act(() => { useFolderStore.getState().createFolder('Child', 'f1'); });
      const stored = JSON.parse(localStorage.getItem('acpui-expanded-folders') || '[]');
      expect(stored).toContain('f1');
    });
  });
});
