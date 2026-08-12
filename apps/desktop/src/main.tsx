import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { applyTheme, bootTheme } from './lib/settings.js'
import './styles.css'

// Before anything paints: the store file is read asynchronously, and a window
// that flashes the wrong colour scheme for even a frame reads as broken. The
// mirrored value is synchronous, so it is what the first paint gets.
applyTheme(bootTheme())

const root = document.getElementById('root')
if (!root) throw new Error('no #root element to mount into')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
