import type { ComponentType } from 'react';
import type { ThemeId } from '@gambit3d/shared';
import type { QualityBudget } from '../../hooks/useSettings.js';
import type { PieceStyle } from '../pieces.js';

/**
 * The contract every map implements.
 *
 * A map is not a colour swap: it supplies its own environment, lighting rig,
 * board materials, piece style, particle system, UI skin and sound palette. The
 * scene composes them; nothing about a specific map leaks into the shared code.
 */

export interface EnvironmentProps {
  quality: QualityBudget;
  reducedMotion: boolean;
  /** Rises to 1 while a game is in check, for maps that react to it. */
  tension: number;
}

export interface BoardMaterialSpec {
  lightSquare: string;
  darkSquare: string;
  /** Emissive tint for the light/dark squares; '#000000' disables it. */
  lightEmissive: string;
  darkEmissive: string;
  lightEmissiveIntensity: number;
  darkEmissiveIntensity: number;
  roughness: number;
  metalness: number;
  /** Frame around the playing surface. */
  frameColor: string;
  frameRoughness: number;
  frameMetalness: number;
  /** Optional texture keys resolved against the asset manifest. */
  surfaceTexture?: 'wood-board' | 'marble' | 'metal' | 'asphalt' | null;
  /** How strongly the texture tints the base square colour, 0-1. */
  textureMix?: number;
  /** Thin emissive seam between squares. */
  gridLineColor?: string;
  gridLineOpacity?: number;
}

/**
 * Surface finish, on top of the base colour.
 *
 * A flat colour with an emissive on it reads as moulded plastic however good
 * the model underneath is. These are the properties that make it read as
 * glass, lacquer, stone or metal instead.
 */
export interface PieceFinish {
  /** Lacquer layer over the surface. 1 is a showroom polish. */
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** How strongly the room shows up in the piece. Needs an environment map. */
  envMapIntensity?: number;
  /** Real refraction. Costly, so it is only applied when reflections are on. */
  transmission?: number;
  /** How deep the material is, for refraction. */
  thickness?: number;
  ior?: number;
  /** Soft off-angle scatter, which is what makes ceramic look like ceramic. */
  sheen?: number;
  sheenColor?: string;
  sheenRoughness?: number;
  /** Strength of the specular highlight for non-metals. */
  specularIntensity?: number;
  /**
   * Colour light picks up passing through the body, and how far it travels
   * before it does. Without absorption, glass renders as milky white - which
   * is exactly what plastic looks like.
   */
  attenuationColor?: string;
  attenuationDistance?: number;
  /** Splits refracted light by wavelength. The thing that reads as crystal. */
  dispersion?: number;
  /** Thin-film interference, for an oil-on-water sheen. */
  iridescence?: number;
  iridescenceIOR?: number;
  /**
   * How much the surface roughness varies across the piece, 0-1.
   *
   * Nothing real is uniformly polished. A perfectly even roughness gives a
   * perfectly even highlight, and an even highlight is the single strongest
   * tell that something was rendered rather than made.
   */
  microVariation?: number;
  /** Size of that variation in world units. Small is fine grain. */
  microScale?: number;
}

export interface PieceSideSpec {
  color: string;
  emissive: string;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
  /** 0-1; below 1 turns on transparency. */
  opacity: number;
  /** Adds a rim/fresnel glow. */
  rim: number;
  rimColor: string;
  /** Physical surface finish. Omitted means a plain standard material. */
  finish?: PieceFinish;
}

export interface PieceMaterialSpec {
  style: PieceStyle;
  /**
   * Which sculpted set to draw, by id. Omitted or
   * 'classic' uses the bundled Staunton set; an id that has not been built
   * falls back to it too.
   */
  set?: string;
  white: PieceSideSpec;
  black: PieceSideSpec;
  /** Draw a dark outline pass behind each piece (cel-shading). */
  outline: boolean;
  outlineColor: string;
  outlineScale: number;
}

export interface HighlightSpec {
  selected: string;
  legalMove: string;
  legalCapture: string;
  lastMove: string;
  check: string;
  hover: string;
  premove: string;
  /** How bright markers glow, scaled by quality. */
  intensity: number;
}

export interface UiSkin {
  /** Applied to <html data-map="..."> so CSS can restyle the whole shell. */
  className: string;
  accent: string;
  accentSoft: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  textMuted: string;
  border: string;
  /** Display font stack for headings. */
  displayFont: string;
  bodyFont: string;
  /** Decorative treatment applied to panels. */
  panelStyle: 'ink' | 'neon' | 'glass';
}

export interface AudioSpec {
  /** Key into the generated asset manifest. */
  themeId: ThemeId;
  /** Label shown next to the ambience toggle. */
  ambienceLabel: string;
  /** Playback gain for the music track, 0-1. */
  musicGain: number;
}

export interface CameraSpec {
  /** Default orbit position, in board units, for a White-side view. */
  position: [number, number, number];
  target: [number, number, number];
  minPolarAngle: number;
  maxPolarAngle: number;
  minDistance: number;
  maxDistance: number;
  fov: number;
  /** Fixed tournament-camera position. */
  tournament: [number, number, number];
}

/**
 * A map's art style: how the finished image is graded.
 *
 * This is what makes two rooms built from the same parts read as different
 * places. It runs after tone mapping, so the numbers mean what they look
 * like, and it is skipped below the top quality tier.
 */
export interface GradeSpec {
  /** Glow on bright areas. Null switches the pass off entirely. */
  bloom: { strength: number; radius: number; threshold: number } | null;
  /** 1 leaves contrast alone; above 1 crushes the ends. */
  contrast: number;
  /** 0 is greyscale, 1 untouched, above 1 pushes colour. */
  saturation: number;
  /** Split toning: one cast in the shadows, another in the highlights. */
  shadowTint: string;
  highlightTint: string;
  tintStrength: number;
  /** Corner darkening, and how far in the falloff starts. */
  vignette: number;
  vignetteSoftness: number;
  /** Animated film grain, heavier in the shadows. Off under reduced motion. */
  grain: number;
  /** Lens colour fringing, growing toward the edges of frame. */
  aberration: number;
  /**
   * Flattens the image into this many bands per channel. 0 is off.
   *
   * Here so a map can be drawn rather than rendered - a cel-shaded look is a
   * low band count with high contrast and no grain - without any new code.
   */
  posterize: number;
}

export interface ThemeModule {
  id: ThemeId;
  name: string;
  tagline: string;
  /** Longer description shown on the map picker card. */
  description: string;
  /** Credits that must be visible in-app for this map's assets. */
  attribution?: string[];

  /** Background colour used before the 3D scene has loaded. */
  loadingBackground: string;
  loadingAccent: string;

  Environment: ComponentType<EnvironmentProps>;
  board: BoardMaterialSpec;
  pieces: PieceMaterialSpec;
  highlights: HighlightSpec;
  ui: UiSkin;
  audio: AudioSpec;
  camera: CameraSpec;

  /** Scene-wide fog. */
  fog: { color: string; near: number; far: number } | null;
  /** Tone mapping exposure. */
  exposure: number;
  /** Ambient light colour + intensity applied on top of the environment map. */
  ambient: { color: string; intensity: number };
  /** How the finished image is graded. Null renders the scene straight. */
  grade: GradeSpec | null;
}

/**
 * Colour-blind-safe overrides.
 *
 * The default palettes distinguish "legal move" from "capture" partly by hue.
 * When the safe palette is on, every marker also differs in lightness and the
 * markers change shape (handled by the renderer), so hue is never load-bearing.
 */
export const COLORBLIND_HIGHLIGHTS: HighlightSpec = {
  selected: '#ffffff',
  legalMove: '#3d9bff', // blue
  legalCapture: '#ffb000', // amber
  lastMove: '#8f6fff', // violet
  check: '#ff4d4d', // red, but paired with a pulsing ring
  hover: '#c9d6e6',
  premove: '#00c2a8', // teal
  intensity: 1.15,
};
