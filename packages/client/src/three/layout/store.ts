import { create } from 'zustand';
import { parseSceneLayout, THEME_IDS, type PlacedProp, type SceneLayout, type ThemeId } from '@gambit3d/shared';
import { defaultLayout } from './defaults.js';

/**
 * Live scene layouts.
 *
 * One store shared by the maps and the level editor: the maps read from it, the
 * editor writes to it, so an edit shows up in the real scene on the next frame
 * with no rebuild and no prop drilling.
 *
 * On first use a map's layout is fetched from `/layouts/<theme>.json`. A missing
 * or malformed file is not an error - the built-in layout takes over, which is
 * the same "assets are optional" rule the rest of the renderer follows.
 */

export type LayoutSource = 'default' | 'file';

interface ThemeState {
  layout: SceneLayout;
  source: LayoutSource;
  status: 'idle' | 'loading' | 'ready';
  /** Edited since it was last saved or loaded. */
  dirty: boolean;
  past: SceneLayout[];
  future: SceneLayout[];
}

/** Deep enough: layouts are plain JSON. */
function clone(layout: SceneLayout): SceneLayout {
  return structuredClone(layout);
}

function initial(theme: ThemeId): ThemeState {
  return {
    layout: defaultLayout(theme),
    source: 'default',
    status: 'idle',
    dirty: false,
    past: [],
    future: [],
  };
}

const HISTORY_LIMIT = 80;

interface LayoutStore {
  themes: Record<ThemeId, ThemeState>;

  /** True while the level editor is mounted: turns on picking in every map. */
  editing: boolean;
  selectedId: string | null;
  /** Bumped whenever a prop's Object3D appears or disappears. */
  registryVersion: number;

  setEditing: (editing: boolean) => void;
  select: (id: string | null) => void;
  bumpRegistry: () => void;

  /** Fetches the saved layout once per theme. Safe to call on every mount. */
  ensureLoaded: (theme: ThemeId) => void;
  /** Replaces a layout wholesale (import, reset, load). Clears history. */
  replace: (theme: ThemeId, layout: SceneLayout, source: LayoutSource) => void;
  resetToDefault: (theme: ThemeId) => void;
  markSaved: (theme: ThemeId) => void;

  /** Snapshot the current state so the next edit can be undone. */
  pushHistory: (theme: ThemeId) => void;
  undo: (theme: ThemeId) => void;
  redo: (theme: ThemeId) => void;

  addProp: (theme: ThemeId, prop: PlacedProp) => void;
  updateProp: (theme: ThemeId, id: string, patch: Partial<PlacedProp>) => void;
  removeProp: (theme: ThemeId, id: string) => void;
}

function withTheme(
  state: LayoutStore,
  theme: ThemeId,
  update: (current: ThemeState) => ThemeState,
): Pick<LayoutStore, 'themes'> {
  const current = state.themes[theme];
  return { themes: { ...state.themes, [theme]: update(current) } };
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  themes: Object.fromEntries(THEME_IDS.map((id) => [id, initial(id)])) as Record<ThemeId, ThemeState>,

  editing: false,
  selectedId: null,
  registryVersion: 0,

  setEditing: (editing) => set({ editing, selectedId: editing ? get().selectedId : null }),
  select: (id) => set({ selectedId: id }),
  bumpRegistry: () => set((s) => ({ registryVersion: s.registryVersion + 1 })),

  ensureLoaded: (theme) => {
    if (get().themes[theme].status !== 'idle') return;
    set((s) => withTheme(s, theme, (t) => ({ ...t, status: 'loading' })));

    void (async () => {
      let layout: SceneLayout | null = null;
      try {
        const response = await fetch(`/layouts/${theme}.json`, { cache: 'no-cache' });
        if (response.ok) {
          layout = parseSceneLayout(await response.json());
          if (!layout) {
            console.warn(`[layout] /layouts/${theme}.json failed validation - using the built-in layout.`);
          } else if (layout.theme !== theme) {
            console.warn(`[layout] /layouts/${theme}.json is for "${layout.theme}" - using the built-in layout.`);
            layout = null;
          }
        }
      } catch {
        // Offline, or no file. Both mean "use the built-in layout".
      }

      set((s) =>
        withTheme(s, theme, (t) => ({
          ...t,
          layout: layout ?? t.layout,
          source: layout ? 'file' : 'default',
          status: 'ready',
          dirty: false,
        })),
      );
    })();
  },

  replace: (theme, layout, source) =>
    set((s) =>
      withTheme(s, theme, (t) => ({
        ...t,
        layout: clone(layout),
        source,
        status: 'ready',
        dirty: source === 'default' ? t.source !== 'default' : false,
        past: [],
        future: [],
      })),
    ),

  resetToDefault: (theme) =>
    set((s) =>
      withTheme(s, theme, (t) => ({
        ...t,
        past: [...t.past, clone(t.layout)].slice(-HISTORY_LIMIT),
        future: [],
        layout: defaultLayout(theme),
        source: 'default',
        status: 'ready',
        dirty: true,
      })),
    ),

  markSaved: (theme) => set((s) => withTheme(s, theme, (t) => ({ ...t, dirty: false, source: 'file' }))),

  pushHistory: (theme) =>
    set((s) =>
      withTheme(s, theme, (t) => ({
        ...t,
        past: [...t.past, clone(t.layout)].slice(-HISTORY_LIMIT),
        future: [],
      })),
    ),

  undo: (theme) =>
    set((s) =>
      withTheme(s, theme, (t) => {
        const previous = t.past[t.past.length - 1];
        if (!previous) return t;
        return {
          ...t,
          past: t.past.slice(0, -1),
          future: [clone(t.layout), ...t.future].slice(0, HISTORY_LIMIT),
          layout: previous,
          dirty: true,
        };
      }),
    ),

  redo: (theme) =>
    set((s) =>
      withTheme(s, theme, (t) => {
        const next = t.future[0];
        if (!next) return t;
        return {
          ...t,
          past: [...t.past, clone(t.layout)].slice(-HISTORY_LIMIT),
          future: t.future.slice(1),
          layout: next,
          dirty: true,
        };
      }),
    ),

  addProp: (theme, prop) =>
    set((s) =>
      withTheme(s, theme, (t) => ({
        ...t,
        layout: { ...t.layout, props: [...t.layout.props, prop] },
        dirty: true,
      })),
    ),

  updateProp: (theme, id, patch) =>
    set((s) =>
      withTheme(s, theme, (t) => ({
        ...t,
        layout: {
          ...t.layout,
          // Only the edited prop gets a new identity, so every other
          // <PropInstance> skips its render and keeps its loaded model.
          props: t.layout.props.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        },
        dirty: true,
      })),
    ),

  removeProp: (theme, id) =>
    set((s) => ({
      ...withTheme(s, theme, (t) => ({
        ...t,
        layout: { ...t.layout, props: t.layout.props.filter((p) => p.id !== id) },
        dirty: true,
      })),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),
}));

/** The props a map should draw right now. */
export function useThemeProps(theme: ThemeId): PlacedProp[] {
  return useLayoutStore((s) => s.themes[theme].layout.props);
}

/** Unique id for a newly placed prop. */
export function nextPropId(existing: PlacedProp[], node: string): string {
  const base = `new-${node.replace(/[^A-Za-z0-9_-]/gu, '')}`.slice(0, 48);
  const taken = new Set(existing.map((p) => p.id));
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Practically unreachable; keeps the return type honest.
  return `${base}-${taken.size + 1}`;
}
