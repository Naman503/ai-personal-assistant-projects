import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/app.css';
import { trackError } from '@/lib/messages';
import { Popup } from './Popup';

addEventListener('error', (e) => trackError('popup', e.error, true));
addEventListener('unhandledrejection', (e) => trackError('popup', e.reason));
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
