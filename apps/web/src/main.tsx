import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted variable fonts (design-spec §2.1): display, body, data.
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
