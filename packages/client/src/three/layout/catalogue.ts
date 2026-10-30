import { useEffect, useMemo, useState } from 'react';
import { MODEL_PACKS, THEME_IDS, type ModelPack, type PlacedProp } from '@gambit3d/shared';
import { defaultLayout } from './defaults.js';

/**
 * Everything the level editor can place.
 *
 * The model pipeline writes `models/index.json` listing the named nodes inside
 * each pack, so the palette shows exactly what was actually built - not a list
 * kept in sync by hand. If that file is missing, the catalogue falls back to
 * the nodes the built-in layouts already reference, which is a smaller list but
 * never a wrong one.
 */

export type Catalogue = Record<ModelPack, string[]>;

export interface CatalogueState {
  entries: Catalogue;
  status: 'loading' | 'index' | 'fallback';
  /** Total node count, for the palette header. */
  total: number;
}

function emptyCatalogue(): Catalogue {
  const out = {} as Catalogue;
  for (const pack of MODEL_PACKS) out[pack] = [];
  return out;
}

/** Nodes referenced by the shipped layouts - the guaranteed-safe minimum. */
function fallbackCatalogue(): Catalogue {
  const out = emptyCatalogue();
  const seen = new Set<string>();
  for (const theme of THEME_IDS) {
    for (const prop of defaultLayout(theme).props) {
      const key = `${prop.pack}/${prop.node}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[prop.pack].push(prop.node);
    }
  }
  for (const pack of MODEL_PACKS) out[pack].sort();
  return out;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function useCatalogue(extraProps: PlacedProp[] = []): CatalogueState {
  const [loaded, setLoaded] = useState<{ entries: Catalogue; status: 'index' | 'fallback' } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/assets/models/index.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error(String(response.status));
        const raw: unknown = await response.json();
        if (cancelled) return;

        const entries = emptyCatalogue();
        let found = 0;
        if (raw && typeof raw === 'object') {
          for (const pack of MODEL_PACKS) {
            const nodes = (raw as Record<string, unknown>)[pack];
            if (!isStringArray(nodes)) continue;
            entries[pack] = [...nodes].sort();
            found += nodes.length;
          }
        }
        setLoaded(found > 0 ? { entries, status: 'index' } : { entries: fallbackCatalogue(), status: 'fallback' });
      } catch {
        if (!cancelled) setLoaded({ entries: fallbackCatalogue(), status: 'fallback' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    if (!loaded) return { entries: emptyCatalogue(), status: 'loading', total: 0 };

    // Anything already placed is placeable, even if the index does not list it.
    const entries = emptyCatalogue();
    for (const pack of MODEL_PACKS) entries[pack] = [...loaded.entries[pack]];
    for (const prop of extraProps) {
      if (!entries[prop.pack].includes(prop.node)) entries[prop.pack] = [...entries[prop.pack], prop.node].sort();
    }

    const total = MODEL_PACKS.reduce((sum, pack) => sum + entries[pack].length, 0);
    return { entries, status: loaded.status, total };
  }, [loaded, extraProps]);
}

export const PACK_LABELS: Record<ModelPack, string> = {
  'apartment-furniture': 'Apartment furniture',
  'city-buildings': 'City buildings',
  'city-props': 'City props & signage',
  'station-props': 'Station fittings',
  'space-scenery': 'Space scenery',
};

/** Which maps a pack belongs to, so the palette can lead with the relevant ones. */
export const PACK_THEMES: Record<ModelPack, ('apartment' | 'station')[]> = {
  'apartment-furniture': ['apartment'],
  'city-buildings': ['apartment'],
  'city-props': ['apartment'],
  'station-props': ['station'],
  'space-scenery': ['station'],
};

/**
 * Sensible starting values for a newly placed model.
 *
 * A tower and a stool are wildly different sizes in their source files, so
 * dropping either at scale 1 would be useless. These make anything you add
 * appear at a size you can actually see and grab.
 */
export function defaultsForPack(pack: ModelPack): {
  group: string;
  ground: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  fitHeight: number | null;
  baseScale: number;
} {
  switch (pack) {
    case 'city-buildings':
      return { group: 'City', ground: true, castShadow: false, receiveShadow: false, fitHeight: null, baseScale: 2 };
    case 'city-props':
      return { group: 'Signage', ground: false, castShadow: false, receiveShadow: false, fitHeight: null, baseScale: 2 };
    case 'space-scenery':
      return { group: 'Structure', ground: false, castShadow: false, receiveShadow: false, fitHeight: null, baseScale: 3 };
    case 'station-props':
      return { group: 'Fittings', ground: true, castShadow: true, receiveShadow: true, fitHeight: 1.6, baseScale: 1 };
    case 'apartment-furniture':
    default:
      return { group: 'Furniture', ground: true, castShadow: true, receiveShadow: true, fitHeight: 1.2, baseScale: 1 };
  }
}
