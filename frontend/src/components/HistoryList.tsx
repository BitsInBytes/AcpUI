import React, { memo } from 'react';
import ChatMessage from './ChatMessage';
import type { Message } from '../types';

interface HistoryListProps {
  messages: Message[];
  acpSessionId?: string | null;
  providerId?: string | null;
}

const HistoryList: React.FC<HistoryListProps> = memo(({ messages, acpSessionId, providerId }) => {
  return (
    <div className="messages">
      {messages.map((msg) => (
        <ChatMessage 
          key={msg.id} 
          message={msg}
          acpSessionId={acpSessionId}
          providerId={providerId}
        />
      ))}
    </div>
  );
});

export default HistoryList;
