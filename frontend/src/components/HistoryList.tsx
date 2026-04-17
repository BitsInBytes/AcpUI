import React, { memo } from 'react';
import ChatMessage from './ChatMessage';
import type { Message } from '../types';

interface HistoryListProps {
  messages: Message[];
  acpSessionId?: string | null;
}

const HistoryList: React.FC<HistoryListProps> = memo(({ messages, acpSessionId }) => {
  return (
    <div className="messages">
      {messages.map((msg) => (
        <ChatMessage 
          key={msg.id} 
          message={msg}
          acpSessionId={acpSessionId}
        />
      ))}
    </div>
  );
});

export default HistoryList;
