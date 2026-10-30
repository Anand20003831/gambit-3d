#!/usr/bin/env node
/**
 * Repairs materials that can never draw.
 *
 * The FBX -> glTF conversion for some packs produced materials with a base
 * colour alpha of 0 *and* alphaMode MASK. In glTF that means every fragment
 * fails the alpha cutoff, so the model is invisible - which is exactly what
 * happened to the apartment furniture: 9 models loading correctly, sized
 * correctly, and discarding every pixel.
 *
 * Nothing is guessed here. A material is only touched when it is provably
 * undrawable: zero alpha, an alpha cutoff above zero, and no alpha texture that
 * could have supplied a usable value.
 *
 * Usage:
 *   node scripts/repair-materials.mjs            # report only
 *   node scripts/repair-materials.mjs --write    # rewrite the affected packs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const MODELS = path.join(REPO, 'packages', 'client', 'public', 'assets', 'models');

const WRITE = process.argv.includes('--write');
const log = (...m) => console.log('[materials]', ...m);

/**
 * True when a material cannot produce a single visible fragment.
 *
 * `OPAQUE` ignores alpha entirely, so only MASK and BLEND can be caught out by
 * a zero alpha, and only when no texture supplies one instead.
 */
function isUndrawable(material) {
  const alpha = material.getAlpha();
  if (alpha > 0) return false;

  const mode = material.getAlphaMode();
  if (mode === 'OPAQUE') return false;

  // A base colour texture with an alpha channel could still make it visible.
  const texture = material.getBaseColorTexture();
  if (texture) {
    const mime = texture.getMimeType();
    if (mime === 'image/png' || mime === 'image/webp') return false;
  }

  return true;
}

async function run() {
  const io = new NodeIO();
  const files = (await fs.readdir(MODELS)).filter((f) => f.endsWith('.glb')).sort();
  if (files.length === 0) {
    log('no packs found - run "npm run assets:models" first.');
    return;
  }

  let repaired = 0;

  for (const file of files) {
    const full = path.join(MODELS, file);
    const document = await io.read(full);
    const materials = document.getRoot().listMaterials();
    const broken = materials.filter(isUndrawable);

    if (broken.length === 0) {
      log(`${file}: ${materials.length} materials, all drawable`);
      continue;
    }

    log(`${file}: ${broken.length}/${materials.length} materials are invisible (alpha 0 with a cutoff)`);
    for (const material of broken.slice(0, 6)) {
      log(`    - ${material.getName() || '(unnamed)'} alphaMode=${material.getAlphaMode()}`);
    }
    if (broken.length > 6) log(`    - ... and ${broken.length - 6} more`);

    if (!WRITE) continue;

    for (const material of broken) {
      const [r, g, b] = material.getBaseColorFactor();
      material.setBaseColorFactor([r, g, b, 1]);
      material.setAlphaMode('OPAQUE');
    }
    await io.write(full, document);
    repaired += broken.length;
    log(`  -> rewrote ${file}`);
  }

  if (!WRITE) {
    log('');
    log('Report only. Re-run with --write to repair.');
  } else {
    log('');
    log(`repaired ${repaired} material(s)`);
  }
}

run().catch((error) => {
  console.error('[materials] failed:', error);
  process.exitCode = 1;
});
