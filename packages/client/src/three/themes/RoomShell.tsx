import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useLoader } from '@react-three/fiber';
import { pbrUrls } from '../assets.js';
import type { QualityBudget } from '../../hooks/useSettings.js';

/**
 * The interior both maps are built on.
 *
 * Each map is a room with one glazed wall. The room itself is simple geometry -
 * that is deliberate. A clean, well-lit interior with real PBR surfaces reads
 * far better than a room assembled from mismatched kit pieces, and it keeps the
 * view through the window as the focal point.
 */

export interface RoomShellProps {
  quality: QualityBudget;
  /**
   * The room is deliberately asymmetric: the glazed wall sits close in front of
   * the board so the view fills the upper part of frame, while the room runs
   * back a long way behind the player. A square room puts the window too far
   * away to read.
   */
  /** Distance from the board to the glazed wall (positive number, drawn at -Z). */
  frontDepth?: number;
  /** Distance from the board to the rear wall. */
  backDepth?: number;
  /** Half-width; side walls sit at ±this. */
  halfWidth?: number;
  /** Wall height. */
  height?: number;

  floor: SurfaceSpec;
  wall: SurfaceSpec;
  ceiling: SurfaceSpec;

  /** Colour and strength of the emissive strip where wall meets ceiling. */
  coveColor: string;
  coveIntensity: number;

  /** Mullion (window frame) appearance. */
  frameColor: string;
  frameMetalness: number;
  frameRoughness: number;

  /** How many vertical panes the window is divided into. */
  panes?: number;
  /** Tint of the glass. Set opacity 0 for an open viewport with no glass. */
  glassColor: string;
  glassOpacity: number;

  /** Rendered beyond the window. */
  children?: React.ReactNode;
}

export interface SurfaceSpec {
  color: string;
  roughness: number;
  metalness: number;
  /** Texture set key from the asset manifest, or null for a flat surface. */
  texture?: 'wood-board' | 'marble' | 'metal' | 'asphalt' | null;
  /** 0-1, how strongly the texture shows through the base colour. */
  textureMix?: number;
  /** Texture tiling across the surface. */
  repeat?: number;
  emissive?: string;
  emissiveIntensity?: number;
}

const DEFAULT_FRONT = 12;
const DEFAULT_BACK = 20;
const DEFAULT_HALF_WIDTH = 17;
const DEFAULT_HEIGHT = 8.5;
const WALL_THICKNESS = 0.35;
/** Floor level. The board's underside sits just above this. */
const FLOOR_Y = -0.9;

/** Loads an optional PBR set; returns null when the manifest has no entry. */
function useSurfaceTextures(spec: SurfaceSpec, anisotropy: number) {
  const urls = spec.texture ? pbrUrls(spec.texture) : null;
  const list = useMemo(
    () => (urls?.available ? ([urls.color, urls.normal, urls.roughness].filter(Boolean) as string[]) : []),
    [urls?.available, urls?.color, urls?.normal, urls?.roughness],
  );

  const loaded = useLoader(THREE.TextureLoader, list.length > 0 ? list : []) as unknown as THREE.Texture[];

  return useMemo(() => {
    if (list.length === 0) return null;
    const textures = Array.isArray(loaded) ? loaded : [loaded];
    const repeat = spec.repeat ?? 4;
    const [color, normal, roughness] = textures;
    for (const t of textures) {
      if (!t) continue;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = anisotropy;
    }
    if (color) color.colorSpace = THREE.SRGBColorSpace;
    return { color: color ?? null, normal: normal ?? null, roughness: roughness ?? null };
  }, [loaded, list.length, spec.repeat, anisotropy]);
}

function useSurfaceMaterial(spec: SurfaceSpec, anisotropy: number): THREE.MeshStandardMaterial {
  const textures = useSurfaceTextures(spec, anisotropy);

  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.color),
      roughness: spec.roughness,
      metalness: spec.metalness,
      emissive: new THREE.Color(spec.emissive ?? '#000000'),
      emissiveIntensity: spec.emissiveIntensity ?? 0,
    });
    const mix = spec.textureMix ?? 0.6;
    if (textures && mix > 0) {
      if (textures.color) {
        m.map = textures.color;
        // The texture tints the flat colour instead of replacing it, so each
        // map keeps its own palette whatever the source photo looked like.
        m.color.lerp(new THREE.Color('#ffffff'), mix);
      }
      if (textures.normal) {
        m.normalMap = textures.normal;
        m.normalScale = new THREE.Vector2(mix, mix);
      }
      if (textures.roughness) m.roughnessMap = textures.roughness;
    }
    return m;
  }, [spec, textures]);

  useEffect(() => () => material.dispose(), [material]);
  return material;
}

export function RoomShell({
  quality,
  frontDepth = DEFAULT_FRONT,
  backDepth = DEFAULT_BACK,
  halfWidth = DEFAULT_HALF_WIDTH,
  height = DEFAULT_HEIGHT,
  floor,
  wall,
  ceiling,
  coveColor,
  coveIntensity,
  frameColor,
  frameMetalness,
  frameRoughness,
  panes = 6,
  glassColor,
  glassOpacity,
  children,
}: RoomShellProps): JSX.Element {
  const half = halfWidth;
  const floorY = FLOOR_Y;
  const frontZ = -frontDepth;
  const backZ = backDepth;
  const depth = frontDepth + backDepth;
  const centreZ = (frontZ + backZ) / 2;
  const width = halfWidth * 2;

  const floorMaterial = useSurfaceMaterial(floor, quality.anisotropy);
  const wallMaterial = useSurfaceMaterial(wall, quality.anisotropy);
  const ceilingMaterial = useSurfaceMaterial(ceiling, quality.anisotropy);

  const frameMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(frameColor),
        metalness: frameMetalness,
        roughness: frameRoughness,
      }),
    [frameColor, frameMetalness, frameRoughness],
  );

  const coveMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color(coveColor), toneMapped: false }),
    [coveColor],
  );

  const glassMaterial = useMemo(() => {
    if (glassOpacity <= 0) return null;
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(glassColor),
      metalness: 0,
      roughness: 0.03,
      transparent: true,
      opacity: glassOpacity,
      transmission: quality.reflections ? 0.6 : 0,
      thickness: 0.1,
      side: THREE.DoubleSide,
      // Glass must not write depth or it hides the city behind it.
      depthWrite: false,
    });
  }, [glassColor, glassOpacity, quality.reflections]);

  useEffect(
    () => () => {
      frameMaterial.dispose();
      coveMaterial.dispose();
      glassMaterial?.dispose();
    },
    [frameMaterial, coveMaterial, glassMaterial],
  );

  // The window occupies the whole -Z wall, from a low sill to just under the
  // ceiling, so the view sits high in frame where the camera can see it.
  const sillHeight = 0.9;
  const headHeight = height - 0.4;
  const windowHeight = headHeight - sillHeight;
  const paneWidth = width / panes;

  return (
    <group>
      {/* Floor */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, floorY, centreZ]}
        material={floorMaterial}
        receiveShadow={quality.shadows}
      >
        <planeGeometry args={[width, depth]} />
      </mesh>

      {/* Ceiling */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, floorY + height, centreZ]} material={ceilingMaterial}>
        <planeGeometry args={[width, depth]} />
      </mesh>

      {/* Rear wall, behind the player */}
      <mesh position={[0, floorY + height / 2, backZ]} material={wallMaterial} receiveShadow={quality.shadows}>
        <boxGeometry args={[width, height, WALL_THICKNESS]} />
      </mesh>

      {/* Side walls */}
      <mesh position={[-half, floorY + height / 2, centreZ]} material={wallMaterial} receiveShadow={quality.shadows}>
        <boxGeometry args={[WALL_THICKNESS, height, depth]} />
      </mesh>
      <mesh position={[half, floorY + height / 2, centreZ]} material={wallMaterial} receiveShadow={quality.shadows}>
        <boxGeometry args={[WALL_THICKNESS, height, depth]} />
      </mesh>

      {/* Window wall: sill, head, mullions, and optional glass */}
      <group position={[0, floorY, frontZ]}>
        <mesh position={[0, sillHeight / 2, 0]} material={frameMaterial} receiveShadow={quality.shadows}>
          <boxGeometry args={[width, sillHeight, WALL_THICKNESS]} />
        </mesh>
        <mesh position={[0, headHeight + (height - headHeight) / 2, 0]} material={wallMaterial}>
          <boxGeometry args={[width, height - headHeight, WALL_THICKNESS]} />
        </mesh>

        {/* Vertical mullions */}
        {Array.from({ length: panes + 1 }, (_, i) => (
          <mesh
            key={i}
            position={[-half + i * paneWidth, sillHeight + windowHeight / 2, 0]}
            material={frameMaterial}
            castShadow={quality.shadows}
          >
            <boxGeometry args={[0.14, windowHeight, WALL_THICKNESS * 0.8]} />
          </mesh>
        ))}

        {/* One horizontal transom, which reads as architectural rather than a grid */}
        <mesh position={[0, sillHeight + windowHeight * 0.66, 0]} material={frameMaterial}>
          <boxGeometry args={[width, 0.12, WALL_THICKNESS * 0.7]} />
        </mesh>

        {glassMaterial && (
          <mesh position={[0, sillHeight + windowHeight / 2, 0.03]} material={glassMaterial} renderOrder={2}>
            <planeGeometry args={[width - 0.2, windowHeight - 0.1]} />
          </mesh>
        )}
      </group>

      {/* Emissive cove strips where the walls meet the ceiling */}
      {(
        [
          { key: 'back', position: [0, floorY + height - 0.16, backZ - 0.35], args: [width - 1, 0.07, 0.12] },
          { key: 'left', position: [-half + 0.35, floorY + height - 0.16, centreZ], args: [0.12, 0.07, depth - 1] },
          { key: 'right', position: [half - 0.35, floorY + height - 0.16, centreZ], args: [0.12, 0.07, depth - 1] },
        ] as const
      ).map((strip) => (
        <mesh key={strip.key} position={strip.position as unknown as [number, number, number]} material={coveMaterial}>
          <boxGeometry args={strip.args as unknown as [number, number, number]} />
        </mesh>
      ))}

      {/*
        Practical lights behind the cove strips.
        Intensities are in candela (three.js uses physical units), so a room this
        size needs values in the hundreds - tens read as almost black.
      */}
      <pointLight
        position={[0, floorY + height - 0.7, 2]}
        color={coveColor}
        intensity={coveIntensity}
        distance={depth * 1.4}
        decay={2}
      />
      {quality.environmentDetail !== 'minimal' && (
        <>
          <pointLight
            position={[-half + 1.5, floorY + height - 0.7, centreZ + 3]}
            color={coveColor}
            intensity={coveIntensity * 0.55}
            distance={depth}
            decay={2}
          />
          <pointLight
            position={[half - 1.5, floorY + height - 0.7, centreZ + 3]}
            color={coveColor}
            intensity={coveIntensity * 0.55}
            distance={depth}
            decay={2}
          />
          <pointLight
            position={[0, floorY + height - 0.7, backZ - 4]}
            color={coveColor}
            intensity={coveIntensity * 0.45}
            distance={depth}
            decay={2}
          />
        </>
      )}

      {/* Whatever the window looks out on */}
      {children}
    </group>
  );
}

/** The plinth the board rests on, so the pieces are not floating over the floor. */
export function BoardPlinth({
  quality,
  color,
  metalness,
  roughness,
  emissive,
  emissiveIntensity,
  glowColor,
}: {
  quality: QualityBudget;
  color: string;
  metalness: number;
  roughness: number;
  emissive?: string;
  emissiveIntensity?: number;
  glowColor?: string;
}): JSX.Element {
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        metalness,
        roughness,
        emissive: new THREE.Color(emissive ?? '#000000'),
        emissiveIntensity: emissiveIntensity ?? 0,
      }),
    [color, metalness, roughness, emissive, emissiveIntensity],
  );

  const glow = useMemo(
    () => (glowColor ? new THREE.MeshBasicMaterial({ color: new THREE.Color(glowColor), toneMapped: false }) : null),
    [glowColor],
  );

  useEffect(
    () => () => {
      material.dispose();
      glow?.dispose();
    },
    [material, glow],
  );

  // The board's underside sits at about y = -0.5; the plinth fills down to the floor.
  const top = -0.52;
  const floorY = -0.9;
  const legHeight = top - floorY;

  return (
    <group>
      {/* Table top under the board */}
      <mesh position={[0, top - 0.09, 0]} material={material} castShadow={quality.shadows} receiveShadow>
        <boxGeometry args={[10.4, 0.18, 10.4]} />
      </mesh>
      {/* Pedestal */}
      <mesh position={[0, floorY + legHeight / 2, 0]} material={material} castShadow={quality.shadows}>
        <cylinderGeometry args={[2.6, 3.2, legHeight, quality.environmentDetail === 'minimal' ? 8 : 24]} />
      </mesh>
      {glow && (
        <mesh position={[0, top - 0.19, 0]} material={glow}>
          <boxGeometry args={[10.5, 0.03, 10.5]} />
        </mesh>
      )}
    </group>
  );
}
