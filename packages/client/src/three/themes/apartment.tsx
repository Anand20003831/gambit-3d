import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Environment as DreiEnvironment } from '@react-three/drei';
import { hdriUrl } from '../assets.js';
import { PropsLayer } from '../layout/PropsLayer.js';
import { preloadPacks, usePackStatus } from '../models.js';
import { BoardPlinth, RoomShell } from './RoomShell.js';
import type { EnvironmentProps, ThemeModule } from './types.js';

/**
 * Neon City Apartment.
 *
 * A high-rise living room with one glazed wall. The board sits on a plinth in
 * the middle of the room; beyond the glass a real modelled city recedes into
 * rain and haze. All signage text is invented for this project - no real brand,
 * logo or character appears anywhere.
 *
 * Where every model sits is data, not code: see `layout/defaults.ts` and the
 * level editor at /editor.
 */

/** Deterministic PRNG so the fallback skyline is identical on every load. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Stand-in used only when the building pack is genuinely unavailable.
 * Deliberately simple - it reads as distant haze, not as buildings.
 */
function ProceduralSkyline({ quality }: Pick<EnvironmentProps, 'quality'>): JSX.Element {
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0b0a18', roughness: 0.9, metalness: 0.1 }),
    [],
  );

  useEffect(() => () => material.dispose(), [material]);

  const blocks = useMemo(() => {
    const count = quality.environmentDetail === 'minimal' ? 14 : 30;
    const random = makeRandom(777);
    return Array.from({ length: count }, () => {
      const depth = 60 + random() * 140;
      const height = 24 + random() * 70;
      return {
        position: [(-1 + random() * 2) * (30 + depth * 0.5), -0.9 + height / 2, -depth] as [number, number, number],
        scale: [8 + random() * 14, height, 8 + random() * 14] as [number, number, number],
      };
    });
  }, [quality.environmentDetail]);

  return (
    <group>
      {blocks.map((b, i) => (
        <mesh key={i} position={b.position} scale={b.scale} material={material}>
          <boxGeometry args={[1, 1, 1]} />
        </mesh>
      ))}
    </group>
  );
}

/** Rain outside, plus streaks running down the glass. */
function Rain({ quality, reducedMotion }: EnvironmentProps): JSX.Element | null {
  const count = Math.round(2200 * quality.particleScale);
  const points = useRef<THREE.Points>(null);

  const { geometry, speeds } = useMemo(() => {
    const positions = new Float32Array(Math.max(1, count) * 3);
    const s = new Float32Array(Math.max(1, count));
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 70;
      positions[i * 3 + 1] = Math.random() * 50 - 6;
      positions[i * 3 + 2] = -12.5 - Math.random() * 45;
      s[i] = 22 + Math.random() * 18;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return { geometry: geo, speeds: s };
  }, [count]);

  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: '#9fe8ff',
        size: 0.09,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((_, delta) => {
    if (!points.current || reducedMotion || count === 0) return;
    const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = attr.array as Float32Array;
    const step = Math.min(delta, 0.05);
    for (let i = 0; i < count; i += 1) {
      const y = i * 3 + 1;
      array[y] = (array[y] ?? 0) - (speeds[i] ?? 24) * step;
      if ((array[y] ?? 0) < -8) {
        array[y] = 40 + Math.random() * 8;
        array[i * 3] = (Math.random() - 0.5) * 70;
        array[i * 3 + 2] = -12.5 - Math.random() * 45;
      }
    }
    attr.needsUpdate = true;
  });

  if (count === 0) return null;
  return <points ref={points} geometry={geometry} material={material} frustumCulled={false} />;
}

// ---------------------------------------------------------------------------

function ApartmentEnvironment(props: EnvironmentProps): JSX.Element {
  const { quality, reducedMotion, tension } = props;
  const hdri = hdriUrl('apartment');
  const keyLight = useRef<THREE.PointLight>(null);
  const cityGlow = useRef<THREE.PointLight>(null);
  const cityPack = usePackStatus('city-buildings');

  useEffect(() => {
    preloadPacks(['city-buildings', 'city-props', 'apartment-furniture']);
  }, []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (keyLight.current) {
      const base = reducedMotion ? 430 : 430 + Math.sin(t * 0.8) * 40;
      keyLight.current.intensity = base + tension * 260;
    }
    if (cityGlow.current) {
      cityGlow.current.intensity = reducedMotion ? 520 : 520 + Math.cos(t * 0.45) * 70;
    }
  });

  return (
    <>
      <color attach="background" args={['#070510']} />
      {hdri && <DreiEnvironment files={hdri} environmentIntensity={0.45} />}

      <ambientLight intensity={0.4} color="#5b4a92" />

      {/* Interior key from the cove lighting, and a big cold wash from the city. */}
      <pointLight
        ref={keyLight}
        position={[4.5, 5.4, 6.5]}
        color="#00e5ff"
        intensity={380}
        distance={26}
        decay={2}
        castShadow={quality.shadows}
        shadow-mapSize-width={quality.shadowMapSize}
        shadow-mapSize-height={quality.shadowMapSize}
        shadow-bias={-0.0012}
      />
      <pointLight position={[-6.5, 5.0, 5.5]} color="#ff2fd0" intensity={230} distance={22} decay={2} />
      {/* The city itself, shining in through the glass. */}
      <pointLight ref={cityGlow} position={[0, 4.2, -9]} color="#8fd8ff" intensity={520} distance={26} decay={2} />
      <directionalLight position={[0, 8, -22]} intensity={1.4} color="#a9d8ff" />

      <RoomShell
        quality={quality}
        frontDepth={12}
        backDepth={20}
        halfWidth={17}
        height={8.5}
        floor={{
          color: '#0d0e16',
          roughness: quality.reflections ? 0.22 : 0.42,
          metalness: 0.45,
          texture: 'marble',
          textureMix: 0.18,
          repeat: 6,
        }}
        wall={{ color: '#211d2e', roughness: 0.85, metalness: 0.05, texture: 'asphalt', textureMix: 0.14, repeat: 3 }}
        ceiling={{ color: '#15121f', roughness: 0.95, metalness: 0.03 }}
        coveColor="#00e5ff"
        coveIntensity={520}
        frameColor="#12101c"
        frameMetalness={0.85}
        frameRoughness={0.3}
        panes={8}
        glassColor="#9fd6ff"
        glassOpacity={0.07}
      >
        {cityPack === 'missing' && <ProceduralSkyline quality={quality} />}
        <Rain {...props} />
      </RoomShell>

      {/* City, signage, rooftop clutter and furniture all come from the layout. */}
      <PropsLayer theme="apartment" quality={quality} reducedMotion={reducedMotion} />

      <BoardPlinth
        quality={quality}
        color="#0d0b16"
        metalness={0.8}
        roughness={0.25}
        emissive="#001c26"
        emissiveIntensity={0.4}
        glowColor="#00e5ff"
      />
    </>
  );
}

export const apartmentTheme: ThemeModule = {
  id: 'apartment',
  name: 'Neon City Apartment',
  tagline: 'A high-rise apartment, rain on the glass, the city burning below.',
  description:
    'Holographic pieces on a black mirror board, set in a high-rise living room. Beyond the glazed wall a modelled city recedes into rain and neon haze.',
  attribution: [
    'Buildings and signage: Quaternius (CC0)',
    'Furniture: Quaternius "Ultimate Furniture Pack" (CC0)',
    'Sky: "Rooftop Night" by Greg Zaal (Poly Haven, CC0)',
    'Music: "Robotic City V2" by section31 (CC0)',
  ],

  loadingBackground: '#08040f',
  loadingAccent: '#00e5ff',

  Environment: ApartmentEnvironment,

  board: {
    // Still a dark mirror, but the two square colours have to actually
    // differ - the old pair were both nearly black.
    lightSquare: '#33465e',
    darkSquare: '#070a12',
    lightEmissive: '#0d4a5e',
    darkEmissive: '#2a0a3a',
    lightEmissiveIntensity: 0.55,
    darkEmissiveIntensity: 0.3,
    roughness: 0.16,
    metalness: 0.86,
    frameColor: '#0a0714',
    frameRoughness: 0.22,
    frameMetalness: 0.9,
    surfaceTexture: 'asphalt',
    textureMix: 0.2,
    gridLineColor: '#00e5ff',
    gridLineOpacity: 0.5,
  },

  /**
   * Holographic, but the two sides still have to be told apart at a glance.
   *
   * Hue alone was not enough: pale cyan and pale pink at the same emissive
   * strength read as the same brightness across the board. The dark side is
   * now genuinely dark - a deep magenta body with a bright rim - so the two
   * differ in lightness as well as colour.
   */
  pieces: {
    style: 'holo',
    set: 'classic',
    white: {
      color: '#cfe6f2',
      emissive: '#0a5f7a',
      emissiveIntensity: 0.05,
      roughness: 0.14,
      metalness: 0,
      opacity: 1,
      rim: 0.18,
      rimColor: '#bfeaff',
      finish: {
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        envMapIntensity: 2.7,
        transmission: 0.8,
        thickness: 1.3,
        ior: 1.53,
        // Light picks up the faintest blue crossing the body. Without this the
        // glass renders colourless, which is indistinguishable from white plastic.
        attenuationColor: '#5fc4e6',
        attenuationDistance: 1.3,
        dispersion: 2.4,
        microVariation: 0.15,
        microScale: 9,
      },
    },
    black: {
      color: '#2a0522',
      emissive: '#b0146f',
      emissiveIntensity: 0.07,
      roughness: 0.16,
      metalness: 0.05,
      opacity: 1,
      rim: 0.3,
      rimColor: '#ff86e6',
      finish: {
        clearcoat: 1,
        clearcoatRoughness: 0.06,
        envMapIntensity: 2,
        transmission: 0.52,
        thickness: 1.6,
        ior: 1.55,
        attenuationColor: '#7d0f5e',
        attenuationDistance: 0.6,
        dispersion: 1.8,
        microVariation: 0.12,
        microScale: 9,
      },
    },
    outline: false,
    outlineColor: '#000000',
    outlineScale: 1,
  },

  highlights: {
    selected: '#ffffff',
    legalMove: '#00ffc8',
    legalCapture: '#ff3d7f',
    lastMove: '#a855ff',
    check: '#ff2f4f',
    hover: '#8ff5ff',
    premove: '#ffd400',
    intensity: 1.5,
  },

  ui: {
    className: 'map-apartment',
    accent: '#00e5ff',
    accentSoft: 'rgba(0, 229, 255, 0.14)',
    surface: 'rgba(10, 8, 22, 0.82)',
    surfaceRaised: 'rgba(18, 14, 36, 0.92)',
    text: '#e6f7ff',
    textMuted: '#8ba2ba',
    border: 'rgba(0, 229, 255, 0.26)',
    displayFont: 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace',
    bodyFont: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    panelStyle: 'neon',
  },

  audio: { themeId: 'apartment', ambienceLabel: 'City rain', musicGain: 0.42 },

  camera: {
    /**
     * Inside the room, looking across the board and out through the glass.
     *
     * The target sits on the near half of the board, not past its far edge:
     * the board turns so your own pieces are always nearest, and those are
     * the ones you are picking up, so they belong in the middle of the frame
     * rather than crushed against the bottom of it.
     */
    position: [0, 6.4, 13.6],
    target: [0, 0.35, 0.8],
    minPolarAngle: 0.32,
    maxPolarAngle: 1.34,
    minDistance: 7,
    maxDistance: 22,
    fov: 46,
    tournament: [0, 9.4, 12.4],
  },

  fog: { color: '#0b0818', near: 55, far: 330 },
  exposure: 1.15,
  ambient: { color: '#4a2f7a', intensity: 0.16 },

  /**
   * Neon noir: the signs and the cove strips bloom, the shadows go cyan and
   * the highlights go warm, and a little grain and lens fringing keep it from
   * looking like clean computer graphics.
   */
  grade: {
    /**
     * The threshold is above 1 on purpose. Bloom runs before tone mapping,
     * where the neon and the cove strips are far brighter than white, so a
     * threshold below 1 catches the entire image and fogs it out.
     */
    bloom: { strength: 0.26, radius: 0.62, threshold: 1.15 },
    contrast: 1.1,
    saturation: 1.16,
    shadowTint: '#2e5f8c',
    highlightTint: '#ffd9c2',
    tintStrength: 0.1,
    vignette: 0.42,
    vignetteSoftness: 0.42,
    grain: 0.045,
    aberration: 0.35,
    posterize: 0,
  },
};
