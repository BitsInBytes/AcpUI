import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import PopOutApp from './PopOutApp.tsx'
import './index.css'
import { installGlobalErrorHandler } from './utils/globalErrorHandler'

const isPopout = new URLSearchParams(window.location.search).has('popout');

installGlobalErrorHandler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPopout ? <PopOutApp /> : <App />}
  </StrictMode>,
)
