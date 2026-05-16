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
import ConfirmModal from './components/ConfirmModal';
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const didInitRef = useRef(false);

  const { sessions, activeSessionId, setSessions, setActiveSessionId, hydrateSession } = useSessionLifecycleStore();
  const { visibleCount } = useUIStore();
  const {
    isCanvasOpen, canvasArtifacts, activeCanvasArtifact, canvasError,
    setIsCanvasOpen, setActiveCanvasArtifact,
    resetCanvas, handleOpenFileInCanvas, handleFileEdited, handleCloseArtifact,
    setCanvasError
  } = useCanvasStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const { socket } = useSocket();

  const { scrollRef, showScrollButton, scrollToBottom, handleScroll, handleWheel } = useScroll(
    activeSessionId, activeSession?.messages, visibleCount
  );

  useChatManager(
    scrollToBottom,
    (filePath) => handleFileEdited(socket, filePath),
    (filePath) => handleOpenFileInCanvas(socket, activeSessionId, filePath),
    { skipInitialLoad: true }
  );

  // Initialize: load the specific session and claim ownership
  useEffect(() => {
    if (!socket || !popoutSessionId || didInitRef.current) return;
    didInitRef.current = true;

    claimSession(popoutSessionId);
    setActiveSessionId(popoutSessionId);

    socket.emit('load_sessions', (res: { sessions?: ChatSession[]; error?: string }) => {
      if (!Array.isArray(res.sessions)) {
        setLoadError(res.error || 'Could not load sessions for pop-out window.');
        setStatus('error');
        return;
      }

      const mapped = res.sessions.map((s: ChatSession) => ({ ...s, isTyping: false, isWarmingUp: false }));
      setSessions(mapped);
      setActiveSessionId(popoutSessionId);

      const session = mapped.find((s: ChatSession) => s.id === popoutSessionId);
      if (!session) {
        setLoadError(`Session ${popoutSessionId} was not found.`);
        setStatus('error');
        return;
      }

      if (session.acpSessionId) {
        socket.emit('watch_session', { providerId: session.provider, sessionId: session.acpSessionId });
      }
      hydrateSession(socket, popoutSessionId);
      setStatus('ready');
    });
  }, [socket, popoutSessionId, setActiveSessionId, setSessions, hydrateSession]);

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

  if (status === 'loading') {
    return (
      <div className="app-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e' }}>
        Loading session...
        <ConfigErrorModal />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="app-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff7b72', flexDirection: 'column', gap: '6px' }}>
        <div>Failed to load session.</div>
        {loadError && <div>{loadError}</div>}
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

export default PopOutApp;
