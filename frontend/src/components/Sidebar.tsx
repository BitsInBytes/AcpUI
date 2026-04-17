import React, { useState, useEffect, useRef } from 'react';
import { Plus, X, Pin, PinOff, ChevronLeft, Archive, FolderPlus } from 'lucide-react';
import SessionItem from './SessionItem';
import FolderItem from './FolderItem';
import ArchiveModal from './ArchiveModal';
import WorkspacePickerModal from './WorkspacePickerModal';
import type { ChatSession } from '../types';
import './Sidebar.css';
import { useSystemStore } from '../store/useSystemStore';
import { useChatStore } from '../store/useChatStore';
import { useUIStore } from '../store/useUIStore';
import { useFolderStore } from '../store/useFolderStore';

const Sidebar: React.FC = () => {
  const socket = useSystemStore(state => state.socket);
  const workspaceCwds = useSystemStore(state => state.workspaceCwds);
  const deletePermanent = useSystemStore(state => state.deletePermanent);
  const { sessions, setSessions, activeSessionId, handleSessionSelect, handleNewChat, handleTogglePin, handleRenameSession } = useChatStore();
  const { isSidebarOpen, isSidebarPinned, setSidebarOpen, setSidebarPinned, toggleSidebarPinned, setSettingsOpen } = useUIStore();
  const { folders, loadFolders, createFolder, moveFolder, moveSessionToFolder } = useFolderStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [showArchives, setShowArchives] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [archives, setArchives] = useState<string[]>([]);
  const [archiveSearch, setArchiveSearch] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const rootDragRef = useRef(0);

  // Sidebar width persisted to localStorage so it survives page reloads
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('acpui-sidebar-width');
    return saved ? parseInt(saved, 10) : 312;
  });
  const resizingRef = useRef(false);

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    let lastWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      lastWidth = Math.max(220, Math.min(500, ev.clientX));
      setSidebarWidth(lastWidth);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('acpui-sidebar-width', String(lastWidth));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => { loadFolders(); }, [loadFolders]);

  const filteredSessions = searchQuery
    ? sessions.filter(s => s.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : sessions;

  // Session hierarchy: root sessions exclude forks and sub-agents; they render nested below their parent
  const rootSessions = filteredSessions.filter(s => !s.folderId && !s.forkedFrom && !s.isSubAgent);
  const getForksOf = (parentId: string) => filteredSessions.filter(s => s.forkedFrom === parentId && !s.isSubAgent);
  const getSubAgentsOf = (parentId: string) => filteredSessions.filter(s => s.isSubAgent && s.forkedFrom === parentId);
  // Root folders (no parent)
  const rootFolders = folders.filter(f => !f.parentId);

  const maybeCollapseSidebar = () => {
    if (!isSidebarPinned) {
      setSidebarOpen(false);
    }
  };

  const handleSelect = (sessionId: string) => {
    handleSessionSelect(socket, sessionId);
    maybeCollapseSidebar();
  };

  const handleNew = (cwd?: string, agent?: string) => {
    handleNewChat(socket, undefined, cwd, agent);
    maybeCollapseSidebar();
  };

  const handleShowArchives = () => {
    if (!socket) return;
    socket.emit('list_archives', (res: { archives: string[] }) => {
      setArchives(res.archives || []);
      setArchiveSearch('');
      setShowArchives(true);
    });
  };

  const handleRestore = (folderName: string) => {
    if (!socket) return;
    setRestoring(folderName);
    socket.emit('restore_archive', { folderName }, (res: { success?: boolean; uiId?: string }) => {
      setRestoring(null);
      if (res.success) {
        setShowArchives(false);
        // Reload sessions but only add new ones — never replace existing in-memory sessions
        socket.emit('load_sessions', (loadRes: { sessions?: ChatSession[] }) => {
          if (loadRes.sessions) {
            const current = useChatStore.getState().sessions;
            const existingIds = new Set(current.map(s => s.id));
            const newSessions = loadRes.sessions
              .filter((s: ChatSession) => !existingIds.has(s.id))
              .map((s: ChatSession) => ({ ...s, isTyping: false, isWarmingUp: false }));
            if (newSessions.length) setSessions([...current, ...newSessions]);
          }
        });
      }
    });
  };

  const handleDeleteArchive = (folderName: string) => {
    if (!socket) return;
    socket.emit('delete_archive', { folderName }, () => {
      setArchives(prev => prev.filter(a => a !== folderName));
    });
  };

  const handleRemoveSession = (sessionId: string) => {
    if (!socket) return;
    const session = useChatStore.getState().sessions.find(s => s.id === sessionId);
    if (deletePermanent || session?.isSubAgent) {
      socket.emit('delete_session', { uiId: sessionId });
    } else {
      socket.emit('archive_session', { uiId: sessionId });
    }
    // Recursively collect all descendant IDs to remove
    const sessions = useChatStore.getState().sessions;
    const removeIds = new Set([sessionId]);
    let added = true;
    while (added) {
      added = false;
      for (const s of sessions) {
        if (!removeIds.has(s.id) && s.forkedFrom && removeIds.has(s.forkedFrom)) {
          removeIds.add(s.id); added = true;
        }
      }
    }
    const updated = sessions.filter(s => !removeIds.has(s.id));
    if (updated.length === 0) {
      useChatStore.setState({ sessions: [] });
      const defaultCwd = useSystemStore.getState().workspaceCwds[0]?.path;
      const defaultAgent = useSystemStore.getState().workspaceCwds[0]?.agent;
      handleNewChat(socket, undefined, defaultCwd, defaultAgent);
    } else {
      const nextId = activeSessionId === sessionId ? updated[0].id : activeSessionId;
      useChatStore.setState({ sessions: updated, activeSessionId: nextId });
    }
  };

  const handleDropSession = (sessionId: string, folderId: string | null) => {
    moveSessionToFolder(sessionId, folderId);
    // Optimistically update local session state
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s => s.id === sessionId ? { ...s, folderId } : s)
    }));
  };

  const handleDropFolder = (folderId: string, newParentId: string | null) => {
    moveFolder(folderId, newParentId);
  };

  // Root drop zone — drop session/folder to remove from folder
  const handleRootDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const handleRootDragEnter = (e: React.DragEvent) => { e.preventDefault(); rootDragRef.current++; setRootDragOver(true); };
  const handleRootDragLeave = () => { rootDragRef.current--; if (rootDragRef.current === 0) setRootDragOver(false); };
  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    rootDragRef.current = 0;
    setRootDragOver(false);
    const sessionId = e.dataTransfer.getData('session-id');
    const folderId = e.dataTransfer.getData('folder-id');
    if (sessionId) handleDropSession(sessionId, null);
    else if (folderId) handleDropFolder(folderId, null);
  };

  // Recursively render forks and sub-agents nested under a parent session
  const renderChildren = (parentId: string, depth = 1): React.ReactNode => {
    const forks = getForksOf(parentId);
    const subs = getSubAgentsOf(parentId);
    if (!forks.length && !subs.length) return null;
    return (
      <>
        {forks.map(fork => (
          <div key={fork.id}>
            <div className="fork-indent" style={{ paddingLeft: `${depth * 12}px` }}>
              <SessionItem
                session={fork}
                isActive={fork.id === activeSessionId}
                onSelect={() => handleSelect(fork.id)}
                onRename={(newName) => handleRenameSession(socket, fork.id, newName)}
                onTogglePin={() => handleTogglePin(socket, fork.id)}
                onArchive={() => handleRemoveSession(fork.id)}
                onSettings={() => setSettingsOpen(true, fork.id)}
              />
            </div>
            {renderChildren(fork.id, depth + 1)}
          </div>
        ))}
        {subs.map(sub => (
          <div key={sub.id} className="fork-indent" style={{ paddingLeft: `${depth * 12}px` }}>
            <SessionItem
              session={sub}
              isActive={sub.id === activeSessionId}
              onSelect={() => handleSelect(sub.id)}
              onRename={() => {}}
              onTogglePin={() => {}}
              onArchive={() => handleRemoveSession(sub.id)}
              onSettings={() => {}}
            />
          </div>
        ))}
      </>
    );
  };

  return (
    <aside className={`sidebar ${isSidebarOpen ? 'open' : ''}`} style={isSidebarOpen ? { width: sidebarWidth } : undefined}>
      <div className="sidebar-resize-handle" onMouseDown={onResizeStart} />
      <div className="sidebar-header-actions">
        <div className="sidebar-workspace-row">
          {workspaceCwds.filter(w => w.pinned).map(w => (
            <button key={w.label} className="new-chat-button" onClick={() => handleNew(w.path, w.agent)} title={`New chat in ${w.path}`}>
              <Plus size={14} />
              {w.label}
            </button>
          ))}
          {workspaceCwds.filter(w => w.pinned).length === 0 && workspaceCwds.length > 0 && (
            <button className="new-chat-button" onClick={() => handleNew(workspaceCwds[0].path, workspaceCwds[0].agent)}>
              <Plus size={18} />
              New Chat
            </button>
          )}
          {workspaceCwds.length === 0 && (
            <button className="new-chat-button" onClick={() => handleNew()}>
              <Plus size={18} />
              New Chat
            </button>
          )}
          {workspaceCwds.filter(w => !w.pinned).length > 0 && (
            <button className="new-chat-button workspace-overflow-btn" onClick={() => setShowWorkspacePicker(true)} title="More workspaces">
              <Plus size={14} />
            </button>
          )}
        </div>
        <div className="sidebar-utility-row">
        <button className="sidebar-utility-btn" onClick={() => createFolder('New Folder')} title="New folder">
          <FolderPlus size={14} />
          New Folder
        </button>
        <button className="sidebar-utility-btn" onClick={handleShowArchives} title="Restore archived chat">
          <Archive size={14} />
          Archives
        </button>
        </div>
      </div>

      {showArchives && (
        <ArchiveModal
          archives={archives}
          archiveSearch={archiveSearch}
          setArchiveSearch={setArchiveSearch}
          onRestore={handleRestore}
          onDelete={handleDeleteArchive}
          restoring={restoring}
          onClose={() => setShowArchives(false)}
        />
      )}

      {showWorkspacePicker && (
        <WorkspacePickerModal
          workspaces={workspaceCwds.filter(w => !w.pinned)}
          onSelect={(w) => handleNew(w.path, w.agent)}
          onClose={() => setShowWorkspacePicker(false)}
        />
      )}

      <div className="sidebar-search">
        <div className="search-wrapper">
          <input
            type="text"
            placeholder="Search chats..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if ((e.key === 'Tab' || e.key === 'Enter') && filteredSessions.length > 0) {
                e.preventDefault();
                handleSelect(filteredSessions[0].id);
                setSearchQuery('');
              }
            }}
            className="sidebar-search-input"
          />
          {searchQuery && <button className="search-clear" onClick={() => setSearchQuery('')}><X size={14} /></button>}
        </div>
      </div>

      <div
        className={`sessions-list ${rootDragOver ? 'root-drag-over' : ''}`}
        onDragOver={handleRootDragOver}
        onDragEnter={handleRootDragEnter}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        {/* Render folders first, then root sessions */}
        {!searchQuery && rootFolders.map(folder => (
          <FolderItem
            key={folder.id}
            folder={folder}
            folders={folders}
            sessions={filteredSessions}
            activeSessionId={activeSessionId}
            depth={0}
            onSelectSession={handleSelect}
            onRenameSession={(id, name) => handleRenameSession(socket, id, name)}
            onTogglePin={(id) => handleTogglePin(socket, id)}
            onArchiveSession={handleRemoveSession}
            onSettingsSession={(id) => setSettingsOpen(true, id)}
            onDropSession={handleDropSession}
            onDropFolder={handleDropFolder}
          />
        ))}
        {(searchQuery ? filteredSessions : rootSessions).map(session => (
          <div key={session.id}>
            <div
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('session-id', session.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              <SessionItem
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={() => handleSelect(session.id)}
                onRename={(newName) => handleRenameSession(socket, session.id, newName)}
                onTogglePin={() => handleTogglePin(socket, session.id)}
                onArchive={() => handleRemoveSession(session.id)}
                onSettings={() => setSettingsOpen(true, session.id)}
              />
            </div>
            {!searchQuery && renderChildren(session.id)}
          </div>
        ))}
      </div>

      {isSidebarOpen && (
        <div className="sidebar-footer">
          <div className="sidebar-footer-actions">
            <button className={`pin-sidebar-btn ${isSidebarPinned ? 'active' : ''}`} onClick={toggleSidebarPinned} title={isSidebarPinned ? "Unpin Sidebar" : "Pin Sidebar"}>
              {isSidebarPinned ? <PinOff size={18} /> : <Pin size={18} />}
            </button>
            <button className="collapse-sidebar-btn" onClick={() => { setSidebarOpen(false); setSidebarPinned(false); }} title="Collapse Sidebar">
              <ChevronLeft size={18} />
              <span>Collapse</span>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
