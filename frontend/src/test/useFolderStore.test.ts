import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFolderStore } from '../store/useFolderStore';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { act } from 'react';

describe('useFolderStore (Pure Logic)', () => {
  let mockSocket: any;

  beforeEach(() => {
    mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: true };
    act(() => {
      useSystemStore.setState({ socket: mockSocket });
      useFolderStore.setState({ folders: [], expandedFolderIds: new Set() });
    });
  });

  it('createFolder emits and updates local state', () => {
    mockSocket.emit.mockImplementation((event: string, _params: any, cb: any) => {
        if (event === 'create_folder') cb({ folder: { id: 'f1', name: 'New Folder', parentId: null, position: 0 } });
    });

    act(() => {
        useFolderStore.getState().createFolder('New Folder');
    });

    expect(useFolderStore.getState().folders).toHaveLength(1);
    expect(useFolderStore.getState().folders[0].id).toBe('f1');
  });

  it('deleteFolder reparents sub-folders and sessions', () => {
    const f1 = { id: 'f1', name: 'F1', parentId: null, position: 0 };
    const f2 = { id: 'f2', name: 'F2', parentId: 'f1', position: 0 };
    const s1 = { id: 's1', folderId: 'f1' } as any;

    act(() => {
        useFolderStore.setState({ folders: [f1, f2] });
        useSessionLifecycleStore.setState({ sessions: [s1] });
        useFolderStore.getState().deleteFolder('f1');
    });

    expect(useFolderStore.getState().folders).toHaveLength(1);
    expect(useFolderStore.getState().folders[0].parentId).toBeNull();
    expect(useSessionLifecycleStore.getState().sessions[0].folderId).toBeNull();
    expect(mockSocket.emit).toHaveBeenCalledWith('delete_folder', { id: 'f1' });
  });

  it('loadFolders emits and sets folders', () => {
    mockSocket.emit.mockImplementation((event: string, paramsOrCb: any, cb?: any) => {
        const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
        if (event === 'load_folders') callback?.({ folders: [{ id: 'f1', name: 'F1', parentId: null, position: 0 }] });
    });
    act(() => { useFolderStore.getState().loadFolders(); });
    expect(useFolderStore.getState().folders).toHaveLength(1);
  });

  it('renameFolder emits and updates local state', () => {
    act(() => {
        useFolderStore.setState({ folders: [{ id: 'f1', name: 'Old', parentId: null, position: 0 }] });
        useFolderStore.getState().renameFolder('f1', 'New');
    });
    expect(useFolderStore.getState().folders[0].name).toBe('New');
    expect(mockSocket.emit).toHaveBeenCalledWith('rename_folder', { id: 'f1', name: 'New' });
  });

  it('moveFolder emits and updates local state', () => {
    act(() => {
        useFolderStore.setState({ folders: [{ id: 'f1', name: 'F1', parentId: null, position: 0 }] });
        useFolderStore.getState().moveFolder('f1', 'parent-1');
    });
    expect(useFolderStore.getState().folders[0].parentId).toBe('parent-1');
    expect(mockSocket.emit).toHaveBeenCalledWith('move_folder', { id: 'f1', newParentId: 'parent-1' });
  });

  it('moveSessionToFolder emits socket event', () => {
    act(() => {
        useFolderStore.getState().moveSessionToFolder('s1', 'f1');
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('move_session_to_folder', { sessionId: 's1', folderId: 'f1' });
  });

  it('toggleFolder manages expanded set', () => {
    act(() => { useFolderStore.getState().toggleFolder('f1'); });
    expect(useFolderStore.getState().expandedFolderIds.has('f1')).toBe(true);

    act(() => { useFolderStore.getState().toggleFolder('f1'); });
    expect(useFolderStore.getState().expandedFolderIds.has('f1')).toBe(false);
  });
});
