import { useId, useState } from 'react';
import {
  DETAIL_LEVELS,
  type DetailLevel,
  type PlacedProp,
  type PropAnimation,
  type PropMaterial,
  type ThemeId,
  type Vec3,
} from '@gambit3d/shared';
import { Button, Select, Toggle } from '../ui/index.js';
import { useLayoutStore } from '../../three/layout/store.js';

/**
 * Numeric editor for the selected prop.
 *
 * The gizmo is for eyeballing; this is for the moment you know the sofa should
 * be at exactly z = 12.5 and want to type it. Both write to the same store, so
 * they stay in step.
 */

export interface InspectorProps {
  theme: ThemeId;
  prop: PlacedProp | null;
  onDuplicate: () => void;
  onDelete: () => void;
  onFrame: () => void;
}

const DEG = 180 / Math.PI;

export function Inspector({ theme, prop, onDuplicate, onDelete, onFrame }: InspectorProps): JSX.Element {
  const updateProp = useLayoutStore((s) => s.updateProp);
  const pushHistory = useLayoutStore((s) => s.pushHistory);
  const [uniformScale, setUniformScale] = useState(true);

  if (!prop) {
    return (
      <div className="ed-panel__empty">
        <p>Nothing selected.</p>
        <p className="ed-hint">
          Click a model in the scene or pick one from the outliner. <kbd>Esc</kbd> clears the selection.
        </p>
      </div>
    );
  }

  const patch = (changes: Partial<PlacedProp>, record = true): void => {
    if (record) pushHistory(theme);
    updateProp(theme, prop.id, changes);
  };

  const patchMaterial = (changes: Partial<PropMaterial>): void => {
    patch({ material: { ...prop.material, ...changes } });
  };

  const setVectorAxis = (key: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, value: number): void => {
    const next: Vec3 = [...prop[key]] as Vec3;
    if (key === 'scale' && uniformScale) {
      next[0] = value;
      next[1] = value;
      next[2] = value;
    } else {
      next[axis] = value;
    }
    patch({ [key]: next } as Partial<PlacedProp>);
  };

  const material = prop.material ?? {};

  return (
    <div className="ed-inspector">
      <header className="ed-inspector__head">
        <input
          className="input ed-inspector__name"
          value={prop.label ?? ''}
          placeholder={prop.node}
          aria-label="Name"
          onFocus={() => pushHistory(theme)}
          onChange={(event) => patch({ label: event.target.value || undefined }, false)}
        />
        <p className="ed-inspector__meta">
          <code>{prop.node}</code> · {prop.pack}
        </p>
      </header>

      <div className="ed-inspector__actions">
        <Button size="sm" variant="ghost" onClick={onFrame}>
          Frame (F)
        </Button>
        <Button size="sm" variant="ghost" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete}>
          Delete
        </Button>
      </div>

      <VectorRow
        label="Position"
        value={prop.position}
        step={0.25}
        onFocus={() => pushHistory(theme)}
        onChange={(axis, v) => setVectorAxis('position', axis, v)}
      />

      <VectorRow
        label="Rotation°"
        value={[prop.rotation[0] * DEG, prop.rotation[1] * DEG, prop.rotation[2] * DEG]}
        step={5}
        onFocus={() => pushHistory(theme)}
        onChange={(axis, v) => setVectorAxis('rotation', axis, v / DEG)}
      />

      <VectorRow
        label="Scale"
        value={prop.scale}
        step={0.1}
        min={0.001}
        onFocus={() => pushHistory(theme)}
        onChange={(axis, v) => setVectorAxis('scale', axis, v)}
      />

      <div className="ed-row ed-row--single">
        <Toggle
          checked={uniformScale}
          onChange={setUniformScale}
          label="Lock scale to one value"
          hint="Off lets you stretch a model on a single axis."
        />
      </div>

      <fieldset className="ed-group">
        <legend>Size</legend>
        <div className="ed-row">
          <label className="ed-num">
            <span>Fit height</span>
            <input
              className="input"
              type="number"
              step={0.1}
              min={0.01}
              value={prop.fitHeight ?? ''}
              placeholder="off"
              onFocus={() => pushHistory(theme)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                patch({ fitHeight: raw === '' ? null : clampNumber(Number(raw), 0.01, 2000) }, false);
              }}
            />
          </label>
          <label className="ed-num">
            <span>Base scale</span>
            <input
              className="input"
              type="number"
              step={0.1}
              min={0.001}
              value={prop.baseScale ?? 1}
              disabled={prop.fitHeight != null}
              onFocus={() => pushHistory(theme)}
              onChange={(event) => patch({ baseScale: clampNumber(Number(event.target.value), 0.001, 2000) }, false)}
            />
          </label>
        </div>
        <p className="ed-hint">
          Fit height normalises the model to that many units tall before Scale is applied. Clear it to size with Base
          scale instead.
        </p>
      </fieldset>

      <fieldset className="ed-group">
        <legend>Placement</legend>
        <Toggle
          checked={prop.ground}
          onChange={(v) => patch({ ground: v })}
          label="Sit base on Y"
          hint="Re-origins the model so its lowest point is at the Y you set."
        />
        <Toggle checked={prop.castShadow} onChange={(v) => patch({ castShadow: v })} label="Cast shadow" />
        <Toggle checked={prop.receiveShadow} onChange={(v) => patch({ receiveShadow: v })} label="Receive shadow" />
        <Toggle
          checked={prop.locked}
          onChange={(v) => patch({ locked: v })}
          label="Locked"
          hint="Locked models cannot be clicked or dragged in the viewport."
        />
        <label className="ed-num ed-num--wide">
          <span>Group</span>
          <input
            className="input"
            value={prop.group}
            onFocus={() => pushHistory(theme)}
            onChange={(event) => patch({ group: event.target.value.slice(0, 40) || 'Props' }, false)}
          />
        </label>
        <label className="ed-num ed-num--wide">
          <span>Shows from quality</span>
          <Select<DetailLevel>
            value={prop.minDetail}
            options={DETAIL_LEVELS.map((level) => ({ value: level, label: DETAIL_LABELS[level] }))}
            onValueChange={(value) => patch({ minDetail: value })}
          />
        </label>
      </fieldset>

      <details className="ed-group ed-group--collapsible">
        <summary>Material</summary>

        <label className="ed-num ed-num--wide">
          <span>Brightness ×</span>
          <input
            className="input"
            type="number"
            step={0.05}
            min={0}
            max={8}
            value={material.colorScale ?? 1}
            onFocus={() => pushHistory(theme)}
            onChange={(event) => patchMaterial({ colorScale: clampNumber(Number(event.target.value), 0, 8) })}
          />
        </label>

        <ColorRow
          label="Tint"
          color={material.tint ?? '#808080'}
          mix={material.tintMix ?? 0}
          onFocus={() => pushHistory(theme)}
          onColor={(value) => patchMaterial({ tint: value })}
          onMix={(value) => patchMaterial({ tintMix: value })}
        />

        <ColorRow
          label="Emissive"
          color={material.emissive ?? '#000000'}
          mix={material.emissiveIntensity ?? 0}
          mixMax={8}
          mixLabel="Strength"
          onFocus={() => pushHistory(theme)}
          onColor={(value) => patchMaterial({ emissive: value })}
          onMix={(value) => patchMaterial({ emissiveIntensity: value })}
        />

        <div className="ed-row">
          <label className="ed-num">
            <span>Roughness</span>
            <input
              className="input"
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={material.roughness ?? ''}
              placeholder="model"
              onFocus={() => pushHistory(theme)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                patchMaterial({ roughness: raw === '' ? undefined : clampNumber(Number(raw), 0, 1) });
              }}
            />
          </label>
          <label className="ed-num">
            <span>Metalness</span>
            <input
              className="input"
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={material.metalness ?? ''}
              placeholder="model"
              onFocus={() => pushHistory(theme)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                patchMaterial({ metalness: raw === '' ? undefined : clampNumber(Number(raw), 0, 1) });
              }}
            />
          </label>
        </div>

        <Toggle
          checked={material.toneMapped !== false}
          onChange={(v) => patchMaterial({ toneMapped: v })}
          label="Tone mapped"
          hint="Turn off so neon punches past the tone mapper."
        />
      </details>

      <fieldset className="ed-group">
        <legend>Animation</legend>
        <AnimationEditor
          animation={prop.animation ?? { kind: 'none' }}
          onChange={(animation) => patch({ animation })}
        />
      </fieldset>
    </div>
  );
}

const DETAIL_LABELS: Record<DetailLevel, string> = {
  minimal: 'Low and above (always)',
  standard: 'Medium and above',
  rich: 'High only',
};

// ---------------------------------------------------------------------------

interface VectorRowProps {
  label: string;
  value: Vec3 | [number, number, number];
  step: number;
  min?: number;
  onFocus: () => void;
  onChange: (axis: 0 | 1 | 2, value: number) => void;
}

const AXES: { axis: 0 | 1 | 2; name: string }[] = [
  { axis: 0, name: 'X' },
  { axis: 1, name: 'Y' },
  { axis: 2, name: 'Z' },
];

function VectorRow({ label, value, step, min, onFocus, onChange }: VectorRowProps): JSX.Element {
  const id = useId();
  return (
    <div className="ed-vector" role="group" aria-labelledby={id}>
      <span className="ed-vector__label" id={id}>
        {label}
      </span>
      {AXES.map(({ axis, name }) => (
        <label key={name} className={`ed-vector__axis ed-vector__axis--${name.toLowerCase()}`}>
          <span aria-hidden="true">{name}</span>
          <input
            className="input"
            type="number"
            step={step}
            {...(min !== undefined ? { min } : {})}
            aria-label={`${label} ${name}`}
            value={roundForInput(value[axis] ?? 0)}
            onFocus={onFocus}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onChange(axis, next);
            }}
          />
        </label>
      ))}
    </div>
  );
}

interface ColorRowProps {
  label: string;
  color: string;
  mix: number;
  mixMax?: number;
  mixLabel?: string;
  onFocus: () => void;
  onColor: (value: string) => void;
  onMix: (value: number) => void;
}

function ColorRow({
  label,
  color,
  mix,
  mixMax = 1,
  mixLabel = 'Mix',
  onFocus,
  onColor,
  onMix,
}: ColorRowProps): JSX.Element {
  return (
    <div className="ed-row">
      <label className="ed-num">
        <span>{label}</span>
        <input
          className="ed-color"
          type="color"
          value={color}
          onFocus={onFocus}
          onChange={(event) => onColor(event.target.value)}
        />
      </label>
      <label className="ed-num">
        <span>{mixLabel}</span>
        <input
          className="input"
          type="number"
          step={0.05}
          min={0}
          max={mixMax}
          value={mix}
          onFocus={onFocus}
          onChange={(event) => onMix(clampNumber(Number(event.target.value), 0, mixMax))}
        />
      </label>
    </div>
  );
}

function AnimationEditor({
  animation,
  onChange,
}: {
  animation: PropAnimation;
  onChange: (animation: PropAnimation) => void;
}): JSX.Element {
  return (
    <>
      <Select<PropAnimation['kind']>
        value={animation.kind}
        options={[
          { value: 'none', label: 'None' },
          { value: 'flicker', label: 'Flicker (neon)' },
          { value: 'spin', label: 'Spin about Y' },
        ]}
        onValueChange={(kind) => {
          if (kind === 'none') onChange({ kind: 'none' });
          else if (kind === 'flicker') onChange({ kind: 'flicker', rate: 0, phase: 0 });
          else onChange({ kind: 'spin', speed: 0.01, phase: 0 });
        }}
      />

      {animation.kind === 'flicker' && (
        <div className="ed-row">
          <label className="ed-num">
            <span>Rate</span>
            <input
              className="input"
              type="number"
              step={0.1}
              min={0}
              max={20}
              value={animation.rate}
              onChange={(event) =>
                onChange({ ...animation, rate: clampNumber(Number(event.target.value), 0, 20) })
              }
            />
          </label>
          <label className="ed-num">
            <span>Phase</span>
            <input
              className="input"
              type="number"
              step={0.1}
              value={animation.phase}
              onChange={(event) =>
                onChange({ ...animation, phase: clampNumber(Number(event.target.value), -100, 100) })
              }
            />
          </label>
        </div>
      )}

      {animation.kind === 'flicker' && <p className="ed-hint">Rate 0 breathes slowly; above 0 is a failing tube.</p>}

      {animation.kind === 'spin' && (
        <label className="ed-num ed-num--wide">
          <span>Speed (rad/s)</span>
          <input
            className="input"
            type="number"
            step={0.002}
            min={-10}
            max={10}
            value={animation.speed}
            onChange={(event) => onChange({ ...animation, speed: clampNumber(Number(event.target.value), -10, 10) })}
          />
        </label>
      )}
    </>
  );
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Keeps the inputs readable while the gizmo streams full-precision values in. */
function roundForInput(value: number): number {
  return Math.round(value * 1000) / 1000;
}
