import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport, OrbitControls, PerspectiveCamera, TransformControls } from '@react-three/drei';
import type {
  OrbitControls as OrbitControlsImpl,
  TransformControls as TransformControlsImpl,
} from 'three-stdlib';
import type { ThemeId } from '@gambit3d/shared';
import { Board3D, type BoardMarkers } from '../Board3D.js';
import { Pieces3D } from '../Pieces3D.js';
import { getTheme } from '../themes/index.js';
import type { QualityBudget } from '../../hooks/useSettings.js';
import { parseFen, trackPieces, type TrackedPiece } from '../../lib/board.js';
import { getPropObject } from './PropsLayer.js';
import { useLayoutStore } from './store.js';

/**
 * The level editor's viewport.
 *
 * Deliberately the same scene the game draws - same map environment, same
 * board, same lighting - with a free camera and a transform gizmo on top. An
 * editor that rendered its own simplified preview would let you line something
 * up perfectly and still have it look wrong in play.
 */

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const EMPTY_MARKERS: BoardMarkers = {
  selected: null,
  legalMoves: [],
  legalCaptures: [],
  lastMove: null,
  checkSquare: null,
  hovered: null,
  premove: null,
};

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type CameraCommand = { kind: 'game' | 'top' | 'frame' | 'wide'; token: number };

export interface EditorSceneProps {
  theme: ThemeId;
  quality: QualityBudget;
  mode: GizmoMode;
  space: 'world' | 'local';
  snap: boolean;
  /** Draw the board and pieces, so scale and framing can be judged. */
  showBoard: boolean;
  showGrid: boolean;
  /** Flat working light, so dark corners can be dressed. */
  workLight: boolean;
  camera: CameraCommand;
  /** Receives the orbit target, so new props can be dropped where you are looking. */
  viewTargetRef: MutableRefObject<[number, number, number]>;
  onTransform: (id: string, patch: TransformPatch) => void;
  onTransformStart: () => void;
}

export interface TransformPatch {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export function EditorScene(props: EditorSceneProps): JSX.Element {
  const theme = getTheme(props.theme);

  return (
    <Canvas
      resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
      dpr={props.quality.dpr}
      shadows={props.quality.shadows}
      gl={{ antialias: props.quality.antialias, alpha: false, stencil: false, preserveDrawingBuffer: false }}
      onCreated={({ gl, scene, camera }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = theme.exposure;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        if (theme.fog) scene.fog = new THREE.Fog(theme.fog.color, theme.fog.near, theme.fog.far);
        if (import.meta.env.DEV) {
          // Same development-only handle the room exposes, so the visual
          // smoke check can measure what the editor actually drew.
          (window as unknown as Record<string, unknown>).__gambit3d = { gl, scene, camera };
        }
      }}
      camera={{ fov: theme.camera.fov, near: 0.1, far: 2000 }}
    >
      <EditorContents {...props} />
    </Canvas>
  );
}

function EditorContents({
  theme: themeId,
  quality,
  mode,
  space,
  snap,
  showBoard,
  showGrid,
  workLight,
  camera,
  viewTargetRef,
  onTransform,
  onTransformStart,
}: EditorSceneProps): JSX.Element {
  const theme = getTheme(themeId);
  const Environment = theme.Environment;
  const controls = useRef<OrbitControlsImpl>(null);
  const { gl, scene } = useThree();

  useEffect(() => {
    gl.toneMappingExposure = theme.exposure;
    scene.fog = theme.fog ? new THREE.Fog(theme.fog.color, theme.fog.near, theme.fog.far) : null;
  }, [gl, scene, theme]);

  const pieces = useMemo<TrackedPiece[]>(() => trackPieces(parseFen(START_FEN), []), []);

  return (
    <>
      <PerspectiveCamera makeDefault fov={theme.camera.fov} position={theme.camera.position} near={0.1} far={2000} />

      {/* Free look: the editor needs to get behind the city, not stay in the chair. */}
      <OrbitControls
        ref={controls}
        makeDefault
        target={theme.camera.target}
        enableDamping
        dampingFactor={0.1}
        enablePan
        enableZoom
        minDistance={0.5}
        maxDistance={900}
        minPolarAngle={0}
        maxPolarAngle={Math.PI}
        panSpeed={1.1}
        zoomSpeed={0.9}
      />

      <CameraRig command={camera} themeId={themeId} controls={controls} viewTargetRef={viewTargetRef} />

      <ambientLight color={theme.ambient.color} intensity={theme.ambient.intensity} />

      {/*
        An editing aid, not part of the map. Both rooms are lit for
        atmosphere, which leaves the near corners nearly black - fine to play
        in, impossible to arrange furniture in. Turn it off to judge how the
        scene will actually look.
      */}
      {workLight && (
        <>
          <ambientLight intensity={1.9} color="#ffffff" />
          <hemisphereLight args={['#ffffff', '#6a7080', 1.6]} />
        </>
      )}

      <Suspense fallback={null}>
        <Environment quality={quality} reducedMotion={false} tension={0} />
      </Suspense>

      {showBoard && (
        <group>
          <Suspense fallback={null}>
            <Board3D
              theme={theme}
              quality={quality}
              markers={EMPTY_MARKERS}
              seat="w"
              showCoordinates
              reducedMotion={false}
              markerStyle="dots"
              onSquarePointerDown={() => undefined}
              onSquareHover={() => undefined}
              interactive={false}
            />
          </Suspense>
          <Suspense fallback={null}>
            <Pieces3D
              theme={theme}
              quality={quality}
              pieces={pieces}
              reducedMotion={false}
              selected={null}
              interactive={false}
              controllable={null}
              frozen
              onPiecePointerDown={() => undefined}
              onPieceHover={() => undefined}
            />
          </Suspense>
        </group>
      )}

      {showGrid && <EditorGrid />}

      <SelectionGizmo mode={mode} space={space} snap={snap} onTransform={onTransform} onStart={onTransformStart} />

      <GizmoHelper alignment="bottom-right" margin={[68, 68]}>
        <GizmoViewport axisColors={['#ff5f7a', '#7ce8d0', '#6fb4ff']} labelColor="#0b1020" />
      </GizmoHelper>
    </>
  );
}

/**
 * A one-unit grid on the floor, to judge distances against.
 *
 * Sized and placed to match the room. A larger grid would carry on past the
 * glazed wall and hang in the middle of the city, which reads as a bug.
 */
function EditorGrid(): JSX.Element {
  const grid = useMemo(() => {
    const helper = new THREE.GridHelper(34, 34, 0x5b6b8c, 0x263149);
    const material = helper.material as THREE.Material | THREE.Material[];
    for (const m of Array.isArray(material) ? material : [material]) {
      m.transparent = true;
      m.opacity = 0.3;
      m.depthWrite = false;
    }
    // Just above the floor so it does not z-fight, and centred on the room
    // rather than the board: the room runs much further back than forward.
    helper.position.set(0, -0.885, 4);
    return helper;
  }, []);

  useEffect(() => () => grid.dispose(), [grid]);
  return <primitive object={grid} />;
}

// ---------------------------------------------------------------------------

/**
 * three-stdlib types the snap steps as private, but they are the documented
 * way to configure the gizmo, so reach them through a narrow shape.
 */
interface SnapFields {
  translationSnap: number | null;
  rotationSnap: number | null;
  scaleSnap: number | null;
}

interface SelectionGizmoProps {
  mode: GizmoMode;
  space: 'world' | 'local';
  snap: boolean;
  onTransform: (id: string, patch: TransformPatch) => void;
  onStart: () => void;
}

function SelectionGizmo({ mode, space, snap, onTransform, onStart }: SelectionGizmoProps): JSX.Element | null {
  const selectedId = useLayoutStore((s) => s.selectedId);
  const registryVersion = useLayoutStore((s) => s.registryVersion);
  const [object, setObject] = useState<THREE.Object3D | null>(null);

  // Models load asynchronously, so the object a selection refers to may not
  // exist yet. The registry bump is what says it has arrived.
  useEffect(() => {
    setObject(getPropObject(selectedId));
  }, [selectedId, registryVersion]);
  const gizmo = useRef<TransformControlsImpl>(null);

  /**
   * Snapping is set on the controls rather than passed as props: three uses a
   * null step to mean no snapping, and a prop that went undefined would leave
   * the previous step in place.
   */
  useEffect(() => {
    const controls = gizmo.current as unknown as SnapFields | null;
    if (!controls) return;
    controls.translationSnap = snap ? 0.25 : null;
    controls.rotationSnap = snap ? Math.PI / 24 : null;
    controls.scaleSnap = snap ? 0.1 : null;
  }, [snap, object]);

  if (!object || !selectedId) return null;

  return (
    <TransformControls
      ref={gizmo}
      object={object}
      mode={mode}
      space={space}
      size={0.9}
      onMouseDown={() => onStart()}
      onObjectChange={() => {
        onTransform(selectedId, {
          position: [object.position.x, object.position.y, object.position.z],
          rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
          scale: [object.scale.x, object.scale.y, object.scale.z],
        });
      }}
    />
  );
}

// ---------------------------------------------------------------------------

interface CameraRigProps {
  command: CameraCommand;
  themeId: ThemeId;
  controls: React.RefObject<OrbitControlsImpl>;
  viewTargetRef: MutableRefObject<[number, number, number]>;
}

/** Handles the camera preset buttons and keeps the orbit target published. */
function CameraRig({ command, themeId, controls, viewTargetRef }: CameraRigProps): null {
  const theme = getTheme(themeId);
  const selectedId = useLayoutStore((s) => s.selectedId);
  const registryVersion = useLayoutStore((s) => s.registryVersion);
  /**
   * The default camera is swapped once during mount, when <PerspectiveCamera
   * makeDefault> takes over from the one the canvas created. The controls are
   * rebuilt around the new camera at its declared position, which would
   * silently undo whatever view we had just set - so re-apply on the swap.
   */
  const camera = useThree((s) => s.camera);
  const lastCamera = useRef<THREE.Camera | null>(null);

  useFrame(() => {
    const target = controls.current?.target;
    if (!target) return;
    const current = viewTargetRef.current;
    if (current[0] !== target.x || current[1] !== target.y || current[2] !== target.z) {
      viewTargetRef.current = [target.x, target.y, target.z];
    }
  });

  const applied = useRef(-1);
  /** Set when a frame request arrived before its model had loaded, so it retries. */
  const awaitingModel = useRef(false);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const cameraSwapped = lastCamera.current !== camera;
    lastCamera.current = camera;
    if (!cameraSwapped && command.token === applied.current && !awaitingModel.current) return;
    applied.current = command.token;
    awaitingModel.current = false;

    if (command.kind === 'game') {
      c.object.position.set(...theme.camera.position);
      c.target.set(...theme.camera.target);
    } else if (command.kind === 'top') {
      // Straight down over the middle of the room, not the middle of the
      // board: the room runs much further back than it does forward.
      c.object.position.set(0, 42, 4.01);
      c.target.set(0, 0, 4);
    } else if (command.kind === 'wide') {
      /**
       * Over the rear corner, looking down into the room.
       *
       * Height matters more than distance here: the rear wall stands 8.5
       * units tall, and a lower angle puts it between the camera and half
       * the furniture.
       */
      c.object.position.set(22, 34, 34);
      c.target.set(0, 0, 4);
    } else if (command.kind === 'frame') {
      const object = getPropObject(selectedId);
      if (!object) {
        awaitingModel.current = true;
        return;
      }
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      const centre = box.getCenter(new THREE.Vector3());
      const radius = Math.max(0.6, box.getSize(new THREE.Vector3()).length() / 2);
      // Pull back along the current view direction so framing keeps the angle.
      const direction = c.object.position.clone().sub(c.target).normalize();
      if (direction.lengthSq() < 1e-6) direction.set(0.6, 0.5, 0.6).normalize();
      c.target.copy(centre);
      c.object.position.copy(centre).addScaledVector(direction, radius * 3.2);
    }

    c.update();
    // `registryVersion` matters for 'frame': the model may still have been loading.
  }, [command.token, command.kind, theme, controls, selectedId, registryVersion, camera]);

  return null;
}
