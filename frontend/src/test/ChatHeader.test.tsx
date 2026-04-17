import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ChatHeader from '../components/ChatHeader/ChatHeader';
import { useSystemStore } from '../store/useSystemStore';
import { useChatStore } from '../store/useChatStore';
import { useUIStore } from '../store/useUIStore';

describe('ChatHeader', () => {
  beforeEach(() => {
    act(() => {
      useSystemStore.setState({ connected: true, isEngineReady: true });
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test Session', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
        activeSessionId: 's1',
      });
      useUIStore.setState({ 
        isAutoScrollDisabled: false, 
        isSidebarOpen: false,
        toggleAutoScroll: vi.fn(),
        setSidebarOpen: vi.fn()
      });
    });
  });

  it('renders session name correctly', () => {
    render(<ChatHeader />);
    expect(screen.getByText('Test Session')).toBeInTheDocument();
  });

  it('applies disconnected class when not connected', () => {
    act(() => { useSystemStore.setState({ connected: false }); });
    const { container } = render(<ChatHeader />);
    expect(container.querySelector('header')).toHaveClass('disconnected');
  });

  it('shows CWD label when session has matching cwd', () => {
    act(() => {
      useSystemStore.setState({ workspaceCwds: [{ label: 'CE', path: '/mnt/c/repos/ce' }] });
      useChatStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null, cwd: '/mnt/c/repos/ce' }],
        activeSessionId: 's1',
      });
    });
    render(<ChatHeader />);
    expect(screen.getByText('(CE)')).toBeInTheDocument();
  });

  it('sidebar button calls setSidebarOpen', () => {
    const mockSetSidebar = vi.fn();
    act(() => { useUIStore.setState({ setSidebarOpen: mockSetSidebar }); });
    render(<ChatHeader />);
    screen.getByTitle('Open Sidebar').click();
    expect(mockSetSidebar).toHaveBeenCalledWith(true);
  });
});
