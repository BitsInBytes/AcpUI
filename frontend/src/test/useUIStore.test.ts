import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUIStore } from '../store/useUIStore';
import { act } from 'react-dom/test-utils';

describe('useUIStore (Pure Logic)', () => {
  beforeEach(() => {
    // Reset localStorage mock
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    vi.spyOn(Storage.prototype, 'setItem');

    act(() => {
        useUIStore.setState({
            isSidebarOpen: false,
            isSidebarPinned: false,
            isSettingsOpen: false,
            isSystemSettingsOpen: false,
            visibleCount: 3,
            isAutoScrollDisabled: false
        });
    });
  });

  it('setSidebarOpen updates state', () => {
    act(() => { useUIStore.getState().setSidebarOpen(true); });
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
  });

  it('toggleSidebarPinned updates state and localStorage', () => {
    act(() => { useUIStore.getState().toggleSidebarPinned(); });
    expect(useUIStore.getState().isSidebarPinned).toBe(true);
    expect(localStorage.setItem).toHaveBeenCalledWith('isSidebarPinned', 'true');
  });

  it('setSettingsOpen manages session ID and tab', () => {
    act(() => { 
        useUIStore.getState().setSettingsOpen(true, 's1', 'config'); 
    });
    const state = useUIStore.getState();
    expect(state.isSettingsOpen).toBe(true);
    expect(state.settingsSessionId).toBe('s1');
    expect(state.settingsInitialTab).toBe('config');

    act(() => { useUIStore.getState().setSettingsOpen(false); });
    expect(useUIStore.getState().settingsSessionId).toBeNull();
  });

  it('incrementVisibleCount and resetVisibleCount manage pagination', () => {
    act(() => { useUIStore.getState().incrementVisibleCount(10); });
    expect(useUIStore.getState().visibleCount).toBe(13);

    act(() => { useUIStore.getState().resetVisibleCount(); });
    expect(useUIStore.getState().visibleCount).toBe(3);
  });

  it('setExpandedProviderId updates state', () => {
    act(() => { useUIStore.getState().setExpandedProviderId('p1'); });
    expect(useUIStore.getState().expandedProviderId).toBe('p1');
  });

  it('setRestartModalOpen updates state', () => {
    act(() => { useUIStore.getState().setRestartModalOpen(true); });
    expect(useUIStore.getState().isRestartModalOpen).toBe(true);
  });

  it('setModelDropdownOpen updates state', () => {
    act(() => { useUIStore.getState().setModelDropdownOpen(true); });
    expect(useUIStore.getState().isModelDropdownOpen).toBe(true);
  });

  it('setNotesOpen and setFileExplorerOpen update state', () => {
    act(() => { useUIStore.getState().setNotesOpen(true); });
    expect(useUIStore.getState().isNotesOpen).toBe(true);

    act(() => { useUIStore.getState().setFileExplorerOpen(true); });
    expect(useUIStore.getState().isFileExplorerOpen).toBe(true);
  });

  it('toggleAutoScroll updates state and localStorage', () => {
    act(() => { useUIStore.getState().toggleAutoScroll(); });
    expect(useUIStore.getState().isAutoScrollDisabled).toBe(true);
    expect(localStorage.setItem).toHaveBeenCalledWith('isAutoScrollDisabled', 'true');
  });
});
