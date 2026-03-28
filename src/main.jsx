import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initAnalytics } from './lib/analytics.js'
import { initSentry } from './lib/sentry.js'

// Initialize tracking (no-ops if env vars not set)
initAnalytics();
initSentry();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
