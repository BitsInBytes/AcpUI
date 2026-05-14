import React, { useEffect, useRef, useState, useCallback, Component } from 'react';
import { ChevronRight, MessageSquare } from 'lucide-react';

// Hooks
import { useSocket } from './hooks/useSocket';
import { useScroll } from './hooks/useScroll';
import { useChatManager } from './hooks/useChatManager';

// Stores
import { useSessionLifecycleStore } from './store/useSessionLifecycleStore';
import { useInputStore } from './store/useInputStore';
import { useCanvasStore } from './store/useCanvasStore';
import { useUIStore } from './store/useUIStore';
import { isSessionPoppedOut, setOwnershipChangeCallback } from './lib/sessionOwnership';
import { computeResizeWidth } from './utils/resizeHelper';

// Components
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader/ChatHeader';
import MessageList from './components/MessageList/MessageList';
import ChatInput from './components/ChatInput/ChatInput';
import SessionSettingsModal from './components/SessionSettingsModal';
import SystemSettingsModal from './components/SystemSettingsModal';
import NotesModal from './components/NotesModal';
import FileExplorer from './components/FileExplorer';
import HelpDocsModal from './components/HelpDocsModal';
import CanvasPane from './components/CanvasPane/CanvasPane';
import ConfigErrorModal from './components/ConfigErrorModal';
import ConfirmModal from './components/ConfirmModal';

// Styles
import './styles/global.css';
import './App.css';

// Monaco editor can crash on rapid session switches — boundary isolates CanvasPane
// so a crash resets canvas state instead of taking down the whole app
class ErrorBoundary extends Component<{ children: React.ReactNode; onError: () => void }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.hasError ? null : this.props.children; }
}

function App() {
  // --- STORES ---
  const { sessions, activeSessionId, checkPendingPrompts } = useSessionLifecycleStore();
  const { handleFileUpload } = useInputStore();

  const {
    isSidebarOpen,
    isSidebarPinned,
    setSidebarOpen,
    visibleCount,
    resetVisibleCount
  } = useUIStore();

  const {
    isCanvasOpen,
    canvasArtifacts,
    activeCanvasArtifact,
    canvasError,
    setIsCanvasOpen,
    setActiveCanvasArtifact,
    setCanvasArtifacts,
    resetCanvas,
    handleOpenFileInCanvas,
    handleFileEdited,
    handleCloseArtifact,
    setCanvasError
  } = useCanvasStore();

  // --- DERIVED ---
  const activeSession = sessions.find(s => s.id === activeSessionId);

  const lastActiveSessionIdRef = useRef<string | null>(null);

  // --- MODULAR HOOKS ---
  const { socket } = useSocket();

  const {
    scrollRef,
    showScrollButton,
    scrollToBottom,
    handleScroll,
    handleWheel
  } = useScroll(activeSessionId, activeSession?.messages, visibleCount);

  // --- CHAT MANAGER (Socket Listeners & Streaming) ---
  useChatManager(
    scrollToBottom,
    (filePath) => handleFileEdited(socket, filePath),
    (filePath) => handleOpenFileInCanvas(socket, activeSessionId, filePath)
  );

  // --- EFFECTS ---

  // Session ownership changes (pop-out open/close) — force sidebar re-render
  // Ownership lives outside React state (sessionOwnership module) — this dummy counter
  // forces a re-render when a pop-out window opens/closes so Sidebar reflects the change
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    setOwnershipChangeCallback(() => forceUpdate(n => n + 1));
  }, []);
  
  // Session switch: unwatch previous ACP session (stops streaming), watch new one,
  // persist canvas open/closed state per-session, and restore terminals tied to the new session
  useEffect(() => {
    if (activeSessionId !== lastActiveSessionIdRef.current) {
      // Unwatch previous session, watch new one
      const prevSession = sessions.find(s => s.id === lastActiveSessionIdRef.current);
      const newSession = sessions.find(s => s.id === activeSessionId);
      if (prevSession?.acpSessionId && socket && !prevSession.isTyping) socket.emit('unwatch_session', { sessionId: prevSession.acpSessionId });
      if (newSession && isSessionPoppedOut(newSession.id)) {
        useSessionLifecycleStore.getState().setActiveSessionId(null);
        return;
      }
      if (newSession?.acpSessionId && socket) {
        socket.emit('watch_session', { sessionId: newSession.acpSessionId });
      }
      // Save current session's canvas open state
      const prevId = lastActiveSessionIdRef.current;
      if (prevId) {
        const { isCanvasOpen: wasOpen } = useCanvasStore.getState();
        useCanvasStore.setState(s => ({ canvasOpenBySession: { ...s.canvasOpenBySession, [prevId]: wasOpen } }));
      }
      // Restore new session's canvas state
      const { canvasOpenBySession, terminals } = useCanvasStore.getState();
      const sessionTerminals = terminals.filter(t => t.sessionId === activeSessionId);
      const savedOpen = canvasOpenBySession[activeSessionId || ''] ?? false;
      setActiveCanvasArtifact(null);
      setCanvasArtifacts([]);
      setIsCanvasOpen(savedOpen || sessionTerminals.length > 0);
      if (sessionTerminals.length > 0) {
        useCanvasStore.setState({ activeTerminalId: sessionTerminals[0].id });
      } else {
        useCanvasStore.setState({ activeTerminalId: null });
      }
      lastActiveSessionIdRef.current = activeSessionId;
      resetVisibleCount();
    }
    
    // Fires on every activeSessionId change (including initial mount) to load
    // any canvas artifacts the backend has persisted for this session
    if (activeSessionId && socket) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.emit('canvas_load', { sessionId: activeSessionId }, (res: { artifacts?: any[] }) => {
        if (res.artifacts && res.artifacts.length > 0) {
          setCanvasArtifacts(res.artifacts);
          setActiveCanvasArtifact(res.artifacts[0]);
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, socket, setIsCanvasOpen, setActiveCanvasArtifact, setCanvasArtifacts, resetCanvas, resetVisibleCount]);

  // Auto-opening Canvas reliably for Plans
  useEffect(() => {
    if (activeSession?.isAwaitingPermission) {
      const hasPlan = canvasArtifacts.some(a => 
        a.filePath?.toLowerCase().endsWith('plan.md') || 
        a.title.toLowerCase().endsWith('plan.md')
      );
      if (hasPlan && !isCanvasOpen) {
        setIsCanvasOpen(true);
      }
    }
  }, [activeSession?.isAwaitingPermission, canvasArtifacts, isCanvasOpen, setIsCanvasOpen]);

  // Sync pending prompts
  useEffect(() => {
    checkPendingPrompts(socket);
  }, [sessions, socket, checkPendingPrompts]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0 && activeSessionId) {
      handleFileUpload(e.dataTransfer.files, activeSessionId);
    }
  };

  // Canvas resize: chat pane width is computed relative to sidebar offset so the handle stays consistent
  const [chatWidth, setChatWidth] = useState<number | null>(null);
  const resizingRef = useRef(false);

  // Locks cursor to col-resize and disables text selection during drag so the
  // resize handle doesn't flicker or accidentally highlight chat content
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      setChatWidth(computeResizeWidth(ev.clientX, isSidebarOpen ? 280 : 0));
    };
    const onUp = () => { resizingRef.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [isSidebarOpen]);

  // Reset width when canvas closes
   
  useEffect(() => { if (!isCanvasOpen) setChatWidth(null); }, [isCanvasOpen]);
   
  return (
    <div className={`app-container ${isSidebarOpen ? 'sidebar-open' : ''} ${isCanvasOpen ? 'split-screen' : ''}`} onDragOver={handleDragOver} onDrop={handleDrop}>
      <Sidebar />

      <div className="main-content" style={chatWidth ? { flex: 'none', width: chatWidth } : undefined} onClick={() => { if (isSidebarOpen && !isSidebarPinned) setSidebarOpen(false); }}>
        {!isSidebarOpen && (
          <button 
            className="open-sidebar-bubble"
            onClick={() => setSidebarOpen(true)}
            title="Open Sidebar"
          >
            <ChevronRight size={20} />
          </button>
        )}
        {/* No session selected — show placeholder instead of rendering chat components
            that would throw on missing session data */}
        {!activeSessionId ? (
          <div className="empty-state">
            <MessageSquare size={48} strokeWidth={1} />
            <p>Select a chat or start a new one</p>
          </div>
        ) : (
        <>
        <ChatHeader />

        <MessageList
          scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
          handleScroll={handleScroll}
          handleWheel={handleWheel}
          showScrollButton={showScrollButton}
          handleBackToBottom={() => scrollToBottom(true)}
        />

        <ChatInput />
        </>
        )}
      </div>

      {isCanvasOpen && <div className="canvas-resize-handle" onMouseDown={onResizeStart} />}
      {isCanvasOpen && (
        <ErrorBoundary key={activeSessionId} onError={() => resetCanvas()}>
          <CanvasPane 
            activeArtifact={activeCanvasArtifact} 
            artifacts={canvasArtifacts}
            onSelectArtifact={setActiveCanvasArtifact}
            onClose={() => setIsCanvasOpen(false)} 
            onCloseArtifact={(id) => handleCloseArtifact(socket, id)}
          />
        </ErrorBoundary>
      )}


      <SessionSettingsModal />
      <SystemSettingsModal />
      <NotesModal />
      <FileExplorer />
      <HelpDocsModal />
      <ConfirmModal
        isOpen={Boolean(canvasError)}
        onClose={() => setCanvasError(null)}
        onConfirm={() => setCanvasError(null)}
        title="Canvas Error"
        message={canvasError || ''}
        confirmText="OK"
        cancelText="Dismiss"
        variant="warning"
      />
      <ConfigErrorModal />
    </div>
  );
}

export default App;
