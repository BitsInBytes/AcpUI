import React, { useRef, useEffect, useState, useMemo } from 'react';
import { Paperclip, Mic, Square, Send, Loader2, StickyNote, TerminalSquare, Layout, ArrowDownToLine, GitMerge, Gauge } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import FileTray from '../FileTray';
import ModelSelector from './ModelSelector';
import SlashDropdown from './SlashDropdown';
import './ChatInput.css';
import { useSystemStore } from '../../store/useSystemStore';
import { useVoiceStore } from '../../store/useVoiceStore';
import { useChatStore } from '../../store/useChatStore';
import { useSessionLifecycleStore } from '../../store/useSessionLifecycleStore';
import { useInputStore } from '../../store/useInputStore';
import { useUIStore } from '../../store/useUIStore';
import { useCanvasStore } from '../../store/useCanvasStore';
import { useFileUpload } from '../../hooks/useFileUpload';
import { useVoice } from '../../hooks/useVoice';

const ChatInput: React.FC = () => {
  const { socket, connected, isEngineReady } = useSystemStore();
  const slashCommandsByProviderId = useSystemStore(state => state.slashCommandsByProviderId);
  const globalSlashCommands = useSystemStore(state => state.slashCommands);
  const contextUsageBySession = useSystemStore(state => state.contextUsageBySession);
  const { isRecording, isProcessingVoice, isVoiceEnabled } = useVoiceStore();
  
  const {
    sessions,
    activeSessionId,
    handleActiveSessionModelChange,
    handleSetSessionOption
  } = useSessionLifecycleStore();

  const { inputs, setInput } = useInputStore();
  const { handleSubmit, handleCancel } = useChatStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeProvider = activeSession?.provider || useSystemStore.getState().activeProviderId;
  const providerCommands = activeProvider ? slashCommandsByProviderId[activeProvider] : null;
  const slashCommands = useMemo(() => {
    const base = providerCommands || globalSlashCommands;
    const custom = globalSlashCommands.filter(c => c.meta?.local);
    if (custom.length === 0) return base;
    const seen = new Set(custom.map(c => c.name));
    return [...custom, ...base.filter(c => !seen.has(c.name))];
  }, [providerCommands, globalSlashCommands]);

  const {
    isModelDropdownOpen,
    setModelDropdownOpen,
    isAutoScrollDisabled,
    toggleAutoScroll,
    setSettingsOpen,
  } = useUIStore();

  const { terminals, isCanvasOpen, openTerminal, setIsCanvasOpen } = useCanvasStore();
  
  const input = activeSession ? (inputs[activeSession.id] || '') : '';
  const reasoningEffortOption = activeSession?.configOptions?.find(o => o.kind === 'reasoning_effort');
  const shouldShowReasoningEffort = reasoningEffortOption?.type === 'select' && !!reasoningEffortOption.options;
  const activeSessionIdRef = useRef<string | null>(activeSessionId);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const {
    attachments,
    setAttachments,
    handleFileUpload
  } = useFileUpload(activeSessionId, activeSessionIdRef);

  const {
    startRecording,
    stopRecording
  } = useVoice(socket);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const isDisabled = !connected || !isEngineReady || activeSession?.isTyping || activeSession?.isWarmingUp;

  const [slashIndex, setSlashIndex] = useState(-1);
  const [merging, setMerging] = useState(false);

  const handleMergeFork = () => {
    if (!socket || !activeSession?.forkedFrom || merging) return;
    setMerging(true);
    const forkId = activeSession.id;
    const parentId = activeSession.forkedFrom;
    socket.emit('merge_fork', { uiId: forkId }, (res: { success?: boolean; parentUiId?: string; error?: string }) => {
      setMerging(false);
      if (res.success) {
        useSessionLifecycleStore.getState().handleSessionSelect(socket, parentId);
        setTimeout(() => {
          useSessionLifecycleStore.setState(state => ({
            sessions: state.sessions.filter(s => s.id !== forkId),
          }));
        }, 100);
      }
    });
  };

  const filteredCommands = useMemo(() => {
    const HIDDEN = ['/usage', '/reply', '/quit', '/plan', '/clear', '/knowledge', '/paste'];
    if (!input.startsWith('/')) return [];
    const query = input.toLowerCase();
    return slashCommands
      .filter(c => !HIDDEN.includes(c.name))
      .filter(c => c.name.toLowerCase().startsWith(query));
  }, [input, slashCommands]);
  const showSlash = filteredCommands.length > 0 && input.startsWith('/') && !input.includes(' ');

  useEffect(() => { setSlashIndex(-1); }, [input]);

  useEffect(() => {
    if (!isModelDropdownOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (modelDropdownRef.current?.contains(target)) return;
      setModelDropdownOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isModelDropdownOpen, setModelDropdownOpen]);

  const selectSlashCommand = (cmd: typeof slashCommands[0]) => {
    const hasArgs = cmd.meta?.inputType === 'panel' || cmd.meta?.hint;
    setInput(activeSessionId || '', cmd.name + (hasArgs ? ' ' : ''));
    if (!hasArgs) {
      setTimeout(() => handleSubmit(socket), 0);
    }
    textareaRef.current?.focus();
  };

  useEffect(() => {
    if (!isDisabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isDisabled, activeSession?.id]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlash) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, filteredCommands.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && slashIndex >= 0)) { e.preventDefault(); selectSlashCommand(filteredCommands[Math.max(slashIndex, 0)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setInput(activeSessionId || '', ''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(socket);
    }
  };

  const onMicClick = () => {
    if (isRecording) {
      stopRecording((text) => setInput(activeSessionId || '', text));
    } else {
      startRecording();
    }
  };

  return (
    <footer className="input-container">
      {merging && (
        <div className="merge-overlay">
          <div className="merge-overlay-content">
            <GitMerge size={32} />
            <span>Merging fork...</span>
          </div>
        </div>
      )}
      {activeSession?.isSubAgent ? (
        <div className="input-wrapper" style={{ opacity: 0.5, textAlign: 'center', padding: '0.75rem', fontSize: '0.85em', color: '#8b949e' }}>
          Sub-agent session (read-only)
        </div>
      ) : (
      <div className={`input-wrapper ${activeSession?.isWarmingUp ? 'warming-up' : ''}`}>
        <FileTray
          attachments={attachments}
          onRemove={(idx) => setAttachments(activeSessionId!, prev => prev.filter((_, i) => i !== idx))}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (activeSession?.isTyping) handleCancel(socket);
            else handleSubmit(socket);
          }}
          className="input-form"
        >
          <input
            type="file"
            multiple
            ref={fileInputRef}
            style={{ display: 'none' }}
            onChange={(e) => handleFileUpload(e.target.files)}
          />
          <button
            type="button"
            className="input-action-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={isDisabled}
            title="Attach files"
          >
            <Paperclip size={20} />
          </button>
          <button
            type="button"
            className={`input-action-btn ${useSessionLifecycleStore.getState().sessionNotes[activeSessionId || ''] ? 'has-notes' : ''}`}
            onClick={() => useUIStore.getState().setNotesOpen(true)}
            title="Scratch Pad"
          >
            <StickyNote size={20} />
          </button>

          <div className="textarea-container">
            <SlashDropdown
              commands={filteredCommands}
              visible={showSlash}
              selectedIndex={slashIndex}
              onSelect={selectSlashCommand}
            />
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(activeSession?.id || '', e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeSession?.isTyping ? (activeProvider ? useSystemStore.getState().providersById[activeProvider]?.branding?.busyText : useSystemStore.getState().branding.busyText) : activeSession?.isHooksRunning ? ((activeProvider ? useSystemStore.getState().providersById[activeProvider]?.branding?.hooksText : useSystemStore.getState().branding.hooksText) || '⚙ Cleaning up...') : !isEngineReady ? ((activeProvider ? useSystemStore.getState().providersById[activeProvider]?.branding?.warmingUpText : useSystemStore.getState().branding.warmingUpText) || 'Engine warming up...') : activeSession?.isWarmingUp ? ((activeProvider ? useSystemStore.getState().providersById[activeProvider]?.branding?.resumingText : useSystemStore.getState().branding.resumingText) || 'Resuming...') : ((activeProvider ? useSystemStore.getState().providersById[activeProvider]?.branding?.inputPlaceholder : useSystemStore.getState().branding.inputPlaceholder) || 'Send a message...')}
              disabled={isDisabled}
              rows={1}
            />
          </div>

          <div className="input-right-actions">
            {isVoiceEnabled && (
            <button
              type="button"
              className={`input-action-btn mic-btn ${isRecording ? 'recording' : ''} ${isProcessingVoice ? 'processing' : ''}`}
              onClick={onMicClick}
              disabled={isDisabled}
              title={isRecording ? "Stop recording" : "Start voice input"}
            >
              {isProcessingVoice ? <Loader2 size={20} className="animate-spin" /> : <Mic size={20} />}
            </button>
            )}

            {activeSession?.isTyping ? (
              <button
                type="button"
                onClick={() => handleCancel(socket)}
                className="send-button cancel"
                title="Stop generating"
              >
                <Square size={18} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={(!input.trim() && attachments.length === 0) || !connected || !isEngineReady || activeSession?.isWarmingUp}
                title="Send message"
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </form>
        <div className="chatinput-pills">
          <button
            className={`chatinput-pill ${terminals.some(t => t.sessionId === activeSessionId) ? 'active' : ''}`}
            onClick={() => openTerminal(activeSessionId || '')}
            title="New Terminal"
          >
            <TerminalSquare size={12} />
            Terminal
          </button>
          <button
            className={`chatinput-pill ${isCanvasOpen ? 'active' : ''}`}
            onClick={() => setIsCanvasOpen(!isCanvasOpen)}
            title={isCanvasOpen ? 'Close Canvas' : 'Open Canvas'}
          >
            <Layout size={12} />
            Canvas
          </button>
          <button
            className={`chatinput-pill ${!isAutoScrollDisabled ? 'active' : ''}`}
            onClick={toggleAutoScroll}
            title={isAutoScrollDisabled ? "Enable Auto-scroll" : "Disable auto-scroll"}
          >
            <ArrowDownToLine size={12} />
            Auto-scroll
          </button>
          {activeSession?.forkedFrom && !activeSession?.isSubAgent && (
            <button
              className="chatinput-pill merge-fork-pill"
              onClick={handleMergeFork}
              disabled={merging || !!activeSession?.isTyping || !!activeSession?.isWarmingUp}
              title="Summarize fork work and send to parent chat"
            >
              <GitMerge size={12} />
              Merge Fork
            </button>
          )}
        </div>
        {(() => {
          const pct = activeSession?.acpSessionId ? (contextUsageBySession[activeSession.acpSessionId] || 0) : 0;
          const color = pct >= 80 ? '#dc2626' : pct >= 60 ? '#eab308' : pct >= 50 ? '#22c55e' : 'rgba(96, 165, 250, 0.5)';
          return (
            <div className="context-bar-track">
              <div className="context-bar-fill" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
            </div>
          );
        })()}
      </div>
      )}

      <div className="chatinput-footer-container">
        <AnimatePresence initial={false}>
          {shouldShowReasoningEffort && (
            <motion.div
              key={`${activeSession?.id}-reasoning-effort`}
              className="effort-selector-motion"
              initial={{ opacity: 0, height: 0, y: 4 }}
              animate={{ opacity: 1, height: 'auto', y: 0 }}
              exit={{ opacity: 0, height: 0, y: 4 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="effort-selector">
                <Gauge size={14} className="effort-icon" />
                <div className="effort-buttons">
                  {reasoningEffortOption.options!.map(o => (
                    <button
                      key={o.value}
                      type="button"
                      className={`effort-btn ${reasoningEffortOption.currentValue === o.value ? 'active' : ''}`}
                      onClick={() => handleSetSessionOption(socket, activeSession!.id, reasoningEffortOption.id, o.value)}
                      title={o.description || o.name}
                    >
                      {o.name}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <ModelSelector
          activeSession={activeSession}
          isModelDropdownOpen={isModelDropdownOpen}
          setIsModelDropdownOpen={setModelDropdownOpen}
          onModelSelect={(model) => handleActiveSessionModelChange(socket, model)}
          modelDropdownRef={modelDropdownRef}
          getActiveModelQuotaPercent={() => null}
          disabled={!!isDisabled}
          onOpenSettings={() => activeSession && setSettingsOpen(true, activeSession.id, 'config')}
        />
      </div>
    </footer>
  );
};

export default ChatInput;
