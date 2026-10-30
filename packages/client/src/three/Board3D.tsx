import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useLoader, type ThreeEvent } from '@react-three/fiber';
import type { Seat, Square } from '@gambit3d/shared';
import {
  ALL_SQUARES,
  BOARD_HALF,
  BOARD_THICKNESS,
  FILES,
  FRAME_WIDTH,
  RANKS,
  SQUARE_SIZE,
  isLightSquare,
  squareToWorld,
} from '../lib/board.js';
import { pbrUrls } from './assets.js';
import type { QualityBudget } from '../hooks/useSettings.js';
import type { HighlightSpec, ThemeModule } from './themes/types.js';

/**
 * The board: 64 individually interactive squares, a frame, coordinates, and the
 * highlight layer.
 *
 * Squares are separate meshes rather than one textured plane so pointer picking
 * is exact and each square can carry its own highlight state.
 */

export interface BoardMarkers {
  selected: Square | null;
  legalMoves: Square[];
  legalCaptures: Square[];
  lastMove: { from: Square; to: Square } | null;
  checkSquare: Square | null;
  hovered: Square | null;
  premove: { from: Square; to: Square } | null;
}

export interface Board3DProps {
  theme: ThemeModule;
  quality: QualityBudget;
  markers: BoardMarkers;
  seat: Seat | null;
  showCoordinates: boolean;
  reducedMotion: boolean;
  /** Distinct marker shapes as well as colours, for colour-blind safety. */
  markerStyle: 'dots' | 'rings' | 'squares';
  onSquarePointerDown: (square: Square, event: ThreeEvent<PointerEvent>) => void;
  onSquareHover: (square: Square | null) => void;
  interactive: boolean;
}

/** Loads a PBR set if the manifest has one; returns null so callers can fall back. */
function useOptionalPbr(prefix: string | null | undefined, anisotropy: number) {
  const urls = prefix ? pbrUrls(prefix) : null;
  const list = useMemo(
    () => (urls?.available ? ([urls.color, urls.normal, urls.roughness].filter(Boolean) as string[]) : []),
    [urls?.color, urls?.normal, urls?.roughness, urls?.available],
  );

  // useLoader suspends; an empty list short-circuits without loading anything.
  const textures = useLoader(THREE.TextureLoader, list.length > 0 ? list : []) as unknown as THREE.Texture[];

  return useMemo(() => {
    if (list.length === 0) return null;
    const [color, normal, roughness] = Array.isArray(textures) ? textures : [textures];
    for (const t of [color, normal, roughness]) {
      if (!t) continue;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = anisotropy;
    }
    if (color) color.colorSpace = THREE.SRGBColorSpace;
    return { color: color ?? null, normal: normal ?? null, roughness: roughness ?? null };
  }, [textures, list.length, anisotropy]);
}

export function Board3D({
  theme,
  quality,
  markers,
  seat,
  showCoordinates,
  reducedMotion,
  markerStyle,
  onSquarePointerDown,
  onSquareHover,
  interactive,
}: Board3DProps): JSX.Element {
  const spec = theme.board;
  const pbr = useOptionalPbr(spec.surfaceTexture, quality.anisotropy);

  const materials = useMemo(() => {
    const mix = spec.textureMix ?? 0;
    const build = (base: string, emissive: string, emissiveIntensity: number): THREE.MeshStandardMaterial => {
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(base),
        emissive: new THREE.Color(emissive),
        emissiveIntensity,
        roughness: spec.roughness,
        metalness: spec.metalness,
      });
      if (pbr && mix > 0) {
        // The texture tints the flat colour rather than replacing it, so the
        // map's palette stays recognisable at any texture.
        if (pbr.color) {
          material.map = pbr.color;
          material.color.lerp(new THREE.Color('#ffffff'), mix);
        }
        if (pbr.normal) {
          material.normalMap = pbr.normal;
          material.normalScale = new THREE.Vector2(mix, mix);
        }
        if (pbr.roughness) material.roughnessMap = pbr.roughness;
      }
      return material;
    };

    return {
      light: build(spec.lightSquare, spec.lightEmissive, spec.lightEmissiveIntensity),
      dark: build(spec.darkSquare, spec.darkEmissive, spec.darkEmissiveIntensity),
      frame: new THREE.MeshStandardMaterial({
        color: new THREE.Color(spec.frameColor),
        roughness: spec.frameRoughness,
        metalness: spec.frameMetalness,
      }),
    };
  }, [spec, pbr]);

  useEffect(
    () => () => {
      materials.light.dispose();
      materials.dark.dispose();
      materials.frame.dispose();
    },
    [materials],
  );

  const squareGeometry = useMemo(
    () => new THREE.BoxGeometry(SQUARE_SIZE * 0.995, BOARD_THICKNESS, SQUARE_SIZE * 0.995),
    [],
  );

  const handleDown = (square: Square) => (event: ThreeEvent<PointerEvent>) => {
    if (!interactive) return;
    event.stopPropagation();
    onSquarePointerDown(square, event);
  };

  const handleOver = (square: Square) => (event: ThreeEvent<PointerEvent>) => {
    if (!interactive) return;
    event.stopPropagation();
    onSquareHover(square);
  };

  return (
    <group>
      {/* Playing surface */}
      {ALL_SQUARES.map((square) => {
        const [x, , z] = squareToWorld(square);
        return (
          <mesh
            key={square}
            name={`square-${square}`}
            position={[x, -BOARD_THICKNESS / 2, z]}
            geometry={squareGeometry}
            material={isLightSquare(square) ? materials.light : materials.dark}
            receiveShadow={quality.shadows}
            onPointerDown={handleDown(square)}
            onPointerOver={handleOver(square)}
            onPointerOut={() => interactive && onSquareHover(null)}
          />
        );
      })}

      <BoardFrame material={materials.frame} castShadow={quality.shadows} />

      {spec.gridLineColor && (spec.gridLineOpacity ?? 0) > 0 && (
        <GridLines color={spec.gridLineColor} opacity={spec.gridLineOpacity ?? 0.3} />
      )}

      <Highlights
        markers={markers}
        highlights={theme.highlights}
        quality={quality}
        reducedMotion={reducedMotion}
        markerStyle={markerStyle}
      />

      {showCoordinates && <Coordinates seat={seat} color={theme.ui.text} />}
    </group>
  );
}

// ---------------------------------------------------------------------------

function BoardFrame({ material, castShadow }: { material: THREE.Material; castShadow: boolean }): JSX.Element {
  const outer = BOARD_HALF + FRAME_WIDTH;
  const height = BOARD_THICKNESS * 1.5;

  return (
    <group>
      {/* Four rails, mitred by overlapping the long pair over the short pair. */}
      <mesh position={[0, -height / 2 + BOARD_THICKNESS * 0.1, -(BOARD_HALF + FRAME_WIDTH / 2)]} material={material} castShadow={castShadow} receiveShadow>
        <boxGeometry args={[outer * 2, height, FRAME_WIDTH]} />
      </mesh>
      <mesh position={[0, -height / 2 + BOARD_THICKNESS * 0.1, BOARD_HALF + FRAME_WIDTH / 2]} material={material} castShadow={castShadow} receiveShadow>
        <boxGeometry args={[outer * 2, height, FRAME_WIDTH]} />
      </mesh>
      <mesh position={[-(BOARD_HALF + FRAME_WIDTH / 2), -height / 2 + BOARD_THICKNESS * 0.1, 0]} material={material} castShadow={castShadow} receiveShadow>
        <boxGeometry args={[FRAME_WIDTH, height, BOARD_HALF * 2]} />
      </mesh>
      <mesh position={[BOARD_HALF + FRAME_WIDTH / 2, -height / 2 + BOARD_THICKNESS * 0.1, 0]} material={material} castShadow={castShadow} receiveShadow>
        <boxGeometry args={[FRAME_WIDTH, height, BOARD_HALF * 2]} />
      </mesh>
      {/* Underside slab, so the board is solid when viewed from a low angle. */}
      <mesh position={[0, -BOARD_THICKNESS - 0.09, 0]} material={material} castShadow={castShadow}>
        <boxGeometry args={[outer * 2, 0.18, outer * 2]} />
      </mesh>
    </group>
  );
}

function GridLines({ color, opacity }: { color: string; opacity: number }): JSX.Element {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const y = 0.004;
    for (let i = 0; i <= 8; i += 1) {
      const p = -BOARD_HALF + i * SQUARE_SIZE;
      positions.push(p, y, -BOARD_HALF, p, y, BOARD_HALF);
      positions.push(-BOARD_HALF, y, p, BOARD_HALF, y, p);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, []);

  const material = useMemo(
    () => new THREE.LineBasicMaterial({ color, transparent: true, opacity, toneMapped: false }),
    [color, opacity],
  );

  return <lineSegments geometry={geometry} material={material} />;
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

interface HighlightsProps {
  markers: BoardMarkers;
  highlights: HighlightSpec;
  quality: QualityBudget;
  reducedMotion: boolean;
  markerStyle: 'dots' | 'rings' | 'squares';
}

function Highlights({ markers, highlights, quality, reducedMotion, markerStyle }: HighlightsProps): JSX.Element {
  const checkRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!checkRef.current) return;
    if (reducedMotion) {
      checkRef.current.scale.setScalar(1);
      return;
    }
    // A pulsing ring means "check" reads without relying on colour alone.
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 5) * 0.12;
    checkRef.current.scale.set(pulse, 1, pulse);
  });

  const y = 0.012;
  const intensity = highlights.intensity * (quality.postProcessing ? 1 : 0.8);

  return (
    <group>
      {markers.lastMove && (
        <>
          <SquareOverlay square={markers.lastMove.from} color={highlights.lastMove} opacity={0.3 * intensity} y={y} />
          <SquareOverlay square={markers.lastMove.to} color={highlights.lastMove} opacity={0.42 * intensity} y={y} />
        </>
      )}

      {markers.premove && (
        <>
          <SquareOverlay square={markers.premove.from} color={highlights.premove} opacity={0.32 * intensity} y={y + 0.001} />
          <SquareOverlay square={markers.premove.to} color={highlights.premove} opacity={0.45 * intensity} y={y + 0.001} />
        </>
      )}

      {markers.hovered && !markers.selected && (
        <SquareOverlay square={markers.hovered} color={highlights.hover} opacity={0.2 * intensity} y={y + 0.002} />
      )}

      {markers.selected && (
        <SquareOverlay square={markers.selected} color={highlights.selected} opacity={0.5 * intensity} y={y + 0.003} ring />
      )}

      {/* A quiet move: a small centred marker. */}
      {markers.legalMoves.map((square) => (
        <MoveMarker key={`m-${square}`} square={square} color={highlights.legalMove} intensity={intensity} style={markerStyle} />
      ))}

      {/* A capture: a thick ring around the target, a different shape from a quiet move. */}
      {markers.legalCaptures.map((square) => (
        <CaptureMarker key={`c-${square}`} square={square} color={highlights.legalCapture} intensity={intensity} />
      ))}

      {markers.checkSquare && (
        <mesh ref={checkRef} position={[...withY(squareToWorld(markers.checkSquare), y + 0.004)]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[SQUARE_SIZE * 0.36, SQUARE_SIZE * 0.48, 32]} />
          <meshBasicMaterial color={highlights.check} transparent opacity={0.9} toneMapped={false} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

function withY(pos: [number, number, number], y: number): [number, number, number] {
  return [pos[0], y, pos[2]];
}

function SquareOverlay({
  square,
  color,
  opacity,
  y,
  ring = false,
}: {
  square: Square;
  color: string;
  opacity: number;
  y: number;
  ring?: boolean;
}): JSX.Element {
  const pos = withY(squareToWorld(square), y);
  return (
    <mesh position={pos} rotation={[-Math.PI / 2, 0, 0]}>
      {ring ? (
        <ringGeometry args={[SQUARE_SIZE * 0.4, SQUARE_SIZE * 0.5, 4, 1, Math.PI / 4]} />
      ) : (
        <planeGeometry args={[SQUARE_SIZE * 0.98, SQUARE_SIZE * 0.98]} />
      )}
      <meshBasicMaterial
        color={color}
        transparent
        opacity={Math.min(1, opacity)}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
}

function MoveMarker({
  square,
  color,
  intensity,
  style,
}: {
  square: Square;
  color: string;
  intensity: number;
  style: 'dots' | 'rings' | 'squares';
}): JSX.Element {
  const pos = withY(squareToWorld(square), 0.018);
  return (
    <mesh position={pos} rotation={[-Math.PI / 2, 0, 0]}>
      {style === 'dots' && <circleGeometry args={[SQUARE_SIZE * 0.17, 24]} />}
      {style === 'rings' && <ringGeometry args={[SQUARE_SIZE * 0.13, SQUARE_SIZE * 0.2, 24]} />}
      {style === 'squares' && <planeGeometry args={[SQUARE_SIZE * 0.3, SQUARE_SIZE * 0.3]} />}
      <meshBasicMaterial
        color={color}
        transparent
        opacity={Math.min(1, 0.7 * intensity)}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
}

/** Captures always read as a ring, whatever the marker style, so shape carries meaning. */
function CaptureMarker({ square, color, intensity }: { square: Square; color: string; intensity: number }): JSX.Element {
  const pos = withY(squareToWorld(square), 0.018);
  return (
    <mesh position={pos} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[SQUARE_SIZE * 0.36, SQUARE_SIZE * 0.47, 28]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={Math.min(1, 0.85 * intensity)}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
}


// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/**
 * Rank and file labels.
 *
 * These are drawn to a small canvas rather than using a text mesh, because
 * every text-mesh option fetches a font file from a CDN at runtime. This game
 * has to work on a Wi-Fi network with no internet at all, so a remote font is
 * not acceptable - canvas uses the operating system's own fonts.
 */

const labelCache = new Map<string, THREE.CanvasTexture>();

function labelTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${text}|${color}`;
  const cached = labelCache.get(key);
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.font = `700 ${Math.round(size * 0.68)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // A dark halo keeps the label readable over both light and dark squares.
    ctx.lineWidth = Math.round(size * 0.1);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.strokeText(text, size / 2, size * 0.54);
    ctx.fillStyle = color;
    ctx.fillText(text, size / 2, size * 0.54);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  labelCache.set(key, texture);
  return texture;
}

function Coordinates({ seat, color }: { seat: Seat | null; color: string }): JSX.Element {
  const offset = BOARD_HALF + FRAME_WIDTH * 0.5;
  const y = 0.06;
  // The board group is rotated for Black, so counter-rotate the labels to keep
  // them the right way up for the reader.
  const flip = seat === 'b';
  const spin = flip ? Math.PI : 0;
  const labelSize = 0.42;

  const materials = useMemo(() => {
    const make = (text: string): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        map: labelTexture(text, color),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
    return {
      files: Object.fromEntries(FILES.map((f) => [f, make(f)])) as Record<string, THREE.MeshBasicMaterial>,
      ranks: Object.fromEntries(RANKS.map((r) => [r, make(r)])) as Record<string, THREE.MeshBasicMaterial>,
    };
  }, [color]);

  useEffect(
    () => () => {
      for (const m of [...Object.values(materials.files), ...Object.values(materials.ranks)]) m.dispose();
    },
    [materials],
  );

  return (
    <group>
      {FILES.map((file, i) => {
        const x = (i - 3.5) * SQUARE_SIZE;
        return (
          <mesh
            key={`f${file}`}
            position={[x, y, flip ? -offset : offset]}
            rotation={[-Math.PI / 2, 0, spin]}
            material={materials.files[file]}
            raycast={() => null}
          >
            <planeGeometry args={[labelSize, labelSize]} />
          </mesh>
        );
      })}
      {RANKS.map((rank, i) => {
        const z = (3.5 - i) * SQUARE_SIZE;
        return (
          <mesh
            key={`r${rank}`}
            position={[flip ? offset : -offset, y, z]}
            rotation={[-Math.PI / 2, 0, spin]}
            material={materials.ranks[rank]}
            raycast={() => null}
          >
            <planeGeometry args={[labelSize, labelSize]} />
          </mesh>
        );
      })}
    </group>
  );
}
