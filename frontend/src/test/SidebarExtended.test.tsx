import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Sidebar from '../components/Sidebar';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { useFolderStore } from '../store/useFolderStore';
import { useUIStore } from '../store/useUIStore';

// Mock components
vi.mock('../components/SessionItem', () => ({ default: ({ session }: any) => <div data-testid="session-item">{session.name}</div> }));
vi.mock('../components/FolderItem', () => ({ default: ({ folder }: any) => <div data-testid="folder-item">{folder.name}</div> }));

describe('Sidebar Component', () => {
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: true };
    
    act(() => {
      useSystemStore.setState({ 
        socket: mockSocket, 
        activeProviderId: 'p1', 
        providersById: { p1: { providerId: 'p1', label: 'P1' } as any },
        orderedProviderIds: ['p1'],
        branding: { sessionLabel: 'Chat' } 
      } as any);
      useUIStore.setState({ isSidebarOpen: true, isSidebarPinned: false });
      useSessionLifecycleStore.setState({ 
        sessions: [
          { id: 's1', name: 'Chat 1', provider: 'p1', messages: [], isTyping: false },
          { id: 's2', name: 'Other', provider: 'p1', messages: [], isTyping: false }
        ] as any,
        activeSessionId: 's1'
      });
      useFolderStore.setState({ folders: [] });
    });
  });

  it('renders session items in the correct provider stack', () => {
    render(<Sidebar />);
    expect(screen.getAllByTestId('session-item')).toHaveLength(2);
  });

  it('filters sessions based on search input', () => {
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText(/Search/);
    fireEvent.change(searchInput, { target: { value: 'Other' } });
    
    expect(screen.getByTestId('session-item')).toHaveTextContent('Other');
    expect(screen.queryByText('Chat 1')).not.toBeInTheDocument();
  });

  it('handles "New Chat" click', () => {
    const handleNewChat = vi.fn();
    act(() => {
       useSessionLifecycleStore.setState({ handleNewChat });
    });

    render(<Sidebar />);
    const newChatBtn = screen.getByText('New Chat');
    fireEvent.click(newChatBtn);
    expect(handleNewChat).toHaveBeenCalled();
  });

  it('toggles pinned state of sidebar', () => {
    render(<Sidebar />);
    const pinBtn = screen.getByTitle('Pin Sidebar');
    fireEvent.click(pinBtn);
    expect(useUIStore.getState().isSidebarPinned).toBe(true);
  });
});
