/**
 * Asset manifest access.
 *
 * The manifest is produced by `scripts/build-assets.mjs`. Every lookup can
 * return null, and every caller must have a procedural fallback - the game is
 * fully playable with an empty `public/assets` folder.
 */

export interface AssetManifest {
  generatedAt: string;
  models: { classicPieces: string | null };
  hdri: Record<string, string | null>;
  textures: Record<string, string | null>;
  sfx: Record<string, Record<string, string>>;
  music: Record<string, { url: string; title: string; author: string; license: string }>;
}

const EMPTY: AssetManifest = {
  generatedAt: '',
  models: { classicPieces: null },
  hdri: {},
  textures: {},
  sfx: {},
  music: {},
};

let manifest: AssetManifest = EMPTY;
let loadPromise: Promise<AssetManifest> | null = null;

export function getManifest(): AssetManifest {
  return manifest;
}

export async function loadManifest(): Promise<AssetManifest> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const response = await fetch('/assets/manifest.json', { cache: 'no-cache' });
      if (!response.ok) return EMPTY;
      const data = (await response.json()) as Partial<AssetManifest>;
      manifest = { ...EMPTY, ...data };
      return manifest;
    } catch {
      // No manifest is a supported state, not an error.
      return EMPTY;
    }
  })();
  return loadPromise;
}

export function textureUrl(key: string): string | null {
  return manifest.textures[key] ?? null;
}

/** Resolves the four maps of a PBR texture set, e.g. `pbrUrls('metal')`. */
export interface PbrUrls {
  color: string | null;
  normal: string | null;
  roughness: string | null;
  metalness: string | null;
  ao: string | null;
  /** True when at least the colour map exists. */
  available: boolean;
}

export function pbrUrls(prefix: string): PbrUrls {
  const color = textureUrl(`${prefix}-color`);
  return {
    color,
    normal: textureUrl(`${prefix}-normal`),
    roughness: textureUrl(`${prefix}-rough`),
    metalness: textureUrl(`${prefix}-metalness`),
    ao: textureUrl(`${prefix}-ao`),
    available: color !== null,
  };
}

export function hdriUrl(key: string): string | null {
  return manifest.hdri[key] ?? null;
}

export function modelUrl(): string | null {
  return manifest.models.classicPieces;
}

/**
 * Where a named chess set lives.
 *
 * Extra sets are resolved by convention rather than through the manifest, so
 * a new set needs no rebuild of anything else - and a set that is missing
 * simply fails to load and the classic set takes over.
 */
export function pieceSetUrl(set: string | undefined): string | null {
  if (!set || set === 'classic') return manifest.models.classicPieces;
  return `/assets/models/pieces-${set}.glb`;
}

export function musicFor(themeId: string): AssetManifest['music'][string] | null {
  return manifest.music[themeId] ?? null;
}

export function sfxFor(themeId: string): Record<string, string> {
  return manifest.sfx[themeId] ?? {};
}
