import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ThemeId } from '@gambit3d/shared';

/**
 * Purely local, per-device preferences. None of this affects gameplay or is
 * ever trusted by the server - it controls how this browser renders and sounds.
 */

export type QualityMode = 'low' | 'medium' | 'high' | 'auto';
export type ResolvedQuality = 'low' | 'medium' | 'high';
export type RenderMode = '3d' | '2d';
export type CameraMode = 'orbit' | 'tournament';
export type PieceMarkerStyle = 'dots' | 'rings' | 'squares';

export interface Settings {
  // --- rendering
  quality: QualityMode;
  renderMode: RenderMode;
  cameraMode: CameraMode;
  /** Overrides the room's theme for this device only. null = follow the room. */
  themeOverride: ThemeId | null;

  // --- audio
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  muted: boolean;
  ambienceEnabled: boolean;

  // --- accessibility
  reducedMotion: boolean;
  colorBlindSafe: boolean;
  highContrast: boolean;
  uiScale: number;
  markerStyle: PieceMarkerStyle;
  showCoordinates: boolean;
  showLegalMoves: boolean;

  // --- gameplay comfort
  premovesEnabled: boolean;
  confirmMoves: boolean;
  autoQueen: boolean;
}

export interface SettingsActions {
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  patch(values: Partial<Settings>): void;
  reset(): void;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  renderMode: '3d',
  cameraMode: 'orbit',
  themeOverride: null,

  masterVolume: 0.7,
  sfxVolume: 0.85,
  musicVolume: 0.35,
  muted: false,
  ambienceEnabled: true,

  reducedMotion: false,
  colorBlindSafe: false,
  highContrast: false,
  uiScale: 1,
  markerStyle: 'dots',
  showCoordinates: true,
  showLegalMoves: true,

  premovesEnabled: true,
  confirmMoves: false,
  autoQueen: false,
};

export const useSettings = create<Settings & SettingsActions>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (key, value) => set({ [key]: value } as unknown as Partial<Settings>),
      patch: (values) => set(values as Partial<Settings>),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: 'gambit3d.settings',
      version: 1,
      // Never persist the action functions.
      partialize: (state) => {
        const { set: _set, patch: _patch, reset: _reset, ...rest } = state;
        return rest;
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Device capability detection
// ---------------------------------------------------------------------------

export interface DeviceProfile {
  webglAvailable: boolean;
  webgl2: boolean;
  /** Rough tier from hardware hints; feeds the "auto" quality mode. */
  tier: ResolvedQuality;
  deviceMemoryGb: number | null;
  cores: number;
  maxTextureSize: number;
  isMobile: boolean;
  prefersReducedMotion: boolean;
  renderer: string | null;
}

let cachedProfile: DeviceProfile | null = null;

export function detectDevice(): DeviceProfile {
  if (cachedProfile) return cachedProfile;

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isMobile =
    typeof navigator !== 'undefined' &&
    (/android|iphone|ipad|ipod|mobile/iu.test(navigator.userAgent) ||
      (navigator.maxTouchPoints ?? 0) > 1);

  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;
  const deviceMemoryGb =
    typeof navigator !== 'undefined' && 'deviceMemory' in navigator
      ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null)
      : null;

  let webglAvailable = false;
  let webgl2 = false;
  let maxTextureSize = 2048;
  let renderer: string | null = null;

  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    const gl = gl2 ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (gl) {
      webglAvailable = true;
      webgl2 = Boolean(gl2);
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
      }
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    }
  } catch {
    webglAvailable = false;
  }

  let tier: ResolvedQuality = 'medium';
  if (!webglAvailable) tier = 'low';
  else if (isMobile) tier = maxTextureSize >= 8192 && cores >= 6 ? 'medium' : 'low';
  else if (cores >= 8 && (deviceMemoryGb ?? 8) >= 8 && webgl2 && maxTextureSize >= 8192) tier = 'high';
  else if (cores <= 2 || (deviceMemoryGb ?? 4) <= 2) tier = 'low';

  // Software renderers cannot sustain the effects budget.
  if (renderer && /swiftshader|llvmpipe|software|basic render/iu.test(renderer)) tier = 'low';

  cachedProfile = {
    webglAvailable,
    webgl2,
    tier,
    deviceMemoryGb,
    cores,
    maxTextureSize,
    isMobile,
    prefersReducedMotion,
    renderer,
  };
  return cachedProfile;
}

export function resolveQuality(mode: QualityMode, profile = detectDevice()): ResolvedQuality {
  return mode === 'auto' ? profile.tier : mode;
}

// ---------------------------------------------------------------------------
// Quality budget
// ---------------------------------------------------------------------------

export interface QualityBudget {
  /** Device pixel ratio cap. */
  dpr: [number, number];
  shadows: boolean;
  shadowMapSize: number;
  antialias: boolean;
  /** Multiplier applied to every theme's particle counts. */
  particleScale: number;
  /** Screen-space reflections / reflective floors. */
  reflections: boolean;
  /** Bloom and other post effects. */
  postProcessing: boolean;
  /** Max environment map resolution to request. */
  envMapSize: number;
  /** Extra decorative geometry in the environment. */
  environmentDetail: 'minimal' | 'standard' | 'rich';
  /** Segment counts for lathed piece geometry. */
  pieceSegments: number;
  /** Soft contact shadows under pieces. */
  contactShadows: boolean;
  anisotropy: number;
}

export const QUALITY_BUDGETS: Record<ResolvedQuality, QualityBudget> = {
  low: {
    dpr: [0.75, 1],
    shadows: false,
    shadowMapSize: 512,
    antialias: false,
    particleScale: 0,
    reflections: false,
    postProcessing: false,
    envMapSize: 256,
    environmentDetail: 'minimal',
    pieceSegments: 12,
    contactShadows: false,
    anisotropy: 1,
  },
  medium: {
    dpr: [1, 1.5],
    shadows: true,
    shadowMapSize: 1024,
    antialias: true,
    particleScale: 0.45,
    reflections: false,
    postProcessing: false,
    envMapSize: 512,
    environmentDetail: 'standard',
    pieceSegments: 24,
    contactShadows: true,
    anisotropy: 4,
  },
  high: {
    dpr: [1, 2],
    shadows: true,
    shadowMapSize: 2048,
    antialias: true,
    particleScale: 1,
    reflections: true,
    postProcessing: true,
    envMapSize: 1024,
    environmentDetail: 'rich',
    pieceSegments: 48,
    contactShadows: true,
    anisotropy: 8,
  },
};

export function budgetFor(mode: QualityMode, profile = detectDevice()): QualityBudget {
  return QUALITY_BUDGETS[resolveQuality(mode, profile)];
}

/**
 * True when animation should be suppressed: either the user asked for it in the
 * app, or their operating system says so.
 */
export function shouldReduceMotion(settings: Pick<Settings, 'reducedMotion'>, profile = detectDevice()): boolean {
  return settings.reducedMotion || profile.prefersReducedMotion;
}
