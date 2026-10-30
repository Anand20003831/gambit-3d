import type { ThemeId } from '@gambit3d/shared';
import { apartmentTheme } from './apartment.js';
import { stationTheme } from './station.js';
import { COLORBLIND_HIGHLIGHTS, type ThemeModule } from './types.js';

export * from './types.js';

export const THEMES: Record<ThemeId, ThemeModule> = {
  apartment: apartmentTheme,
  station: stationTheme,
};

export const THEME_LIST: ThemeModule[] = [apartmentTheme, stationTheme];

export function getTheme(id: ThemeId | null | undefined): ThemeModule {
  return (id && THEMES[id]) || apartmentTheme;
}

/**
 * Applies the colour-blind-safe marker palette on top of a map's own theme.
 * Only the highlight colours change; the map keeps its identity.
 */
export function withAccessibleHighlights(theme: ThemeModule, colorBlindSafe: boolean): ThemeModule {
  if (!colorBlindSafe) return theme;
  return { ...theme, highlights: COLORBLIND_HIGHLIGHTS };
}
