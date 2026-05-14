import React, { useState, useEffect, useRef } from 'react';
import { Plus, X, Pin, PinOff, ChevronLeft, Archive, FolderPlus } from 'lucide-react';
import SessionItem from './SessionItem';
import FolderItem from './FolderItem';
import ArchiveModal from './ArchiveModal';
import WorkspacePickerModal from './WorkspacePickerModal';
import ProviderStatusPanel from './ProviderStatusPanel';
import type { ChatSession, ProviderBranding, ProviderSummary } from '../types';
import './Sidebar.css';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useUIStore } from '../store/useUIStore';
import { useFolderStore } from '../store/useFolderStore';

const Sidebar: React.FC = () => {
  const socket = useSystemStore(state => state.socket);
  const workspaceCwds = useSystemStore(state => state.workspaceCwds);
  const deletePermanent = useSystemStore(state => state.deletePermanent);
  const { sessions, setSessions, activeSessionId, handleSessionSelect, handleNewChat, handleTogglePin, handleRenameSession } = useSessionLifecycleStore();     
  const { isSidebarOpen, isSidebarPinned, setSidebarOpen, setSidebarPinned, toggleSidebarPinned, setSettingsOpen, expandedProviderId, setExpandedProviderId } = useUIStore();
  const providersById = useSystemStore(state => state.providersById);
  const orderedProviderIds = useSystemStore(state => state.orderedProviderIds);
  const providers = orderedProviderIds.map(id => providersById[id]).filter(Boolean);
  const fallbackBranding: ProviderBranding = {
    providerId: 'default',
    assistantName: 'Default',
    busyText: 'Working...',
    emptyChatMessage: 'Send a message to start.',
    notificationTitle: 'ACP UI',
    appHeader: 'ACP UI',
    sessionLabel: 'Session',
    modelLabel: 'Model',
  };
  const fallbackProvider: ProviderSummary = { providerId: 'default', label: 'Default', branding: fallbackBranding };
  const effectiveProviders = providers.length > 0 ? providers : [fallbackProvider];
  const activeProviderId = useSystemStore(state => state.activeProviderId);
  const defaultProviderId = useSystemStore(state => state.defaultProviderId);
  const currentExpandedId = expandedProviderId || activeProviderId || defaultProviderId || effectiveProviders[0]?.providerId;
  const { folders, loadFolders, createFolder, moveFolder, moveSessionToFolder } = useFolderStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [showArchives, setShowArchives] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [archives, setArchives] = useState<string[]>([]);
  const [archiveSearch, setArchiveSearch] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [rootDragOver, setRootDragOver] = useState(false);
  const rootDragRef = useRef(0);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (showNewFolderModal) {
      newFolderInputRef.current?.focus();
    }
  }, [showNewFolderModal]);

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
    if (currentExpandedId) {
      useSystemStore.setState({ activeProviderId: currentExpandedId });
    }
    handleNewChat(socket, undefined, cwd, agent);
    maybeCollapseSidebar();
  };

  const handlePrimaryNew = () => {
    if (workspaceCwds.length > 1) {
      setShowWorkspacePicker(true);
      return;
    }
    const onlyWorkspace = workspaceCwds[0];
    handleNew(onlyWorkspace?.path, onlyWorkspace?.agent);
  };

  const primaryWorkspace = workspaceCwds.length === 1 ? workspaceCwds[0] : null;
  const primaryWorkspaceLabel = primaryWorkspace
    ? (primaryWorkspace.label || primaryWorkspace.path.split(/[\\/]/).pop() || 'Workspace').replace(/^\+\s*/, '')
    : null;
  const primaryNewChatTitle = primaryWorkspaceLabel
    ? primaryWorkspaceLabel
    : workspaceCwds.length > 1
      ? 'Choose Workspace'
      : 'New Chat';

  const handleShowArchives = () => {
    if (!socket) return;
    const pid = currentExpandedId;
    const payload = pid ? { providerId: pid } : undefined;
    const callback = (res: { archives: string[] }) => {
      setArchives(res.archives || []);
      setArchiveSearch('');
      setShowArchives(true);
    };
    if (payload) socket.emit('list_archives', payload, callback);
    else socket.emit('list_archives', callback);
  };

  const handleRestore = (folderName: string) => {
    if (!socket) return;
    setRestoring(folderName);
    const pid = currentExpandedId;
    socket.emit('restore_archive', { ...(pid ? { providerId: pid } : {}), folderName }, (res: { success?: boolean; uiId?: string }) => {
      setRestoring(null);
      if (res.success) {
        setShowArchives(false);
        // Reload sessions but only add new ones â€” never replace existing in-memory sessions
        socket.emit('load_sessions', (loadRes: { sessions?: ChatSession[] }) => {
          if (loadRes.sessions) {
            const current = useSessionLifecycleStore.getState().sessions;
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
    const pid = currentExpandedId;
    socket.emit('delete_archive', { ...(pid ? { providerId: pid } : {}), folderName }, () => {
      setArchives(prev => prev.filter(a => a !== folderName));
    });
  };

  const handleRemoveSession = (sessionId: string) => {
    if (!socket) return;
    const session = useSessionLifecycleStore.getState().sessions.find(s => s.id === sessionId);
    if (deletePermanent || session?.isSubAgent) {
      socket.emit('delete_session', { uiId: sessionId });
    } else {
      const archiveProviderId = session?.provider || activeProviderId || defaultProviderId;
      socket.emit('archive_session', { ...(archiveProviderId ? { providerId: archiveProviderId } : {}), uiId: sessionId });
    }
    // Recursively collect all descendant IDs to remove
    const sessions = useSessionLifecycleStore.getState().sessions;
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
    const nextId = activeSessionId && !removeIds.has(activeSessionId)
      ? activeSessionId
      : null;
    useSessionLifecycleStore.getState().setSessions(updated);
    useSessionLifecycleStore.getState().setActiveSessionId(nextId);
  };

  const handleDropSession = (sessionId: string, folderId: string | null) => {
    moveSessionToFolder(sessionId, folderId);
    // Optimistically update local session state
    useSessionLifecycleStore.setState(state => ({ sessions: state.sessions.map(s => s.id === sessionId ? { ...s, folderId } : s) }));
  };

  const handleDropFolder = (folderId: string, newParentId: string | null) => {
    moveFolder(folderId, newParentId);
  };

  const handleOpenNewFolderModal = () => {
    setNewFolderName('');
    setShowNewFolderModal(true);
  };

  const handleCloseNewFolderModal = () => {
    setShowNewFolderModal(false);
    setNewFolderName('');
  };

  const handleCreateFolderSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    createFolder(name, null, currentExpandedId || null);
    handleCloseNewFolderModal();
  };

  // Root drop zone â€” drop session/folder to remove from folder
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
          <div key={sub.id}>
            <div className="fork-indent" style={{ paddingLeft: `${depth * 12}px` }}>
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
            {renderChildren(sub.id, depth + 1)}
          </div>
        ))}
      </>
    );
  };

  return (
    <aside className={`sidebar ${isSidebarOpen ? 'open' : ''}`} style={isSidebarOpen ? { width: sidebarWidth } : undefined}>
      <div className="sidebar-resize-handle" onMouseDown={onResizeStart} />
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
        {effectiveProviders.map(p => {
          const isExpanded = currentExpandedId === p.providerId;
          const pSessions = (searchQuery ? filteredSessions : rootSessions).filter(s => (s.provider || activeProviderId || defaultProviderId || 'default') === p.providerId);
          const pFolders = isExpanded ? rootFolders.filter(f => f.providerId === p.providerId) : [];

          const allPSessions = sessions.filter(s => (s.provider || activeProviderId || defaultProviderId || 'default') === p.providerId);
          const isTyping = allPSessions.some(s => s.isTyping);
          const hasUnreadResponse = !isExpanded && !isTyping && allPSessions.some(s => s.hasUnreadResponse);

          let headerClass = 'provider-stack-header';
          if (hasUnreadResponse) headerClass += ' unread';

          return (
            <div key={p.providerId} className={`provider-stack ${isExpanded ? 'expanded' : ''}`}>
              <div
                className={headerClass}
                onClick={() => setExpandedProviderId(isExpanded ? null : p.providerId)}
              >
                {p.branding?.title || p.label || p.providerId}
              </div>

              {!isExpanded && (isTyping || hasUnreadResponse) && (
                <div className="provider-stack-content collapsed-running">
                  <div className="provider-stack-sessions">
                    {allPSessions.filter(s => s.isTyping || s.hasUnreadResponse).map(session => (
                      <div key={session.id}>
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
                    ))}
                  </div>
                </div>
              )}

              {isExpanded && (
                <div className="provider-stack-content">
                  <div className="sidebar-workspace-row" style={{ padding: '0 0.25rem', marginBottom: '0.25rem' }}>
                    <button className="new-chat-button" onClick={handlePrimaryNew}>
                      <Plus size={18} />
                      <span className="new-chat-label">
                        <span className="new-chat-title">{primaryNewChatTitle}</span>
                      </span>
                    </button>
                  </div>
                  <div className="sidebar-utility-row" style={{ padding: '0 0.25rem', marginBottom: '0.375rem' }}>
                    <button className="sidebar-utility-btn" title="New folder" onClick={handleOpenNewFolderModal}>
                      <FolderPlus size={14} />
                      <span>New Folder</span>
                    </button>
                    <button className="sidebar-utility-btn" title="Restore archived chat" onClick={() => handleShowArchives()}>
                      <Archive size={14} />
                      <span>Archives</span>
                    </button>
                  </div>
                  <div className="provider-stack-sessions">
                    {!searchQuery && pFolders.map(folder => (
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
                    {pSessions.map(session => (
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
                  <ProviderStatusPanel providerId={p.providerId} />
                </div>
              )}
            </div>
          );
        })}
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

      {showArchives && (
        <ArchiveModal
          onClose={() => setShowArchives(false)}
          archives={archives}
          archiveSearch={archiveSearch}
          setArchiveSearch={setArchiveSearch}
          onRestore={handleRestore}
          onDelete={handleDeleteArchive}
          restoring={restoring}
        />
      )}

      {showWorkspacePicker && (
        <WorkspacePickerModal
          workspaces={workspaceCwds}
          onClose={() => setShowWorkspacePicker(false)}
          onSelect={(workspace) => {
            handleNew(workspace.path, workspace.agent);
            setShowWorkspacePicker(false);
          }}
        />
      )}

      {showNewFolderModal && (
        <div className="archive-modal-overlay" onClick={handleCloseNewFolderModal}>
          <div className="archive-modal new-folder-modal" onClick={e => e.stopPropagation()}>
            <div className="archive-modal-header">
              <h3>Create Folder</h3>
              <button type="button" onClick={handleCloseNewFolderModal}><X size={16} /></button>
            </div>
            <form className="new-folder-form" onSubmit={handleCreateFolderSubmit}>
              <input
                ref={newFolderInputRef}
                className="new-folder-input"
                type="text"
                placeholder="Folder name"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
              />
              <div className="new-folder-actions">
                <button type="button" className="new-folder-cancel-btn" onClick={handleCloseNewFolderModal}>Cancel</button>
                <button type="submit" className="new-folder-create-btn" disabled={!newFolderName.trim()}>Create</button>
              </div>
            </form>
          </div>
        </div>
      )}

    </aside>
  );
};

export default Sidebar;
