import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import PopOutApp from './PopOutApp.tsx'
import './index.css'

const isPopout = new URLSearchParams(window.location.search).has('popout');

// Global error handler for debugging blank pages
window.onerror = function(message, _source, _lineno, _colno, error) {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="padding: 20px; color: red; font-family: monospace;">
      <h1>Runtime Error</h1>
      <p>${message}</p>
      <pre>${error?.stack || ''}</pre>
    </div>`;
  }
  return false;
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPopout ? <PopOutApp /> : <App />}
  </StrictMode>,
)
