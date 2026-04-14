import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initAnalytics } from './lib/analytics.js'
import { initSentry } from './lib/sentry.js'
import { initGA4 } from './lib/ga4.js'

// Sentry always runs (error tracking is useful even for admin views).
initSentry();

// Skip analytics on admin dashboard views (internal, not real traffic).
const isAdminView = new URLSearchParams(window.location.search).get("admin") === "1";
if (!isAdminView) {
  initAnalytics();
  initGA4();
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
