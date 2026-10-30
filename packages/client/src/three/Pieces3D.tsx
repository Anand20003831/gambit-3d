import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import type { PieceColor, PieceType, Square } from '@gambit3d/shared';
import { PIECE_BASE_Y, squareToWorld, type TrackedPiece } from '../lib/board.js';
import { pieceGeometry } from './pieces.js';
import { pieceSetUrl } from './assets.js';
import type { QualityBudget } from '../hooks/useSettings.js';
import type { ThemeModule } from './themes/types.js';

/**
 * Piece rendering and movement animation.
 *
 * Each piece is a persistent object keyed by a stable id, so a move animates the
 * same object from one square to the next rather than swapping meshes. Captures
 * play a short sink-and-fade before the object is released.
 */

const MOVE_DURATION = 0.34; // seconds
const CAPTURE_DURATION = 0.3;
const ARC_HEIGHT = 0.55;

export interface Pieces3DProps {
  theme: ThemeModule;
  quality: QualityBudget;
  pieces: TrackedPiece[];
  reducedMotion: boolean;
  selected: Square | null;
  interactive: boolean;
  /** Only pieces of this colour respond to pointer events. */
  controllable: PieceColor | null;
  onPiecePointerDown: (square: Square, event: ThreeEvent<PointerEvent>) => void;
  onPieceHover: (square: Square | null) => void;
  /** Set while a promotion dialog is open, to freeze interaction. */
  frozen: boolean;
}

interface Animated {
  id: string;
  type: PieceType;
  color: PieceColor;
  square: Square;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** 0..1 progress, or -1 when settled. */
  t: number;
  /** Set for pieces on their way out. */
  dying: boolean;
}

export function Pieces3D(props: Pieces3DProps): JSX.Element {
  const { theme, quality, pieces, reducedMotion } = props;
  const url = pieceSetUrl(theme.pieces.set);
  const [useModel, setUseModel] = useState(Boolean(url));

  // If the GLB fails, fall back to procedural geometry rather than an empty board.
  useEffect(() => {
    if (!url) {
      setUseModel(false);
      return undefined;
    }
    let cancelled = false;
    useGLTF
      .preload?.(url);
    fetch(url, { method: 'HEAD' })
      .then((r) => {
        if (!cancelled && !r.ok) setUseModel(false);
      })
      .catch(() => {
        if (!cancelled) setUseModel(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const geometries = usePieceGeometries(theme, quality, useModel && Boolean(url) ? url : null);
  const materials = usePieceMaterials(theme, quality);

  const animated = useAnimatedPieces(pieces, reducedMotion);

  return (
    <group>
      {animated.map((piece) => (
        <PieceMesh
          key={piece.id}
          {...props}
          piece={piece}
          geometry={geometries[piece.type]}
          material={piece.color === 'w' ? materials.white : materials.black}
          outlineMaterial={materials.outline}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type GeometryMap = Record<PieceType, THREE.BufferGeometry>;

function usePieceGeometries(theme: ThemeModule, quality: QualityBudget, glbUrl: string | null): GeometryMap {
  const procedural = useMemo(() => {
    const style = theme.pieces.style;
    const out = {} as GeometryMap;
    for (const type of ['p', 'n', 'b', 'r', 'q', 'k'] as PieceType[]) {
      out[type] = pieceGeometry(type, style, quality.pieceSegments);
    }
    return out;
  }, [theme.pieces.style, quality.pieceSegments]);

  const model = useOptionalModel(glbUrl);

  return useMemo(() => {
    /**
     * The sculpted set is used by every map when it is available.
     *
     * A map's identity is in its materials and lighting, not in the shape of
     * a knight - and the procedural knight is a lathed silhouette with no
     * head on it, because a shape of revolution cannot have one. The
     * procedural set stays as the fallback for when the model is missing.
     */
    if (!model) return procedural;
    const merged = { ...procedural };
    for (const type of Object.keys(model) as PieceType[]) {
      const geo = model[type];
      if (geo) merged[type] = geo;
    }
    return merged;
  }, [model, procedural]);
}

/**
 * How tall the king stands, in board squares. Everything else follows from it.
 *
 * A tournament set puts the king at roughly 1.65 times the width of a square.
 * Backing off slightly from that keeps the far rank from hiding the board at
 this camera's angle, while still reading as a proper set rather than counters.
 */
const KING_HEIGHT = 1.5;

/**
 * Pulls the six piece meshes out of the optimised GLB and puts them on this
 * project's board scale: base at y = 0, centred on its square.
 *
 * The whole set is scaled by a single factor taken from the tallest piece,
 * rather than each piece being stretched to a target height of its own.
 * Fitting them individually overrides the proportions the set was carved
 * with - it was squashing the bishop and the queen by around a tenth each,
 * which is exactly the sort of thing that reads as "wrong" without being
 * obvious why.
 */
function useOptionalModel(url: string | null): Partial<Record<PieceType, THREE.BufferGeometry>> | null {
  const [result, setResult] = useState<Partial<Record<PieceType, THREE.BufferGeometry>> | null>(null);

  useEffect(() => {
    if (!url) {
      setResult(null);
      return undefined;
    }
    let cancelled = false;

    void (async () => {
      try {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js');
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        if (cancelled) return;

        gltf.scene.updateMatrixWorld(true);

        /**
         * A piece can arrive as several primitives - the bishop is a body plus
         * the finial on top - and each becomes its own mesh. Collect them all
         * and merge, or the last one silently replaces the piece.
         */
        const parts = new Map<PieceType, THREE.BufferGeometry[]>();

        gltf.scene.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const match =
            /^piece_([pnbrqk])$/u.exec(child.name) ?? /^piece_([pnbrqk])$/u.exec(child.parent?.name ?? '');
          if (!match) return;
          const type = match[1] as PieceType;

          const geo = dequantize(child.geometry.clone() as THREE.BufferGeometry);
          // Bake the node transform, which after quantisation carries the real size.
          geo.applyMatrix4(child.matrixWorld);

          const list = parts.get(type) ?? [];
          list.push(geo);
          parts.set(type, list);
        });

        const whole = new Map<PieceType, THREE.BufferGeometry>();
        for (const [type, list] of parts) {
          const first = list[0];
          if (!first) continue;
          const merged = list.length === 1 ? first : (mergeGeometries(list, false) ?? first);
          if (merged !== first) for (const part of list) part.dispose();
          merged.computeBoundingBox();
          if (merged.boundingBox) whole.set(type, merged);
        }

        // One factor for the whole set, measured from whichever piece is tallest.
        let tallest = 0;
        for (const geo of whole.values()) {
          const box = geo.boundingBox;
          if (box) tallest = Math.max(tallest, box.max.y - box.min.y);
        }
        const scale = tallest > 1e-6 ? KING_HEIGHT / tallest : 1;

        const out: Partial<Record<PieceType, THREE.BufferGeometry>> = {};
        const centre = new THREE.Vector3();
        for (const [type, geo] of whole) {
          const box = geo.boundingBox;
          if (!box) continue;
          box.getCenter(centre);
          // Centre on its square, base on the board.
          geo.translate(-centre.x, -box.min.y, -centre.z);
          geo.scale(scale, scale, scale);
          /**
           * The set ships with its own normals, and they carry the hard edges
           * the sculptor put in. Recomputing them would smooth every crown and
           * mitre into a blob, so only fill them in when they are absent.
           */
          if (!geo.getAttribute('normal')) geo.computeVertexNormals();
          geo.computeBoundingBox();
          geo.computeBoundingSphere();
          out[type] = geo;
        }

        if (!cancelled) setResult(Object.keys(out).length > 0 ? out : null);
      } catch {
        // Any failure -> procedural pieces. The board is never empty.
        if (!cancelled) setResult(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return result;
}

/**
 * Expands quantised attributes back to plain floats.
 *
 * The asset pipeline quantises positions to normalised 16-bit integers and
 * leaves the real size in the node's scale. Transforming such an attribute
 * writes the result back through the same normalised integers, which can only
 * hold -1 to 1: scaling a piece up to board size overflows them and the values
 * wrap, which turns the model into noise. Only the pawn and the rook were small
 * enough to survive it.
 */
function dequantize(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of ['position', 'normal', 'uv'] as const) {
    const attribute = geometry.getAttribute(name);
    if (!attribute) continue;
    if (attribute.array instanceof Float32Array && !attribute.normalized) continue;

    const size = attribute.itemSize;
    const expanded = new Float32Array(attribute.count * size);
    for (let i = 0; i < attribute.count; i += 1) {
      expanded[i * size] = attribute.getX(i);
      if (size > 1) expanded[i * size + 1] = attribute.getY(i);
      if (size > 2) expanded[i * size + 2] = attribute.getZ(i);
      if (size > 3) expanded[i * size + 3] = attribute.getW(i);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(expanded, size));
  }
  return geometry;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

interface PieceMaterials {
  white: THREE.Material;
  black: THREE.Material;
  outline: THREE.Material | null;
}

/**
 * Builds the two side materials.
 *
 * `MeshPhysicalMaterial` rather than the standard one: a flat colour with an
 * emissive term on top reads as moulded plastic no matter how good the model
 * is, because nothing in it varies with viewing angle. Clearcoat, sheen and a
 * reflected environment are what make a surface look like a material.
 *
 * Refraction is the expensive one - it costs an extra render pass - so it is
 * only switched on where the quality budget already allows reflections.
 */
function usePieceMaterials(theme: ThemeModule, quality: QualityBudget): PieceMaterials {
  return useMemo(() => {
    const spec = theme.pieces;

    const build = (side: typeof spec.white): THREE.Material => {
      const finish = side.finish ?? {};
      const refracts = Boolean(finish.transmission) && quality.reflections;

      const material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(side.color),
        emissive: new THREE.Color(side.emissive),
        emissiveIntensity: side.emissiveIntensity,
        roughness: side.roughness,
        metalness: side.metalness,
        // Refraction carries its own translucency; stacking blend on top of
        // it just muddies the piece.
        transparent: !refracts && side.opacity < 1,
        opacity: refracts ? 1 : side.opacity,
        clearcoat: finish.clearcoat ?? 0,
        clearcoatRoughness: finish.clearcoatRoughness ?? 0.1,
        envMapIntensity: finish.envMapIntensity ?? 1,
        transmission: refracts ? (finish.transmission ?? 0) : 0,
        thickness: finish.thickness ?? 0,
        ior: finish.ior ?? 1.5,
        sheen: finish.sheen ?? 0,
        sheenColor: new THREE.Color(finish.sheenColor ?? side.rimColor),
        sheenRoughness: finish.sheenRoughness ?? 0.5,
        specularIntensity: finish.specularIntensity ?? 1,
        attenuationColor: new THREE.Color(finish.attenuationColor ?? side.rimColor),
        attenuationDistance: finish.attenuationDistance ?? Infinity,
        dispersion: refracts ? (finish.dispersion ?? 0) : 0,
        iridescence: finish.iridescence ?? 0,
        iridescenceIOR: finish.iridescenceIOR ?? 1.3,
      });

      const micro = finish.microVariation ?? 0;
      if (side.rim > 0 || micro > 0) {
        const rimColor = new THREE.Color(side.rimColor);
        const rimStrength = side.rim;
        const microScale = finish.microScale ?? 6;

        material.onBeforeCompile = (shader) => {
          shader.uniforms.uRimColor = { value: rimColor };
          shader.uniforms.uRimStrength = { value: rimStrength };
          shader.uniforms.uMicro = { value: micro };
          shader.uniforms.uMicroScale = { value: microScale };

          /**
           * The variation is sampled in world space rather than from a texture:
           * these sets are printing models with no UVs at all, so there is
           * nothing to map a roughness image onto.
           */
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n varying vec3 vMicroPos;`)
            .replace(
              '#include <begin_vertex>',
              `#include <begin_vertex>
               vMicroPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
            );

          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              `#include <common>
               uniform vec3 uRimColor;
               uniform float uRimStrength;
               uniform float uMicro;
               uniform float uMicroScale;
               varying vec3 vMicroPos;

               float microHash(vec3 p) {
                 return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
               }
               float microNoise(vec3 p) {
                 vec3 i = floor(p);
                 vec3 f = fract(p);
                 f = f * f * (3.0 - 2.0 * f);
                 float n000 = microHash(i);
                 float n100 = microHash(i + vec3(1.0, 0.0, 0.0));
                 float n010 = microHash(i + vec3(0.0, 1.0, 0.0));
                 float n110 = microHash(i + vec3(1.0, 1.0, 0.0));
                 float n001 = microHash(i + vec3(0.0, 0.0, 1.0));
                 float n101 = microHash(i + vec3(1.0, 0.0, 1.0));
                 float n011 = microHash(i + vec3(0.0, 1.0, 1.0));
                 float n111 = microHash(i + vec3(1.0, 1.0, 1.0));
                 return mix(
                   mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                   mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
                   f.z
                 );
               }`,
            )
            .replace(
              '#include <roughnessmap_fragment>',
              `#include <roughnessmap_fragment>
               if (uMicro > 0.0) {
                 // Two octaves: broad unevenness plus a finer tooth.
                 float grain = microNoise(vMicroPos * uMicroScale) * 0.65
                             + microNoise(vMicroPos * uMicroScale * 3.7) * 0.35;
                 roughnessFactor = clamp(roughnessFactor + (grain - 0.5) * uMicro, 0.015, 1.0);
               }`,
            )
            .replace(
              '#include <dithering_fragment>',
              `#include <dithering_fragment>
               if (uRimStrength > 0.0) {
                 float rim = 1.0 - max(0.0, dot(normalize(vNormal), normalize(vViewPosition)));
                 gl_FragColor.rgb += uRimColor * pow(rim, 2.5) * uRimStrength;
               }`,
            );
        };
        material.needsUpdate = true;
      }
      return material;
    };

    return {
      white: build(spec.white),
      black: build(spec.black),
      outline: spec.outline
        ? new THREE.MeshBasicMaterial({ color: new THREE.Color(spec.outlineColor), side: THREE.BackSide })
        : null,
    };
  }, [theme.pieces, quality.reflections]);
}

// ---------------------------------------------------------------------------
// Animation bookkeeping
// ---------------------------------------------------------------------------

function useAnimatedPieces(pieces: TrackedPiece[], reducedMotion: boolean): Animated[] {
  const stateRef = useRef<Map<string, Animated>>(new Map());
  const [, forceRender] = useState(0);

  useEffect(() => {
    const map = stateRef.current;
    const seen = new Set<string>();

    for (const piece of pieces) {
      seen.add(piece.id);
      const target = new THREE.Vector3(...squareToWorld(piece.square));
      const existing = map.get(piece.id);

      if (!existing) {
        map.set(piece.id, {
          id: piece.id,
          type: piece.type,
          color: piece.color,
          square: piece.square,
          from: target.clone(),
          to: target,
          t: -1,
          dying: false,
        });
        continue;
      }

      if (existing.square !== piece.square) {
        // Start a fresh glide from wherever the piece currently is.
        existing.from = currentPosition(existing);
        existing.to = target;
        existing.square = piece.square;
        existing.t = reducedMotion ? 1 : 0;
      }
      existing.type = piece.type;
      existing.color = piece.color;
      existing.dying = false;
    }

    // Anything no longer present is captured: let it sink out rather than pop.
    for (const [id, piece] of map) {
      if (seen.has(id) || piece.dying) continue;
      piece.dying = true;
      piece.t = reducedMotion ? 1 : 0;
      piece.from = currentPosition(piece);
      piece.to = piece.from.clone().setY(piece.from.y - 1.2);
      if (reducedMotion) map.delete(id);
    }

    forceRender((n) => n + 1);
  }, [pieces, reducedMotion]);

  useFrame((_, delta) => {
    const map = stateRef.current;
    let changed = false;
    for (const [id, piece] of map) {
      if (piece.t < 0) continue;
      const duration = piece.dying ? CAPTURE_DURATION : MOVE_DURATION;
      piece.t = Math.min(1, piece.t + delta / duration);
      if (piece.t >= 1) {
        if (piece.dying) {
          map.delete(id);
          changed = true;
        } else {
          piece.t = -1;
        }
      }
    }
    if (changed) forceRender((n) => n + 1);
  });

  return [...stateRef.current.values()];
}

function currentPosition(piece: Animated): THREE.Vector3 {
  if (piece.t < 0) return piece.to.clone();
  return piece.from.clone().lerp(piece.to, easeInOut(piece.t));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

// ---------------------------------------------------------------------------
// One piece
// ---------------------------------------------------------------------------

interface PieceMeshProps extends Pieces3DProps {
  piece: Animated;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  outlineMaterial: THREE.Material | null;
}

function PieceMesh({
  piece,
  geometry,
  material,
  outlineMaterial,
  theme,
  quality,
  reducedMotion,
  selected,
  interactive,
  controllable,
  frozen,
  onPiecePointerDown,
  onPieceHover,
}: PieceMeshProps): JSX.Element {
  const group = useRef<THREE.Group>(null);
  const isSelected = selected === piece.square;
  const canGrab = interactive && !frozen && controllable === piece.color;

  // Black pieces face the other way, which matters for the knight.
  const facing = piece.color === 'w' ? 0 : Math.PI;

  useFrame((state) => {
    const node = group.current;
    if (!node) return;

    const pos = currentPosition(piece);
    let y = PIECE_BASE_Y;

    if (piece.dying) {
      const k = easeInOut(piece.t < 0 ? 1 : piece.t);
      y = PIECE_BASE_Y - k * 1.2;
      node.scale.setScalar(Math.max(0.001, 1 - k));
      node.rotation.y = facing + k * 2.2;
    } else {
      node.scale.setScalar(1);
      node.rotation.y = facing;
      if (piece.t >= 0 && !reducedMotion) {
        // Lift over the board mid-glide so pieces do not clip through each other.
        y = PIECE_BASE_Y + Math.sin(easeInOut(piece.t) * Math.PI) * ARC_HEIGHT;
      }
      if (isSelected && !reducedMotion) {
        y += 0.09 + Math.sin(state.clock.elapsedTime * 3.4) * 0.035;
      } else if (isSelected) {
        y += 0.1;
      }
    }

    node.position.set(pos.x, y, pos.z);
  });

  const handleDown = (event: ThreeEvent<PointerEvent>): void => {
    if (!interactive || frozen) return;
    event.stopPropagation();
    onPiecePointerDown(piece.square, event);
  };

  return (
    <group ref={group}>
      {outlineMaterial && (
        <mesh
          geometry={geometry}
          material={outlineMaterial}
          scale={theme.pieces.outlineScale}
          raycast={() => null}
        />
      )}
      <mesh
        geometry={geometry}
        material={material}
        castShadow={quality.shadows}
        receiveShadow={quality.shadows}
        onPointerDown={handleDown}
        onPointerOver={(event) => {
          if (!interactive || frozen) return;
          event.stopPropagation();
          onPieceHover(piece.square);
          if (canGrab) document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          if (!interactive) return;
          onPieceHover(null);
          document.body.style.cursor = '';
        }}
      />
      {quality.contactShadows && !piece.dying && (
        <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
          <circleGeometry args={[0.3, 16]} />
          <meshBasicMaterial color="#000000" transparent opacity={0.24} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
