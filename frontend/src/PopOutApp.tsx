import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { ChatSession } from './types';
import { useSocket } from './hooks/useSocket';
import { useScroll } from './hooks/useScroll';
import { useChatManager } from './hooks/useChatManager';
import { useSessionLifecycleStore } from './store/useSessionLifecycleStore';
import { useCanvasStore } from './store/useCanvasStore';
import { useUIStore } from './store/useUIStore';
import ChatHeader from './components/ChatHeader/ChatHeader';
import MessageList from './components/MessageList/MessageList';
import ChatInput from './components/ChatInput/ChatInput';
import CanvasPane from './components/CanvasPane/CanvasPane';
import ConfigErrorModal from './components/ConfigErrorModal';
import { claimSession } from './lib/sessionOwnership';
import { computeResizeWidthNoSidebar } from './utils/resizeHelper';
import './styles/global.css';
import './App.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode; onError: () => void }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.hasError ? null : this.props.children; }
}

function PopOutApp() {
  const popoutSessionId = new URLSearchParams(window.location.search).get('popout')!;
  const [ready, setReady] = useState(false);

  const { sessions, activeSessionId } = useSessionLifecycleStore();
  const { visibleCount } = useUIStore();
  const {
    isCanvasOpen, canvasArtifacts, activeCanvasArtifact,
    setIsCanvasOpen, setActiveCanvasArtifact,
    resetCanvas, handleOpenFileInCanvas, handleFileEdited, handleCloseArtifact
  } = useCanvasStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const { socket } = useSocket();

  const { scrollRef, showScrollButton, scrollToBottom, handleScroll, handleWheel } = useScroll(
    activeSessionId, activeSession?.messages, visibleCount
  );

  useChatManager(
    scrollToBottom,
    (filePath) => handleFileEdited(socket, filePath),
    (filePath) => handleOpenFileInCanvas(socket, activeSessionId, filePath)
  );

  // Initialize: load the specific session and claim ownership
  useEffect(() => {
    if (!socket || !popoutSessionId || ready) return;

    // Claim ownership via BroadcastChannel
    claimSession(popoutSessionId);

    // Set the active session
    useSessionLifecycleStore.setState({ activeSessionId: popoutSessionId });

    // Load sessions from backend
    socket.emit('load_sessions', (res: { sessions?: ChatSession[] }) => {
      if (res.sessions) {
        const mapped = res.sessions.map((s: ChatSession) => ({ ...s, isTyping: false, isWarmingUp: false }));
        useSessionLifecycleStore.setState({ sessions: mapped, activeSessionId: popoutSessionId });

        // Hydrate the session
        const session = mapped.find((s: ChatSession) => s.id === popoutSessionId);
        if (session?.acpSessionId) {
          socket.emit('watch_session', { sessionId: session.acpSessionId });
          useSessionLifecycleStore.getState().hydrateSession(socket, popoutSessionId);
        }
        setReady(true);
      }
    });
  }, [socket, popoutSessionId, ready]);

  // Canvas resize
  const [chatWidth, setChatWidth] = useState<number | null>(null);
  const resizingRef = useRef(false);
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      setChatWidth(computeResizeWidthNoSidebar(ev.clientX));
    };
    const onUp = () => { resizingRef.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { if (!isCanvasOpen) setChatWidth(null); }, [isCanvasOpen]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Set window title
  useEffect(() => {
    if (activeSession?.name) document.title = `${activeSession.name} — Pop Out`;
  }, [activeSession?.name]);

  if (!ready) {
    return (
      <div className="app-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e' }}>
        Loading session...
        <ConfigErrorModal />
      </div>
    );
  }

  return (
    <div className={`app-container ${isCanvasOpen ? 'split-screen' : ''}`}>
      <div className="main-content" style={chatWidth ? { flex: 'none', width: chatWidth } : undefined}>
        <ChatHeader />
        <MessageList
          scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
          handleScroll={handleScroll}
          handleWheel={handleWheel}
          showScrollButton={showScrollButton}
          handleBackToBottom={() => scrollToBottom(true)}
        />
        <ChatInput />
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
      <ConfigErrorModal />
    </div>
  );
}

export default PopOutApp;
