import {
  emptyLayout,
  type DetailLevel,
  type ModelPack,
  type PlacedProp,
  type SceneLayout,
  type ThemeId,
  type Vec3,
} from '@gambit3d/shared';

/**
 * The built-in layout for each map.
 *
 * These are the placements the maps shipped with, expressed as data. A map
 * loads `/layouts/<theme>.json` if one exists and falls back to this, so the
 * game still looks right with an empty `public/layouts` folder and a bad save
 * can always be undone by deleting the file.
 *
 * The scattered props (towers, signage, station hardware) are generated from a
 * fixed seed, so this file stays short and every load produces the same city.
 * Baking them into a layout also makes each one individually editable, which
 * placing them in a loop never allowed.
 */

const NEON = ['#00e5ff', '#ff2fd0', '#a855ff', '#22d3ee', '#f472ff', '#ffd166'] as const;

/** Deterministic PRNG. Same generator the maps used, so the seeds still mean something. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T;
}

/** Pads an index so ids sort naturally in the outliner. */
function pad(index: number): string {
  return String(index).padStart(2, '0');
}

interface PropSeed {
  id: string;
  pack: ModelPack;
  node: string;
  group: string;
  position: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  fitHeight?: number | null;
  baseScale?: number;
  ground?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  minDetail?: DetailLevel;
  label?: string;
  material?: PlacedProp['material'];
  animation?: PlacedProp['animation'];
}

/** Fills in the defaults so the generators below stay readable. */
function prop(seed: PropSeed): PlacedProp {
  return {
    id: seed.id,
    ...(seed.label ? { label: seed.label } : {}),
    pack: seed.pack,
    node: seed.node,
    group: seed.group,
    position: seed.position,
    rotation: seed.rotation ?? [0, 0, 0],
    scale: seed.scale ?? [1, 1, 1],
    fitHeight: seed.fitHeight ?? null,
    baseScale: seed.baseScale ?? 1,
    ground: seed.ground ?? true,
    castShadow: seed.castShadow ?? true,
    receiveShadow: seed.receiveShadow ?? true,
    minDetail: seed.minDetail ?? 'minimal',
    visible: true,
    locked: false,
    ...(seed.material ? { material: seed.material } : {}),
    ...(seed.animation ? { animation: seed.animation } : {}),
  };
}

/** Floor level in both rooms. */
const FLOOR_Y = -0.9;

// ---------------------------------------------------------------------------
// Neon City Apartment
// ---------------------------------------------------------------------------

const TOWER_NODES = ['towerLarge', 'towerMedium', 'towerSmall'] as const;

/**
 * The city beyond the glass.
 *
 * Towers keep a wide corridor clear straight ahead: one is ~20 units across
 * before scaling, so anything nearer than the clearance fills the window and
 * blanks out the whole view. The detail tags reproduce the old quality tiers -
 * 8 towers on minimal, 18 on standard, 30 on rich.
 */
function cityTowers(): PlacedProp[] {
  const random = makeRandom(20260819);
  const out: PlacedProp[] = [];

  for (let i = 0; i < 30; i += 1) {
    const depth = 55 + random() * 150;
    const side = random() < 0.5 ? -1 : 1;
    const clearance = 15 + depth * 0.13;
    const x = side * (clearance + random() * (30 + depth * 0.32));
    const baseScale = 1.8 + random() * 1.6 + depth * 0.008;
    const node = pick(random, TOWER_NODES);
    const rotationY = random() * Math.PI * 2;
    const tint = pick(random, NEON);

    out.push(
      prop({
        id: `apt-tower-${pad(i)}`,
        pack: 'city-buildings',
        node,
        group: 'City',
        position: [round(x), FLOOR_Y, round(-depth)],
        rotation: [0, round(rotationY), 0],
        baseScale: round(baseScale),
        castShadow: false,
        receiveShadow: false,
        minDetail: i < 8 ? 'minimal' : i < 18 ? 'standard' : 'rich',
        material: {
          // Night grade: dark facades so the baked lit-window textures carry
          // the light, plus a faint neon bounce off the fabric.
          colorScale: 0.3,
          emissive: tint,
          emissiveIntensity: 0.09,
          roughness: 0.95,
          metalness: 0.05,
          envMapIntensity: 0.35,
        },
      }),
    );
  }

  // A low band of distant towers across the centre, far enough back that they
  // read as skyline rather than obstruction.
  const bandCount = 11;
  for (let i = 0; i < bandCount; i += 1) {
    const z = -(105 + random() * 150);
    const node = pick(random, TOWER_NODES);
    const x = (-1 + (i / (bandCount - 1)) * 2) * 110 + (random() - 0.5) * 34;
    const rotationY = random() * Math.PI * 2;
    const baseScale = 1.9 + random() * 1.5;
    const tint = pick(random, NEON);

    out.push(
      prop({
        id: `apt-band-${pad(i)}`,
        pack: 'city-buildings',
        node,
        group: 'City',
        position: [round(x), FLOOR_Y, round(z)],
        rotation: [0, round(rotationY), 0],
        baseScale: round(baseScale),
        castShadow: false,
        receiveShadow: false,
        minDetail: i < 4 ? 'minimal' : 'standard',
        material: {
          colorScale: 0.3,
          emissive: tint,
          emissiveIntensity: 0.09,
          roughness: 0.95,
          metalness: 0.05,
          envMapIntensity: 0.35,
        },
      }),
    );
  }

  // Far towers first, so the outliner reads back-to-front like the city does.
  return out.sort((a, b) => a.position[2] - b.position[2]);
}

const SIGN_NODES = ['sign1', 'sign2', 'sign3', 'sign4', 'signSmall1', 'signSmall2', 'tv1', 'tv2'] as const;
const CLUTTER_NODES = ['ac', 'acStacked', 'antenna1', 'antenna2', 'pipe', 'support', 'streetLight'] as const;

/** Signage hanging off the neighbouring blocks, and clutter on the near ledge. */
function cityDressing(): PlacedProp[] {
  const random = makeRandom(4242);
  const out: PlacedProp[] = [];

  for (let i = 0; i < 16; i += 1) {
    const node = pick(random, SIGN_NODES);
    const tint = pick(random, NEON);
    const baseScale = 1.4 + random() * 2.6;
    // Roughly a third of the signs have a failing tube; the rest breathe.
    const rate = random() < 0.3 ? 0.6 + random() * 1.4 : 0;
    const phase = random() * 6.28;
    const side = random() < 0.5 ? -1 : 1;
    const x = side * (14 + random() * 20);
    const y = 0.5 + random() * 11;
    const z = -16 - random() * 50;
    const rotationY = -side * (0.4 + random() * 0.5);

    out.push(
      prop({
        id: `apt-sign-${pad(i)}`,
        pack: 'city-props',
        node,
        group: 'Signage',
        position: [round(x), round(y), round(z)],
        rotation: [0, round(rotationY), 0],
        baseScale: round(baseScale),
        ground: false,
        castShadow: false,
        receiveShadow: false,
        minDetail: i < 9 ? 'standard' : 'rich',
        material: {
          emissive: tint,
          emissiveIntensity: 1.6,
          toneMapped: false,
        },
        animation: { kind: 'flicker', rate: round(rate), phase: round(phase) },
      }),
    );
  }

  for (let i = 0; i < 12; i += 1) {
    const node = pick(random, CLUTTER_NODES);
    const baseScale = 1.2 + random() * 1.4;
    const x = -16 + random() * 32;
    const z = -12.4 - random() * 7;
    const rotationY = random() * Math.PI * 2;

    out.push(
      prop({
        id: `apt-clutter-${pad(i)}`,
        pack: 'city-props',
        node,
        group: 'Rooftop',
        // Sitting on the ledge just outside the glass.
        position: [round(x), -1.6, round(z)],
        rotation: [0, round(rotationY), 0],
        baseScale: round(baseScale),
        castShadow: false,
        receiveShadow: false,
        minDetail: i < 6 ? 'standard' : 'rich',
        material: { colorScale: 0.5 },
      }),
    );
  }

  return out;
}

/** Furniture, placed around the edges so nothing crowds the board or the view. */
function apartmentFurniture(): PlacedProp[] {
  const items: {
    node: string;
    position: Vec3;
    rotationY: number;
    height: number;
    minDetail?: DetailLevel;
  }[] = [
    { node: 'sofa', position: [0, FLOOR_Y, 12.5], rotationY: Math.PI, height: 1.5 },
    { node: 'lowTable', position: [7.6, FLOOR_Y, 10.8], rotationY: 0.3, height: 0.55, minDetail: 'standard' },
    { node: 'armchair', position: [-9.5, FLOOR_Y, 10.2], rotationY: 0.9, height: 1.4, minDetail: 'standard' },
    { node: 'bookcase', position: [-15.2, FLOOR_Y, 1.5], rotationY: Math.PI / 2, height: 2.6 },
    { node: 'shelf', position: [-15.2, FLOOR_Y, 6.0], rotationY: Math.PI / 2, height: 2.2, minDetail: 'standard' },
    { node: 'desk', position: [15.0, FLOOR_Y, 2.5], rotationY: -Math.PI / 2, height: 1.0 },
    { node: 'chair', position: [12.8, FLOOR_Y, 2.5], rotationY: -Math.PI / 2, height: 1.1, minDetail: 'standard' },
    { node: 'sideTable', position: [-6.5, FLOOR_Y, 13.0], rotationY: 0, height: 0.7, minDetail: 'standard' },
    { node: 'stool', position: [6.2, FLOOR_Y, -7.5], rotationY: 0.4, height: 0.6, minDetail: 'standard' },
  ];

  return items.map((item, i) =>
    prop({
      id: `apt-furn-${pad(i)}`,
      pack: 'apartment-furniture',
      node: item.node,
      group: 'Furniture',
      position: item.position,
      rotation: [0, round(item.rotationY), 0],
      fitHeight: item.height,
      ...(item.minDetail ? { minDetail: item.minDetail } : {}),
      material: {
        // Warm the furniture slightly against the cold city light.
        tint: '#3a3340',
        tintMix: 0.25,
        roughnessAdd: 0.1,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Orbital Station
// ---------------------------------------------------------------------------

const HARDWARE_NODES = ['support', 'connector', 'moduleLong', 'dome'] as const;

/** Planets and station hardware drifting past the viewport. */
function spaceScenery(): PlacedProp[] {
  const out: PlacedProp[] = [
    prop({
      id: 'sta-planet-a',
      label: 'Planet',
      pack: 'space-scenery',
      node: 'planetA',
      group: 'Space',
      position: [-42, -46, -140],
      baseScale: 34,
      ground: false,
      castShadow: false,
      receiveShadow: false,
      material: { emissive: '#1d2a55', emissiveIntensity: 0.28, roughness: 0.95, metalness: 0 },
      animation: { kind: 'spin', speed: 0.006, phase: 0 },
    }),
    prop({
      id: 'sta-planet-b',
      label: 'Moon',
      pack: 'space-scenery',
      node: 'planetB',
      group: 'Space',
      position: [56, 28, -190],
      baseScale: 9,
      ground: false,
      castShadow: false,
      receiveShadow: false,
      material: { emissive: '#3a2f55', emissiveIntensity: 0.2 },
      animation: { kind: 'spin', speed: -0.004, phase: 1.7 },
    }),
    prop({
      id: 'sta-planet-c',
      label: 'Far world',
      pack: 'space-scenery',
      node: 'planetC',
      group: 'Space',
      position: [-70, 34, -230],
      baseScale: 5,
      ground: false,
      castShadow: false,
      receiveShadow: false,
      minDetail: 'rich',
    }),
  ];

  // Structure just outside the glass, so the room reads as part of something
  // larger rather than a box floating in the void.
  const random = makeRandom(99887);
  for (let i = 0; i < 10; i += 1) {
    const node = pick(random, HARDWARE_NODES);
    const baseScale = 1.6 + random() * 3.4;
    const side = random() < 0.5 ? -1 : 1;
    const x = side * (16 + random() * 22);
    const y = -8 + random() * 20;
    const z = -18 - random() * 40;
    const rotation: Vec3 = [round(random() * 0.6), round(random() * Math.PI * 2), round(random() * 0.4)];

    out.push(
      prop({
        id: `sta-hw-${pad(i)}`,
        pack: 'space-scenery',
        node,
        group: 'Structure',
        position: [round(x), round(y), round(z)],
        rotation,
        baseScale: round(baseScale),
        ground: false,
        castShadow: false,
        receiveShadow: false,
        minDetail: i < 2 ? 'minimal' : i < 5 ? 'standard' : 'rich',
        material: { tint: '#9aa6c4', tintMix: 0.4, metalness: 0.85, roughness: 0.35 },
      }),
    );
  }

  return out;
}

/** Consoles, crates and pods lining the observation room. */
function stationFittings(): PlacedProp[] {
  const items: {
    node: string;
    position: Vec3;
    rotationY: number;
    height: number;
    minDetail?: DetailLevel;
  }[] = [
    { node: 'computer', position: [-14.2, FLOOR_Y, -2.0], rotationY: Math.PI / 2, height: 2.1 },
    { node: 'computer', position: [-14.2, FLOOR_Y, 2.4], rotationY: Math.PI / 2, height: 2.1, minDetail: 'standard' },
    { node: 'computerSmall', position: [14.2, FLOOR_Y, -2.4], rotationY: -Math.PI / 2, height: 1.4 },
    { node: 'shelfTall', position: [14.2, FLOOR_Y, 4.4], rotationY: -Math.PI / 2, height: 2.6, minDetail: 'standard' },
    { node: 'shelf', position: [-14.0, FLOOR_Y, 8.2], rotationY: Math.PI / 2, height: 1.8, minDetail: 'standard' },
    { node: 'crate', position: [9.6, FLOOR_Y, 12.4], rotationY: 0.4, height: 1.0 },
    { node: 'crateLong', position: [-9.2, FLOOR_Y, 12.8], rotationY: -0.25, height: 0.9, minDetail: 'standard' },
    { node: 'pod', position: [6.4, FLOOR_Y, -9.6], rotationY: 0.15, height: 2.2 },
    { node: 'pod', position: [-6.4, FLOOR_Y, -9.6], rotationY: -0.15, height: 2.2, minDetail: 'standard' },
    { node: 'vesselTall', position: [12.2, FLOOR_Y, 10.0], rotationY: 0, height: 1.6, minDetail: 'standard' },
    { node: 'containerFull', position: [-12.0, FLOOR_Y, -7.6], rotationY: 0.5, height: 1.2, minDetail: 'standard' },
    { node: 'column', position: [-14.6, FLOOR_Y, -10.4], rotationY: 0, height: 6.6 },
    { node: 'column', position: [14.6, FLOOR_Y, -10.4], rotationY: 0, height: 6.6 },
    { node: 'columnSlim', position: [-14.6, FLOOR_Y, 13.4], rotationY: 0, height: 6.6, minDetail: 'standard' },
    { node: 'columnSlim', position: [14.6, FLOOR_Y, 13.4], rotationY: 0, height: 6.6, minDetail: 'standard' },
    { node: 'pipes', position: [0, 5.6, 15.0], rotationY: 0, height: 0.9, minDetail: 'standard' },
  ];

  return items.map((item, i) =>
    prop({
      id: `sta-fit-${pad(i)}`,
      pack: 'station-props',
      node: item.node,
      group: 'Fittings',
      position: item.position,
      rotation: [0, round(item.rotationY), 0],
      fitHeight: item.height,
      ...(item.minDetail ? { minDetail: item.minDetail } : {}),
      material: {
        tint: '#8e9ab8',
        tintMix: 0.28,
        metalnessAdd: 0.3,
        roughnessAdd: -0.1,
      },
    }),
  );
}

// ---------------------------------------------------------------------------

/** Trims float noise so saved layouts diff cleanly. */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

const BUILDERS: Record<ThemeId, () => PlacedProp[]> = {
  apartment: () => [...cityTowers(), ...cityDressing(), ...apartmentFurniture()],
  station: () => [...spaceScenery(), ...stationFittings()],
};

/** A fresh copy of a map's built-in layout. Never shared - callers mutate it. */
export function defaultLayout(theme: ThemeId): SceneLayout {
  const build = BUILDERS[theme];
  if (!build) return emptyLayout(theme);
  return { version: 1, theme, props: build() };
}

/** Group names a map uses, in the order the outliner should show them. */
export const GROUP_ORDER: Record<ThemeId, string[]> = {
  apartment: ['Furniture', 'Rooftop', 'Signage', 'City'],
  station: ['Fittings', 'Structure', 'Space'],
};
