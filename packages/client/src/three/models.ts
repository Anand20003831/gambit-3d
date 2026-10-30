import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Loader for the bundled model packs.
 *
 * Each pack is one GLB holding several named root nodes (see
 * `scripts/build-models.mjs`). Callers ask for a node by name and get a clone,
 * already grounded so its base sits at y = 0 and optionally scaled to a target
 * height. Every lookup can return null - a missing pack is a supported state and
 * each map draws a procedural stand-in instead.
 */

export type PackName =
  | 'apartment-furniture'
  | 'station-props'
  | 'city-buildings'
  | 'city-props'
  | 'space-scenery';

export interface LoadedPack {
  /** Root nodes keyed by the name the pipeline assigned. */
  nodes: Map<string, THREE.Object3D>;
}

const cache = new Map<PackName, Promise<LoadedPack | null>>();
let loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  loader ??= new GLTFLoader();
  return loader;
}

export function loadPack(pack: PackName): Promise<LoadedPack | null> {
  const existing = cache.get(pack);
  if (existing) return existing;

  const promise = (async (): Promise<LoadedPack | null> => {
    try {
      const gltf = await getLoader().loadAsync(`/assets/models/${pack}.glb`);
      const nodes = new Map<string, THREE.Object3D>();
      gltf.scene.updateMatrixWorld(true);
      for (const child of gltf.scene.children) {
        if (child.name) nodes.set(child.name, child);
      }
      if (nodes.size === 0) return null;
      return { nodes };
    } catch {
      // Missing or corrupt pack: callers fall back to procedural geometry.
      return null;
    }
  })();

  cache.set(pack, promise);
  return promise;
}

/** React hook wrapper. Returns null until the pack resolves, and on failure. */
export function usePack(pack: PackName): LoadedPack | null {
  const [loaded, setLoaded] = useState<LoadedPack | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPack(pack).then((result) => {
      if (!cancelled) setLoaded(result);
    });
    return () => {
      cancelled = true;
    };
  }, [pack]);

  return loaded;
}

/**
 * Whether a pack is still loading, usable, or absent.
 *
 * Maps use this to decide when to draw a procedural stand-in: showing the
 * fallback only once the fetch has actually failed avoids a visible pop when
 * the real models arrive a moment later.
 */
export function usePackStatus(pack: PackName): 'loading' | 'ready' | 'missing' {
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void loadPack(pack).then((loaded) => {
      if (!cancelled) setStatus(loaded ? 'ready' : 'missing');
    });
    return () => {
      cancelled = true;
    };
  }, [pack]);

  return status;
}

/**
 * Loads several packs at once, revealing each as it arrives.
 *
 * A single hook with a dynamic list, rather than one `usePack` per pack: a map
 * must not fetch the other map's models just to keep the hook count stable.
 */
export function usePacks(names: PackName[]): Map<PackName, LoadedPack> {
  const key = names.join(',');
  const [packs, setPacks] = useState<Map<PackName, LoadedPack>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    const wanted = key ? (key.split(',') as PackName[]) : [];
    setPacks(new Map());

    for (const name of wanted) {
      void loadPack(name).then((pack) => {
        if (cancelled || !pack) return;
        setPacks((current) => {
          if (current.get(name) === pack) return current;
          const next = new Map(current);
          next.set(name, pack);
          return next;
        });
      });
    }

    return () => {
      cancelled = true;
    };
  }, [key]);

  return packs;
}

export interface CloneOptions {
  /** Scale so the model's height matches this, in world units. */
  height?: number;
  /** Uniform scale, applied when `height` is not given. */
  scale?: number;
  /** Re-origin so the base sits at y = 0 and it is centred on X/Z. */
  ground?: boolean;
  /** Replace every material with this one (used for silhouettes and glass). */
  material?: THREE.Material;
  /** Applied to every material found on the clone. */
  tweakMaterial?: (material: THREE.MeshStandardMaterial) => void;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/**
 * Clones a node out of a pack, ready to drop into a scene.
 *
 * Grounding is done here rather than trusted from the source file: the packs
 * come from several authors and their origins are not consistent.
 */
export function cloneNode(
  pack: LoadedPack | null,
  name: string,
  options: CloneOptions = {},
): THREE.Object3D | null {
  const source = pack?.nodes.get(name);
  if (!source) return null;

  const clone = source.clone(true);
  clone.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(clone);
  if (box.isEmpty()) return null;

  const size = new THREE.Vector3();
  box.getSize(size);

  let scale = options.scale ?? 1;
  if (options.height && size.y > 1e-5) scale = options.height / size.y;

  // A wrapper keeps the clone's own transform intact while we position it.
  const wrapper = new THREE.Group();
  wrapper.name = `${name}-instance`;

  if (options.ground !== false) {
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    clone.position.x -= centre.x;
    clone.position.z -= centre.z;
    clone.position.y -= box.min.y;
  }

  wrapper.add(clone);
  wrapper.scale.setScalar(scale);

  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = options.castShadow ?? true;
    child.receiveShadow = options.receiveShadow ?? true;

    if (options.material) {
      child.material = options.material;
      return;
    }
    if (!options.tweakMaterial) return;

    // Clone materials before tweaking: packs share materials between nodes and
    // we must not mutate another instance's appearance.
    const apply = (m: THREE.Material): THREE.Material => {
      if (!(m instanceof THREE.MeshStandardMaterial)) return m;
      const copy = m.clone();
      options.tweakMaterial?.(copy);
      return copy;
    };
    child.material = Array.isArray(child.material)
      ? child.material.map(apply)
      : apply(child.material as THREE.Material);
  });

  return wrapper;
}

/** Measures a pack node without cloning it, for layout maths. */
export function measureNode(pack: LoadedPack | null, name: string): THREE.Vector3 | null {
  const source = pack?.nodes.get(name);
  if (!source) return null;
  const box = new THREE.Box3().setFromObject(source);
  if (box.isEmpty()) return null;
  const size = new THREE.Vector3();
  box.getSize(size);
  return size;
}

/**
 * Preloads packs so a map does not pop in piece by piece.
 * Failures are swallowed; the maps handle absent packs.
 */
export function preloadPacks(packs: PackName[]): void {
  for (const pack of packs) void loadPack(pack);
}
