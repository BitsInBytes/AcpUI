import React, { useState, useEffect, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check, Archive, Layout } from 'lucide-react';
import type { Message } from '../types';
import './ChatMessage.css';

import { useSystemStore } from '../store/useSystemStore';
import { useCanvasStore } from '../store/useCanvasStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import UserMessage from './UserMessage';
import AssistantMessage from './AssistantMessage';

interface ChatMessageProps {
  message: Message;
  acpSessionId?: string | null;
  providerId?: string | null;
}

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('Clipboard API failed, trying fallback...', err);
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "absolute";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  let success = false;
  try { success = document.execCommand('copy'); } catch (err) { console.error('Fallback copy failed:', err); }
  document.body.removeChild(textArea);
  return success;
};

const CodeBlock = ({ language, value }: { language: string; value: string }) => {
  const [copied, setCopied] = useState(false);
  const isCanvasOpen = useCanvasStore(state => state.isCanvasOpen);
  const handleOpenInCanvas = useCanvasStore(state => state.handleOpenInCanvas);
  const socket = useSystemStore(state => state.socket);
  const activeSessionId = useSessionLifecycleStore(state => state.activeSessionId);

  const handleCopy = async () => {
    const success = await copyToClipboard(value);
    if (success) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const handleOpenCanvas = () => {
    handleOpenInCanvas(socket, activeSessionId, {
      id: `canvas-${Date.now()}`,
      sessionId: activeSessionId || '',
      title: `${language} snippet`,
      content: value,
      language: language,
      version: 1
    });
  };

  return (
    <div className="code-block-container">
      <div className="code-block-header">
        <span>{language}</span>
        <div className="code-block-actions">
          {isCanvasOpen && (
            <button className="copy-button" onClick={handleOpenCanvas} title="Open in Canvas">
              <Layout size={14} /> Canvas
            </button>
          )}
          <button className="copy-button" onClick={handleCopy}>
            {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
          </button>
        </div>
      </div>
      <SyntaxHighlighter style={vscDarkPlus} language={language} PreTag="div" className="syntax-highlighter">
        {value}
      </SyntaxHighlighter>
    </div>
  );
};

const ChatMessage: React.FC<ChatMessageProps> = ({ message, acpSessionId, providerId }) => {
  const [localCollapsed, setLocalCollapsed] = useState<Record<number, boolean>>({});
  const manuallyToggled = useRef<Set<number>>(new Set());
  const { role, timeline, isStreaming } = message || {};

  useEffect(() => {
    if (!timeline) return;
    const updates: Record<number, boolean> = { ...localCollapsed };

    if (!isStreaming) {
      timeline.forEach((step, idx) => {
        if (manuallyToggled.current.has(idx)) return;
        if (typeof step.isCollapsed === 'boolean') updates[idx] = step.isCollapsed;
        else if (step.type === 'tool') updates[idx] = true;
        else if (step.type === 'thought') updates[idx] = true;
        else if (step.type === 'text') updates[idx] = false;
      });
    } else {
      const toolIndices = timeline.map((step, idx) => step.type === 'tool' ? idx : -1).filter(idx => idx !== -1);
      const thoughtIndices = timeline.map((step, idx) => step.type === 'thought' ? idx : -1).filter(idx => idx !== -1);
      const last3Tools = toolIndices.slice(-3);
      const last3Thoughts = thoughtIndices.slice(-3);

      timeline.forEach((step, idx) => {
        if (manuallyToggled.current.has(idx)) return;
        if (typeof step.isCollapsed === 'boolean') updates[idx] = step.isCollapsed;
        else if (step.type === 'tool') updates[idx] = !last3Tools.includes(idx);
        else if (step.type === 'thought') updates[idx] = !last3Thoughts.includes(idx);
        else if (step.type === 'text') updates[idx] = false;
        else if (step.type === 'permission' && updates[idx] === undefined) updates[idx] = false;
      });
    }

    const hasChanged = Object.keys(updates).length !== Object.keys(localCollapsed).length ||
      Object.keys(updates).some(key => updates[Number(key)] !== localCollapsed[Number(key)]);
    if (hasChanged) setLocalCollapsed(updates);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, isStreaming]);

  if (!message) return null;

   
  const markdownComponents = {
    hr() {
      return <div className="response-divider"><div className="response-divider-dot" /></div>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    code({ node: _node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const language = match ? match[1] : 'text';
      if (!inline && (match || String(children).includes('\n'))) {
        return <CodeBlock language={language} value={String(children).replace(/\n$/, '')} />;
      }
      return <code className={className} {...props}>{children}</code>;
    }
  };

  if (role === 'divider') {
    return (
      <div className="compression-divider">
        <div className="divider-line"></div>
        <div className="divider-content">
          <Archive size={14} />
          <span>Context Compressed</span>
        </div>
        <div className="divider-line"></div>
      </div>
    );
  }

  if (role === 'user') {
    return <UserMessage message={message} markdownComponents={markdownComponents} />;
  }

  return (
    <AssistantMessage
      message={message}
      acpSessionId={acpSessionId}
      providerId={providerId}
      isStreaming={isStreaming}
      timeline={timeline}
      localCollapsed={localCollapsed}
      toggleCollapse={(idx) => {
        manuallyToggled.current.add(idx);
        setLocalCollapsed(prev => {
          const current = prev[idx] ?? timeline?.[idx]?.isCollapsed ?? false;
          return { ...prev, [idx]: !current };
        });
      }}
      markdownComponents={markdownComponents}
    />
  );
};

export default ChatMessage;
