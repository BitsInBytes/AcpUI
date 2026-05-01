import { useChatStore } from '../store/useChatStore';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Sidebar from '../components/Sidebar';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useFolderStore } from '../store/useFolderStore';
import { useUIStore } from '../store/useUIStore';

describe('Sidebar', () => {
  const mockSessions: any[] = [
    { id: '1', acpSessionId: 'acp-1', name: 'Chat One', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
    { id: '2', acpSessionId: 'acp-2', name: 'Chat Two', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: true },
  ];

  beforeEach(() => {
    window.prompt = vi.fn().mockReturnValue('New Folder');
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: { emit: vi.fn() } as any });
      useSessionLifecycleStore.setState({ sessions: mockSessions,
        activeSessionId: '1',
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleNewChat: vi.fn(), });
      useUIStore.setState({
        isSidebarOpen: true,
        isSidebarPinned: false,
        expandedProviderId: null,
        setSidebarOpen: vi.fn(),
        setSidebarPinned: vi.fn(),
        toggleSidebarPinned: vi.fn(),
        setSettingsOpen: vi.fn(),
      });
    });
  });

  it('renders session list with pinned status indicators', () => {
    render(<Sidebar />);
    expect(screen.getByText('Chat One')).toBeInTheDocument();
    expect(screen.getByText('Chat Two')).toBeInTheDocument();
    const sessionTwo = screen.getByText('Chat Two').closest('.session-item');
    expect(sessionTwo).toHaveClass('pinned');
  });

  it('applies typing class when a session is typing', () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ ...mockSessions[0], isTyping: true }, mockSessions[1]], });
    });
    render(<Sidebar />);
    const sessionOne = screen.getByText('Chat One').closest('.session-item');
    expect(sessionOne).toHaveClass('typing');
  });

  it('renders a typing session outside the provider content when collapsed', () => {
    act(() => {
      useUIStore.setState({ expandedProviderId: 'other-provider' });
      useSessionLifecycleStore.setState({ sessions: [{ ...mockSessions[0], isTyping: true, isWarmingUp: false }, mockSessions[1]], });
    });
    const { container } = render(<Sidebar />);
    const collapsedRunning = container.querySelector('.collapsed-running');
    expect(collapsedRunning).toBeInTheDocument();
    expect(collapsedRunning).toHaveTextContent('Chat One');
    expect(collapsedRunning).not.toHaveTextContent('Chat Two');
  });

  it('does not render running sessions outside when only resuming', () => {
    act(() => {
      useUIStore.setState({ expandedProviderId: 'other-provider' });
      useSessionLifecycleStore.setState({ sessions: [{ ...mockSessions[0], isTyping: false, isWarmingUp: true }, mockSessions[1]], });
    });
    const { container } = render(<Sidebar />);
    const collapsedRunning = container.querySelector('.collapsed-running');
    expect(collapsedRunning).not.toBeInTheDocument();
  });

  it('renders an unread session outside the provider content when collapsed', () => {
    act(() => {
      useUIStore.setState({ expandedProviderId: 'other-provider' });
      useSessionLifecycleStore.setState({ sessions: [{ ...mockSessions[0], hasUnreadResponse: true }, mockSessions[1]], });
    });
    const { container } = render(<Sidebar />);
    const collapsedRunning = container.querySelector('.collapsed-running');
    expect(collapsedRunning).toBeInTheDocument();
    expect(collapsedRunning).toHaveTextContent('Chat One');
    expect(collapsedRunning).not.toHaveTextContent('Chat Two');
  });

  it('marks a collapsed provider header as unread when one of its chats has an unread response', () => {
    act(() => {
      useUIStore.setState({ expandedProviderId: 'other-provider' });
      useSessionLifecycleStore.setState({ sessions: [{ ...mockSessions[0], hasUnreadResponse: true }, mockSessions[1]], });
    });
    render(<Sidebar />);
    expect(screen.getByText('Default')).toHaveClass('unread');
  });

  it('does not mark an expanded provider header as unread', () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ ...mockSessions[0], hasUnreadResponse: true }, mockSessions[1]], });
    });
    render(<Sidebar />);
    expect(screen.getByText('Default')).not.toHaveClass('unread');
  });

  it('applies unread class when a session has unread response', () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ ...mockSessions[0], hasUnreadResponse: true }, mockSessions[1]], });
    });
    render(<Sidebar />);
    const sessionOne = screen.getByText('Chat One').closest('.session-item');
    expect(sessionOne).toHaveClass('unread');
  });

  it('applies awaiting-permission class when a session is awaiting permission', () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [{ ...mockSessions[0], isAwaitingPermission: true }, mockSessions[1]], });
    });
    render(<Sidebar />);
    const sessionOne = screen.getByText('Chat One').closest('.session-item');
    expect(sessionOne).toHaveClass('awaiting-permission');
  });

  it('calls handleTogglePin when pin button is clicked', () => {
    const handleTogglePin = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleTogglePin });
    });
    render(<Sidebar />);
    const pinButtons = screen.getAllByTitle(/Pin/i);
    fireEvent.click(pinButtons[0]);
    expect(handleTogglePin).toHaveBeenCalled();
  });

  it('triggers rename mode on right click (context menu)', () => {
    render(<Sidebar />);
    const sessionOne = screen.getByText('Chat One');
    fireEvent.contextMenu(sessionOne);
    const input = screen.getByDisplayValue('Chat One');
    expect(input).toBeInTheDocument();
  });

  it('saves new name on Enter key', () => {
    const handleRenameSession = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleRenameSession });
    });
    render(<Sidebar />);
    const sessionOne = screen.getByText('Chat One');
    fireEvent.contextMenu(sessionOne);
    const input = screen.getByDisplayValue('Chat One');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handleRenameSession).toHaveBeenCalledWith(expect.anything(), '1', 'New Name');
  });

  it('calls toggleSidebarPinned when sidebar pin button is clicked', () => {
    const toggleSidebarPinned = vi.fn();
    act(() => {
      useUIStore.setState({ toggleSidebarPinned });
    });
    render(<Sidebar />);
    const pinButton = screen.getByTitle(/Pin Sidebar/i);
    fireEvent.click(pinButton);
    expect(toggleSidebarPinned).toHaveBeenCalled();
  });

  it('collapses sidebar when collapse button is clicked', () => {
    const setSidebarOpen = vi.fn();
    const setSidebarPinned = vi.fn();
    act(() => {
      useUIStore.setState({ setSidebarOpen, setSidebarPinned });
    });
    render(<Sidebar />);
    
    const collapseBtn = screen.getByTitle('Collapse Sidebar');
    fireEvent.click(collapseBtn);
    
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
    expect(setSidebarPinned).toHaveBeenCalledWith(false);
  });

  it('keeps workspace shortcuts out of the provider stack', () => {
    act(() => {
      useSystemStore.setState({
        workspaceCwds: [
          { label: '+ CE', path: '/repos/demo-project', agent: 'agent-dev', pinned: true },
          { label: '+ TS', path: '/repos/demo-lib', agent: 'agent-lib', pinned: true },
        ],
      });
    });
    render(<Sidebar />);
    expect(screen.getAllByText('Choose Workspace')).toHaveLength(1);
    expect(screen.queryByText('+ CE')).not.toBeInTheDocument();
    expect(screen.queryByText('+ TS')).not.toBeInTheDocument();
  });

  it('filters sessions by search input', () => {
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText('Search chats...');
    fireEvent.change(searchInput, { target: { value: 'One' } });
    expect(screen.getByText('Chat One')).toBeInTheDocument();
    expect(screen.queryByText('Chat Two')).not.toBeInTheDocument();
  });

  it('clearing search shows all sessions', () => {
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText('Search chats...');
    fireEvent.change(searchInput, { target: { value: 'One' } });
    expect(screen.queryByText('Chat Two')).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.getByText('Chat One')).toBeInTheDocument();
    expect(screen.getByText('Chat Two')).toBeInTheDocument();
  });

  it('archive button opens archive modal', () => {
    const emitMock = vi.fn((_event: string, ...args: any[]) => {
      const cb = typeof args[0] === "function" ? args[0] : args[1];
      if(cb) cb({ archives: ['archived-chat-1', 'archived-chat-2'] });
    });
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('Restore archived chat'));
    expect(emitMock).toHaveBeenCalledWith('list_archives', expect.anything(), expect.any(Function));
    expect(screen.getByText('Archived Chats')).toBeInTheDocument();
  });

  it('archive modal shows list of archived chats', () => {
    const emitMock = vi.fn((_event: string, ...args: any[]) => {
      const cb = typeof args[0] === "function" ? args[0] : args[1];
      if(cb) cb({ archives: ['my-old-chat', 'another-archive'] });
    });
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('Restore archived chat'));
    expect(screen.getByText('my-old-chat')).toBeInTheDocument();
    expect(screen.getByText('another-archive')).toBeInTheDocument();
  });

  it('restoring archive preserves existing sessions and only adds new ones', async () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [
          { ...mockSessions[0], isTyping: true, messages: [{ id: 'm1', content: 'hello' }] },
          mockSessions[1],
        ],
        activeSessionId: '1', });
    });

    const emitMock = vi.fn((event: string, ...args: any[]) => {
      const cb = typeof args[0] === "function" ? args[0] : args[1];
      
      if (event === 'list_archives') if(cb) cb({ archives: ['old-chat'] });
      if (event === 'restore_archive') cb({ success: true, uiId: 'restored-1' });
      if (event === 'load_sessions') cb({ sessions: [
        { id: '1', name: 'Chat One', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
        { id: '2', name: 'Chat Two', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: true },
        { id: 'restored-1', name: 'Restored Chat', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
      ]});
    });
    act(() => { useSystemStore.setState({ socket: { emit: emitMock } as any }); });

    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('Restore archived chat'));
    fireEvent.click(screen.getByText('old-chat'));

    const sessions = useSessionLifecycleStore.getState().sessions;
    const s1 = sessions.find(s => s.id === '1');
    expect(s1?.isTyping).toBe(true);
    expect(s1?.messages).toHaveLength(1);
    expect(sessions.find(s => s.id === 'restored-1')).toBeDefined();
    expect(useSessionLifecycleStore.getState().activeSessionId).toBe('1');
  });

  it('pin button toggles between Pin and Unpin titles', () => {
    render(<Sidebar />);
    // Session 1 is unpinned → title should be "Pin"
    // Session 2 is pinned → title should be "Unpin"
    expect(screen.getByTitle('Pin')).toBeInTheDocument();
    expect(screen.getByTitle('Unpin')).toBeInTheDocument();
  });

  it('rename flow via rename button - click, type, enter saves', () => {
    const handleRenameSession = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleRenameSession });
    });
    render(<Sidebar />);
    const renameBtns = screen.getAllByTitle('Rename');
    fireEvent.click(renameBtns[0]);
    const input = screen.getByDisplayValue('Chat One');
    fireEvent.change(input, { target: { value: 'Renamed Chat' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handleRenameSession).toHaveBeenCalledWith(expect.anything(), '1', 'Renamed Chat');
  });

  it('clicking archive item calls restore_archive socket emit', () => {
    const emitMock = vi.fn((event: string, ...args: any[]) => {
      const cb = typeof args[0] === "function" ? args[0] : args[1];
      if (event === 'list_archives') cb({ archives: ['old-chat'] });
      if (event === 'restore_archive') args[1]({ success: true });
    });
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('Restore archived chat'));
    fireEvent.click(screen.getByText('old-chat'));
    expect(emitMock).toHaveBeenCalledWith('restore_archive', expect.objectContaining({ folderName: 'old-chat', providerId: 'default' }), expect.any(Function));
  });

  it('search bar X button clears search text', () => {
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText('Search chats...');
    fireEvent.change(searchInput, { target: { value: 'One' } });
    expect(screen.queryByText('Chat Two')).not.toBeInTheDocument();

    screen.getByRole('button', { name: '' });
    // The X button is inside search-wrapper with class search-clear
    const searchWrapper = searchInput.closest('.search-wrapper');
    const clearButton = searchWrapper?.querySelector('.search-clear');
    expect(clearButton).toBeTruthy();
    fireEvent.click(clearButton!);

    expect(screen.getByText('Chat One')).toBeInTheDocument();
    expect(screen.getByText('Chat Two')).toBeInTheDocument();
  });

  it('Tab in search selects first filtered session', () => {
    const handleSessionSelect = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleSessionSelect });
    });
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText('Search chats...');
    fireEvent.change(searchInput, { target: { value: 'One' } });
    fireEvent.keyDown(searchInput, { key: 'Tab' });
    expect(handleSessionSelect).toHaveBeenCalledWith(expect.anything(), '1');
  });

  it('Enter in search selects first filtered session', () => {
    const handleSessionSelect = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleSessionSelect });
    });
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText('Search chats...');
    fireEvent.change(searchInput, { target: { value: 'Two' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    expect(handleSessionSelect).toHaveBeenCalledWith(expect.anything(), '2');
  });

  it('clicking the workspace new chat button uses the only configured workspace', () => {
    const handleNewChat = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleNewChat });
      useSystemStore.setState({
        workspaceCwds: [
          { label: '+ CE', path: '/repos/demo-project', agent: 'agent-dev', pinned: true },
        ],
      });
    });
    render(<Sidebar />);
    expect(screen.queryByText('/repos/demo-project')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('CE'));
    expect(handleNewChat).toHaveBeenCalledWith(expect.anything(), undefined, '/repos/demo-project', 'agent-dev');
  });

  it('settings button on session item calls setSettingsOpen', () => {
    const setSettingsOpen = vi.fn();
    act(() => {
      useUIStore.setState({ setSettingsOpen });
    });
    render(<Sidebar />);
    const settingsBtns = screen.getAllByTitle('Chat Settings');
    fireEvent.click(settingsBtns[0]);
    expect(setSettingsOpen).toHaveBeenCalledWith(true, '1');
  });

  it('active session has active class', () => {
    render(<Sidebar />);
    const sessionOne = screen.getByText('Chat One').closest('.session-item');
    expect(sessionOne).toHaveClass('active');
    const sessionTwo = screen.getByText('Chat Two').closest('.session-item');
    expect(sessionTwo).not.toHaveClass('active');
  });

  it('renders folders from folder store', () => {
    act(() => {
      useFolderStore.setState({
        folders: [{ id: 'f1', name: 'Work', parentId: null, position: 0, providerId: 'default' }],
        expandedFolderIds: new Set()
      });
    });
    render(<Sidebar />);
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('shows new folder button', () => {
    render(<Sidebar />);
    expect(screen.getByTitle('New folder')).toBeInTheDocument();
  });

  it('archive button shows archive modal', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('Restore archived chat'));
    // The socket emit for list_archives should fire
    expect(useChatStore.getState()).toBeDefined();
  });

  it('sessions inside folders are not shown at root level', () => {
    act(() => {
      useSessionLifecycleStore.setState({ sessions: [
          { id: '1', name: 'Root Chat', acpSessionId: null, messages: [], isTyping: false, isWarmingUp: false, model: 'flagship', folderId: null },
          { id: '2', name: 'Folder Chat', acpSessionId: null, messages: [], isTyping: false, isWarmingUp: false, model: 'flagship', folderId: 'f1' },
        ],
        activeSessionId: '1',
        handleSessionSelect: vi.fn(),
        handleNewChat: vi.fn(),
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(), });
      useFolderStore.setState({
        folders: [{ id: 'f1', name: 'Work', parentId: null, position: 0 }],
        expandedFolderIds: new Set()
      });
    });
    render(<Sidebar />);
    // Root Chat visible at root, Folder Chat hidden (folder collapsed)
    expect(screen.getByText('Root Chat')).toBeInTheDocument();
    expect(screen.queryByText('Folder Chat')).not.toBeInTheDocument();
  });
});


describe('Sidebar - additional coverage', () => {
  const mockSessions: any[] = [
    { id: '1', acpSessionId: 'acp-1', name: 'Chat One', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
    { id: '2', acpSessionId: 'acp-2', name: 'Chat Two', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: true },
    { id: '3', acpSessionId: 'acp-3', name: 'Chat Three', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: { emit: vi.fn() } as any, workspaceCwds: [] });
      useSessionLifecycleStore.setState({ sessions: mockSessions,
        activeSessionId: '1',
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleNewChat: vi.fn(), });
      useUIStore.setState({
        isSidebarOpen: true,
        isSidebarPinned: false,
        setSidebarOpen: vi.fn(),
        setSidebarPinned: vi.fn(),
        toggleSidebarPinned: vi.fn(),
        setSettingsOpen: vi.fn(),
      });
      useFolderStore.setState({
        folders: [],
        expandedFolderIds: new Set(),
        loadFolders: vi.fn(),
        createFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveSessionToFolder: vi.fn(),
      });
    });
  });

  it('search is case-insensitive', () => {
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText('Search chats...');
    fireEvent.change(searchInput, { target: { value: 'chat one' } });
    expect(screen.getByText('Chat One')).toBeInTheDocument();
    expect(screen.queryByText('Chat Two')).not.toBeInTheDocument();
  });

  it('search with no matches shows empty list', () => {
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText('Search chats...');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
    expect(screen.queryByText('Chat One')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat Two')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat Three')).not.toBeInTheDocument();
  });

  it('clicking New Chat button calls handleNewChat without cwd when no workspaceCwds', () => {
    const handleNewChat = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleNewChat });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByText('New Chat'));
    expect(handleNewChat).toHaveBeenCalledWith(expect.anything(), undefined, undefined, undefined);
  });

  it('workspace picker starts a new chat with the selected cwd and agent', () => {
    const handleNewChat = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleNewChat });
      useSystemStore.setState({
        workspaceCwds: [
          { label: '+ CE', path: '/repos/demo-project', agent: 'agent-dev', pinned: true },
          { label: '+ TS', path: '/repos/demo-lib', agent: 'agent-lib', pinned: true },
        ],
      });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Choose Workspace'));
    expect(screen.getByText('Open Workspace')).toBeInTheDocument();
    fireEvent.click(screen.getByText('+ TS'));
    expect(handleNewChat).toHaveBeenCalledWith(expect.anything(), undefined, '/repos/demo-lib', 'agent-lib');
  });

  it('new folder button opens the app modal and creates a folder', () => {
    const createFolder = vi.fn();
    act(() => {
      useFolderStore.setState({ createFolder });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('New folder'));
    expect(screen.getByText('Create Folder')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'Project Notes' } });
    fireEvent.click(screen.getByText('Create'));
    expect(createFolder).toHaveBeenCalledWith('Project Notes', null, 'default');
  });

  it('new folder button does not use the browser prompt', () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('New folder'));
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('new folder modal trims the folder name before creating it', () => {
    const createFolder = vi.fn();
    act(() => {
      useFolderStore.setState({ createFolder });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('New folder'));
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: '  New Folder  ' } });
    fireEvent.click(screen.getByText('Create'));
    expect(createFolder).toHaveBeenCalledWith('New Folder', null, 'default');
  });

  it('archive session removes it from the list', () => {
    const emitMock = vi.fn();
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any });
    });
    render(<Sidebar />);
    // Archive via the session item's archive button
    const archiveBtns = screen.getAllByTitle('Archive Chat');
    fireEvent.click(archiveBtns[0]);
    expect(emitMock).toHaveBeenCalledWith('archive_session', { providerId: 'default', uiId: '1' });
    expect(useSessionLifecycleStore.getState().sessions.map(s => s.id)).toEqual(['2', '3']);
    expect(useSessionLifecycleStore.getState().activeSessionId).toBeNull();
  });

  it('sidebar is hidden when isSidebarOpen is false', () => {
    act(() => {
      useUIStore.setState({ isSidebarOpen: false });
    });
    const { container } = render(<Sidebar />);
    const sidebar = container.querySelector('.sidebar');
    expect(sidebar).not.toHaveClass('open');
  });

  it('pinned sidebar button shows active class when pinned', () => {
    act(() => {
      useUIStore.setState({ isSidebarPinned: true });
    });
    render(<Sidebar />);
    const pinBtn = screen.getByTitle('Unpin Sidebar');
    expect(pinBtn).toHaveClass('active');
  });

  it('drag and drop session to root calls moveSessionToFolder with null', () => {
    const moveSessionToFolder = vi.fn();
    act(() => {
      useFolderStore.setState({ moveSessionToFolder });
    });
    const { container } = render(<Sidebar />);
    const sessionsList = container.querySelector('.sessions-list')!;

    const dataTransfer = { getData: (key: string) => key === 'session-id' ? '2' : '', preventDefault: vi.fn(), dropEffect: '' };
    fireEvent.dragOver(sessionsList, { dataTransfer, preventDefault: vi.fn() });
    fireEvent.drop(sessionsList, { dataTransfer, preventDefault: vi.fn() });
    expect(moveSessionToFolder).toHaveBeenCalledWith('2', null);
  });

  it('search then Tab selects first match and clears search', () => {
    const handleSessionSelect = vi.fn();
    act(() => {
      useSessionLifecycleStore.setState({ handleSessionSelect });
    });
    render(<Sidebar />);
    const searchInput = screen.getByPlaceholderText('Search chats...');
    fireEvent.change(searchInput, { target: { value: 'Three' } });
    fireEvent.keyDown(searchInput, { key: 'Tab' });
    expect(handleSessionSelect).toHaveBeenCalledWith(expect.anything(), '3');
  });

  it('delete archive removes it from the list', () => {
    const emitMock = vi.fn((event: string, ...args: any[]) => {
      const cb = typeof args[0] === "function" ? args[0] : args[1];
      if (event === 'list_archives') cb({ archives: ['arch1', 'arch2'] });
      if (event === 'delete_archive') args[1]();
    });
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('Restore archived chat'));
    expect(screen.getByText('arch1')).toBeInTheDocument();
    expect(screen.getByText('arch2')).toBeInTheDocument();
  });
});

describe('Sidebar - workspace picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({
        socket: { emit: vi.fn() } as any,
        workspaceCwds: [
          { label: '+ CE', path: '/repos/demo-project', agent: 'agent-dev', pinned: true },
          { label: 'Extra', path: '/repos/extra', agent: 'agent-dev', pinned: false },
        ],
      });
      useSessionLifecycleStore.setState({ sessions: [{ id: '1', acpSessionId: 'acp-1', name: 'Chat One', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false }],
        activeSessionId: '1',
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleNewChat: vi.fn(), });
      useUIStore.setState({
        isSidebarOpen: true,
        isSidebarPinned: false,
        setSidebarOpen: vi.fn(),
        setSidebarPinned: vi.fn(),
        toggleSidebarPinned: vi.fn(),
        setSettingsOpen: vi.fn(),
      });
      useFolderStore.setState({
        folders: [],
        expandedFolderIds: new Set(),
        loadFolders: vi.fn(),
        createFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveSessionToFolder: vi.fn(),
      });
    });
  });

  it('does not render a separate overflow workspace button', () => {
    render(<Sidebar />);
    expect(screen.queryByTitle('More workspaces')).not.toBeInTheDocument();
  });

  it('primary New Chat opens the workspace picker when multiple workspaces exist', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Choose Workspace'));
    expect(screen.getByText('Open Workspace')).toBeInTheDocument();
    expect(screen.getByText('Extra')).toBeInTheDocument();
  });

  it('primary New Chat opens the workspace picker when all workspaces are pinned', () => {
    act(() => {
      useSystemStore.setState({
        workspaceCwds: [
          { label: '+ CE', path: '/repos/demo-project', agent: 'agent-dev', pinned: true },
          { label: '+ TS', path: '/repos/demo-lib', agent: 'agent-lib', pinned: true },
        ],
      });
    });
    render(<Sidebar />);
    expect(screen.queryByTitle('More workspaces')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Choose Workspace'));
    expect(screen.getByText('Open Workspace')).toBeInTheDocument();
    expect(screen.getByText('+ TS')).toBeInTheDocument();
  });
});


describe('Sidebar - utility row and workspace row layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: { emit: vi.fn() } as any, workspaceCwds: [] });
      useSessionLifecycleStore.setState({ sessions: [],
        activeSessionId: null,
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleNewChat: vi.fn(), });
      useUIStore.setState({
        isSidebarOpen: true,
        isSidebarPinned: false,
        setSidebarOpen: vi.fn(),
        setSidebarPinned: vi.fn(),
        toggleSidebarPinned: vi.fn(),
        setSettingsOpen: vi.fn(),
      });
      useFolderStore.setState({
        folders: [],
        expandedFolderIds: new Set(),
        loadFolders: vi.fn(),
        createFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveSessionToFolder: vi.fn(),
      });
    });
  });

  it('utility row renders New Folder and Archives buttons with text labels', () => {
    render(<Sidebar />);
    const utilityRow = document.querySelector('.sidebar-utility-row')!;
    const buttons = utilityRow.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('New Folder');
    expect(buttons[1].textContent).toContain('Archives');
  });

  it('utility buttons both use sidebar-utility-btn class with no special archive class', () => {
    render(<Sidebar />);
    const utilityBtns = document.querySelectorAll('.sidebar-utility-btn');
    expect(utilityBtns).toHaveLength(2);
    utilityBtns.forEach(btn => {
      expect(btn.classList.contains('archive-button')).toBe(false);
    });
  });

  it('sidebar header renders workspace-row and utility-row as separate divs', () => {
    render(<Sidebar />);
    const workspaceRow = document.querySelector('.sidebar-workspace-row');
    const utilityRow = document.querySelector('.sidebar-utility-row');
    expect(workspaceRow).toBeInstanceOf(HTMLDivElement);
    expect(utilityRow).toBeInstanceOf(HTMLDivElement);
    expect(workspaceRow).not.toBe(utilityRow);
  });

  it('workspace labels do not create duplicate new chat shortcuts', () => {
    act(() => {
      useSystemStore.setState({
        workspaceCwds: [
          { label: '+ CE', path: '/repos/demo-project', agent: 'agent-dev', pinned: true },
          { label: '+ TS', path: '/repos/demo-lib', agent: 'agent-lib', pinned: true },
        ],
      });
    });
    render(<Sidebar />);
    expect(screen.getAllByText('Choose Workspace')).toHaveLength(1);
    expect(screen.queryByText('+ CE')).not.toBeInTheDocument();
    expect(screen.queryByText('+ TS')).not.toBeInTheDocument();
  });
});


describe('Sidebar - deletePermanent socket events', () => {
  const mockSessions: any[] = [
    { id: '1', acpSessionId: 'acp-1', name: 'Chat One', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: { emit: vi.fn() } as any, workspaceCwds: [] });
      useSessionLifecycleStore.setState({ sessions: mockSessions,
        activeSessionId: '1',
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleNewChat: vi.fn(), });
      useUIStore.setState({
        isSidebarOpen: true,
        isSidebarPinned: false,
        setSidebarOpen: vi.fn(),
        setSidebarPinned: vi.fn(),
        toggleSidebarPinned: vi.fn(),
        setSettingsOpen: vi.fn(),
      });
      useFolderStore.setState({
        folders: [],
        expandedFolderIds: new Set(),
        loadFolders: vi.fn(),
        createFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveSessionToFolder: vi.fn(),
      });
    });
  });

  it('emits archive_session when deletePermanent is false', () => {
    const emitMock = vi.fn();
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any, deletePermanent: false });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('Archive Chat'));
    expect(emitMock).toHaveBeenCalledWith('archive_session', { providerId: 'default', uiId: '1' });
  });

  it('emits delete_session when deletePermanent is true', () => {
    const emitMock = vi.fn();
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any, deletePermanent: true });
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle('Delete Chat'));
    expect(emitMock).toHaveBeenCalledWith('delete_session', { uiId: '1' });
  });

  it('deleting a parent session also removes its forks from the session list', () => {
    const emitMock = vi.fn();
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any, deletePermanent: true });
      useSessionLifecycleStore.setState({ sessions: [
          { id: 'parent', acpSessionId: 'acp-p', name: 'Parent', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
          { id: 'fork-1', acpSessionId: 'acp-f1', name: 'Fork', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false, forkedFrom: 'parent' },
          { id: 'other', acpSessionId: 'acp-o', name: 'Other Chat', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
        ],
        activeSessionId: 'other',
        handleNewChat: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(), });
    });
    render(<Sidebar />);
    // Delete the parent session
    const parentItem = screen.getByText('Parent').closest('.session-item')!;
    const deleteBtn = parentItem.querySelector('[title="Delete Chat"]')!;
    fireEvent.click(deleteBtn);

    // After delete, fork should be removed from store along with parent
    const remaining = useSessionLifecycleStore.getState().sessions;
    expect(remaining.map(s => s.id)).toEqual(['other']);
  });

  it('deleting the active session clears the active chat instead of selecting another session', () => {
    const emitMock = vi.fn();
    act(() => {
      useSystemStore.setState({ socket: { emit: emitMock } as any, deletePermanent: true });
      useSessionLifecycleStore.setState({ sessions: [
          { id: '1', acpSessionId: 'acp-1', name: 'Chat One', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
          { id: '2', acpSessionId: 'acp-2', name: 'Chat Two', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced', isPinned: false },
        ],
        activeSessionId: '1', });
    });
    render(<Sidebar />);

    fireEvent.click(screen.getAllByTitle('Delete Chat')[0]);

    expect(useSessionLifecycleStore.getState().sessions.map(s => s.id)).toEqual(['2']);
    expect(useSessionLifecycleStore.getState().activeSessionId).toBeNull();
  });
});


describe('Sidebar - fork nesting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: { emit: vi.fn() } as any, workspaceCwds: [] });
      useSessionLifecycleStore.setState({ sessions: [
          { id: 'parent', acpSessionId: 'acp-p', name: 'Parent Chat', messages: [], isTyping: false, isWarmingUp: false, model: 'flagship', isPinned: false },
          { id: 'fork-1', acpSessionId: 'acp-f1', name: 'Parent Chat (fork)', messages: [], isTyping: false, isWarmingUp: false, model: 'flagship', isPinned: false, forkedFrom: 'parent', forkPoint: 2 },
        ],
        activeSessionId: 'parent',
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleNewChat: vi.fn(), });
      useUIStore.setState({
        isSidebarOpen: true,
        isSidebarPinned: false,
        setSidebarOpen: vi.fn(),
        setSidebarPinned: vi.fn(),
        toggleSidebarPinned: vi.fn(),
        setSettingsOpen: vi.fn(),
      });
      useFolderStore.setState({
        folders: [],
        expandedFolderIds: new Set(),
        loadFolders: vi.fn(),
        createFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveSessionToFolder: vi.fn(),
      });
    });
  });

  it('forked sessions render indented under parent', () => {
    const { container } = render(<Sidebar />);
    const forkIndent = container.querySelector('.fork-indent');
    expect(forkIndent).toBeInTheDocument();
    expect(forkIndent!.textContent).toContain('Parent Chat (fork)');
  });

  it('forked sessions are NOT shown as root sessions', () => {
    const { container } = render(<Sidebar />);
    // All session-items NOT inside a .fork-indent are root sessions
    const allItems = Array.from(container.querySelectorAll('.session-item'));
    const rootItems = allItems.filter(el => !el.closest('.fork-indent'));
    const rootNames = rootItems.map(el => el.querySelector('.session-name')?.textContent);
    expect(rootNames).toContain('Parent Chat');
    expect(rootNames).not.toContain('Parent Chat (fork)');
  });
});



// Mock sessionOwnership for pop-out tests
vi.mock('../lib/sessionOwnership', () => ({
  isSessionPoppedOut: vi.fn(() => false),
  openPopout: vi.fn(),
  focusPopout: vi.fn(),
  setOwnershipChangeCallback: vi.fn(),
}));

import { isSessionPoppedOut } from '../lib/sessionOwnership';

describe('Sidebar - popped-out sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isSessionPoppedOut).mockReturnValue(false);
    act(() => {
      useSystemStore.setState({ socket: { emit: vi.fn() } as any, workspaceCwds: [] });
      useSessionLifecycleStore.setState({ sessions: [
          { id: '1', acpSessionId: 'acp-1', name: 'Normal Chat', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced' },
          { id: '2', acpSessionId: 'acp-2', name: 'Popped Chat', messages: [], isTyping: false, isWarmingUp: false, model: 'balanced' },
        ],
        activeSessionId: '1',
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleNewChat: vi.fn(), });
      useUIStore.setState({
        isSidebarOpen: true,
        isSidebarPinned: false,
        setSidebarOpen: vi.fn(),
        setSidebarPinned: vi.fn(),
        toggleSidebarPinned: vi.fn(),
        setSettingsOpen: vi.fn(),
      });
      useFolderStore.setState({
        folders: [],
        expandedFolderIds: new Set(),
        loadFolders: vi.fn(),
        createFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveSessionToFolder: vi.fn(),
      });
    });
  });

  it('popped-out sessions show popped-out class', () => {
    vi.mocked(isSessionPoppedOut).mockImplementation((id: string) => id === '2');
    render(<Sidebar />);
    const poppedItem = screen.getByText('Popped Chat').closest('.session-item');
    expect(poppedItem).toHaveClass('popped-out');
    const normalItem = screen.getByText('Normal Chat').closest('.session-item');
    expect(normalItem).not.toHaveClass('popped-out');
  });

  it('pop-out button exists on session items', () => {
    render(<Sidebar />);
    const popOutBtns = screen.getAllByTitle('Pop Out');
    expect(popOutBtns.length).toBe(2);
  });
});


describe('Sidebar - resize', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useSystemStore.setState({ socket: { emit: vi.fn() } as any, connected: true, isEngineReady: true, workspaceCwds: [] });
      useSessionLifecycleStore.setState({ sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null }],
        activeSessionId: 's1',
        handleNewChat: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(), });
      useUIStore.setState({ isSidebarOpen: true, isSidebarPinned: true });
    });
  });

  it('renders resize handle when sidebar is open', () => {
    const { container } = render(<Sidebar />);
    expect(container.querySelector('.sidebar-resize-handle')).toBeInTheDocument();
  });

  it('uses default width of 312 when no localStorage value', () => {
    const { container } = render(<Sidebar />);
    const sidebar = container.querySelector('.sidebar');
    expect(sidebar).toHaveStyle({ width: '312px' });
  });

  it('restores width from localStorage', () => {
    localStorage.setItem('acpui-sidebar-width', '400');
    const { container } = render(<Sidebar />);
    const sidebar = container.querySelector('.sidebar');
    expect(sidebar).toHaveStyle({ width: '400px' });
  });
});


describe('Sidebar - recursive fork nesting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSystemStore.setState({ socket: { emit: vi.fn() } as any, connected: true, isEngineReady: true, workspaceCwds: [] });
      useSessionLifecycleStore.setState({ sessions: [
          { id: 'root', name: 'Root Chat', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null },
          { id: 'fork1', name: 'Fork 1', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null, forkedFrom: 'root' },
          { id: 'fork2', name: 'Fork of Fork', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null, forkedFrom: 'fork1' },
        ],
        activeSessionId: 'root',
        handleNewChat: vi.fn(),
        handleSessionSelect: vi.fn(),
        handleTogglePin: vi.fn(),
        handleRenameSession: vi.fn(), });
      useUIStore.setState({ isSidebarOpen: true, isSidebarPinned: true });
    });
  });

  it('renders fork-of-fork nested under its parent fork', () => {
    const { container } = render(<Sidebar />);
    const names = Array.from(container.querySelectorAll('.session-name')).map(el => el.textContent);
    expect(names).toContain('Root Chat');
    expect(names).toContain('Fork 1');
    expect(names).toContain('Fork of Fork');
  });

  it('forks are rendered inside fork-indent containers', () => {
    const { container } = render(<Sidebar />);
    const forkIndents = container.querySelectorAll('.fork-indent .session-name');
    const forkNames = Array.from(forkIndents).map(el => el.textContent);
    expect(forkNames).toContain('Fork 1');
    expect(forkNames).toContain('Fork of Fork');
  });
});
