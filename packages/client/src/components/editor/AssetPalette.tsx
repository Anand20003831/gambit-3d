import { useMemo, useState } from 'react';
import { MODEL_PACKS, type ModelPack, type PlacedProp, type ThemeId } from '@gambit3d/shared';
import { TextInput } from '../ui/index.js';
import { PACK_LABELS, PACK_THEMES, useCatalogue } from '../../three/layout/catalogue.js';

/**
 * Every model in every downloaded pack, ready to drop into the scene.
 *
 * The list comes from the pipeline's own `models/index.json`, so it is exactly
 * what was built - nothing here is a model that will fail to load. Packs
 * belonging to the map you are editing come first; the rest are still available
 * because there is no rule that says a station cannot have a sofa in it.
 */

export interface AssetPaletteProps {
  theme: ThemeId;
  /** Already-placed props, so nodes missing from the index are still offered. */
  placed: PlacedProp[];
  onAdd: (pack: ModelPack, node: string) => void;
}

export function AssetPalette({ theme, placed, onAdd }: AssetPaletteProps): JSX.Element {
  const catalogue = useCatalogue(placed);
  const [query, setQuery] = useState('');

  const packs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const ordered = [...MODEL_PACKS].sort((a, b) => {
      const aOwn = PACK_THEMES[a].includes(theme) ? 0 : 1;
      const bOwn = PACK_THEMES[b].includes(theme) ? 0 : 1;
      return aOwn - bOwn || PACK_LABELS[a].localeCompare(PACK_LABELS[b]);
    });

    return ordered
      .map((pack) => ({
        pack,
        own: PACK_THEMES[pack].includes(theme),
        nodes: catalogue.entries[pack].filter(
          (node) => !needle || node.toLowerCase().includes(needle) || PACK_LABELS[pack].toLowerCase().includes(needle),
        ),
      }))
      .filter((entry) => entry.nodes.length > 0);
  }, [catalogue.entries, query, theme]);

  return (
    <div className="ed-palette">
      <TextInput
        type="search"
        value={query}
        placeholder={catalogue.status === 'loading' ? 'Loading models…' : `Search ${catalogue.total} models`}
        aria-label="Search models"
        onChange={(event) => setQuery(event.target.value)}
      />

      {catalogue.status === 'fallback' && (
        <p className="ed-hint">
          <code>assets/models/index.json</code> is missing, so this lists only the models the maps already use. Run{' '}
          <code>npm run assets</code> to rebuild the full catalogue.
        </p>
      )}

      <p className="ed-hint">Adding drops the model where the camera is looking, then selects it.</p>

      <div className="ed-palette__list">
        {packs.map(({ pack, own, nodes }) => (
          <section key={pack} className="ed-palette__pack">
            <h3>
              {PACK_LABELS[pack]}
              {!own && <span className="ed-palette__other">other map</span>}
              <span className="ed-outliner__count">{nodes.length}</span>
            </h3>
            <div className="ed-palette__grid">
              {nodes.map((node) => (
                <button key={node} type="button" className="ed-palette__item" onClick={() => onAdd(pack, node)}>
                  {node}
                </button>
              ))}
            </div>
          </section>
        ))}
        {packs.length === 0 && catalogue.status !== 'loading' && (
          <p className="ed-hint">Nothing matches “{query}”.</p>
        )}
      </div>
    </div>
  );
}
