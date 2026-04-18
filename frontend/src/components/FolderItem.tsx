import React, { useState, useRef } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Pencil, Check, X, Trash2, FolderPlus } from 'lucide-react';
import type { Folder as FolderType, ChatSession } from '../types';
import { useFolderStore } from '../store/useFolderStore';
import SessionItem from './SessionItem';

interface FolderItemProps {
  folder: FolderType;
  folders: FolderType[];
  sessions: ChatSession[];
  activeSessionId: string | null;
  depth: number;
  onSelectSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onTogglePin: (id: string) => void;
  onArchiveSession: (id: string) => void;
  onSettingsSession: (id: string) => void;
  onDropSession: (sessionId: string, folderId: string | null) => void;
  onDropFolder: (folderId: string, newParentId: string | null) => void;
}

const FolderItem: React.FC<FolderItemProps> = ({
  folder, folders, sessions, activeSessionId, depth,
  onSelectSession, onRenameSession, onTogglePin, onArchiveSession, onSettingsSession,
  onDropSession, onDropFolder
}) => {
  const { expandedFolderIds, toggleFolder, renameFolder, deleteFolder, createFolder } = useFolderStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const dragOverRef = useRef(0);

  const isExpanded = expandedFolderIds.has(folder.id);
  const childFolders = folders.filter(f => f.parentId === folder.id);
  const childSessions = sessions.filter(s => s.folderId === folder.id && !s.forkedFrom);
  const getForksOf = (parentId: string) => sessions.filter(s => s.forkedFrom === parentId && !s.isSubAgent);
  const getSubAgentsOf = (parentId: string) => sessions.filter(s => s.isSubAgent && s.forkedFrom === parentId);

  const renderForkTree = (parentId: string, indent = 1): React.ReactNode => {
    const forks = getForksOf(parentId);
    const subs = getSubAgentsOf(parentId);
    if (!forks.length && !subs.length) return null;
    return (
      <>
        {forks.map(fork => (
          <div key={fork.id}>
            <div className="fork-indent" style={{ marginLeft: `${(depth + indent) * 16}px` }}>
              <SessionItem
                session={fork}
                isActive={fork.id === activeSessionId}
                onSelect={() => onSelectSession(fork.id)}
                onRename={(name) => onRenameSession(fork.id, name)}
                onTogglePin={() => onTogglePin(fork.id)}
                onArchive={() => onArchiveSession(fork.id)}
                onSettings={() => onSettingsSession(fork.id)}
              />
            </div>
            {renderForkTree(fork.id, indent + 1)}
          </div>
        ))}
        {subs.map(sub => (
          <div key={sub.id} className="fork-indent" style={{ marginLeft: `${(depth + indent) * 16}px` }}>
            <SessionItem
              session={sub}
              isActive={sub.id === activeSessionId}
              onSelect={() => onSelectSession(sub.id)}
              onRename={() => {}}
              onTogglePin={() => {}}
              onArchive={() => onArchiveSession(sub.id)}
              onSettings={() => {}}
            />
          </div>
        ))}
      </>
    );
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragOverRef.current++;
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    dragOverRef.current--;
    if (dragOverRef.current === 0) setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragOverRef.current = 0;
    setIsDragOver(false);

    const sessionId = e.dataTransfer.getData('session-id');
    const dragFolderId = e.dataTransfer.getData('folder-id');

    if (sessionId) {
      onDropSession(sessionId, folder.id);
    } else if (dragFolderId && dragFolderId !== folder.id) {
      // Prevent dropping a folder into its own descendant
      if (!isDescendant(dragFolderId, folder.id, folders)) {
        onDropFolder(dragFolderId, folder.id);
      }
    }

    // Auto-expand on drop
    if (!isExpanded) toggleFolder(folder.id);
  };

  const handleFolderDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData('folder-id', folder.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const startEdit = () => {
    setIsEditing(true);
    setEditName(folder.name);
  };

  const saveEdit = () => {
    if (editName.trim()) renameFolder(folder.id, editName.trim());
    setIsEditing(false);
  };

  return (
    <div className="folder-tree-item">
      <div
        className={`folder-row ${isDragOver ? 'drag-over' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        draggable
        onDragStart={handleFolderDragStart}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => toggleFolder(folder.id)}
        onContextMenu={(e) => { e.preventDefault(); startEdit(); }}
      >
        <span className="folder-chevron">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        {isExpanded ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" />}

        {isEditing ? (
          <div className="folder-edit" onClick={e => e.stopPropagation()}>
            <input
              autoFocus
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setIsEditing(false); }}
              className="folder-edit-input"
            />
            <Check size={12} onClick={saveEdit} className="action-icon" />
            <X size={12} onClick={() => setIsEditing(false)} className="action-icon" />
          </div>
        ) : (
          <>
            <span className="folder-name">{folder.name}</span>
            <span className="folder-count">{childSessions.length + childFolders.length}</span>
            <div className="folder-actions" onClick={e => e.stopPropagation()}>
              <button title="New subfolder" onClick={() => createFolder('New Folder', folder.id, folder.providerId)}><FolderPlus size={12} /></button>
              <button title="Rename" onClick={startEdit}><Pencil size={12} /></button>
              <button title="Delete folder" onClick={() => deleteFolder(folder.id)}><Trash2 size={12} /></button>
            </div>
          </>
        )}
      </div>

      {isExpanded && (
        <div className="folder-children">
          {childFolders.map(cf => (
            <FolderItem
              key={cf.id}
              folder={cf}
              folders={folders}
              sessions={sessions}
              activeSessionId={activeSessionId}
              depth={depth + 1}
              onSelectSession={onSelectSession}
              onRenameSession={onRenameSession}
              onTogglePin={onTogglePin}
              onArchiveSession={onArchiveSession}
              onSettingsSession={onSettingsSession}
              onDropSession={onDropSession}
              onDropFolder={onDropFolder}
            />
          ))}
          {childSessions.map(session => (
            <div key={session.id}>
              <div
                style={{ paddingLeft: `${(depth + 1) * 16}px` }}
                draggable
                onDragStart={e => {
                  e.stopPropagation();
                  e.dataTransfer.setData('session-id', session.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
              >
                <SessionItem
                  session={session}
                  isActive={session.id === activeSessionId}
                  onSelect={() => onSelectSession(session.id)}
                  onRename={(name) => onRenameSession(session.id, name)}
                  onTogglePin={() => onTogglePin(session.id)}
                  onArchive={() => onArchiveSession(session.id)}
                  onSettings={() => onSettingsSession(session.id)}
                />
              </div>
              {renderForkTree(session.id)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function isDescendant(folderId: string, targetId: string, folders: FolderType[]): boolean {
  let current = folders.find(f => f.id === targetId);
  while (current) {
    if (current.parentId === folderId) return true;
    current = folders.find(f => f.id === current!.parentId);
  }
  return false;
}

export default FolderItem;
