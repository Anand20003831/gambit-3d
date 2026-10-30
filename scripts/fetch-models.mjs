#!/usr/bin/env node
/**
 * Downloads the CC0 model packs the two maps are built from.
 *
 * Everything here comes from Quaternius (quaternius.com), released CC0. Files
 * land in the downloads folder untouched; `build-assets.mjs` is what converts
 * and optimises them into the project. Re-running is safe - existing files are
 * skipped unless --force is passed.
 *
 * Usage: node scripts/fetch-models.mjs [--force] [--only <packKey>]
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { listFolder, downloadFile } from './lib/drive.mjs';

const DEST_ROOT = `${process.env.CHESS_MODELS_DIR ?? 'Chess models'}/quaternius`;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

/**
 * Each job names a Drive folder, where its files go, and which extensions to
 * keep. Keeping the filter tight matters: these folders carry Blend/FBX/OBJ/GLTF
 * duplicates of every model and we only want one format per pack.
 */
const JOBS = [
  {
    key: 'modular-scifi',
    label: 'Ultimate Modular Sci-Fi Pack',
    // FBX root: floor/roof tiles, columns, doors, props.
    folder: '1QKWz64T8lZrXuxBB29cwXACucpPfg6bG',
    dest: 'modular-scifi',
    extensions: ['.fbx'],
    recurse: true,
  },
  {
    key: 'furniture',
    label: 'Ultimate Furniture Pack',
    folder: '1URIlOFggYYWv7Pf_RW2lzpZk0nj0gFrt',
    dest: 'furniture',
    extensions: ['.fbx'],
    recurse: false,
  },
  {
    key: 'cyberpunk-props',
    label: 'Cyberpunk Game Kit - props and signage (ships glTF)',
    folder: '11xjYnK4TW3ny9G1Cl99htFwc-T9RiR7d',
    dest: 'cyberpunk-props',
    extensions: ['.gltf', '.bin'],
    recurse: false,
  },
  {
    key: 'cyberpunk-textures',
    label: 'Cyberpunk Game Kit - textures',
    folder: '1E6H56T0OGTEwzlLryM5OmsSKPui3M0ss',
    dest: 'cyberpunk-textures',
    extensions: ['.png', '.jpg'],
    recurse: true,
  },
  {
    key: 'space-environment',
    label: 'Ultimate Space Kit - environment (ships glTF)',
    folder: '1CkD9pizeE7OROHQAId7DeWgmbt_XkMTX',
    dest: 'space-environment',
    extensions: ['.gltf', '.bin', '.png'],
    recurse: true,
    // Only the GLTF subfolder plus the shared atlas.
    include: (p) => /(^|\/)GLTF\//i.test(p) || /Atlas\.png$/i.test(p),
  },
  {
    key: 'buildings',
    label: 'Ultimate Textured Buildings',
    folder: '1Vp2OEjEOpD65VlEVjmBjHGdCfZrcnih8',
    dest: 'buildings',
    extensions: ['.fbx', '.png'],
    recurse: true,
    include: (p) => /Finished Textured Buildings\/FBX\//i.test(p) || /Textures\//i.test(p),
  },
];

/** Licence files, fetched so the exact CC0 wording is on disk next to the models. */
const LICENSES = [
  { key: 'modular-scifi', id: '1yC4Yk0ujAzgNJxf0EYHau6zL4LPrUTX-', name: 'LICENSE-modular-scifi.txt' },
  { key: 'furniture', id: '1Z2K2CouSEJCdVucJpUJoH3pmvJtzMQL4', name: 'LICENSE-furniture.txt' },
  { key: 'cyberpunk-props', id: '1-hNes9woutDvbaJCpPYOKJlvO_cTMSU8', name: 'LICENSE-cyberpunk.txt' },
  { key: 'space-environment', id: '1WmpH3wsL_759gtn2JQTsz0v4eyG0bK-Z', name: 'LICENSE-space-kit.txt' },
  { key: 'buildings', id: '1tSk6QjHVGJtpPSDuggR02LyNgO0bBG7g', name: 'LICENSE-buildings.txt' },
];

const log = (...m) => console.log('[models]', ...m);

async function walk(folderId, prefix = '', depth = 0) {
  if (depth > 5) return [];
  const entries = await listFolder(folderId);
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFolder) out.push(...(await walk(entry.id, rel, depth + 1)));
    else out.push({ id: entry.id, path: rel, name: entry.name });
  }
  return out;
}

async function runJob(job) {
  const destDir = path.join(DEST_ROOT, job.dest);
  await fs.mkdir(destDir, { recursive: true });

  log(`${job.label} - listing…`);
  const all = job.recurse ? await walk(job.folder) : (await listFolder(job.folder)).filter((e) => !e.isFolder).map((e) => ({ id: e.id, path: e.name, name: e.name }));

  const wanted = all.filter((f) => {
    const ext = path.extname(f.name).toLowerCase();
    if (!job.extensions.includes(ext)) return false;
    if (job.include && !job.include(f.path)) return false;
    return true;
  });

  log(`${job.label} - ${wanted.length} of ${all.length} files match`);

  let written = 0;
  let skipped = 0;
  let failed = 0;

  // Sequential: Drive rate-limits aggressive parallel pulls from one IP.
  for (const file of wanted) {
    const dest = path.join(destDir, file.path.replace(/[/\\]+/g, path.sep));
    if (!FORCE && existsSync(dest)) {
      skipped += 1;
      continue;
    }
    try {
      const buffer = await downloadFile(file.id);
      // A Drive error page is HTML; never write one out as if it were a model.
      if (buffer.length < 200 && buffer.toString('utf8').includes('<')) {
        throw new Error('received an HTML error page instead of the file');
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buffer);
      written += 1;
      if (written % 10 === 0) log(`  …${written} downloaded`);
    } catch (error) {
      failed += 1;
      console.warn(`[models] ! ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`${job.label} - ${written} written, ${skipped} already present, ${failed} failed`);
  return { written, skipped, failed };
}

async function main() {
  await fs.mkdir(DEST_ROOT, { recursive: true });
  const jobs = ONLY ? JOBS.filter((j) => j.key === ONLY) : JOBS;
  if (jobs.length === 0) {
    console.error(`No job matches --only ${ONLY}. Known: ${JOBS.map((j) => j.key).join(', ')}`);
    process.exit(1);
  }

  const totals = { written: 0, skipped: 0, failed: 0 };
  for (const job of jobs) {
    const result = await runJob(job);
    totals.written += result.written;
    totals.skipped += result.skipped;
    totals.failed += result.failed;
  }

  for (const lic of LICENSES) {
    if (ONLY && lic.key !== ONLY) continue;
    const dest = path.join(DEST_ROOT, lic.name);
    if (!FORCE && existsSync(dest)) continue;
    try {
      await fs.writeFile(dest, await downloadFile(lic.id));
      log(`licence -> ${lic.name}`);
    } catch (error) {
      console.warn(`[models] ! licence ${lic.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`done: ${totals.written} written, ${totals.skipped} present, ${totals.failed} failed`);
  log(`originals kept in ${DEST_ROOT}`);
  if (totals.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[models] failed:', error);
  process.exitCode = 1;
});
