import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../types';

interface UserMessageProps {
  message: Message;
  markdownComponents: object;
}

const UserMessage: React.FC<UserMessageProps> = ({ message, markdownComponents }) => {
  const attachments = message.attachments || [];

  return (
    <div className={`message-wrapper user ${message.isArchived ? 'archived' : ''}`}>
      <div className="message">
        <div className="message-role">You</div>
        <div className="message-content markdown-body">
          {attachments.length > 0 && (
            <div className="user-attachments">
              {attachments.map((a, i) => {
                const isImage = a.mimeType?.startsWith('image/') || a.type?.startsWith('image/');
                return isImage && a.data ? (
                  <img key={i} src={`data:${a.mimeType || a.type};base64,${a.data}`} alt={a.name} className="user-attachment-img" />
                ) : (
                  <span key={i} className="user-attachment-file">📎 {a.name}</span>
                );
              })}
            </div>
          )}
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
};

export default UserMessage;
