import React from 'react';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { useSystemStore } from '../store/useSystemStore';
import { useChatStore } from '../store/useChatStore';
import './SubAgentPanel.css';

/**
 * Displays sub-agent tool steps and permission prompts only — no streaming text.
 * Embedded inside the parent's invoke_sub_agents ToolStep when expanded.
 * Agents are filtered to those whose parentSessionId matches the active chat.
 */
const SubAgentPanel: React.FC = () => {
  const allAgents = useSubAgentStore(state => state.agents);
  const activeSession = useChatStore(state => state.sessions.find(s => s.id === state.activeSessionId));
  const socket = useSystemStore(state => state.socket);
  const agents = allAgents.filter(a => a.parentSessionId === activeSession?.acpSessionId);

  if (agents.length === 0) return null;

  const handlePermission = (agent: typeof agents[0], optionId: string) => {
    if (!socket || !agent.permission) return;
    socket.emit('respond_permission', { id: agent.permission.id, sessionId: agent.permission.sessionId, optionId, toolCallId: agent.permission.toolCall?.toolCallId });
    useSubAgentStore.getState().clearPermission(agent.acpSessionId);
  };

  return (
    <div className="sub-agent-panel">
      {agents.map(agent => (
        <div key={agent.acpSessionId} className={`sub-agent-card ${agent.status}`}>
          <div className="sub-agent-header">
            <span className={`sub-agent-status ${agent.status}`}>
              {agent.status === 'running' ? '🟢' : agent.status === 'completed' ? '✅' : '❌'}
            </span>
            <span className="sub-agent-label">{agent.index + 1}: {agent.name} ({agent.agent})</span>
          </div>

          {agent.toolSteps.length > 0 && (
            <div className="sub-agent-tools">
              {agent.toolSteps.length > 4 && (
                <div className="sub-agent-tool" style={{ opacity: 0.4 }}>+ {agent.toolSteps.length - 4} earlier</div>
              )}
              {agent.toolSteps.slice(-4).map(step => (
                <div key={step.id} className={`sub-agent-tool ${step.status}`}>
                  <span className="sub-agent-tool-icon">{step.status === 'in_progress' ? '⏳' : '✓'}</span>
                  <span className="sub-agent-tool-title">{step.title}</span>
                </div>
              ))}
            </div>
          )}

          {agent.permission && (
            <div className="sub-agent-permission">
              <div className="sub-agent-permission-title">⚠ Permission: {agent.permission.toolCall?.title || 'Tool requires approval'}</div>
              <div className="sub-agent-permission-actions">
                {agent.permission.options.map(opt => (
                  <button key={opt.optionId} className={`sub-agent-perm-btn ${opt.kind === 'allow' ? 'allow' : ''}`} onClick={() => handlePermission(agent, opt.optionId)}>
                    {opt.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default SubAgentPanel;
