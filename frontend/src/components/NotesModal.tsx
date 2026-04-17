import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, StickyNote } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useSystemStore } from '../store/useSystemStore';
import { useChatStore } from '../store/useChatStore';
import { useUIStore } from '../store/useUIStore';
import './SessionSettingsModal.css';

const NotesModal: React.FC = () => {
  const socket = useSystemStore(state => state.socket);
  const activeSessionId = useChatStore(state => state.activeSessionId);
  const isOpen = useUIStore(state => state.isNotesOpen);
  const setOpen = useUIStore(state => state.setNotesOpen);

  const [notes, setNotes] = useState('');
  const [activeTab, setActiveTab] = useState<'raw' | 'rendered'>('raw');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(activeSessionId);

  // Load notes when opened or session changes
  useEffect(() => {
    if (!isOpen || !socket || !activeSessionId) return;
    sessionRef.current = activeSessionId;
    socket.emit('get_notes', { sessionId: activeSessionId }, (res: { notes?: string }) => {
      if (sessionRef.current === activeSessionId) setNotes(res.notes || '');
    });
  }, [isOpen, socket, activeSessionId]);

  const saveNotes = useCallback((text: string) => {
    if (!socket || !activeSessionId) return;
    socket.emit('save_notes', { sessionId: activeSessionId, notes: text });
    // Track that this session has notes for the button tint
    useChatStore.setState(state => ({
      sessionNotes: { ...state.sessionNotes, [activeSessionId]: text.length > 0 }
    }));
  }, [socket, activeSessionId]);

  const handleChange = (text: string) => {
    setNotes(text);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveNotes(text), 500);
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="modal-overlay">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.2 }}
          className="modal-content notes-modal"
          onClick={e => e.stopPropagation()}
        >
          <div className="modal-header">
            <div className="modal-title">
              <StickyNote size={18} />
              <h2>Scratch Pad</h2>
            </div>
            <button className="close-btn" onClick={() => setOpen(false)}>
              <X size={20} />
            </button>
          </div>

          <div className="modal-tabs">
            <button className={`tab-btn ${activeTab === 'raw' ? 'active' : ''}`} onClick={() => setActiveTab('raw')}>Raw</button>
            <button className={`tab-btn ${activeTab === 'rendered' ? 'active' : ''}`} onClick={() => setActiveTab('rendered')}>Rendered</button>
          </div>

          <div className="modal-body notes-body">
            {activeTab === 'raw' ? (
              <textarea
                className="notes-textarea"
                value={notes}
                onChange={e => handleChange(e.target.value)}
                placeholder="Write notes here... Markdown supported."
                autoFocus
              />
            ) : (
              <div className="notes-rendered message-wrapper">
                {notes ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
                      code({ node: _node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        const language = match ? match[1] : 'text';
                        if (!inline && (match || String(children).includes('\n'))) {
                          return (
                            <SyntaxHighlighter style={vscDarkPlus} language={language} PreTag="div" className="syntax-highlighter">
                              {String(children).replace(/\n$/, '')}
                            </SyntaxHighlighter>
                          );
                        }
                        return <code className={className} {...props}>{children}</code>;
                      }
                    }}
                  >
                    {notes}
                  </ReactMarkdown>
                ) : <p className="notes-empty">No notes yet.</p>}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default NotesModal;
