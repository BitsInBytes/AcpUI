import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useSystemStore } from '../store/useSystemStore';
import './ConfigErrorModal.css';

const ConfigErrorModal: React.FC = () => {
  const invalidJsonConfigs = useSystemStore(state => state.invalidJsonConfigs);

  if (invalidJsonConfigs.length === 0) return null;

  return (
    <div className="config-error-overlay" role="presentation">
      <section className="config-error-modal" role="alertdialog" aria-modal="true" aria-labelledby="config-error-title">
        <div className="config-error-header">
          <AlertTriangle size={22} />
          <h2 id="config-error-title">Invalid JSON Configuration</h2>
        </div>
        <p className="config-error-copy">
          AcpUI cannot continue until these configuration files contain valid JSON. Fix the file contents, restart the backend, and reload the app.
        </p>
        <div className="config-error-list" aria-label="Invalid JSON configuration files">
          {invalidJsonConfigs.map((issue) => (
            <article className="config-error-item" key={`${issue.id}:${issue.path}`}>
              <div className="config-error-label">{issue.label}</div>
              <div className="config-error-path" title={issue.path}>{issue.path}</div>
              <div className="config-error-message">{issue.message}</div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
};

export default ConfigErrorModal;
