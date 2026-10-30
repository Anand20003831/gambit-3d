#!/usr/bin/env node
/**
 * Asset pipeline.
 *
 * Reads the ORIGINAL downloads (which stay untouched in the downloads folder),
 * optimises them for web delivery, and writes only what the game actually uses
 * into packages/client/public/assets.
 *
 * Everything it produces is derived from a source recorded in ASSET_CREDITS.md.
 * The game runs without any of it - every theme has a procedural fallback - so a
 * missing source folder is a warning, not a build failure.
 *
 * Usage:  node scripts/build-assets.mjs [--force] [--source <dir>]
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { dedup, prune, weld, quantize, textureCompress } from '@gltf-transform/functions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'packages', 'client', 'public', 'assets');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const sourceIdx = args.indexOf('--source');
const SOURCE =
  sourceIdx >= 0 && args[sourceIdx + 1]
    ? path.resolve(args[sourceIdx + 1])
    : process.env.CHESS_MODELS_DIR ?? 'Chess models';

const log = (...m) => console.log('[assets]', ...m);
const warn = (...m) => console.warn('[assets] !', ...m);

let produced = 0;
let skipped = 0;
const missing = [];

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function needsBuild(dest, src) {
  if (FORCE) return true;
  if (!existsSync(dest)) return true;
  try {
    const [d, s] = await Promise.all([fs.stat(dest), fs.stat(src)]);
    return s.mtimeMs > d.mtimeMs;
  } catch {
    return true;
  }
}

function requireSource(p, label) {
  if (existsSync(p)) return true;
  missing.push(`${label} (expected at ${p})`);
  return false;
}

// ---------------------------------------------------------------------------
// 1. Chess pieces: extract one mesh per piece type into a compact GLB
// ---------------------------------------------------------------------------

/**
 * The Poly Haven set places 32 individual nodes on a board. The game only needs
 * six distinct shapes - it instances them itself - so we keep one representative
 * of each, re-origin it, and drop everything else. That takes the bundle from
 * ~19 MB to well under 1 MB of geometry.
 */
const PIECE_SOURCE_NODES = {
  p: 'piece_pawn_white_01',
  n: 'piece_knight_white_01',
  b: 'piece_bishop_white_01',
  r: 'piece_rook_white_01',
  q: 'piece_queen_white',
  k: 'piece_king_white',
};

async function buildPieces() {
  const src = path.join(SOURCE, 'polyhaven', 'chess_set', 'chess_set_2k.gltf');
  if (!requireSource(src, 'Poly Haven chess_set glTF')) return;

  const dest = path.join(OUT, 'models', 'classic-pieces.glb');
  if (!(await needsBuild(dest, src))) {
    skipped += 1;
    log('pieces up to date');
    return;
  }

  await ensureDir(path.dirname(dest));
  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
  const doc = await io.read(src);
  const root = doc.getRoot();

  const wanted = new Map(Object.entries(PIECE_SOURCE_NODES).map(([k, v]) => [v, k]));
  const keep = [];

  for (const node of root.listNodes()) {
    const pieceKey = wanted.get(node.getName());
    if (!pieceKey) continue;
    // Rename to a stable key the renderer looks up, and reset the transform so
    // the mesh sits at the origin ready to be placed on a square.
    node.setName(`piece_${pieceKey}`);
    node.setTranslation([0, 0, 0]);
    node.setRotation([0, 0, 0, 1]);
    node.setScale([1, 1, 1]);
    keep.push(node);
  }

  if (keep.length !== 6) {
    warn(`expected 6 piece nodes, found ${keep.length}: ${keep.map((n) => n.getName()).join(', ')}`);
  }

  // Drop every other node from every scene.
  for (const scene of root.listScenes()) {
    for (const child of scene.listChildren()) {
      if (!keep.includes(child)) scene.removeChild(child);
    }
  }
  for (const node of root.listNodes()) {
    if (!keep.includes(node)) node.dispose();
  }

  await doc.transform(
    dedup(),
    prune({ keepAttributes: false }),
    weld(),
    // 1K textures are plenty for pieces this size on screen.
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 82 }),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
  );

  const glb = await io.writeBinary(doc);
  await fs.writeFile(dest, glb);
  produced += 1;
  log(`pieces -> ${path.relative(REPO, dest)} (${(glb.byteLength / 1024).toFixed(0)} KB, ${keep.length} meshes)`);
}

// ---------------------------------------------------------------------------
// 2. Board textures
// ---------------------------------------------------------------------------

const TEXTURE_JOBS = [
  {
    src: ['ambientcg', 'Marble012', 'Marble012_1K-JPG_Color.jpg'],
    dest: ['textures', 'marble-color.webp'],
    size: 1024,
    quality: 82,
  },
  {
    src: ['ambientcg', 'Marble012', 'Marble012_1K-JPG_NormalGL.jpg'],
    dest: ['textures', 'marble-normal.webp'],
    size: 1024,
    quality: 88,
  },
  {
    src: ['ambientcg', 'Marble012', 'Marble012_1K-JPG_Roughness.jpg'],
    dest: ['textures', 'marble-rough.webp'],
    size: 1024,
    quality: 80,
  },
  {
    src: ['ambientcg', 'MetalPlates006', 'MetalPlates006_1K-JPG_Color.jpg'],
    dest: ['textures', 'metal-color.webp'],
    size: 1024,
    quality: 84,
  },
  {
    src: ['ambientcg', 'MetalPlates006', 'MetalPlates006_1K-JPG_NormalGL.jpg'],
    dest: ['textures', 'metal-normal.webp'],
    size: 1024,
    quality: 90,
  },
  {
    src: ['ambientcg', 'MetalPlates006', 'MetalPlates006_1K-JPG_Roughness.jpg'],
    dest: ['textures', 'metal-rough.webp'],
    size: 1024,
    quality: 82,
  },
  {
    src: ['ambientcg', 'MetalPlates006', 'MetalPlates006_1K-JPG_Metalness.jpg'],
    dest: ['textures', 'metal-metalness.webp'],
    size: 1024,
    quality: 82,
  },
  {
    src: ['ambientcg', 'Asphalt033', 'Asphalt033_1K-JPG_Color.jpg'],
    dest: ['textures', 'asphalt-color.webp'],
    size: 1024,
    quality: 82,
  },
  {
    src: ['ambientcg', 'Asphalt033', 'Asphalt033_1K-JPG_NormalGL.jpg'],
    dest: ['textures', 'asphalt-normal.webp'],
    size: 1024,
    quality: 90,
  },
  {
    src: ['ambientcg', 'Asphalt033', 'Asphalt033_1K-JPG_Roughness.jpg'],
    dest: ['textures', 'asphalt-rough.webp'],
    size: 1024,
    quality: 82,
  },
  {
    src: ['ambientcg', 'Asphalt033', 'Asphalt033_1K-JPG_AmbientOcclusion.jpg'],
    dest: ['textures', 'asphalt-ao.webp'],
    size: 1024,
    quality: 80,
  },
  // Equirectangular Milky Way for the station sky sphere.
  {
    src: ['eso', 'eso0932a_publicationjpg.jpg'],
    dest: ['textures', 'milkyway-4k.webp'],
    size: 4096,
    quality: 80,
    fit: 'inside',
  },
  {
    src: ['eso', 'eso0932a_screen.jpg'],
    dest: ['textures', 'milkyway-lod.webp'],
    size: 1280,
    quality: 72,
    fit: 'inside',
  },
];

async function buildTextures() {
  for (const job of TEXTURE_JOBS) {
    const src = path.join(SOURCE, ...job.src);
    if (!requireSource(src, `texture ${job.src.at(-1)}`)) continue;

    const dest = path.join(OUT, ...job.dest);
    if (!(await needsBuild(dest, src))) {
      skipped += 1;
      continue;
    }
    await ensureDir(path.dirname(dest));

    await sharp(src)
      .resize(job.size, job.fit === 'inside' ? Math.round(job.size / 2) : job.size, {
        fit: job.fit ?? 'cover',
        withoutEnlargement: true,
      })
      .webp({ quality: job.quality, effort: 5 })
      .toFile(dest);

    const { size } = await fs.stat(dest);
    produced += 1;
    log(`texture -> ${job.dest.join('/')} (${(size / 1024).toFixed(0)} KB)`);
  }
}

// ---------------------------------------------------------------------------
// 3. HDRIs (copied as-is; .hdr is already a compact float format)
// ---------------------------------------------------------------------------

const HDRI_JOBS = [
  { src: ['polyhaven', 'hdri', 'rooftop_night_1k.hdr'], dest: ['hdri', 'apartment-night.hdr'] },
];

async function buildHdris() {
  for (const job of HDRI_JOBS) {
    const src = path.join(SOURCE, ...job.src);
    if (!requireSource(src, `HDRI ${job.src.at(-1)}`)) continue;
    const dest = path.join(OUT, ...job.dest);
    if (!(await needsBuild(dest, src))) {
      skipped += 1;
      continue;
    }
    await ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
    const { size } = await fs.stat(dest);
    produced += 1;
    log(`hdri -> ${job.dest.join('/')} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

// ---------------------------------------------------------------------------
// 4. Sound effects: one curated cue per event, per theme
// ---------------------------------------------------------------------------

/**
 * Each theme gets a genuinely different palette, not the same clip re-pitched:
 *  - apartment    switches, glitches and zaps
 *  - station      metal, force fields and station tones
 */
const SOUND_MAP = {
  apartment: {
    move: ['kenney_interface-sounds', 'switch_003.ogg'],
    capture: ['kenney_digital-audio', 'zap1.ogg'],
    castle: ['kenney_digital-audio', 'phaseJump1.ogg'],
    check: ['kenney_digital-audio', 'zapTwoTone.ogg'],
    promote: ['kenney_digital-audio', 'powerUp5.ogg'],
    gameStart: ['kenney_digital-audio', 'powerUp1.ogg'],
    gameEnd: ['kenney_digital-audio', 'phaserDown1.ogg'],
    select: ['kenney_interface-sounds', 'tick_001.ogg'],
    illegal: ['kenney_interface-sounds', 'glitch_004.ogg'],
    lowTime: ['kenney_interface-sounds', 'tick_004.ogg'],
    notify: ['kenney_digital-audio', 'twoTone1.ogg'],
    uiClick: ['kenney_interface-sounds', 'click_002.ogg'],
  },
  station: {
    move: ['kenney_sci-fi-sounds', 'impactMetal_000.ogg'],
    capture: ['kenney_sci-fi-sounds', 'impactMetal_003.ogg'],
    castle: ['kenney_sci-fi-sounds', 'doorOpen_000.ogg'],
    check: ['kenney_sci-fi-sounds', 'computerNoise_002.ogg'],
    promote: ['kenney_sci-fi-sounds', 'forceField_002.ogg'],
    gameStart: ['kenney_sci-fi-sounds', 'spaceEngineSmall_000.ogg'],
    gameEnd: ['kenney_sci-fi-sounds', 'lowFrequency_explosion_000.ogg'],
    select: ['kenney_sci-fi-sounds', 'computerNoise_000.ogg'],
    illegal: ['kenney_interface-sounds', 'error_005.ogg'],
    lowTime: ['kenney_interface-sounds', 'tick_001.ogg'],
    notify: ['kenney_sci-fi-sounds', 'forceField_004.ogg'],
    uiClick: ['kenney_interface-sounds', 'click_004.ogg'],
  },
};
async function findOgg(pack, file) {
  const base = path.join(SOURCE, 'kenney', 'extracted', pack);
  if (!existsSync(base)) return null;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === file.toLowerCase()) return full;
    }
  }
  return null;
}

async function buildSounds() {
  const manifest = {};
  for (const [theme, cues] of Object.entries(SOUND_MAP)) {
    manifest[theme] = {};
    for (const [cue, [pack, file]] of Object.entries(cues)) {
      const src = await findOgg(pack, file);
      if (!src) {
        missing.push(`sound ${theme}/${cue} (${pack}/${file})`);
        continue;
      }
      const rel = ['sfx', theme, `${cue}.ogg`];
      const dest = path.join(OUT, ...rel);
      if (await needsBuild(dest, src)) {
        await ensureDir(path.dirname(dest));
        await fs.copyFile(src, dest);
        produced += 1;
      } else {
        skipped += 1;
      }
      manifest[theme][cue] = `/assets/${rel.join('/')}`;
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// 5. Ambient music, one track per theme
// ---------------------------------------------------------------------------

const MUSIC_JOBS = [
  {
    theme: 'apartment',
    src: ['opengameart', 'robotic_city_v2__section31__CC0.ogg'],
    dest: ['music', 'apartment-ambience.ogg'],
    title: 'Robotic City V2',
    author: 'section31',
  },
  {
    theme: 'station',
    src: ['opengameart', 'deep_space_array__Tozan__CC0.ogg'],
    dest: ['music', 'station-ambience.ogg'],
    title: 'Deep Space Array',
    author: 'Tozan',
  },
];

async function buildMusic() {
  const manifest = {};
  for (const job of MUSIC_JOBS) {
    const src = path.join(SOURCE, ...job.src);
    if (!requireSource(src, `music ${job.title}`)) continue;
    const dest = path.join(OUT, ...job.dest);
    if (await needsBuild(dest, src)) {
      await ensureDir(path.dirname(dest));
      await fs.copyFile(src, dest);
      const { size } = await fs.stat(dest);
      produced += 1;
      log(`music -> ${job.dest.join('/')} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      skipped += 1;
    }
    manifest[job.theme] = {
      url: `/assets/${job.dest.join('/')}`,
      title: job.title,
      author: job.author,
      license: 'CC0 1.0',
    };
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

async function writeManifest(sfx, music) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    note: 'Generated by scripts/build-assets.mjs. Every entry has a procedural fallback in-game.',
    models: {
      classicPieces: existsSync(path.join(OUT, 'models', 'classic-pieces.glb'))
        ? '/assets/models/classic-pieces.glb'
        : null,
    },
    hdri: {
      apartment: existsSync(path.join(OUT, 'hdri', 'apartment-night.hdr')) ? '/assets/hdri/apartment-night.hdr' : null,
      // The station uses the equirectangular Milky Way plate instead.
      station: null,
    },
    textures: Object.fromEntries(
      TEXTURE_JOBS.map((j) => [
        path.basename(j.dest.at(-1), '.webp'),
        existsSync(path.join(OUT, ...j.dest)) ? `/assets/${j.dest.join('/')}` : null,
      ]),
    ),
    sfx,
    music,
  };

  const dest = path.join(OUT, 'manifest.json');
  await ensureDir(OUT);
  await fs.writeFile(dest, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest -> ${path.relative(REPO, dest)}`);
  return manifest;
}

// ---------------------------------------------------------------------------

async function main() {
  log(`source: ${SOURCE}`);
  log(`output: ${path.relative(REPO, OUT)}`);

  if (!existsSync(SOURCE)) {
    warn(`source folder not found. The game will run entirely on procedural assets.`);
    await writeManifest({}, {});
    return;
  }

  await ensureDir(OUT);
  await buildPieces();
  await buildTextures();
  await buildHdris();
  const sfx = await buildSounds();
  const music = await buildMusic();
  await writeManifest(sfx, music);

  log(`done: ${produced} written, ${skipped} up to date`);
  if (missing.length > 0) {
    warn(`${missing.length} source file(s) not found - the game falls back to procedural assets for these:`);
    for (const m of missing.slice(0, 12)) warn(`  - ${m}`);
    if (missing.length > 12) warn(`  ... and ${missing.length - 12} more`);
  }
}

main().catch((error) => {
  console.error('[assets] failed:', error);
  process.exitCode = 1;
});
