import React from 'react';
import { AlertTriangle, CheckCircle2, Circle, Clock, Loader2, Square, XCircle } from 'lucide-react';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import './SubAgentPanel.css';

interface SubAgentPanelProps {
  /** The invocationId from the parent sub-agent start ToolStep's SystemEvent.
   *  Filters the store to only the agents spawned by that specific tool call,
   *  ensuring historical turns each show their own batch of agents. */
  invocationId?: string;
}

function renderAgentStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={14} />;
    case 'failed':
      return <XCircle size={14} />;
    case 'cancelled':
      return <Circle size={14} />;
    case 'waiting_permission':
      return <Clock size={14} />;
    default:
      return <Loader2 size={14} />;
  }
}

function renderToolStatusIcon(status: string) {
  return status === 'in_progress' ? <Loader2 size={12} /> : <CheckCircle2 size={12} />;
}

/**
 * Displays sub-agent tool steps and permission prompts only -- no streaming text.
 * Embedded inside the parent's sub-agent start ToolStep when expanded.
 * Agents are filtered by invocationId so each ToolStep shows only its own agents.
 */
const SubAgentPanel: React.FC<SubAgentPanelProps> = ({ invocationId }) => {
  const allAgents = useSubAgentStore(state => state.agents);
  const invocation = useSubAgentStore(state => state.invocations.find(inv => inv.invocationId === invocationId));
  const isInvocationActive = useSubAgentStore(state => state.isInvocationActive(invocationId));
  const activeSession = useSessionLifecycleStore(state => state.sessions.find(s => s.id === state.activeSessionId));
  const socket = useSystemStore(state => state.socket);
  // Filter by invocationId so historical turns show their own agents, not the latest batch.
  // If invocationId is undefined (e.g., old data before this fix), show nothing.
  const agents = invocationId ? allAgents.filter(a => a.invocationId === invocationId) : [];

  if (agents.length === 0) return null;

  const providerId = invocation?.providerId || agents[0]?.providerId || activeSession?.provider || null;

  const handlePermission = (agent: typeof agents[0], optionId: string) => {
    if (!socket || !agent.permission) return;
    socket.emit('respond_permission', {
      providerId,
      id: agent.permission.id,
      sessionId: agent.permission.sessionId,
      optionId,
      toolCallId: agent.permission.toolCall?.toolCallId
    });
    useSubAgentStore.getState().clearPermission(agent.acpSessionId);
  };

  const handleStop = () => {
    if (!socket || !invocationId || !providerId || !isInvocationActive) return;
    socket.emit('cancel_subagents', { providerId, invocationId });
    useSubAgentStore.getState().setInvocationStatus(invocationId, 'cancelling');
  };

  return (
    <div className="sub-agent-panel">
      <div className="sub-agent-panel-toolbar">
        <span className="sub-agent-panel-status">
          {invocation?.status || (isInvocationActive ? 'running' : 'completed')}
        </span>
        {isInvocationActive && (
          <button className="sub-agent-stop-btn" type="button" onClick={handleStop} title="Stop sub-agents">
            <Square size={12} />
            Stop
          </button>
        )}
      </div>

      {agents.map(agent => (
        <div key={agent.acpSessionId} className={`sub-agent-card ${agent.status}`}>
          <div className="sub-agent-header">
            <span className={`sub-agent-status ${agent.status}`}>
              {renderAgentStatusIcon(agent.status)}
            </span>
            <span className="sub-agent-label">
              {agent.index + 1}: {agent.name} ({agent.agent})
              {agent.status === 'spawning' && ' - Starting...'}
              {agent.status === 'prompting' && ' - Thinking...'}
              {agent.status === 'waiting_permission' && ' - Waiting for permission'}
              {agent.status === 'cancelling' && ' - Stopping...'}
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
                  <span className="sub-agent-tool-icon">{renderToolStatusIcon(step.status)}</span>
                  <span className="sub-agent-tool-title">{step.title}</span>
                </div>
              ))}
            </div>
          )}

          {agent.permission && (
            <div className="sub-agent-permission">
              <div className="sub-agent-permission-title"><AlertTriangle size={14} /> Permission: {agent.permission.toolCall?.title || 'Tool requires approval'}</div>
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
