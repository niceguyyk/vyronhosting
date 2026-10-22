import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import './dark.css'
import './landing.css'
import './portal.css'
import './enterprise.css'
import './site-dialog.css'
import './domain-spacing.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
)
