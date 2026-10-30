import { z } from 'zod';
import { THEME_IDS, type ThemeId } from './types.js';

/**
 * Scene layouts: where every environment model sits in a map.
 *
 * The maps used to hard-code their prop placement in the render code, which
 * meant the only way to nudge a sofa was to edit TypeScript and rebuild. A
 * layout is that same information as data, so the in-app level editor can move,
 * rotate and scale anything and write the result back.
 *
 * The shapes live in `shared` because the editor's save endpoint validates
 * exactly what the renderer consumes - no second, drifting definition.
 */

export const DETAIL_LEVELS = ['minimal', 'standard', 'rich'] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** Rank used to decide whether a prop survives the current quality budget. */
export const DETAIL_RANK: Record<DetailLevel, number> = { minimal: 0, standard: 1, rich: 2 };

export const MODEL_PACKS = [
  'apartment-furniture',
  'station-props',
  'city-buildings',
  'city-props',
  'space-scenery',
] as const;
export type ModelPack = (typeof MODEL_PACKS)[number];

export type Vec3 = [number, number, number];

/**
 * Material overrides applied to every material on a prop.
 *
 * Absolute values are applied first, then the `*Add` deltas, then the result is
 * clamped. That ordering is what lets a layout say "whatever this model's
 * roughness is, add a tenth" - which is how the maps were originally written.
 */
export interface PropMaterial {
  /** Multiplies the base colour. Below 1 darkens. */
  colorScale?: number;
  /** Colour to blend the base colour toward. */
  tint?: string;
  /** How far to blend toward `tint`, 0-1. */
  tintMix?: number;
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  roughnessAdd?: number;
  metalness?: number;
  metalnessAdd?: number;
  envMapIntensity?: number;
  /** False makes emissive colours punch past the tone mapper, for neon. */
  toneMapped?: boolean;
}

export type PropAnimation =
  | { kind: 'none' }
  /** Neon sign. `rate` 0 is a slow breathing pulse; above 0 is a failing tube. */
  | { kind: 'flicker'; rate: number; phase: number }
  /** Slow rotation about Y, used for planets drifting past the viewport. */
  | { kind: 'spin'; speed: number; phase: number };

export interface PlacedProp {
  id: string;
  /** Shown in the editor outliner. Falls back to the node name. */
  label?: string;
  pack: ModelPack;
  /** Node name inside the pack, as listed in `models/index.json`. */
  node: string;
  /** Outliner grouping, e.g. 'City', 'Signage', 'Furniture'. */
  group: string;

  position: Vec3;
  /** Euler angles in radians, XYZ order. */
  rotation: Vec3;
  /** Multiplier on top of the base size. */
  scale: Vec3;

  /** Normalise the model to this world height before applying `scale`. */
  fitHeight?: number | null;
  /** Uniform base size used when `fitHeight` is null. */
  baseScale?: number;
  /** Re-origin so the model's base sits at y = 0 and it is centred on X/Z. */
  ground: boolean;

  castShadow: boolean;
  receiveShadow: boolean;

  /** Lowest quality budget this prop appears at. */
  minDetail: DetailLevel;
  visible: boolean;
  /** Locked props cannot be picked or dragged in the editor. */
  locked: boolean;

  material?: PropMaterial;
  animation?: PropAnimation;
}

export interface SceneLayout {
  version: 1;
  theme: ThemeId;
  props: PlacedProp[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Generous but finite: a stray Infinity must never reach a matrix. */
const coord = z.number().finite().min(-5_000).max(5_000);
const angle = z.number().finite().min(-1_000).max(1_000);
const factor = z.number().finite().min(-1_000).max(1_000);
const unit = z.number().finite().min(0).max(1);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u, 'Expected a #rrggbb colour');

const vec3 = (schema: z.ZodNumber) => z.tuple([schema, schema, schema]);

export const propMaterialSchema = z
  .object({
    colorScale: z.number().finite().min(0).max(8).optional(),
    tint: hexColor.optional(),
    tintMix: unit.optional(),
    emissive: hexColor.optional(),
    emissiveIntensity: z.number().finite().min(0).max(20).optional(),
    roughness: unit.optional(),
    roughnessAdd: z.number().finite().min(-1).max(1).optional(),
    metalness: unit.optional(),
    metalnessAdd: z.number().finite().min(-1).max(1).optional(),
    envMapIntensity: z.number().finite().min(0).max(8).optional(),
    toneMapped: z.boolean().optional(),
  })
  .strict();

export const propAnimationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('flicker'),
      rate: z.number().finite().min(0).max(20),
      phase: z.number().finite().min(-100).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('spin'),
      speed: z.number().finite().min(-10).max(10),
      phase: z.number().finite().min(-100).max(100),
    })
    .strict(),
]);

export const placedPropSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    label: z.string().max(60).optional(),
    pack: z.enum(MODEL_PACKS),
    node: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u),
    group: z.string().min(1).max(40),

    position: vec3(coord),
    rotation: vec3(angle),
    scale: vec3(factor),

    fitHeight: z.number().finite().min(0.001).max(2_000).nullable().optional(),
    baseScale: z.number().finite().min(0.0001).max(2_000).optional(),
    ground: z.boolean(),

    castShadow: z.boolean(),
    receiveShadow: z.boolean(),

    minDetail: z.enum(DETAIL_LEVELS),
    visible: z.boolean(),
    locked: z.boolean(),

    material: propMaterialSchema.optional(),
    animation: propAnimationSchema.optional(),
  })
  .strict();

/** Hard cap. Well above what either map uses, low enough to bound a POST body. */
export const MAX_PROPS_PER_LAYOUT = 400;

export const sceneLayoutSchema = z
  .object({
    version: z.literal(1),
    theme: z.enum(THEME_IDS),
    props: z
      .array(placedPropSchema)
      .max(MAX_PROPS_PER_LAYOUT)
      // Duplicate ids would make the editor edit two objects at once.
      .refine((props) => new Set(props.map((p) => p.id)).size === props.length, {
        message: 'Prop ids must be unique',
      }),
  })
  .strict();

export function parseSceneLayout(value: unknown): SceneLayout | null {
  const result = sceneLayoutSchema.safeParse(value);
  return result.success ? (result.data as SceneLayout) : null;
}

/** True when a prop should be drawn at the given environment detail level. */
export function propVisibleAt(prop: PlacedProp, detail: DetailLevel): boolean {
  return prop.visible && DETAIL_RANK[prop.minDetail] <= DETAIL_RANK[detail];
}

export function emptyLayout(theme: ThemeId): SceneLayout {
  return { version: 1, theme, props: [] };
}
