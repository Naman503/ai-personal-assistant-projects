import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/app.css';
import { trackError } from '@/lib/messages';
import { App } from './App';
import { configureLogger } from '@/lib/logger';

configureLogger({ context: 'options' });
addEventListener('error', (e) => trackError('options', e.error, true));
addEventListener('unhandledrejection', (e) => trackError('options', e.reason));
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
