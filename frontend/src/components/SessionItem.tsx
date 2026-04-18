import React, { useState } from 'react';
import { MessageSquare, Pencil, Check, X, Settings, Pin, PinOff, Archive, Trash2, StickyNote, GitFork, ExternalLink, Bot, Terminal } from 'lucide-react';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { useCanvasStore } from '../store/useCanvasStore';
import { openPopout, isSessionPoppedOut, focusPopout } from '../lib/sessionOwnership';
import type { ChatSession } from '../types';

interface SessionItemProps {
  session: ChatSession;
  isActive: boolean;
  onSelect: () => void;
  onRename: (newName: string) => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onSettings: () => void;
}

const SessionItem: React.FC<SessionItemProps> = ({ session, isActive, onSelect, onRename, onTogglePin, onArchive, onSettings }) => {
  const hasNotes = useSessionLifecycleStore(state => state.sessionNotes[session.id]);
  const deletePermanent = useSystemStore(state => state.deletePermanent);
  const hasTerminal = useCanvasStore(state => state.terminals.some(t => t.sessionId === session.id));
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');

  const handleStartEdit = () => {
    setIsEditing(true);
    setEditName(session.name);
  };

  const handleSaveEdit = () => {
    if (editName.trim()) onRename(editName.trim());
    setIsEditing(false);
  };

  return (
    <div
      className={`session-item ${isActive ? 'active' : ''} ${session.isPinned ? 'pinned' : ''} ${session.isTyping ? 'typing' : ''} ${session.hasUnreadResponse ? 'unread' : ''} ${session.isAwaitingPermission ? 'awaiting-permission' : ''} ${isSessionPoppedOut(session.id) ? 'popped-out' : ''}`}
      onClick={() => !isEditing && (isSessionPoppedOut(session.id) ? focusPopout(session.id) : onSelect())}
      onContextMenu={(e) => { e.preventDefault(); handleStartEdit(); }}
    >
      {(session.forkedFrom || session.isSubAgent) && <span className="fork-arrow">↳</span>}
      {session.isSubAgent ? <Bot size={16} className="session-icon" style={{ color: 'rgba(34, 197, 94, 0.7)' }} />
        : session.forkedFrom ? <GitFork size={16} className="session-icon fork-icon" style={{ color: 'rgba(88, 166, 255, 0.6)' }} />
        : hasTerminal ? <Terminal size={16} className="session-icon" style={{ color: 'rgba(34, 197, 94, 0.7)' }} />
        : <MessageSquare size={16} className="session-icon" />}

      {isEditing ? (
        <div className="edit-container">
          <input
            autoFocus
            className="edit-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveEdit();
              if (e.key === 'Escape') setIsEditing(false);
            }}
          />
          <div className="edit-actions">
            <Check size={14} onClick={handleSaveEdit} className="action-icon" />
            <X size={14} onClick={() => setIsEditing(false)} className="action-icon" />
          </div>
        </div>
      ) : (
        <>
          <span className="session-name">{session.name}</span>
          {hasNotes && <StickyNote size={10} className="session-notes-indicator" />}
          <div className="session-actions">
            {session.isSubAgent ? (
              !session.isTyping && (
                <button className="session-action-btn" title="Delete" onClick={(e) => { e.stopPropagation(); onArchive(); }}>
                  <Trash2 size={12} />
                </button>
              )
            ) : (
            <>
            <button className={`session-action-btn ${session.isPinned ? 'active' : ''}`} title={session.isPinned ? "Unpin" : "Pin"} onClick={(e) => { e.stopPropagation(); onTogglePin(); }}>
              {session.isPinned ? <PinOff size={12} /> : <Pin size={12} />}
            </button>
            <button className="session-action-btn" title="Rename" onClick={(e) => { e.stopPropagation(); handleStartEdit(); }}>
              <Pencil size={12} />
            </button>
            <button className="session-action-btn" title="Chat Settings" onClick={(e) => { e.stopPropagation(); onSettings(); }}>
              <Settings size={12} />
            </button>
            <button className="session-action-btn" title="Pop Out" onClick={(e) => { e.stopPropagation(); openPopout(session.id); }}>
              <ExternalLink size={12} />
            </button>
            <button className="session-action-btn" title={deletePermanent ? "Delete Chat" : "Archive Chat"} onClick={(e) => { e.stopPropagation(); onArchive(); }}>
              {deletePermanent ? <Trash2 size={12} /> : <Archive size={12} />}
            </button>
            </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default SessionItem;
