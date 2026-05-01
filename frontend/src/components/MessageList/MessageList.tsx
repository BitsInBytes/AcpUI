import React from 'react';
import { History, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import HistoryList from '../HistoryList';
import { useSystemStore } from '../../store/useSystemStore';
import './MessageList.css';
import { useSessionLifecycleStore } from '../../store/useSessionLifecycleStore';
import { useUIStore } from '../../store/useUIStore';

interface MessageListProps {
  scrollRef: React.RefObject<HTMLDivElement>;
  handleScroll: () => void;
  handleWheel: (e: React.WheelEvent) => void;
  showScrollButton: boolean;
  handleBackToBottom: () => void;
}

const MessageList: React.FC<MessageListProps> = ({
  scrollRef,
  handleScroll,
  handleWheel,
  showScrollButton,
  handleBackToBottom
}) => {
  const { sessions, activeSessionId } = useSessionLifecycleStore();
  const { visibleCount, incrementVisibleCount } = useUIStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const branding = useSystemStore(state => state.getBranding(activeSession?.provider));

  if (!activeSession) return null;
  const slicedMessages = activeSession.messages ? activeSession.messages.slice(-visibleCount) : [];
  const hasMoreMessages = (activeSession.messages?.length || 0) > visibleCount;

  return (
    <div className="message-list-wrapper">
      <main 
        className="chat-container" 
        ref={scrollRef} 
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        <div className="chat-content">
          {!activeSession.messages || activeSession.messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon-container">
                <History size={48} className="empty-icon" />
              </div>
              <h2>New Conversation</h2>
              <p>{branding.emptyChatMessage}</p>
            </div>
          ) : (
            <>
              {hasMoreMessages && (
                <button className="load-more-btn" onClick={() => incrementVisibleCount(10)}>
                  <History size={14} />
                  <span>Load previous messages...</span>
                </button>
              )}
              <HistoryList 
                messages={slicedMessages} 
                acpSessionId={activeSession.acpSessionId}
                providerId={activeSession.provider}
              />
            </>
          )}
          <div className="scroll-spacer" />
        </div>
      </main>

      <AnimatePresence>
        {showScrollButton && (
          <div className="back-to-bottom-container">
            <motion.button
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              onClick={handleBackToBottom}
              className="back-to-bottom-btn"
              title="Scroll to bottom"
            >
              <ChevronDown size={16} />
              <span>Back to Bottom</span>
            </motion.button>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MessageList;
