import React from 'react';
import { Terminal, Menu, Settings, FolderOpen } from 'lucide-react';
import StatusIndicator from '../Status/StatusIndicator';
import './ChatHeader.css';
import { useSessionLifecycleStore } from '../../store/useSessionLifecycleStore';
import { useUIStore } from '../../store/useUIStore';
import { useSystemStore } from '../../store/useSystemStore';

const ChatHeader: React.FC = () => {
  const { sessions, activeSessionId } = useSessionLifecycleStore();
  const { 
    setSidebarOpen
  } = useUIStore();
  const { connected, isEngineReady } = useSystemStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const branding = useSystemStore(state => state.getBranding(activeSession?.provider));
  const activeSessionName = activeSession?.name;
  const isPopout = new URLSearchParams(window.location.search).has('popout');

  const cwdLabel = activeSession?.cwd
    ? useSystemStore.getState().workspaceCwds.find(w => w.path === activeSession.cwd)?.label || null
    : null;

  return (
    <header className={`header ${!connected ? 'disconnected' : ''}`}>
      <div className="header-left">
        {!isPopout && (
          <button onClick={() => setSidebarOpen(true)} className="mobile-header-menu-btn" title="Open Sidebar">
            <Menu size={20} />
          </button>
        )}
        <StatusIndicator connected={connected} isEngineReady={isEngineReady} />
        <div className="header-divider" />
        <div className="header-title-container">
          <Terminal size={18} className="header-icon" />
          <h1 className="header-title">
            {activeSessionName ? (
              <span className="header-session-name">{activeSessionName}{cwdLabel && <span className="header-cwd-label"> ({cwdLabel})</span>}</span>
            ) : (
              <span className="header-mobile-fallback">{branding.appHeader}</span>
            )}
          </h1>
        </div>
      </div>

      {!isPopout && (
        <div className="header-actions">
          <button
            onClick={() => useUIStore.getState().setFileExplorerOpen(true)}
            className="icon-button"
            title="File Explorer"
          >
            <FolderOpen size={18} />
          </button>
          <button
            onClick={() => useUIStore.getState().setSystemSettingsOpen(true)}
            className="icon-button"
            title="System Settings"
          >
            <Settings size={18} />
          </button>
        </div>
      )}
    </header>
  );
};

export default ChatHeader;
