import { create } from 'zustand';

export type SettingsTab = 'session' | 'config' | 'rehydrate' | 'export' | 'danger';

interface UIState {
  // Sidebar
  isSidebarOpen: boolean;
  isSidebarPinned: boolean;
  expandedProviderId: string | null;
  
  // Modals
  isSettingsOpen: boolean;
  isSystemSettingsOpen: boolean;
  isNotesOpen: boolean;
  isFileExplorerOpen: boolean;
  settingsSessionId: string | null;
  settingsInitialTab: SettingsTab;
  isRestartModalOpen: boolean;
  isModelDropdownOpen: boolean;
  
  // Message Pagination
  visibleCount: number;
  
  // Scrolling
  isAutoScrollDisabled: boolean;

  // Actions
  setSidebarOpen: (isOpen: boolean) => void;
  setSidebarPinned: (isPinned: boolean) => void;
  setExpandedProviderId: (id: string | null) => void;
  toggleSidebarPinned: () => void;
  setSettingsOpen: (isOpen: boolean, sessionId?: string | null, initialTab?: SettingsTab) => void;
  setSystemSettingsOpen: (isOpen: boolean) => void;
  setNotesOpen: (isOpen: boolean) => void;
  setFileExplorerOpen: (isOpen: boolean) => void;
  setRestartModalOpen: (isOpen: boolean) => void;
  setModelDropdownOpen: (isOpen: boolean) => void;
  incrementVisibleCount: (amount: number) => void;
  resetVisibleCount: () => void;
  toggleAutoScroll: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  // Sidebar - Initialize from localStorage
  isSidebarOpen: localStorage.getItem('isSidebarPinned') === 'true',
  isSidebarPinned: localStorage.getItem('isSidebarPinned') === 'true',
  expandedProviderId: null,

  // Modals
  isSettingsOpen: false,
  isSystemSettingsOpen: false,
  isNotesOpen: false,
  isFileExplorerOpen: false,
  settingsSessionId: null,
  settingsInitialTab: 'session',
  isRestartModalOpen: false,
  isModelDropdownOpen: false,
  
  // Message Pagination
  visibleCount: 3,

  // Scrolling
  isAutoScrollDisabled: localStorage.getItem('isAutoScrollDisabled') === 'true',

  setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),
  setExpandedProviderId: (id) => set({ expandedProviderId: id }),
  setSidebarPinned: (isPinned) => {
    localStorage.setItem('isSidebarPinned', isPinned.toString());
    set({ isSidebarPinned: isPinned });
  },
  toggleSidebarPinned: () => set((state) => {
    const nextPinned = !state.isSidebarPinned;
    localStorage.setItem('isSidebarPinned', nextPinned.toString());
    return { isSidebarPinned: nextPinned };
  }),
  
  setSettingsOpen: (isOpen, sessionId = null, initialTab = 'session') => set({
    isSettingsOpen: isOpen, 
    settingsSessionId: isOpen ? sessionId : null,
    settingsInitialTab: isOpen ? initialTab : 'session',
  }),
  setSystemSettingsOpen: (isOpen) => set({ isSystemSettingsOpen: isOpen }),
  setNotesOpen: (isOpen) => set({ isNotesOpen: isOpen }),
  setFileExplorerOpen: (isOpen) => set({ isFileExplorerOpen: isOpen }),
  
  setRestartModalOpen: (isOpen) => set({ isRestartModalOpen: isOpen }),
  setModelDropdownOpen: (isOpen) => set({ isModelDropdownOpen: isOpen }),
  
  incrementVisibleCount: (amount) => set((state) => ({ visibleCount: state.visibleCount + amount })),
  resetVisibleCount: () => set({ visibleCount: 3 }),

  toggleAutoScroll: () => set((state) => {
    const newValue = !state.isAutoScrollDisabled;
    localStorage.setItem('isAutoScrollDisabled', newValue.toString());
    return { isAutoScrollDisabled: newValue };
  }),
}));
