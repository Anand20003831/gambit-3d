import { useMemo, useState } from 'react';
import type { PlacedProp, ThemeId } from '@gambit3d/shared';
import { TextInput } from '../ui/index.js';
import { GROUP_ORDER } from '../../three/layout/defaults.js';
import { useLayoutStore } from '../../three/layout/store.js';

/**
 * Everything in the map, grouped.
 *
 * Clicking picks; the eye and padlock are here rather than in the inspector
 * because hiding half the city to get at what is behind it is the single most
 * common thing you do while dressing a scene.
 */

export interface OutlinerProps {
  theme: ThemeId;
  props: PlacedProp[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function Outliner({ theme, props, selectedId, onSelect }: OutlinerProps): JSX.Element {
  const updateProp = useLayoutStore((s) => s.updateProp);
  const pushHistory = useLayoutStore((s) => s.pushHistory);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? props.filter(
          (p) =>
            p.node.toLowerCase().includes(needle) ||
            (p.label ?? '').toLowerCase().includes(needle) ||
            p.group.toLowerCase().includes(needle),
        )
      : props;

    const byGroup = new Map<string, PlacedProp[]>();
    for (const prop of matched) {
      const list = byGroup.get(prop.group) ?? [];
      list.push(prop);
      byGroup.set(prop.group, list);
    }

    const order = GROUP_ORDER[theme] ?? [];
    return [...byGroup.entries()].sort(([a], [b]) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      return a.localeCompare(b);
    });
  }, [props, query, theme]);

  const toggle = (prop: PlacedProp, key: 'visible' | 'locked'): void => {
    pushHistory(theme);
    updateProp(theme, prop.id, { [key]: !prop[key] });
  };

  return (
    <div className="ed-outliner">
      <TextInput
        type="search"
        value={query}
        placeholder={`Filter ${props.length} models`}
        aria-label="Filter models"
        onChange={(event) => setQuery(event.target.value)}
      />

      {groups.length === 0 && <p className="ed-hint ed-outliner__empty">Nothing matches “{query}”.</p>}

      <div className="ed-outliner__list">
        {groups.map(([group, items]) => (
          <section key={group} className="ed-outliner__group">
            <h3>
              {group} <span className="ed-outliner__count">{items.length}</span>
            </h3>
            <ul>
              {items.map((prop) => (
                <li key={prop.id} className={prop.id === selectedId ? 'is-selected' : ''}>
                  <button
                    type="button"
                    className="ed-outliner__pick"
                    onClick={() => onSelect(prop.id)}
                    aria-current={prop.id === selectedId}
                  >
                    <span className="ed-outliner__name">{prop.label || prop.node}</span>
                    {prop.minDetail !== 'minimal' && (
                      <span className="ed-outliner__tag" title={`Only shown on ${prop.minDetail} quality and above`}>
                        {prop.minDetail === 'rich' ? 'High' : 'Med'}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`ed-icon ${prop.visible ? '' : 'is-off'}`}
                    title={prop.visible ? 'Hide' : 'Show'}
                    aria-label={`${prop.visible ? 'Hide' : 'Show'} ${prop.label || prop.node}`}
                    aria-pressed={!prop.visible}
                    onClick={() => toggle(prop, 'visible')}
                  >
                    {prop.visible ? '◉' : '○'}
                  </button>
                  <button
                    type="button"
                    className={`ed-icon ${prop.locked ? 'is-on' : ''}`}
                    title={prop.locked ? 'Unlock' : 'Lock'}
                    aria-label={`${prop.locked ? 'Unlock' : 'Lock'} ${prop.label || prop.node}`}
                    aria-pressed={prop.locked}
                    onClick={() => toggle(prop, 'locked')}
                  >
                    {prop.locked ? '▣' : '▢'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
