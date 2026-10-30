import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  parseSceneLayout,
  THEME_IDS,
  type ModelPack,
  type PlacedProp,
  type SceneLayout,
  type ThemeId,
} from '@gambit3d/shared';
import { Button, Segmented, Toggle } from '../components/ui/index.js';
import { AssetPalette } from '../components/editor/AssetPalette.js';
import { Inspector } from '../components/editor/Inspector.js';
import { Outliner } from '../components/editor/Outliner.js';
import { budgetFor, detectDevice, useSettings } from '../hooks/useSettings.js';
import { serverUrl } from '../net/socket.js';
import { EditorScene, type CameraCommand, type GizmoMode, type TransformPatch } from '../three/layout/EditorScene.js';
import { defaultsForPack } from '../three/layout/catalogue.js';
import { nextPropId, useLayoutStore } from '../three/layout/store.js';
import { getTheme, THEME_LIST } from '../three/themes/index.js';

/**
 * Level editor.
 *
 * Dress a map by dragging its models around inside the real scene, then write
 * the result back to `packages/client/public/layouts/<map>.json`. Nothing here
 * touches gameplay - a layout only decides where the scenery stands.
 */

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string };

interface EditorStatus {
  enabled: boolean;
  reason: string | null;
  directory: string;
}

function isThemeId(value: string | null): value is ThemeId {
  return value !== null && (THEME_IDS as readonly string[]).includes(value);
}

export function EditorPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const themeParam = params.get('map');
  const theme: ThemeId = isThemeId(themeParam) ? themeParam : 'apartment';

  const settings = useSettings();
  const profile = useMemo(() => detectDevice(), []);
  const quality = useMemo(() => budgetFor(settings.quality, profile), [settings.quality, profile]);

  const state = useLayoutStore((s) => s.themes[theme]);
  const selectedId = useLayoutStore((s) => s.selectedId);
  const select = useLayoutStore((s) => s.select);
  const setEditing = useLayoutStore((s) => s.setEditing);
  const ensureLoaded = useLayoutStore((s) => s.ensureLoaded);
  const pushHistory = useLayoutStore((s) => s.pushHistory);
  const updateProp = useLayoutStore((s) => s.updateProp);
  const addProp = useLayoutStore((s) => s.addProp);
  const removeProp = useLayoutStore((s) => s.removeProp);
  const replace = useLayoutStore((s) => s.replace);
  const resetToDefault = useLayoutStore((s) => s.resetToDefault);
  const markSaved = useLayoutStore((s) => s.markSaved);
  const undo = useLayoutStore((s) => s.undo);
  const redo = useLayoutStore((s) => s.redo);

  const layout = state.layout;
  const selected = useMemo(() => layout.props.find((p) => p.id === selectedId) ?? null, [layout.props, selectedId]);

  const [mode, setMode] = useState<GizmoMode>('translate');
  const [space, setSpace] = useState<'world' | 'local'>('world');
  const [snap, setSnap] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showBoard, setShowBoard] = useState(true);
  const [workLight, setWorkLight] = useState(false);
  const [showPanels, setShowPanels] = useState(true);
  const [tab, setTab] = useState<'outliner' | 'add'>('outliner');
  // Opens looking at the whole room rather than from the player's chair:
  // half the scenery is behind you in the game view. "Game view" is one
  // click away when you want to check the framing that actually ships.
  const [camera, setCamera] = useState<CameraCommand>({ kind: 'wide', token: 0 });
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [status, setStatus] = useState<EditorStatus | null>(null);

  const viewTarget = useRef<[number, number, number]>([0, 0.5, -3.4]);
  const fileInput = useRef<HTMLInputElement>(null);

  // --- lifecycle ----------------------------------------------------------

  useEffect(() => {
    setEditing(true);
    return () => setEditing(false);
  }, [setEditing]);

  useEffect(() => {
    ensureLoaded(theme);
  }, [ensureLoaded, theme]);

  useEffect(() => {
    document.title = 'Level editor · Gambit3D';
  }, []);

  // Same shell treatment the room gets: map palette, no page scroll.
  useEffect(() => {
    const module = getTheme(theme);
    const root = document.documentElement;
    root.dataset.map = module.id;
    root.dataset.immersive = 'on';
    root.style.setProperty('--map-accent', module.ui.accent);
    root.style.setProperty('--map-accent-soft', module.ui.accentSoft);
    root.style.setProperty('--map-surface', module.ui.surface);
    root.style.setProperty('--map-surface-raised', module.ui.surfaceRaised);
    root.style.setProperty('--map-text', module.ui.text);
    root.style.setProperty('--map-text-muted', module.ui.textMuted);
    root.style.setProperty('--map-border', module.ui.border);
    return () => {
      delete root.dataset.map;
      delete root.dataset.immersive;
    };
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${serverUrl()}/api/editor/status`);
        const body: unknown = await response.json();
        if (cancelled) return;
        const data = (body as { data?: EditorStatus }).data;
        if (data) setStatus(data);
      } catch {
        if (!cancelled) {
          setStatus({ enabled: false, reason: 'The server is unreachable, so saving is unavailable.', directory: '' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Unsaved work is easy to lose to a stray Ctrl+W.
  useEffect(() => {
    if (!state.dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.dirty]);

  // --- actions ------------------------------------------------------------

  const runCamera = useCallback((kind: CameraCommand['kind']) => {
    setCamera((current) => ({ kind, token: current.token + 1 }));
  }, []);

  const handleTransform = useCallback(
    (id: string, patch: TransformPatch) => {
      updateProp(theme, id, patch);
    },
    [theme, updateProp],
  );

  const handleTransformStart = useCallback(() => pushHistory(theme), [pushHistory, theme]);

  const handleAdd = useCallback(
    (pack: ModelPack, node: string) => {
      const defaults = defaultsForPack(pack);
      const [x, y, z] = viewTarget.current;
      const prop: PlacedProp = {
        id: nextPropId(layout.props, node),
        pack,
        node,
        group: defaults.group,
        position: [round(x), round(y), round(z)],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        fitHeight: defaults.fitHeight,
        baseScale: defaults.baseScale,
        ground: defaults.ground,
        castShadow: defaults.castShadow,
        receiveShadow: defaults.receiveShadow,
        minDetail: 'minimal',
        visible: true,
        locked: false,
      };
      pushHistory(theme);
      addProp(theme, prop);
      select(prop.id);
    },
    [addProp, layout.props, pushHistory, select, theme],
  );

  const handleDuplicate = useCallback(() => {
    if (!selected) return;
    const copy: PlacedProp = {
      ...structuredClone(selected),
      id: nextPropId(layout.props, selected.node),
      // Offset so the copy is visible rather than hidden inside the original.
      position: [selected.position[0] + 1, selected.position[1], selected.position[2] + 1],
    };
    pushHistory(theme);
    addProp(theme, copy);
    select(copy.id);
  }, [addProp, layout.props, pushHistory, select, selected, theme]);

  const handleDelete = useCallback(() => {
    if (!selected) return;
    pushHistory(theme);
    removeProp(theme, selected.id);
  }, [pushHistory, removeProp, selected, theme]);

  const handleSave = useCallback(async () => {
    setSave({ kind: 'saving' });
    try {
      const response = await fetch(`${serverUrl()}/api/editor/layout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(layout),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        message?: string;
        data?: { written?: string[]; props?: number };
      };
      if (!response.ok || !body.ok) {
        setSave({ kind: 'error', message: body.message ?? `Save failed (${response.status}).` });
        return;
      }
      markSaved(theme);
      const written = body.data?.written ?? [];
      setSave({
        kind: 'saved',
        message: `Saved ${body.data?.props ?? layout.props.length} models to ${written[0] ?? 'disk'}${
          written.length > 1 ? ` (+${written.length - 1} more)` : ''
        }.`,
      });
    } catch {
      setSave({ kind: 'error', message: 'Could not reach the server. Use Download instead.' });
    }
  }, [layout, markSaved, theme]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([`${JSON.stringify(layout, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${theme}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setSave({ kind: 'saved', message: `Downloaded ${theme}.json. Put it in packages/client/public/layouts/.` });
  }, [layout, theme]);

  const handleImport = useCallback(
    async (file: File) => {
      try {
        const parsed = parseSceneLayout(JSON.parse(await file.text()));
        if (!parsed) {
          setSave({ kind: 'error', message: `${file.name} is not a valid layout.` });
          return;
        }
        if (parsed.theme !== theme) {
          setSave({ kind: 'error', message: `${file.name} is a layout for the ${parsed.theme} map.` });
          return;
        }
        replace(theme, parsed, 'file');
        select(null);
        setSave({ kind: 'saved', message: `Loaded ${parsed.props.length} models from ${file.name}. Not saved yet.` });
      } catch {
        setSave({ kind: 'error', message: `${file.name} could not be read as JSON.` });
      }
    },
    [replace, select, theme],
  );

  // --- keyboard -----------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName) || target.isContentEditable)) return;

      const meta = event.ctrlKey || event.metaKey;

      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(theme);
        else undo(theme);
        return;
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo(theme);
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (status?.enabled) void handleSave();
        else handleDownload();
        return;
      }
      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        handleDuplicate();
        return;
      }
      if (meta) return;

      switch (event.key) {
        case 'w':
        case 'W':
          setMode('translate');
          break;
        case 'e':
        case 'E':
          setMode('rotate');
          break;
        case 'r':
        case 'R':
          setMode('scale');
          break;
        case 'x':
        case 'X':
          setSpace((s) => (s === 'world' ? 'local' : 'world'));
          break;
        case 'f':
        case 'F':
          runCamera('frame');
          break;
        case 'g':
        case 'G':
          setShowGrid((v) => !v);
          break;
        case 'l':
        case 'L':
          setWorkLight((v) => !v);
          break;
        case 'u':
        case 'U':
          setShowPanels((v) => !v);
          break;
        case 'h':
        case 'H':
          if (selected) {
            pushHistory(theme);
            updateProp(theme, selected.id, { visible: !selected.visible });
          }
          break;
        case 'Escape':
          select(null);
          break;
        case 'Delete':
        case 'Backspace':
          handleDelete();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    handleDelete,
    handleDownload,
    handleDuplicate,
    handleSave,
    pushHistory,
    redo,
    runCamera,
    select,
    selected,
    status?.enabled,
    theme,
    undo,
    updateProp,
  ]);

  // --- render -------------------------------------------------------------

  const themeModule = getTheme(theme);
  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;

  return (
    <div className="editor" data-map={themeModule.ui.className}>
      <div className="editor__stage">
        <EditorScene
          theme={theme}
          quality={quality}
          mode={mode}
          space={space}
          snap={snap}
          showBoard={showBoard}
          showGrid={showGrid}
          workLight={workLight}
          camera={camera}
          viewTargetRef={viewTarget}
          onTransform={handleTransform}
          onTransformStart={handleTransformStart}
        />
      </div>

      <header className="editor__bar">
        <div className="editor__bar-group">
          <Link className="btn btn--ghost btn--sm" to="/">
            ← Exit
          </Link>
          <strong className="editor__title">Level editor</strong>
          <Segmented<ThemeId>
            label="Map"
            value={theme}
            options={THEME_LIST.map((t) => ({ value: t.id, label: t.name }))}
            onChange={(value) => {
              setParams({ map: value }, { replace: true });
              select(null);
            }}
          />
        </div>

        <div className="editor__bar-group">
          <Segmented<GizmoMode>
            label="Transform"
            value={mode}
            options={[
              { value: 'translate', label: 'Move' },
              { value: 'rotate', label: 'Rotate' },
              { value: 'scale', label: 'Scale' },
            ]}
            onChange={setMode}
          />
          <Segmented<'world' | 'local'>
            label="Axes"
            value={space}
            options={[
              { value: 'world', label: 'World' },
              { value: 'local', label: 'Local' },
            ]}
            onChange={setSpace}
          />
          <Button size="sm" variant={snap ? 'primary' : 'ghost'} onClick={() => setSnap((v) => !v)} aria-pressed={snap}>
            Snap
          </Button>
        </div>

        <div className="editor__bar-group">
          <Button size="sm" variant="ghost" onClick={() => runCamera('game')}>
            Game view
          </Button>
          <Button size="sm" variant="ghost" onClick={() => runCamera('wide')}>
            Wide
          </Button>
          <Button size="sm" variant="ghost" onClick={() => runCamera('top')}>
            Top
          </Button>
        </div>

        <div className="editor__bar-group editor__bar-group--end">
          <Button size="sm" variant="ghost" disabled={!canUndo} onClick={() => undo(theme)} title="Ctrl+Z">
            Undo
          </Button>
          <Button size="sm" variant="ghost" disabled={!canRedo} onClick={() => redo(theme)} title="Ctrl+Shift+Z">
            Redo
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={save.kind === 'saving'}
            disabled={!status?.enabled}
            onClick={() => void handleSave()}
            title={status?.enabled ? 'Ctrl+S' : (status?.reason ?? 'Checking the server…')}
          >
            {state.dirty ? 'Save •' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDownload}>
            Download
          </Button>
          <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
            Import
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              resetToDefault(theme);
              select(null);
              setSave({ kind: 'idle' });
            }}
            title="Restore the layout this map shipped with. Save afterwards to keep it."
          >
            Reset
          </Button>
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="editor__file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleImport(file);
          event.target.value = '';
        }}
      />

      {/* Always present so the three grid rows keep their heights. */}
      <div className="editor__middle">
        {showPanels && (
          <>
            <aside className="editor__panel editor__panel--left" aria-label="Scene contents">
              <div className="ed-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'outliner'}
                  className={tab === 'outliner' ? 'is-active' : ''}
                  onClick={() => setTab('outliner')}
                >
                  Scene
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'add'}
                  className={tab === 'add' ? 'is-active' : ''}
                  onClick={() => setTab('add')}
                >
                  Add model
                </button>
              </div>

              {tab === 'outliner' ? (
                <Outliner theme={theme} props={layout.props} selectedId={selectedId} onSelect={select} />
              ) : (
                <AssetPalette theme={theme} placed={layout.props} onAdd={handleAdd} />
              )}
            </aside>

            <aside className="editor__panel editor__panel--right" aria-label="Selected model">
              <Inspector
                theme={theme}
                prop={selected}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onFrame={() => runCamera('frame')}
              />
            </aside>
          </>
        )}
      </div>

      <footer className="editor__status">
        <div className="editor__status-left">
          <Toggle checked={showBoard} onChange={setShowBoard} label="Board" />
          <Toggle checked={showGrid} onChange={setShowGrid} label="Grid" />
          <Toggle
            checked={workLight}
            onChange={setWorkLight}
            label="Work light"
            hint="Flat light for editing. Not part of the map."
          />
          <Toggle checked={showPanels} onChange={setShowPanels} label="Panels" />
          <span className="ed-hint">
            {layout.props.length} models · {state.source === 'file' ? 'saved layout' : 'built-in layout'}
            {state.dirty ? ' · unsaved changes' : ''}
          </span>
        </div>

        <div className="editor__status-right">
          {save.message && (
            <span className={save.kind === 'error' ? 'editor__msg is-error' : 'editor__msg'} role="status">
              {save.message}
            </span>
          )}
          {status && !status.enabled && !save.message && <span className="editor__msg">{status.reason}</span>}
          <span className="ed-hint ed-hint--keys">
            <kbd>W</kbd>
            <kbd>E</kbd>
            <kbd>R</kbd> tool · <kbd>F</kbd> frame · <kbd>L</kbd> light · <kbd>X</kbd> axes · <kbd>U</kbd> panels · <kbd>Del</kbd> remove
          </span>
        </div>
      </footer>
    </div>
  );
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export type { SceneLayout };
