import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ChatHeader from '../components/ChatHeader/ChatHeader';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { useUIStore } from '../store/useUIStore';

describe('ChatHeader Component', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: true };
    
    act(() => {
      useSystemStore.setState({ 
          socket: mockSocket, 
          connected: true,
          isEngineReady: true,
          workspaceCwds: [],
          activeProviderId: 'p1', 
          branding: { appHeader: 'Default Title' } 
      } as any);
      useSessionLifecycleStore.setState({ 
        activeSessionId: 's1',
        sessions: [{ id: 's1', name: 'Test Chat', model: 'balanced', acpSessionId: 'a1' } as any]
      });
    });
  });

  it('renders session name correctly', () => {
    render(<ChatHeader />);
    expect(screen.getByText('Test Chat')).toBeInTheDocument();
  });

  it('handles "System Settings" button click', () => {
    render(<ChatHeader />);
    const settingsBtn = screen.getByTitle('System Settings');
    fireEvent.click(settingsBtn);
    expect(useUIStore.getState().isSystemSettingsOpen).toBe(true);
  });

  it('handles "File Explorer" button click', () => {
    render(<ChatHeader />);
    const feBtn = screen.getByTitle('File Explorer');
    fireEvent.click(feBtn);
    expect(useUIStore.getState().isFileExplorerOpen).toBe(true);
  });

  it('renders app header fallback if no active session', () => {
    act(() => {
       useSessionLifecycleStore.setState({ activeSessionId: null });
    });
    render(<ChatHeader />);
    expect(screen.getByText('Default Title')).toBeInTheDocument();
  });

  it('hides sidebar menu and action buttons in pop-out mode', () => {
    // Mock window.location.search
    const originalLocation = window.location;
    delete (window as any).location;
    (window as any).location = { ...originalLocation, search: '?popout=s1' };

    render(<ChatHeader />);
    
    expect(screen.queryByTitle('Open Sidebar')).not.toBeInTheDocument();
    expect(screen.queryByTitle('File Explorer')).not.toBeInTheDocument();
    expect(screen.queryByTitle('System Settings')).not.toBeInTheDocument();

    // Restore location
    (window as any).location = originalLocation;
  });
});
