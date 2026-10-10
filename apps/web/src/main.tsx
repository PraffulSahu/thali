import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <h1>Thali</h1>
  </StrictMode>,
);
