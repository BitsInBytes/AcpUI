import { create } from 'zustand';
import type { Folder } from '../types';
import { useSystemStore } from './useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';

interface FolderState {
  folders: Folder[];
  expandedFolderIds: Set<string>;
  setFolders: (folders: Folder[]) => void;
  toggleFolder: (id: string) => void;
  loadFolders: () => void;
  createFolder: (name: string, parentId?: string | null, providerId?: string | null) => void;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
  moveFolder: (id: string, newParentId: string | null) => void;
  moveSessionToFolder: (sessionId: string, folderId: string | null) => void;
}

const EXPANDED_KEY = 'acpui-expanded-folders';

const loadExpanded = (): Set<string> => {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
};

const saveExpanded = (ids: Set<string>) => {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
};

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  expandedFolderIds: loadExpanded(),

  setFolders: (folders) => set({ folders }),

  toggleFolder: (id) => set(state => {
    const next = new Set(state.expandedFolderIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    saveExpanded(next);
    return { expandedFolderIds: next };
  }),

  loadFolders: () => {
    const socket = useSystemStore.getState().socket;
    socket?.emit('load_folders', (res: { folders?: Folder[] }) => {
      if (res.folders) set({ folders: res.folders });
    });
  },

  createFolder: (name, parentId = null, providerId = null) => {
    const socket = useSystemStore.getState().socket;
    socket?.emit('create_folder', { name, parentId, providerId }, (res: { folder?: Folder }) => {
      if (res.folder) {
        set(state => ({ folders: [...state.folders, res.folder!] }));
        // Auto-expand parent if creating inside one
        if (parentId) {
          set(state => {
            const next = new Set(state.expandedFolderIds);
            next.add(parentId);
            saveExpanded(next);
            return { expandedFolderIds: next };
          });
        }
      }
    });
  },

  renameFolder: (id, name) => {
    const socket = useSystemStore.getState().socket;
    socket?.emit('rename_folder', { id, name });
    set(state => ({
      folders: state.folders.map(f => f.id === id ? { ...f, name } : f)
    }));
  },

  deleteFolder: (id) => {
    const socket = useSystemStore.getState().socket;
    socket?.emit('delete_folder', { id });
    const deleted = get().folders.find(f => f.id === id);
    const parentId = deleted?.parentId ?? null;
    set(state => ({
      folders: state.folders
        .filter(f => f.id !== id)
        .map(f => f.parentId === id ? { ...f, parentId } : f)
    }));
    // Reparent sessions in local state
    useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => s.folderId === id ? { ...s, folderId: parentId } : s) }));
  },

  moveFolder: (id, newParentId) => {
    const socket = useSystemStore.getState().socket;
    socket?.emit('move_folder', { id, newParentId });
    set(state => ({
      folders: state.folders.map(f => f.id === id ? { ...f, parentId: newParentId } : f)
    }));
  },

  moveSessionToFolder: (sessionId, folderId) => {
    const socket = useSystemStore.getState().socket;
    socket?.emit('move_session_to_folder', { sessionId, folderId });
  }
}));
