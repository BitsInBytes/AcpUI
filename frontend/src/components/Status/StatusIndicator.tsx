import React from 'react';
import './StatusIndicator.css';

interface StatusIndicatorProps {
  connected: boolean;
  isEngineReady: boolean;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ connected, isEngineReady }) => {
  return (
    <div className="status-indicator">
      <div className={`status-dot ${connected ? (isEngineReady ? 'ready' : 'connected') : 'disconnected'}`} />
      <span className="status-text">
        {!connected ? 'Disconnected' : (isEngineReady ? 'Engine Ready' : 'Warming up...')}
      </span>
    </div>
  );
};

export default StatusIndicator;
