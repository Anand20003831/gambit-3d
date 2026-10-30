import { Suspense, lazy, useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { useStore } from './net/store.js';
import { useSettings, detectDevice, shouldReduceMotion } from './hooks/useSettings.js';
import { Spinner } from './components/ui/index.js';
import { Toasts } from './components/Toasts.js';
import { ConnectionBanner } from './components/ConnectionBanner.js';
import { MenuBackdropLayer, isMenuRoute } from './components/menu/MenuBackdropLayer.js';
import { HomePage } from './routes/HomePage.js';
import { PlayPage } from './routes/PlayPage.js';
import { LobbyPage } from './routes/LobbyPage.js';
import { CreatePage } from './routes/CreatePage.js';
import { JoinPage } from './routes/JoinPage.js';
import { LanPage } from './routes/LanPage.js';
import { CreditsPage } from './routes/CreditsPage.js';
import { SettingsPage } from './routes/SettingsPage.js';

// The room view pulls in the whole 3D stack, so it loads on demand.
const RoomPage = lazy(() => import('./routes/RoomPage.js').then((m) => ({ default: m.RoomPage })));
// The level editor pulls in the 3D stack plus the transform gizmo.
const EditorPage = lazy(() => import('./routes/EditorPage.js').then((m) => ({ default: m.EditorPage })));

export function App(): JSX.Element {
  const settings = useSettings();
  const bootstrapped = useStore((s) => s.bootstrapped);
  const location = useLocation();

  // Apply device-level preferences to the document once, and on change.
  useEffect(() => {
    const root = document.documentElement;
    const profile = detectDevice();
    root.style.setProperty('--ui-scale', String(settings.uiScale));
    root.dataset.contrast = settings.highContrast ? 'high' : 'normal';
    root.dataset.motion = shouldReduceMotion(settings, profile) ? 'reduced' : 'full';
    root.dataset.cbsafe = settings.colorBlindSafe ? 'on' : 'off';
  }, [settings]);

  // Announce route changes for screen readers.
  useEffect(() => {
    const title = routeTitle(location.pathname);
    document.title = title ? `${title} · Gambit3D` : 'Gambit3D';
  }, [location.pathname]);

  if (!bootstrapped) {
    return (
      <div className="boot">
        <div className="boot__inner">
          <h1 className="boot__logo">Gambit3D</h1>
          <Spinner label="Connecting to the game server" />
          <p className="boot__hint">Connecting…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <ConnectionBanner />

      {/* Mounted once for the session; the router changes over the top of it. */}
      <MenuBackdropLayer active={isMenuRoute(location.pathname)} />

      <main id="main" className="app__main" tabIndex={-1}>
        <Suspense
          fallback={
            <div className="route-loading">
              <Spinner label="Loading the board" />
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/play" element={<PlayPage />} />
            <Route path="/lobby" element={<LobbyPage />} />
            <Route path="/create" element={<CreatePage />} />
            <Route path="/room/:roomId" element={<RoomPage />} />
            <Route path="/join/:code" element={<JoinPage />} />
            <Route path="/join" element={<JoinPage />} />
            <Route path="/lan" element={<LanPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/editor" element={<EditorPage />} />
            <Route path="/credits" element={<CreditsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>

      <Toasts />
    </div>
  );
}

function NotFound(): JSX.Element {
  return (
    <div className="page page--narrow">
      <h1>That page does not exist</h1>
      <p className="muted">The link may be old, or the room may have closed.</p>
      <Link className="btn btn--primary btn--md" to="/">
        Back to the main menu
      </Link>
    </div>
  );
}

function routeTitle(pathname: string): string {
  if (pathname === '/') return '';
  if (pathname.startsWith('/play')) return 'Play';
  if (pathname.startsWith('/lobby')) return 'Public games';
  if (pathname.startsWith('/create')) return 'New game';
  if (pathname.startsWith('/room')) return 'Game';
  if (pathname.startsWith('/join')) return 'Join a game';
  if (pathname.startsWith('/lan')) return 'Local Wi-Fi';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/credits')) return 'Credits';
  if (pathname.startsWith('/editor')) return 'Level editor';
  return '';
}
