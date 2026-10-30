import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Environment as DreiEnvironment } from '@react-three/drei';
import { textureUrl } from '../assets.js';
import { PropsLayer } from '../layout/PropsLayer.js';
import { preloadPacks } from '../models.js';
import { BoardPlinth, RoomShell } from './RoomShell.js';
import type { QualityBudget } from '../../hooks/useSettings.js';
import type { EnvironmentProps, ThemeModule } from './types.js';

/**
 * Orbital Station.
 *
 * An observation room aboard a station in high orbit. Same interior grammar as
 * the apartment - a room with one glazed wall - but the wall opens onto space
 * rather than a city, and the room is dressed with sci-fi hardware.
 *
 * The sky is ESO/S. Brunier's Milky Way panorama, used under CC BY 4.0; the
 * credit appears in the map info panel and on the Credits screen. If the plate
 * is missing, a procedural starfield takes its place.
 */

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

/**
 * Loads the sky plate once, for the dome and for reflections.
 *
 * Without an environment map a polished or metallic surface has nothing to
 * mirror and renders nearly black, which is what made the pieces here look
 * like painted plastic.
 */
function useSkyTexture(quality: QualityBudget): THREE.Texture | null {
  const url = quality.envMapSize <= 256 ? textureUrl('milkyway-lod') : textureUrl('milkyway-4k');
  const [map, setMap] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (texture) => {
        if (cancelled) {
          texture.dispose();
          return;
        }
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        setMap(texture);
      },
      undefined,
      // A missing or corrupt plate must not take the scene down.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  return map;
}

function SkyDome({ map }: { map: THREE.Texture | null }): JSX.Element {
  const fallback = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vDir;
          float hash(vec3 p) {
            p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
            p *= 17.0;
            return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
          }
          float stars(vec3 d, float density, float sharp) {
            vec3 p = d * density;
            vec3 i = floor(p);
            float h = hash(i);
            if (h < 0.985) return 0.0;
            float dist = length(fract(p) - 0.5);
            return smoothstep(sharp, 0.0, dist) * (0.4 + hash(i + 7.0) * 0.6);
          }
          void main() {
            vec3 d = normalize(vDir);
            vec3 col = vec3(0.012, 0.016, 0.045);
            col += vec3(0.10, 0.09, 0.20) * exp(-abs(d.y) * 4.0) * 0.7;
            col += vec3(0.28, 0.12, 0.42) * pow(max(0.0, dot(d, normalize(vec3(0.6, 0.15, -0.7)))), 6.0) * 0.5;
            col += vec3(0.10, 0.24, 0.46) * pow(max(0.0, dot(d, normalize(vec3(-0.7, -0.1, 0.5)))), 8.0) * 0.45;
            col += vec3(0.85, 0.88, 1.0) * (stars(d, 220.0, 0.30) + stars(d, 90.0, 0.22) * 1.4);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    [],
  );

  const photo = useMemo(
    () => (map ? new THREE.MeshBasicMaterial({ map, side: THREE.BackSide, depthWrite: false, toneMapped: false }) : null),
    [map],
  );

  useEffect(
    () => () => {
      fallback.dispose();
      photo?.dispose();
    },
    [fallback, photo],
  );

  return (
    <mesh material={photo ?? fallback} frustumCulled={false} renderOrder={-1000}>
      <sphereGeometry args={[420, 48, 32]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Beyond the viewport
// ---------------------------------------------------------------------------

/** Motes drifting upward in low gravity inside the room. */
function LowGravityMotes({ quality, reducedMotion }: EnvironmentProps): JSX.Element | null {
  const count = Math.round(380 * quality.particleScale);
  const points = useRef<THREE.Points>(null);

  const { geometry, drift } = useMemo(() => {
    const positions = new Float32Array(Math.max(1, count) * 3);
    const d = new Float32Array(Math.max(1, count) * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 15;
      positions[i * 3 + 1] = Math.random() * 5.5 - 0.6;
      positions[i * 3 + 2] = -6 + (Math.random() - 0.5) * 15;
      d[i * 3] = (Math.random() - 0.5) * 0.1;
      d[i * 3 + 1] = 0.1 + Math.random() * 0.2;
      d[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return { geometry: geo, drift: d };
  }, [count]);

  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: '#cfd8ff',
        size: 0.04,
        transparent: true,
        opacity: 0.55,
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
      const b = i * 3;
      array[b] = (array[b] ?? 0) + (drift[b] ?? 0) * step;
      array[b + 1] = (array[b + 1] ?? 0) + (drift[b + 1] ?? 0) * step;
      array[b + 2] = (array[b + 2] ?? 0) + (drift[b + 2] ?? 0) * step;
      if ((array[b + 1] ?? 0) > 6) {
        array[b] = (Math.random() - 0.5) * 15;
        array[b + 1] = -0.6;
        array[b + 2] = -6 + (Math.random() - 0.5) * 15;
      }
    }
    attr.needsUpdate = true;
  });

  if (count === 0) return null;
  return <points ref={points} geometry={geometry} material={material} frustumCulled={false} />;
}

// ---------------------------------------------------------------------------

function StationEnvironment(props: EnvironmentProps): JSX.Element {
  const { quality, reducedMotion, tension } = props;
  const accent = useRef<THREE.PointLight>(null);
  const sky = useSkyTexture(quality);

  useEffect(() => {
    preloadPacks(['station-props', 'space-scenery']);
  }, []);

  useFrame((state) => {
    if (!accent.current) return;
    const t = state.clock.elapsedTime;
    const base = reducedMotion ? 340 : 340 + Math.sin(t * 0.5) * 40;
    accent.current.intensity = base + tension * 240;
  });

  return (
    <>
      <SkyDome map={sky} />
      {/* The same plate again, as the environment polished surfaces reflect. */}
      {sky && <DreiEnvironment map={sky} environmentIntensity={0.55} />}

      <ambientLight intensity={0.6} color="#8b96d8" />
      <hemisphereLight args={['#9fb0f0', '#1a1d38', 1.1]} />

      {/* A distant star doing the hard lighting, plus interior fill. */}
      <directionalLight
        position={[16, 12, -22]}
        intensity={2.6}
        color="#eaf1ff"
        castShadow={quality.shadows}
        shadow-mapSize-width={quality.shadowMapSize}
        shadow-mapSize-height={quality.shadowMapSize}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
        shadow-bias={-0.0009}
      />
      <pointLight ref={accent} position={[-5.5, 5.0, 5.5]} color="#a99bff" intensity={340} distance={40} decay={2} />
      <pointLight position={[6.5, 4.6, -4.5]} color="#6fd8ff" intensity={280} distance={38} decay={2} />

      <RoomShell
        quality={quality}
        frontDepth={12}
        backDepth={19}
        halfWidth={16}
        height={8.5}
        floor={{
          color: '#2a3145',
          roughness: 0.38,
          metalness: 0.75,
          texture: 'metal',
          textureMix: 0.45,
          repeat: 4,
        }}
        wall={{ color: '#3d465f', roughness: 0.62, metalness: 0.45, texture: 'metal', textureMix: 0.3, repeat: 2.5 }}
        ceiling={{ color: '#2b3149', roughness: 0.6, metalness: 0.5 }}
        coveColor="#8fb4ff"
        coveIntensity={560}
        frameColor="#aab5cc"
        frameMetalness={0.95}
        frameRoughness={0.28}
        panes={7}
        glassColor="#bcd8ff"
        glassOpacity={0.05}
      />

      {/* Planets, station structure and interior fittings all come from the layout. */}
      <PropsLayer theme="station" quality={quality} reducedMotion={reducedMotion} />
      <LowGravityMotes {...props} />

      <BoardPlinth
        quality={quality}
        color="#59637d"
        metalness={0.92}
        roughness={0.3}
        emissive="#141a33"
        emissiveIntensity={0.35}
        glowColor="#8fb4ff"
      />
    </>
  );
}

export const stationTheme: ThemeModule = {
  id: 'station',
  name: 'Orbital Station',
  tagline: 'A quiet observation deck aboard a station in high orbit.',
  description:
    'Energy pieces on a brushed-metal board, in an observation room aboard an orbital station. The viewport looks out on a planet, drifting hardware and the Milky Way.',
  attribution: [
    'Sky: "The Milky Way panorama" — ESO/S. Brunier (CC BY 4.0)',
    'Planets and station hardware: Quaternius "Ultimate Space Kit" (CC0)',
    'Interior props: Quaternius "Ultimate Modular Sci-Fi Pack" (CC0)',
    'Music: "Deep Space Array" by Tozan (CC0)',
  ],

  loadingBackground: '#05061a',
  loadingAccent: '#a99bff',

  Environment: StationEnvironment,

  board: {
    lightSquare: '#c3cee6',
    darkSquare: '#1b2340',
    lightEmissive: '#26365e',
    darkEmissive: '#3a2a6e',
    lightEmissiveIntensity: 0.1,
    darkEmissiveIntensity: 0.2,
    roughness: 0.3,
    metalness: 0.78,
    frameColor: '#8b97ad',
    frameRoughness: 0.32,
    frameMetalness: 0.95,
    surfaceTexture: 'metal',
    textureMix: 0.38,
    gridLineColor: '#8fb4ff',
    gridLineOpacity: 0.38,
  },

  pieces: {
    style: 'energy',
    set: 'classic',
    white: {
      color: '#e8eefa',
      emissive: '#2c5b96',
      emissiveIntensity: 0.04,
      roughness: 0.21,
      metalness: 0.1,
      opacity: 1,
      rim: 0.16,
      rimColor: '#e8f2ff',
      finish: {
        clearcoat: 0.95,
        clearcoatRoughness: 0.09,
        envMapIntensity: 1.6,
        sheen: 0.55,
        sheenColor: '#cfe2ff',
        sheenRoughness: 0.35,
        // Glaze is never perfectly even, and the unevenness is what makes it
        // read as fired ceramic rather than moulded.
        microVariation: 0.16,
        microScale: 7,
        iridescence: 0.12,
      },
    },
    black: {
      color: '#191340',
      emissive: '#3b1f9c',
      emissiveIntensity: 0.09,
      roughness: 0.24,
      metalness: 0.72,
      opacity: 1,
      rim: 0.28,
      rimColor: '#b39bff',
      finish: {
        clearcoat: 0.8,
        clearcoatRoughness: 0.14,
        envMapIntensity: 1.9,
        sheen: 0.2,
        microVariation: 0.2,
        microScale: 6,
        iridescence: 0.18,
        iridescenceIOR: 1.6,
      },
    },
    outline: false,
    outlineColor: '#000000',
    outlineScale: 1,
  },

  highlights: {
    selected: '#ffffff',
    legalMove: '#7ce8d0',
    legalCapture: '#ff8a9e',
    lastMove: '#a99bff',
    check: '#ff5f7a',
    hover: '#d8ecff',
    premove: '#ffd97a',
    intensity: 1.25,
  },

  ui: {
    className: 'map-station',
    accent: '#a99bff',
    accentSoft: 'rgba(169, 155, 255, 0.15)',
    surface: 'rgba(10, 12, 32, 0.82)',
    surfaceRaised: 'rgba(18, 22, 48, 0.92)',
    text: '#e8ecff',
    textMuted: '#8b93bd',
    border: 'rgba(169, 155, 255, 0.26)',
    displayFont: '"Avenir Next", "Segoe UI", system-ui, sans-serif',
    bodyFont: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    panelStyle: 'glass',
  },

  audio: { themeId: 'station', ambienceLabel: 'Station hum', musicGain: 0.45 },

  camera: {
    // Same framing rule as the apartment: centred on the near half of the
    // board, which is always the side of whoever is to play.
    position: [0, 6.5, 13.8],
    target: [0, 0.35, 0.8],
    minPolarAngle: 0.3,
    maxPolarAngle: 1.34,
    minDistance: 7,
    maxDistance: 22,
    fov: 45,
    tournament: [0, 9.6, 12.6],
  },

  fog: null,
  exposure: 1.02,
  ambient: { color: '#7b86c8', intensity: 0.2 },

  /**
   * Clinical: a tight bloom on the specular hits only, cool shadows against
   * clean white highlights, and almost no grain. The opposite of the
   * apartment on purpose - the two maps should not be mistakable.
   */
  grade: {
    bloom: { strength: 0.18, radius: 0.45, threshold: 1.3 },
    contrast: 1.14,
    saturation: 0.94,
    shadowTint: '#4d6ea8',
    highlightTint: '#ffffff',
    tintStrength: 0.12,
    vignette: 0.3,
    vignetteSoftness: 0.55,
    grain: 0.012,
    aberration: 0.15,
    posterize: 0,
  },
};
