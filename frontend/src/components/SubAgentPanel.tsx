import React from 'react';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import './SubAgentPanel.css';

interface SubAgentPanelProps {
  /** The invocationId from the parent ux_invoke_subagents ToolStep's SystemEvent.
   *  Filters the store to only the agents spawned by that specific tool call,
   *  ensuring historical turns each show their own batch of agents. */
  invocationId?: string;
}

/**
 * Displays sub-agent tool steps and permission prompts only — no streaming text.
 * Embedded inside the parent's ux_invoke_subagents ToolStep when expanded.
 * Agents are filtered by invocationId so each ToolStep shows only its own agents.
 */
const SubAgentPanel: React.FC<SubAgentPanelProps> = ({ invocationId }) => {
  const allAgents = useSubAgentStore(state => state.agents);
  const activeSession = useSessionLifecycleStore(state => state.sessions.find(s => s.id === state.activeSessionId));
  const socket = useSystemStore(state => state.socket);
  // Filter by invocationId so historical turns show their own agents, not the latest batch.
  // If invocationId is undefined (e.g., old data before this fix), show nothing.
  const agents = invocationId ? allAgents.filter(a => a.invocationId === invocationId) : [];

  if (agents.length === 0) return null;

  const handlePermission = (agent: typeof agents[0], optionId: string) => {
    if (!socket || !agent.permission) return;
    socket.emit('respond_permission', { 
      providerId: activeSession?.provider,
      id: agent.permission.id, 
      sessionId: agent.permission.sessionId, 
      optionId, 
      toolCallId: agent.permission.toolCall?.toolCallId 
    });
    useSubAgentStore.getState().clearPermission(agent.acpSessionId);
  };

  return (
    <div className="sub-agent-panel">
      {agents.map(agent => (
        <div key={agent.acpSessionId} className={`sub-agent-card ${agent.status}`}>
          <div className="sub-agent-header">
            <span className={`sub-agent-status ${agent.status}`}>
              {agent.status === 'completed' ? '✅' : agent.status === 'failed' ? '❌' : agent.status === 'cancelled' ? '⬜' : '🔄'}
            </span>
            <span className="sub-agent-label">
              {agent.index + 1}: {agent.name} ({agent.agent})
              {agent.status === 'spawning' && ' - Starting...'}
              {agent.status === 'prompting' && ' - Thinking...'}
              {agent.status === 'failed' && ' - Error'}
              {agent.status === 'cancelled' && ' - Cancelled'}
            </span>
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
