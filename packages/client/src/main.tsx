import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ConfirmProvider } from './components/ui/index.js';
import { wireSocket } from './net/store.js';
import { loadManifest } from './three/assets.js';
import './styles/global.css';
import './styles/themes.css';
import './styles/board.css';
import './styles/menu.css';
import './styles/room.css';
import './styles/editor.css';

// Kick off the socket and the asset manifest before React mounts, so the first
// render already knows what it has.
wireSocket();
void loadManifest();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </BrowserRouter>
  </StrictMode>,
);
