import { memo, useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useHelper } from '@react-three/drei';
import { propVisibleAt, type ModelPack, type PlacedProp, type ThemeId } from '@gambit3d/shared';
import type { QualityBudget } from '../../hooks/useSettings.js';
import { cloneNode, usePacks, type LoadedPack } from '../models.js';
import { useLayoutStore } from './store.js';

/**
 * Draws a map's scene layout.
 *
 * Both maps render their environment models through this, and so does the level
 * editor - the editor is looking at the real scene, not a preview of it, which
 * is the whole reason it can be trusted to get the framing right.
 *
 * Picking and selection outlines switch on from the store rather than from a
 * prop, so a map does not need to know the editor exists.
 */

/**
 * Live Object3D for each drawn prop, so the editor can hang a gizmo on one.
 * A plain map rather than state: it changes during commit, and the store's
 * `registryVersion` is what tells React something appeared.
 */
const propObjects = new Map<string, THREE.Object3D>();

export function getPropObject(id: string | null): THREE.Object3D | null {
  return id ? (propObjects.get(id) ?? null) : null;
}

export interface PropsLayerProps {
  theme: ThemeId;
  quality: QualityBudget;
  reducedMotion: boolean;
}

export function PropsLayer({ theme, quality, reducedMotion }: PropsLayerProps): JSX.Element {
  const props = useLayoutStore((s) => s.themes[theme].layout.props);
  const ensureLoaded = useLayoutStore((s) => s.ensureLoaded);
  const editing = useLayoutStore((s) => s.editing);
  const selectedId = useLayoutStore((s) => s.selectedId);
  const select = useLayoutStore((s) => s.select);
  const bumpRegistry = useLayoutStore((s) => s.bumpRegistry);

  useEffect(() => {
    ensureLoaded(theme);
  }, [ensureLoaded, theme]);

  // Fetch only the packs this layout actually references.
  const packNames = useMemo(() => {
    const seen = new Set<ModelPack>();
    for (const p of props) seen.add(p.pack);
    return [...seen].sort();
  }, [props]);

  const packs = usePacks(packNames);

  const visible = useMemo(
    () => props.filter((p) => propVisibleAt(p, quality.environmentDetail)),
    [props, quality.environmentDetail],
  );

  const register = useCallback(
    (id: string, object: THREE.Object3D | null) => {
      if (object) propObjects.set(id, object);
      else propObjects.delete(id);
      bumpRegistry();
    },
    [bumpRegistry],
  );

  return (
    <group name="scene-props">
      {visible.map((prop) => (
        <PropInstance
          key={prop.id}
          prop={prop}
          pack={packs.get(prop.pack) ?? null}
          shadows={quality.shadows}
          reducedMotion={reducedMotion}
          editable={editing}
          selected={editing && prop.id === selectedId}
          onSelect={select}
          onRegister={register}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------

interface PropInstanceProps {
  prop: PlacedProp;
  pack: LoadedPack | null;
  shadows: boolean;
  reducedMotion: boolean;
  editable: boolean;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onRegister: (id: string, object: THREE.Object3D | null) => void;
}

const PropInstance = memo(function PropInstance({
  prop,
  pack,
  shadows,
  reducedMotion,
  editable,
  selected,
  onSelect,
  onRegister,
}: PropInstanceProps): JSX.Element | null {
  const group = useRef<THREE.Group>(null);
  const materials = useRef<THREE.MeshStandardMaterial[]>([]);

  /**
   * The model is rebuilt only when something structural changes. Moving,
   * rotating or scaling a prop touches the wrapper group instead, so dragging
   * the gizmo never reloads geometry.
   */
  const built = useMemo(() => {
    if (!pack) return null;
    const collected: THREE.MeshStandardMaterial[] = [];
    const spec = prop.material;

    const object = cloneNode(pack, prop.node, {
      ...(prop.fitHeight ? { height: prop.fitHeight } : { scale: prop.baseScale ?? 1 }),
      ground: prop.ground,
      castShadow: prop.castShadow && shadows,
      receiveShadow: prop.receiveShadow,
      ...(spec
        ? {
            tweakMaterial: (material: THREE.MeshStandardMaterial) => {
              applyMaterial(material, spec);
              collected.push(material);
            },
          }
        : {}),
    });

    if (!object) return null;
    materials.current = collected;
    return object;
  }, [
    pack,
    prop.node,
    prop.fitHeight,
    prop.baseScale,
    prop.ground,
    prop.castShadow,
    prop.receiveShadow,
    prop.material,
    shadows,
  ]);

  useEffect(() => {
    if (!built) return undefined;
    onRegister(prop.id, group.current);
    return () => onRegister(prop.id, null);
  }, [onRegister, prop.id, built]);

  // Free the cloned materials when the model is swapped or removed.
  useEffect(
    () => () => {
      for (const material of materials.current) material.dispose();
      materials.current = [];
    },
    [built],
  );

  const animation = prop.animation;
  const baseEmissive = prop.material?.emissiveIntensity ?? 1;

  useFrame((state) => {
    if (!animation || animation.kind === 'none' || reducedMotion) return;
    const t = state.clock.elapsedTime;

    if (animation.kind === 'spin') {
      if (group.current) group.current.rotation.y = prop.rotation[1] + t * animation.speed + animation.phase;
      return;
    }

    // Flicker. Rate 0 breathes; above 0 is a failing tube - mostly on, with
    // brief dropouts, rather than a strobe.
    const wobble = Math.sin(t * animation.rate * 8 + animation.phase) * Math.sin(t * animation.rate * 2.1 + animation.phase);
    const level =
      animation.rate === 0
        ? baseEmissive * (0.94 + Math.sin(t * 0.6 + animation.phase) * 0.16)
        : wobble < -0.75
          ? baseEmissive * 0.19
          : baseEmissive * 1.06;

    for (const material of materials.current) material.emissiveIntensity = level;
  });

  useHelper(
    selected && built ? (group as unknown as MutableRefObject<THREE.Object3D>) : null,
    THREE.BoxHelper,
    '#ffc400',
  );

  const handlePointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      if (prop.locked) return;
      event.stopPropagation();
      onSelect(prop.id);
    },
    [onSelect, prop.id, prop.locked],
  );

  if (!built) return null;

  return (
    <group
      ref={group}
      name={prop.id}
      position={prop.position}
      rotation={prop.rotation}
      scale={prop.scale}
      userData={{ propId: prop.id }}
      {...(editable ? { onPointerDown: handlePointerDown } : {})}
    >
      <primitive object={built} />
    </group>
  );
});

// ---------------------------------------------------------------------------

const TMP_COLOR = new THREE.Color();

/**
 * Applies a layout's material overrides.
 *
 * Absolute values land first, then the relative deltas, then everything is
 * clamped - that ordering is what lets a map say "add a tenth to whatever
 * roughness this model came with".
 */
function applyMaterial(material: THREE.MeshStandardMaterial, spec: NonNullable<PlacedProp['material']>): void {
  if (spec.colorScale !== undefined) material.color.multiplyScalar(spec.colorScale);
  if (spec.tint !== undefined) material.color.lerp(TMP_COLOR.set(spec.tint), spec.tintMix ?? 1);

  if (spec.emissive !== undefined) material.emissive = new THREE.Color(spec.emissive);
  if (spec.emissiveIntensity !== undefined) material.emissiveIntensity = spec.emissiveIntensity;

  if (spec.roughness !== undefined) material.roughness = spec.roughness;
  if (spec.roughnessAdd !== undefined) material.roughness += spec.roughnessAdd;
  material.roughness = clamp01(material.roughness);

  if (spec.metalness !== undefined) material.metalness = spec.metalness;
  if (spec.metalnessAdd !== undefined) material.metalness += spec.metalnessAdd;
  material.metalness = clamp01(material.metalness);

  if (spec.envMapIntensity !== undefined) material.envMapIntensity = spec.envMapIntensity;
  if (spec.toneMapped !== undefined) material.toneMapped = spec.toneMapped;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
