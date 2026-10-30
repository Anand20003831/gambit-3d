import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { THEME_IDS, type ThemeId } from '@gambit3d/shared';
import { detectDevice, shouldReduceMotion, useSettings } from '../../hooks/useSettings.js';

/**
 * The scene behind the menus, mounted once for the whole session.
 *
 * It deliberately lives above the router. When it sat inside the menu screen it
 * was torn down and rebuilt on every navigation, which restarted the camera
 * from the top and rebuilt a WebGL context each time - the menu appeared to
 * jump back to the beginning whenever you clicked anything.
 */

const MenuBackdrop = lazy(() =>
  import('../../three/MenuBackdrop.js').then((m) => ({ default: m.MenuBackdrop })),
);

/**
 * Which map the menus show, chosen once per session.
 *
 * Module scope on purpose: picking it inside a component would re-roll on every
 * navigation and the backdrop would change map underneath you.
 */
export const MENU_THEME: ThemeId = THEME_IDS[Math.floor(Math.random() * THEME_IDS.length)] ?? 'apartment';

/** True for every screen that is a menu rather than a board. */
export function isMenuRoute(pathname: string): boolean {
  return !pathname.startsWith('/room') && !pathname.startsWith('/editor');
}

export function MenuBackdropLayer({ active }: { active: boolean }): JSX.Element | null {
  const settings = useSettings();
  const profile = useMemo(() => detectDevice(), []);
  const reducedMotion = shouldReduceMotion(settings, profile);

  /**
   * Skipped outright on a low budget or in 2D mode - someone who has turned the
   * 3D board off does not want a 3D menu either.
   */
  const wanted = active && settings.renderMode === '3d' && settings.quality !== 'low';
  const [ready, setReady] = useState(false);
  const [lost, setLost] = useState(false);

  /**
   * A lost WebGL context leaves a black rectangle behind the whole menu.
   * Drop back to the gradient instead - the menu still reads, and the scene
   * was only ever decoration.
   */
  useEffect(() => {
    const onLost = (event: Event): void => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.('.menubackdrop')) return;
      event.preventDefault();
      console.warn('[menu] the backdrop lost its WebGL context - falling back to the gradient.');
      setLost(true);
    };
    window.addEventListener('webglcontextlost', onLost, true);
    return () => window.removeEventListener('webglcontextlost', onLost, true);
  }, []);

  // Let the menu paint first, then bring the scene in behind it.
  useEffect(() => {
    if (!wanted) return undefined;
    const id = window.setTimeout(() => setReady(true), 120);
    return () => window.clearTimeout(id);
  }, [wanted]);

  if (!active) return null;

  return (
    <div className="menubackdrop" data-map={MENU_THEME} aria-hidden="true">
      {wanted && ready && !lost && (
        <Suspense fallback={null}>
          <MenuBackdrop theme={MENU_THEME} reducedMotion={reducedMotion} quality={settings.quality} />
        </Suspense>
      )}
    </div>
  );
}
