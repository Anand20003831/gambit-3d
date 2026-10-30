import { Suspense, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera, Preload } from '@react-three/drei';
import type { ThemeId } from '@gambit3d/shared';
import { Board3D, type BoardMarkers } from './Board3D.js';
import { Pieces3D } from './Pieces3D.js';
import { PostFX } from './PostFX.js';
import { getTheme } from './themes/index.js';
import { parseFen, trackPieces, type TrackedPiece } from '../lib/board.js';
import { budgetFor, type QualityBudget, type QualityMode } from '../hooks/useSettings.js';

/**
 * The live scene behind the menus.
 *
 * It is the real renderer, not a picture of one: the same map, the same
 * sculpted pieces, the same grade the game is played through. A menu sitting on
 * a flat panel tells you nothing about what the game looks like; this shows you
 * before you have clicked anything.
 *
 * It is decoration, so it runs on a reduced budget and never casts shadows, and
 * the camera holds still when the player has asked for reduced motion.
 */

/**
 * A position with something going on in it. A starting line-up reads as a shop
 * display; a game in progress reads as a game.
 */
const HERO_FEN = 'r1bqk2r/pp2bppp/2n1pn2/2pp4/3P1B2/2P1PN2/PP1N1PPP/R2QKB1R w KQkq - 0 8';

const NO_MARKERS: BoardMarkers = {
  selected: null,
  legalMoves: [],
  legalCaptures: [],
  lastMove: null,
  checkSquare: null,
  hovered: null,
  premove: null,
};

export interface MenuBackdropProps {
  theme: ThemeId;
  reducedMotion: boolean;
  /** Quality to render at. The menu deliberately runs below the game. */
  quality: QualityMode;
}

export function MenuBackdrop({ theme, reducedMotion, quality }: MenuBackdropProps): JSX.Element {
  const module = getTheme(theme);

  /**
   * A cheaper budget than the game uses. Shadows off, particles down: this is
   * running while the player reads a menu, and it must not make the machine
   * work hard before the game has even started.
   */
  const budget = useMemo<QualityBudget>(() => {
    const base = budgetFor(quality);
    return {
      ...base,
      shadows: false,
      contactShadows: false,
      particleScale: base.particleScale * 0.4,
      environmentDetail: base.environmentDetail === 'rich' ? 'standard' : base.environmentDetail,
    };
  }, [quality]);

  return (
    <Canvas
      resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
      dpr={budget.dpr}
      shadows={false}
      gl={{
        antialias: budget.antialias,
        alpha: false,
        stencil: false,
        /*
          Only needed on the on-demand path: when the scene is not redrawing
          every frame, a buffer that is not preserved can composite as black.
        */
        preserveDrawingBuffer: reducedMotion,
      }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = module.exposure;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        if (module.fog) scene.fog = new THREE.Fog(module.fog.color, module.fog.near, module.fog.far);
      }}
      camera={{ fov: 38, near: 0.1, far: 600 }}
      frameloop={reducedMotion ? 'demand' : 'always'}
    >
      <Scene theme={theme} reducedMotion={reducedMotion} budget={budget} />
    </Canvas>
  );
}

function Scene({
  theme,
  reducedMotion,
  budget,
}: {
  theme: ThemeId;
  reducedMotion: boolean;
  budget: QualityBudget;
}): JSX.Element {
  const module = getTheme(theme);
  const Environment = module.Environment;
  const pieces = useMemo<TrackedPiece[]>(() => trackPieces(parseFen(HERO_FEN), []), []);

  return (
    <>
      <PerspectiveCamera makeDefault fov={38} position={[8.6, 4.3, 8.6]} near={0.1} far={600} />
      <CameraDrift reducedMotion={reducedMotion} />

      <ambientLight color={module.ambient.color} intensity={module.ambient.intensity} />

      <Suspense fallback={null}>
        <Environment quality={budget} reducedMotion={reducedMotion} tension={0} />
      </Suspense>

      <group>
        <Suspense fallback={null}>
          <Board3D
            theme={module}
            quality={budget}
            markers={NO_MARKERS}
            seat="w"
            showCoordinates={false}
            reducedMotion={reducedMotion}
            markerStyle="dots"
            onSquarePointerDown={() => undefined}
            onSquareHover={() => undefined}
            interactive={false}
          />
        </Suspense>
        <Suspense fallback={null}>
          <Pieces3D
            theme={module}
            quality={budget}
            pieces={pieces}
            reducedMotion={reducedMotion}
            selected={null}
            interactive={false}
            controllable={null}
            frozen
            onPiecePointerDown={() => undefined}
            onPieceHover={() => undefined}
          />
        </Suspense>
      </group>

      <Preload all />
      <PostFX grade={module.grade} enabled={budget.postProcessing} reducedMotion={reducedMotion} />
    </>
  );
}

/** How far the camera looks past the board, so it sits right of frame. */
const SUBJECT_OFFSET = 0.3;

/**
 * A slow arc across the board.
 *
 * Deliberately gentle and never repeating exactly - two sine waves at
 * unrelated periods - so it reads as a held camera rather than a turntable.
 */
function CameraDrift({ reducedMotion }: { reducedMotion: boolean }): null {
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3(-0.4, 0.5, 0));

  useFrame((state) => {
    if (reducedMotion) {
      camera.lookAt(target.current);
      camera.rotateY(SUBJECT_OFFSET);
      return;
    }
    // A full circuit takes about a minute and a half - clearly moving when you
    // look at it, never distracting while you read the menu.
    const t = state.clock.elapsedTime * 0.072;
    const radius = 12.4 + Math.sin(t * 0.63) * 1.1;
    camera.position.set(
      Math.sin(t) * radius,
      4.3 + Math.sin(t * 0.41) * 0.7,
      Math.cos(t) * radius,
    );
    camera.lookAt(target.current);
    // Aim a little off the board so it sits right of frame, clear of the menu.
    camera.rotateY(SUBJECT_OFFSET);
  });

  return null;
}
