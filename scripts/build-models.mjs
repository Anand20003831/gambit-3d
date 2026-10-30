#!/usr/bin/env node
/**
 * Model pipeline.
 *
 * Turns the raw downloaded packs into a handful of optimised GLB bundles, one
 * per logical group, each holding several named nodes. Bundling matters: a map
 * that needs a sofa, a table and a bookcase should cost one request, not three.
 *
 * FBX sources are converted with Blender in headless mode; glTF sources are read
 * directly. Everything is then merged, deduplicated, texture-compressed to WebP
 * and quantised.
 *
 * Usage:
 *   node scripts/build-models.mjs [--force] [--only <groupKey>] [--blender <path>]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit, KHRTextureTransform } from '@gltf-transform/extensions';
import { dedup, mergeDocuments, prune, quantize, textureCompress, unpartition, weld } from '@gltf-transform/functions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'packages', 'client', 'public', 'assets', 'models');
const SOURCE = process.env.CHESS_MODELS_DIR ?? 'Chess models';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const only = args.indexOf('--only') >= 0 ? args[args.indexOf('--only') + 1] : null;
const blenderArg = args.indexOf('--blender') >= 0 ? args[args.indexOf('--blender') + 1] : null;

const log = (...m) => console.log('[models]', ...m);
const warn = (...m) => console.warn('[models] !', ...m);

// ---------------------------------------------------------------------------
// Blender discovery
// ---------------------------------------------------------------------------

function findBlender() {
  if (blenderArg) return blenderArg;
  if (process.env.BLENDER_PATH) return process.env.BLENDER_PATH;

  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\Blender Foundation', 'C:\\Program Files (x86)\\Blender Foundation']) {
      if (!existsSync(base)) continue;
      try {
        // Newest version first, so a machine with several installs picks the latest.
        const versions = readdirSync(base).sort().reverse();
        for (const v of versions) candidates.push(path.join(base, v, 'blender.exe'));
      } catch {
        /* unreadable directory */
      }
    }
  } else {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender');
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const Q = path.join(SOURCE, 'quaternius');
const DOWNTOWN = path.join(SOURCE, 'downtown-city');

/**
 * Each group merges several source models into one GLB. `nodes` maps the name
 * the renderer will look up to the source file.
 */
const GROUPS = [
  {
    key: 'apartment-furniture',
    label: 'Apartment furniture',
    kind: 'fbx',
    dir: path.join(Q, 'furniture'),
    textureSize: 512,
    nodes: {
      sofa: 'Sofa.fbx',
      sofaCorner: 'Sofa2.fbx',
      armchair: 'Sofa_individual.fbx',
      table: 'Table.fbx',
      lowTable: 'Table2.fbx',
      chair: 'Chair.fbx',
      stool: 'Stool.fbx',
      bookcase: 'Bookcase_Books.fbx',
      shelf: 'Bookcase.fbx',
      desk: 'Desk.fbx',
      sideTable: 'NightStand.fbx',
    },
  },
  {
    key: 'station-props',
    label: 'Station interior props',
    kind: 'fbx',
    dir: path.join(Q, 'modular-scifi'),
    textureSize: 512,
    nodes: {
      computer: 'Props_Computer.fbx',
      computerSmall: 'Props_ComputerSmall.fbx',
      shelf: 'Props_Shelf.fbx',
      shelfTall: 'Props_Shelf_Tall.fbx',
      crate: 'Props_Crate.fbx',
      crateLong: 'Props_CrateLong.fbx',
      pod: 'Props_Pod.fbx',
      vessel: 'Props_Vessel.fbx',
      vesselTall: 'Props_Vessel_Tall.fbx',
      base: 'Props_Base.fbx',
      column: 'Column_1.fbx',
      columnSlim: 'Column_Slim.fbx',
      pipes: 'Pipes.fbx',
      containerFull: 'Props_ContainerFull.fbx',
    },
  },
  {
    key: 'city-buildings',
    label: 'City buildings',
    kind: 'gltf',
    dir: DOWNTOWN,
    textureSize: 512,
    nodes: {
      towerLarge: 'Building_Large_2.gltf',
      towerMedium: 'Building_Medium_2_001.gltf',
      towerSmall: 'Building_Small_1.gltf',
    },
  },
  {
    key: 'city-props',
    label: 'City signage and rooftop clutter',
    kind: 'gltf',
    dir: path.join(Q, 'cyberpunk-props'),
    textureSize: 512,
    nodes: {
      sign1: 'Sign_1.gltf',
      sign2: 'Sign_2.gltf',
      sign3: 'Sign_3.gltf',
      sign4: 'Sign_4.gltf',
      signSmall1: 'Sign_Small_1.gltf',
      signSmall2: 'Sign_Small_2.gltf',
      tv1: 'TV_1.gltf',
      tv2: 'TV_2.gltf',
      ac: 'AC.gltf',
      acStacked: 'AC_Stacked.gltf',
      antenna1: 'Antenna_1.gltf',
      antenna2: 'Antenna_2.gltf',
      cable: 'Cable_Long.gltf',
      streetLight: 'Light_Street_1.gltf',
      pipe: 'Pipe_1.gltf',
      support: 'Support.gltf',
    },
  },
  {
    key: 'space-scenery',
    label: 'Planets and station exterior',
    kind: 'gltf',
    dir: path.join(Q, 'space-environment', 'GLTF'),
    textureSize: 512,
    nodes: {
      planetA: 'Planet_3.gltf',
      planetB: 'Planet_7.gltf',
      planetC: 'Planet_10.gltf',
      dome: 'GeodesicDome.gltf',
      support: 'MetalSupport.gltf',
      connector: 'Connector.gltf',
      moduleLong: 'Building_L.gltf',
    },
  },
];

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const io = new NodeIO().registerExtensions([KHRMaterialsUnlit, KHRTextureTransform]);

async function convertFbxGroup(group, blender, tmpDir) {
  const inputs = [];
  const missing = [];
  for (const [, file] of Object.entries(group.nodes)) {
    const full = path.join(group.dir, file);
    if (existsSync(full)) inputs.push(full);
    else missing.push(file);
  }
  if (missing.length > 0) warn(`${group.label}: missing ${missing.join(', ')}`);
  if (inputs.length === 0) return null;

  await fs.mkdir(tmpDir, { recursive: true });
  const result = spawnSync(
    blender,
    ['--background', '--factory-startup', '--python', path.join(__dirname, 'lib', 'fbx_to_glb.py'), '--', '--out', tmpDir, ...inputs],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failures = [...output.matchAll(/CONVERT_FAIL (.+)/g)].map((m) => m[1]);
  for (const f of failures) warn(`blender: ${f}`);
  if (result.status !== 0 && failures.length === 0) {
    warn(`blender exited ${result.status} for ${group.label}`);
    warn(output.split('\n').slice(-8).join('\n'));
  }
  return tmpDir;
}

/**
 * Merges the group's sources into one document, renaming each root node to the
 * key the renderer uses.
 */
async function mergeGroup(group, resolvedFiles) {
  const merged = new Document();
  const scene = merged.createScene('scene');

  for (const [nodeName, sourcePath] of resolvedFiles) {
    let doc;
    try {
      doc = await io.read(sourcePath);
    } catch (error) {
      warn(`${group.label}/${nodeName}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    // Copy the source document into the merged one, then reparent its scene
    // roots under a single named node.
    mergeDocuments(merged, doc);

    const incoming = merged
      .getRoot()
      .listScenes()
      .filter((s) => s !== scene);

    const wrapper = merged.createNode(nodeName);
    for (const s of incoming) {
      for (const child of s.listChildren()) {
        s.removeChild(child);
        wrapper.addChild(child);
      }
      s.dispose();
    }
    scene.addChild(wrapper);
  }

  merged.getRoot().setDefaultScene(scene);
  return merged;
}

/**
 * Undoes an FBX conversion quirk that makes models vanish.
 *
 * Several source packs come through with a base colour alpha of 0 and
 * alphaMode MASK, which discards every fragment: the model loads, measures
 * and positions correctly, and draws nothing at all. Only provably
 * undrawable materials are touched - zero alpha, a cutoff above zero, and no
 * texture that could have supplied a usable alpha.
 *
 * See scripts/repair-materials.mjs, which applies the same rule to packs that
 * were built before this check existed.
 */
function makeMaterialsDrawable(doc) {
  let repaired = 0;
  for (const material of doc.getRoot().listMaterials()) {
    if (material.getAlpha() > 0) continue;
    if (material.getAlphaMode() === 'OPAQUE') continue;
    const texture = material.getBaseColorTexture();
    const mime = texture?.getMimeType();
    if (mime === 'image/png' || mime === 'image/webp') continue;

    const [r, g, b] = material.getBaseColorFactor();
    material.setBaseColorFactor([r, g, b, 1]);
    material.setAlphaMode('OPAQUE');
    repaired += 1;
  }
  return repaired;
}

async function buildGroup(group, blender) {
  const dest = path.join(OUT, `${group.key}.glb`);
  if (!FORCE && existsSync(dest)) {
    log(`${group.label}: up to date`);
    return { skipped: true };
  }

  let resolved = [];

  if (group.kind === 'fbx') {
    if (!blender) {
      warn(`${group.label}: Blender not found, skipping (pass --blender <path> or set BLENDER_PATH)`);
      return { skipped: true };
    }
    const tmpDir = path.join(os.tmpdir(), 'gambit3d-glb', group.key);
    await fs.rm(tmpDir, { recursive: true, force: true });
    await convertFbxGroup(group, blender, tmpDir);
    resolved = Object.entries(group.nodes)
      .map(([name, file]) => [name, path.join(tmpDir, `${path.basename(file, path.extname(file))}.glb`)])
      .filter(([, p]) => existsSync(p));
  } else {
    resolved = Object.entries(group.nodes)
      .map(([name, file]) => [name, path.join(group.dir, file)])
      .filter(([name, p]) => {
        if (existsSync(p)) return true;
        warn(`${group.label}: missing ${name} (${path.basename(p)})`);
        return false;
      });
  }

  if (resolved.length === 0) {
    warn(`${group.label}: nothing to build`);
    return { skipped: true };
  }

  const doc = await mergeGroup(group, resolved);

  const rescued = makeMaterialsDrawable(doc);
  if (rescued > 0) {
    warn(`${group.label}: repaired ${rescued} material(s) that would have been invisible`);
  }

  await doc.transform(
    // Merging brings one buffer per source; GLB allows only one.
    unpartition(),
    dedup(),
    prune({ keepAttributes: false }),
    weld(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [group.textureSize, group.textureSize],
      quality: 80,
    }),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
  );

  await fs.mkdir(OUT, { recursive: true });
  const glb = await io.writeBinary(doc);
  await fs.writeFile(dest, glb);

  const built = doc.getRoot().listScenes()[0]?.listChildren().map((n) => n.getName()) ?? [];
  if (built.length === 0) {
    warn(group.label + ': every source failed to load, bundle not written');
    await fs.rm(dest, { force: true });
    return { skipped: true };
  }
  const names = built.join(', ');

  log(`${group.label} -> ${path.basename(dest)} (${(glb.byteLength / 1024).toFixed(0)} KB): ${names}`);
  return { skipped: false, nodes: built };
}

async function main() {
  const blender = findBlender();
  log(blender ? `Blender: ${blender}` : 'Blender: not found (FBX groups will be skipped)');
  log(`source: ${SOURCE}`);
  log(`output: ${path.relative(REPO, OUT)}`);

  if (!existsSync(SOURCE)) {
    warn('source folder missing - run "npm run assets:fetch" first. Maps fall back to procedural geometry.');
    return;
  }

  const groups = only ? GROUPS.filter((g) => g.key === only) : GROUPS;
  if (groups.length === 0) {
    console.error(`No group matches --only ${only}. Known: ${GROUPS.map((g) => g.key).join(', ')}`);
    process.exit(1);
  }

  const built = {};
  for (const group of groups) {
    try {
      const result = await buildGroup(group, blender);
      if (!result.skipped) built[group.key] = result.nodes;
    } catch (error) {
      warn(`${group.label} failed: ${error instanceof Error ? error.stack : String(error)}`);
    }
  }

  // Record which node names exist, so the renderer can check before cloning.
  const indexPath = path.join(OUT, 'index.json');
  let existing = {};
  if (existsSync(indexPath)) {
    try {
      existing = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const index = { ...existing, ...built };
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  log(`index -> ${path.relative(REPO, indexPath)}`);
}

main().catch((error) => {
  console.error('[models] failed:', error);
  process.exitCode = 1;
});
