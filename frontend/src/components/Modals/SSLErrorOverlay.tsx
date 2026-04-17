import React from 'react';
import './SSLErrorOverlay.css';
import { BACKEND_PORT } from '../../utils/backendConfig';

interface SSLErrorOverlayProps {
  hostname: string;
}

const SSLErrorOverlay: React.FC<SSLErrorOverlayProps> = ({ hostname }) => {
  return (
    <div className="ssl-error-overlay">
      <div className="ssl-error-modal">
        <h2>Connection Blocked</h2>
        <p>Your browser is blocking the secure connection to the backend engine because it uses a self-signed certificate.</p>
        <p>To fix this and enable features like voice recording:</p>
        <ol>
          <li>Click the button below to open the backend in a new tab.</li>
          <li>Click <strong>Advanced</strong>.</li>
          <li>Click <strong>Proceed to {hostname} (unsafe)</strong>.</li>
          <li>Close that tab and come back here. The connection will automatically succeed.</li>
        </ol>
        <a 
          href={`https://${hostname}:${BACKEND_PORT}`} 
          target="_blank" 
          rel="noopener noreferrer"
          className="ssl-auth-button"
        >
          Authorize Backend Connection
        </a>
      </div>
    </div>
  );
};

export default SSLErrorOverlay;
