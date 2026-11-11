import { createRoot } from 'react-dom/client'
import './index.css'
// The user's own look, written by JARVIS on request (bridge/customize.mjs).
// After the stock sheet so it wins; empty means the stock look.
import './custom/user-theme.css'
// Hides the stock parts a custom layout replaces (see src/custom/hide.css).
import './custom/hide.css'
import App from './App.tsx'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
