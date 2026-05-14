import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Check, Archive, Brain, ChevronDown, ChevronRight, GitFork } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import MemoizedMarkdown from './MemoizedMarkdown';
import { Settings } from 'lucide-react';
import ToolStep from './ToolStep';
import PermissionStep from './PermissionStep';
import SubAgentPanel from './SubAgentPanel';
import type { Message, TimelineStep } from '../types';
import { useSystemStore } from '../store/useSystemStore';
import { useCanvasStore } from '../store/useCanvasStore';
import { useElapsed } from '../utils/timer';
import { useChatStore } from '../store/useChatStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { isAcpUxSubAgentStartToolEvent } from '../utils/acpUxTools';

interface AssistantMessageProps {
  message: Message;
  acpSessionId?: string | null;
  providerId?: string | null;
  isStreaming?: boolean;
  timeline?: TimelineStep[];
  localCollapsed: Record<number, boolean>;
  toggleCollapse: (idx: number) => void;
  markdownComponents: object;
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

function getPinnedSubAgentInvocationIds(timeline?: TimelineStep[]): string[] {
  if (!timeline) return [];
  const invocationIds: string[] = [];
  const seen = new Set<string>();

  for (const step of timeline) {
    if (step.type !== 'tool') continue;
    const invocationId = step.event.invocationId;
    if (!invocationId || !isAcpUxSubAgentStartToolEvent(step.event) || seen.has(invocationId)) continue;
    seen.add(invocationId);
    invocationIds.push(invocationId);
  }

  return invocationIds;
}

const TERMINAL_SUB_AGENT_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const PINNED_SUB_AGENT_AUTO_COLLAPSE_MS = 2000;

function isTerminalSubAgentStatus(status?: string | null) {
  return TERMINAL_SUB_AGENT_STATUSES.has(String(status || ''));
}

const PinnedSubAgentPanel: React.FC<{ invocationId: string }> = ({ invocationId }) => {
  const invocations = useSubAgentStore(state => state.invocations);
  const allAgents = useSubAgentStore(state => state.agents);
  const isInvocationActive = useSubAgentStore(state => state.isInvocationActive(invocationId));

  const invocation = useMemo(
    () => invocations.find(inv => inv.invocationId === invocationId),
    [invocationId, invocations]
  );
  const agents = useMemo(
    () => allAgents.filter(agent => agent.invocationId === invocationId),
    [allAgents, invocationId]
  );

  const terminalCount = agents.filter(agent => isTerminalSubAgentStatus(agent.status)).length;
  const isTerminal = agents.length > 0
    && !isInvocationActive
    && (isTerminalSubAgentStatus(invocation?.status) || terminalCount === agents.length);
  const [hasObservedActiveAgents, setHasObservedActiveAgents] = useState(() => agents.length > 0 && !isTerminal);
  const [manuallyToggled, setManuallyToggled] = useState(false);
  const autoCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldStartCollapsed = isTerminal && !hasObservedActiveAgents;
  const [isCollapsed, setIsCollapsed] = useState(shouldStartCollapsed);
  const shouldCollapseImmediately = isTerminal && !hasObservedActiveAgents && !manuallyToggled;
  const effectiveCollapsed = isCollapsed || shouldCollapseImmediately;

  useEffect(() => {
    const unsubscribe = useSubAgentStore.subscribe(state => {
      const scopedInvocation = state.invocations.find(inv => inv.invocationId === invocationId);
      if (scopedInvocation && isTerminalSubAgentStatus(scopedInvocation.status)) return;

      const hasActiveAgent = state.agents.some(agent =>
        agent.invocationId === invocationId && !isTerminalSubAgentStatus(agent.status)
      );
      if (!hasActiveAgent && !scopedInvocation) return;

      setHasObservedActiveAgents(true);
      if (!manuallyToggled) setIsCollapsed(false);
    });

    return unsubscribe;
  }, [invocationId, manuallyToggled]);

  useEffect(() => {
    if (autoCollapseTimerRef.current) {
      clearTimeout(autoCollapseTimerRef.current);
      autoCollapseTimerRef.current = null;
    }

    if (!isTerminal || manuallyToggled || !hasObservedActiveAgents || isCollapsed) return;

    autoCollapseTimerRef.current = setTimeout(() => {
      setIsCollapsed(true);
      autoCollapseTimerRef.current = null;
    }, PINNED_SUB_AGENT_AUTO_COLLAPSE_MS);

    return () => {
      if (autoCollapseTimerRef.current) {
        clearTimeout(autoCollapseTimerRef.current);
        autoCollapseTimerRef.current = null;
      }
    };
  }, [hasObservedActiveAgents, isCollapsed, isTerminal, manuallyToggled]);

  const toggleCollapsed = () => {
    setManuallyToggled(true);
    if (autoCollapseTimerRef.current) {
      clearTimeout(autoCollapseTimerRef.current);
      autoCollapseTimerRef.current = null;
    }
    setIsCollapsed(!effectiveCollapsed);
  };

  if (agents.length === 0) return null;

  const statusText = invocation?.status || (isInvocationActive ? 'running' : 'completed');
  const countText = agents.length > 0 ? `${terminalCount}/${agents.length}` : '';

  return (
    <div className={`sub-agent-pinned-panel ${effectiveCollapsed ? 'collapsed' : 'expanded'}`}>
      <div className="sub-agent-pinned-header">
        <div className="sub-agent-pinned-heading">
          <span className="sub-agent-pinned-title">Subagents</span>
          <span className="sub-agent-pinned-status">{statusText}{countText ? ` ${countText}` : ''}</span>
        </div>
        <button
          className="sub-agent-pinned-toggle"
          type="button"
          aria-label={effectiveCollapsed ? 'Show sub-agents' : 'Hide sub-agents'}
          aria-expanded={!effectiveCollapsed}
          onClick={toggleCollapsed}
          title={effectiveCollapsed ? 'Show sub-agents' : 'Hide sub-agents'}
        >
          {effectiveCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {!effectiveCollapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="sub-agent-pinned-body"
          >
            <SubAgentPanel invocationId={invocationId} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message, acpSessionId, providerId, isStreaming, timeline, localCollapsed, toggleCollapse, markdownComponents  
}) => {
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socket = useSystemStore(state => state.socket);
  const branding = useSystemStore(state => state.getBranding(providerId));
  
  const activeSessionId = useSessionLifecycleStore(state => state.activeSessionId);
  const handleRespondPermission = useChatStore(state => state.handleRespondPermission);
  const isHooksRunning = useSessionLifecycleStore(state => state.sessions.find(s => s.acpSessionId === acpSessionId)?.isHooksRunning);
  const handleOpenFileInCanvas = useCanvasStore(state => state.handleOpenFileInCanvas);

  const { content, isArchived } = message;
  const turnElapsed = useElapsed(message.turnStartTime, message.turnEndTime ?? (isStreaming ? undefined : message.turnStartTime));
  const pinnedSubAgentInvocationIds = useMemo(() => getPinnedSubAgentInvocationIds(timeline), [timeline]);

  const handleCopyAll = async () => {
    const cleanContent = content.replace(/\n*:::RESPONSE_DIVIDER:::\n*/g, '\n\n');
    const success = await copyToClipboard(cleanContent);
    if (success) {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleFork = () => {
    if (!socket || !activeSessionId || forking) return;
    const sessions = useSessionLifecycleStore.getState().sessions;
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return;
    const msgIndex = session.messages.findIndex(m => m.id === message.id);
    if (msgIndex === -1) return;
    setForking(true);
    useChatStore.getState().handleForkSession(socket, activeSessionId, msgIndex, () => setForking(false));
  };

  const renderContentWithErrors = (text: string) => {
    if (!text) return null;
    const parts = text.split(/(:::ERROR:::[\s\S]*?:::END_ERROR:::)/g);
    return parts.map((part, i) => {
      if (part.startsWith(':::ERROR:::')) {
        const errorText = part.replace(':::ERROR:::', '').replace(':::END_ERROR:::', '').trim();    
        return (
          <div key={i} className="error-message-box">
            <Settings size={16} className="error-icon" />
            <div className="error-text">{errorText}</div>
          </div>
        );
      }
      return (
        <MemoizedMarkdown
          key={i}
          content={part.replace(/:::RESPONSE_DIVIDER:::/g, '\n\n---\n\n')}
          isStreaming={!!isStreaming}
          components={markdownComponents}
        />
      );
    });
  };

  return (
    <div className={`message-wrapper assistant ${isStreaming ? 'streaming' : ''} ${isArchived ? 'archived' : ''}`}>
      <div className="message">
        <div className="message-role-wrapper">
          <div className="message-role">{branding.assistantName}</div>    
          {!isArchived && !isStreaming && (
            <div style={{ display: 'flex', gap: '2px' }}>
              <button className="copy-btn" onClick={handleCopyAll} title="Copy full response">      
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              {!useSessionLifecycleStore.getState().sessions.find(s => s.id === activeSessionId)?.isSubAgent && (
              <button className="copy-btn" onClick={handleFork} title="Fork conversation from here">
                <GitFork size={14} />
              </button>
              )}
            </div>
          )}
          {isArchived && <Archive size={14} className="archived-icon" />}
        </div>

        <div className="unified-timeline">
          {timeline && timeline.map((step, index) => {
            const isCollapsed = localCollapsed[index] ?? step.isCollapsed ?? false;

            if (step.type === 'text') {
              return (
                <div key={index} className="message-content response-tab-content markdown-body">    
                  {renderContentWithErrors(step.content)}
                </div>
              );
            }

            if (step.type === 'permission') {
              return (
                <PermissionStep
                  key={index}
                  step={step}
                  onRespond={(requestId, optionId, toolCallId) =>
                    handleRespondPermission(socket, requestId, optionId, toolCallId, acpSessionId || undefined)
                  }
                />
              );
            }

            return (
              <div key={index} className="timeline-step">
                {step.type === 'tool' ? (
                  <ToolStep
                    step={step}
                    isCollapsed={isCollapsed}
                    onToggle={() => toggleCollapse(index)}
                    onOpenInCanvas={(filePath) => handleOpenFileInCanvas(socket, activeSessionId, filePath)}
                    markdownComponents={markdownComponents}
                  />
                ) : (
                  <div className="thinking-block-unified">
                    <button className="timeline-step-header" onClick={() => toggleCollapse(index)}> 
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}        
                      <Brain size={14} className="step-icon" />
                      <span className="event-title">Thinking Process</span>
                    </button>
                    <AnimatePresence>
                      {!isCollapsed && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="step-content-wrapper"
                        >
                          <div className="thinking-text markdown-body">
                            <MemoizedMarkdown
                              content={step.content}
                              isStreaming={!!isStreaming && !isCollapsed}
                              components={markdownComponents}
                            />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {content && (!timeline || !timeline.some(s => s.type === 'text')) && (
          <div className="message-content response-tab-content fallback-content markdown-body">     
            {renderContentWithErrors(content)}
          </div>
        )}

        {pinnedSubAgentInvocationIds.length > 0 && (
          <div className="sub-agent-pinned-panels">
            {pinnedSubAgentInvocationIds.map(invocationId => (
              <PinnedSubAgentPanel key={invocationId} invocationId={invocationId} />
            ))}
          </div>
        )}
      </div>
      {turnElapsed && <span className="turn-timer">{turnElapsed}</span>}
      {isHooksRunning && <span className="hooks-running">⚙ Hooks running...</span>}
      {forking && (
        <div className="fork-overlay">
          <div className="fork-overlay-content">
            <GitFork size={24} />
            <span>Forking conversation...</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default AssistantMessage;
