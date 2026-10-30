import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Preload } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { PieceColor, Seat, Square } from '@gambit3d/shared';
import { Board3D, type BoardMarkers } from './Board3D.js';
import { Pieces3D } from './Pieces3D.js';
import { PostFX } from './PostFX.js';
import { getTheme, withAccessibleHighlights } from './themes/index.js';
import type { ThemeModule } from './themes/types.js';
import type { QualityBudget, Settings } from '../hooks/useSettings.js';
import type { TrackedPiece } from '../lib/board.js';
import { seatYaw } from '../lib/board.js';

/**
 * The 3D scene shell: canvas setup, camera rig, per-map environment, and the
 * board + pieces. All game logic lives outside; this component only renders
 * what it is given and reports pointer intent back up.
 */

export interface SceneProps {
  theme: ThemeModule;
  quality: QualityBudget;
  settings: Settings;
  reducedMotion: boolean;
  pieces: TrackedPiece[];
  markers: BoardMarkers;
  seat: Seat | null;
  interactive: boolean;
  controllable: PieceColor | null;
  frozen: boolean;
  /** 0..1; drives per-map "tension" reactions such as light pulses. */
  tension: number;
  onSquarePointerDown: (square: Square, event: ThreeEvent<PointerEvent>) => void;
  onHover: (square: Square | null) => void;
  /** Bumping this number snaps the camera back to its default. */
  resetCameraToken: number;
  /** Fired once the WebGL renderer exists. Used to detect a stuck canvas. */
  onReady?: () => void;
}

export function Scene(props: SceneProps): JSX.Element {
  const { theme, quality, settings, reducedMotion, onReady } = props;
  const effective = useMemo(
    () => withAccessibleHighlights(theme, settings.colorBlindSafe),
    [theme, settings.colorBlindSafe],
  );

  return (
    <Canvas
      // Measure without waiting on scroll containers; some embedded browser
      // views never deliver those events and the canvas would stay 0x0.
      resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
      dpr={quality.dpr}
      shadows={quality.shadows}
      gl={{
        antialias: quality.antialias,
        alpha: false,
        powerPreference: quality.postProcessing ? 'high-performance' : 'default',
        stencil: false,
        // Preserving the drawing buffer is only needed for screenshots and is
        // expensive on mobile GPUs.
        preserveDrawingBuffer: false,
      }}
      onCreated={({ gl, scene, camera }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = effective.exposure;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        if (effective.fog) {
          scene.fog = new THREE.Fog(effective.fog.color, effective.fog.near, effective.fog.far);
        }
        if (import.meta.env.DEV) {
          // Development-only handle, used by the smoke checks and when
          // debugging a map in the console. Never present in a production build.
          (window as unknown as Record<string, unknown>).__gambit3d = { gl, scene, camera };
        }
        onReady?.();
      }}
      // The board is far more legible with the camera above it, so we start high.
      camera={{ fov: effective.camera.fov, near: 0.1, far: 600 }}
      frameloop={reducedMotion ? 'demand' : 'always'}
    >
      <SceneContents {...props} theme={effective} />
    </Canvas>
  );
}

function SceneContents(props: SceneProps): JSX.Element {
  const {
    theme,
    quality,
    settings,
    reducedMotion,
    pieces,
    markers,
    seat,
    interactive,
    controllable,
    frozen,
    tension,
    onSquarePointerDown,
    onHover,
    resetCameraToken,
  } = props;

  const controls = useRef<OrbitControlsImpl>(null);
  const { gl, scene } = useThree();

  // Keep tone mapping and fog in sync when the map changes without a remount.
  useEffect(() => {
    gl.toneMappingExposure = theme.exposure;
    scene.fog = theme.fog ? new THREE.Fog(theme.fog.color, theme.fog.near, theme.fog.far) : null;
  }, [gl, scene, theme]);

  const Environment = theme.Environment;
  const cam = theme.camera;


  const defaultPosition = useMemo<[number, number, number]>(
    () => (settings.cameraMode === 'tournament' ? cam.tournament : cam.position),
    [cam.position, cam.tournament, settings.cameraMode],
  );

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    c.object.position.set(...defaultPosition);
    c.target.set(...cam.target);
    c.update();
  }, [defaultPosition, cam.target, resetCameraToken]);

  const smoothTension = useSmoothed(tension, reducedMotion);

  return (
    <>
      <PerspectiveCamera makeDefault fov={cam.fov} position={defaultPosition} near={0.1} far={600} />

      <OrbitControls
        ref={controls}
        target={cam.target}
        enableDamping={!reducedMotion}
        dampingFactor={0.08}
        // The tournament camera is fixed; orbit mode allows a constrained arc.
        enableRotate={settings.cameraMode === 'orbit'}
        enablePan={false}
        enableZoom
        minPolarAngle={cam.minPolarAngle}
        maxPolarAngle={cam.maxPolarAngle}
        minDistance={cam.minDistance}
        maxDistance={cam.maxDistance}
        rotateSpeed={0.6}
        zoomSpeed={0.7}
        makeDefault
      />

      <ambientLight color={theme.ambient.color} intensity={theme.ambient.intensity} />

      <Suspense fallback={null}>
        <Environment quality={quality} reducedMotion={reducedMotion} tension={smoothTension} />
      </Suspense>

      {/* The board and its pieces turn together to face the player to move. */}
      <BoardOrientation seat={seat} reducedMotion={reducedMotion}>
        <Suspense fallback={null}>
          <Board3D
            theme={theme}
            quality={quality}
            markers={markers}
            seat={seat}
            showCoordinates={settings.showCoordinates}
            reducedMotion={reducedMotion}
            markerStyle={settings.markerStyle}
            onSquarePointerDown={onSquarePointerDown}
            onSquareHover={onHover}
            interactive={interactive && !frozen}
          />
        </Suspense>

        <Suspense fallback={null}>
          <Pieces3D
            theme={theme}
            quality={quality}
            pieces={pieces}
            reducedMotion={reducedMotion}
            selected={markers.selected}
            interactive={interactive}
            controllable={controllable}
            frozen={frozen}
            onPiecePointerDown={onSquarePointerDown}
            onPieceHover={onHover}
          />
        </Suspense>
      </BoardOrientation>

      <Preload all />

      {/* The map's own grade. Must come after everything it grades. */}
      <PostFX grade={theme.grade} enabled={quality.postProcessing} reducedMotion={reducedMotion} />

      <FrameGovernor reducedMotion={reducedMotion} />
    </>
  );
}

/** How long the board takes to turn around, in seconds. */
const FLIP_SECONDS = 0.85;
const TAU = Math.PI * 2;

/**
 * Turns the board to face whoever is to play, so their own pieces are near.
 *
 * The *board* rotates, not the camera. Each map is a room with one glazed
 * wall, so it is not symmetric: mirroring the camera through the origin for
 * Black would put it outside the window looking back at the building.
 *
 * The turn is animated. In a same-device game the board comes round after
 * every move, and an instant 180-degree jump reads as though something else
 * moved the pieces rather than as the board being handed over. Spinning it
 * shows what actually happened.
 */
function BoardOrientation({
  seat,
  reducedMotion,
  children,
}: {
  seat: Seat | null;
  reducedMotion: boolean;
  children: ReactNode;
}): JSX.Element {
  const group = useRef<THREE.Group>(null);
  const from = useRef(seatYaw(seat));
  const to = useRef(seatYaw(seat));
  /** Progress through the current turn, 0-1. Starts finished. */
  const progress = useRef(1);

  /**
   * A layout effect, and the rotation is never passed as a prop: a prop would
   * be re-applied on every render - and a live game re-renders on every clock
   * tick - which would drag the board back to the start of the turn several
   * times a second.
   */
  useLayoutEffect(() => {
    const desired = seatYaw(seat);
    const live =
      progress.current >= 1
        ? to.current
        : from.current + (to.current - from.current) * ease(progress.current);

    // Whole turns look identical, so fold them away rather than letting the
    // angle grow for the length of the game.
    const start = ((live % TAU) + TAU) % TAU;

    /**
     * Always turn the same way round. A shortest-path interpolation between
     * 0 and PI has no defined direction, so the board would sometimes spin
     * one way and sometimes the other for the same move.
     */
    let delta = (desired - start) % TAU;
    if (delta < 0) delta += TAU;

    if (delta < 1e-4) {
      // Already facing the right way - this is also the first mount.
      from.current = desired;
      to.current = desired;
      progress.current = 1;
      if (group.current) group.current.rotation.y = desired;
      return;
    }

    from.current = start;
    to.current = start + delta;
    progress.current = 0;
  }, [seat]);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;

    if (reducedMotion) {
      progress.current = 1;
      g.rotation.y = to.current;
      return;
    }
    if (progress.current >= 1) return;

    progress.current = Math.min(1, progress.current + delta / FLIP_SECONDS);
    g.rotation.y = from.current + (to.current - from.current) * ease(progress.current);
  });

  return (
    <group ref={group} name="board-orientation">
      {children}
    </group>
  );
}

/** Smoothstep: eases in and out, so the turn starts and settles gently. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Eases a 0/1 flag so light pulses ramp instead of snapping. */
function useSmoothed(target: number, reducedMotion: boolean): number {
  const ref = useRef(target);
  const [value, setValue] = useState(target);

  useFrame((_, delta) => {
    if (reducedMotion) {
      if (ref.current !== target) {
        ref.current = target;
        setValue(target);
      }
      return;
    }
    const next = ref.current + (target - ref.current) * Math.min(1, delta * 3.5);
    if (Math.abs(next - ref.current) > 0.002) {
      ref.current = next;
      setValue(next);
    }
  });

  return value;
}

/**
 * With reduced motion the canvas renders on demand. This nudges a frame when the
 * scene graph changes, so the board never goes stale.
 */
function FrameGovernor({ reducedMotion }: { reducedMotion: boolean }): null {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!reducedMotion) return undefined;
    const id = window.setInterval(() => invalidate(), 120);
    return () => window.clearInterval(id);
  }, [reducedMotion, invalidate]);
  return null;
}

// ---------------------------------------------------------------------------
// WebGL guard
// ---------------------------------------------------------------------------

/**
 * Wraps the scene so a lost or unavailable WebGL context degrades to the 2D
 * board instead of a blank screen.
 */
export function useWebGLHealth(): { healthy: boolean; reset: () => void } {
  const [healthy, setHealthy] = useState(true);

  const reset = useCallback(() => setHealthy(true), []);

  useEffect(() => {
    const onLost = (event: Event): void => {
      event.preventDefault();
      console.warn('[3d] WebGL context lost - switching to the 2D board.');
      setHealthy(false);
    };
    window.addEventListener('webglcontextlost', onLost, true);
    return () => window.removeEventListener('webglcontextlost', onLost, true);
  }, []);

  return { healthy, reset };
}

export { getTheme };
