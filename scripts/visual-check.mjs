#!/usr/bin/env node
/**
 * Visual smoke check.
 *
 * Drives two isolated browser contexts through a real match and captures a
 * screenshot of each map, plus a report of what the renderer actually drew.
 * This is what proves the 3D scene is not a blank canvas - a passing type check
 * says nothing about whether anything reached the screen.
 *
 * Usage: node scripts/visual-check.mjs [--url http://localhost:5173] [--out <dir>]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const BASE = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5173';
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(REPO, 'screenshots');

const log = (...m) => console.log('[visual]', ...m);

/**
 * Measures a captured frame.
 *
 * Draw-call counts are not always trustworthy: drei's axis gizmo renders a
 * second pass and leaves its own numbers in `gl.info`. The pixels do not lie -
 * a scene that failed to draw comes out flat, and this reports how flat.
 */
async function describeImage(file) {
  const image = sharp(file);
  const { width, height } = await image.metadata();
  const stats = await image.stats();
  const spread = Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
  const mean = stats.channels.slice(0, 3).reduce((sum, c) => sum + c.mean, 0) / 3;
  return { size: `${width}x${height}`, spread: Number(spread.toFixed(1)), mean: Number(mean.toFixed(1)) };
}

/** A frame this flat means nothing reached the screen. */
const FLAT_THRESHOLD = 6;

/** Reads what the renderer produced, so "it rendered" is a measurement. */
const SCENE_REPORT = `(() => {
  const g = window.__gambit3d;
  if (!g) return { ok: false, reason: 'renderer handle missing' };
  const info = g.gl.info;
  let meshes = 0, points = 0, lights = 0;
  g.scene.traverse((o) => {
    if (o.isMesh) meshes++;
    if (o.isPoints) points++;
    if (o.isLight) lights++;
  });
  return {
    ok: true,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    frames: info.render.frame,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    meshes, points, lights,
    canvas: [g.gl.domElement.width, g.gl.domElement.height],
  };
})()`;

async function createRoom(page, theme) {
  await page.goto(`${BASE}/create?mode=public`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.create__grid', { timeout: 20000 });
  await page.selectOption('select:below(:text("Map"))', theme).catch(() => undefined);

  // Fall back to picking the map select by its option values.
  const selects = await page.locator('select').all();
  for (const select of selects) {
    const values = await select.locator('option').evaluateAll((os) => os.map((o) => o.value));
    if (values.includes(theme)) {
      await select.selectOption(theme);
      break;
    }
  }

  await page.getByRole('button', { name: 'Create game' }).click();
  await page.waitForURL(/\/room\//, { timeout: 20000 });
  return page.url().split('/room/')[1];
}

/**
 * Checks the pieces are the sculpted set, at sane sizes.
 *
 * Two things have gone wrong here before and both were silent. The models
 * were only wired up for one map, so every other map drew lathed stand-ins
 * with no head on the knight. And the positions are quantised to normalised
 * 16-bit integers, so scaling the geometry up to board size overflowed them
 * and the values wrapped - which shows up as a piece exactly 2 units tall,
 * the full width of the normalised range.
 */
async function checkPieces(page) {
  const measured = await page.evaluate(() => {
    const g = window.__gambit3d;
    const board = g.scene?.getObjectByName('board-orientation');
    if (!board) return null;
    const seen = new Map();
    board.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.getAttribute('position');
      if (!pos || pos.count < 400 || seen.has(pos.count)) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      seen.set(pos.count, {
        verts: pos.count,
        h: Math.round((b.max.y - b.min.y) * 1000) / 1000,
        w: Math.round((b.max.x - b.min.x) * 1000) / 1000,
        d: Math.round((b.max.z - b.min.z) * 1000) / 1000,
      });
    });
    return [...seen.values()].sort((a, b) => a.h - b.h);
  });

  if (!measured) return { ok: false, verdict: 'no board group (is this a production build?)' };
  if (measured.length !== 6) {
    return { ok: false, verdict: `expected 6 piece shapes, found ${measured.length}`, measured };
  }

  const problems = [];
  const tallest = measured[measured.length - 1];
  const shortest = measured[0];

  // A piece exactly 2 units tall is the overflow signature.
  for (const piece of measured) {
    if (Math.abs(piece.h - 2) < 0.02) problems.push(`${piece.verts} verts is exactly 2 units tall`);
    // Nothing may spill onto a neighbouring square.
    if (piece.w > 0.98 || piece.d > 0.98) problems.push(`${piece.verts} verts is wider than its square`);
  }
  if (tallest.h < 1.2 || tallest.h > 1.8) problems.push(`king is ${tallest.h} units tall`);
  if (shortest.h > tallest.h * 0.75) problems.push('pawn is nearly as tall as the king');

  /**
   * A sculpted set runs to thousands of vertices a piece. The procedural
   * fallback is a lathe at a few dozen segments and never comes close, so this
   * is what catches the models silently not being wired up.
   */
  const detailed = measured.filter((p) => p.verts >= 4000).length;
  if (detailed < 6) {
    problems.push(`only ${detailed}/6 pieces are sculpted - the rest are the procedural fallback`);
  }

  return problems.length === 0
    ? { ok: true, verdict: `6 sculpted shapes, king ${tallest.h}, pawn ${shortest.h}` }
    : { ok: false, verdict: problems.join('; '), measured };
}

/**
 * Checks that the board turns round smoothly rather than snapping.
 *
 * In a same-device game the board comes round to face whoever is to play. An
 * instant 180-degree jump reads as though something else moved the pieces, so
 * the turn is animated - and an animation that silently stops animating looks
 * exactly like the bug it replaced.
 *
 * A takeback is what drives it here: it hands the board back to the other
 * side without remounting the scene, which switching between 2D and 3D would.
 */
async function checkBoardTurn(page) {
  const yaw = () =>
    page.evaluate(() => {
      const g = window.__gambit3d?.scene?.getObjectByName('board-orientation');
      return g ? Math.round(((g.rotation.y * 180) / Math.PI) * 10) / 10 : null;
    });

  const takeback = page.locator('.controls').getByRole('button', { name: 'Take back move' });
  if ((await takeback.count()) === 0) return { ok: false, verdict: 'no takeback button to trigger a turn' };

  const before = await yaw();
  if (before === null) return { ok: false, verdict: 'board group not found (is this a production build?)' };

  await takeback.first().click();

  const samples = [];
  for (let i = 0; i < 16; i += 1) {
    samples.push(await yaw());
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1200);
  const after = await yaw();

  const moved = Math.abs((after ?? 0) - before) > 90;
  // The point of the check: angles strictly between the two ends.
  const partial = samples.filter((a) => a !== null && a !== before && a !== after);
  if (!moved) return { ok: false, verdict: `never turned (stayed at ${before})`, samples };
  if (partial.length < 3) return { ok: false, verdict: 'snapped instead of turning', samples };

  return { ok: true, verdict: `turned ${before} -> ${after} over ${partial.length} sampled frames`, samples };
}

/**
 * Plays a few half-moves on the 2D board, alternating colours.
 *
 * Deliberately uses the flat board rather than picking 3D squares: this leg
 * is checking that one person can move both sides, not that raycasting works.
 */
async function playLocalMoves(page) {
  const twoD = page.getByRole('button', { name: '2D', exact: true });
  if (await twoD.count()) {
    await twoD.first().click();
    await page.waitForTimeout(600);
  }

  const square = (name) => page.locator(`button[aria-label^="${name},"]`).first();
  for (const [from, to] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']]) {
    await square(from).click();
    await page.waitForTimeout(250);
    await square(to).click();
    await page.waitForTimeout(500);
  }

  const played = await page.evaluate(() => document.querySelectorAll('.movelist__san, .movelist td').length);

  // Back to 3D: the turn check needs the scene, and switching remounts it,
  // so it has to happen before the board is asked to turn.
  const threeD = page.getByRole('button', { name: '3D', exact: true });
  if (await threeD.count()) {
    await threeD.first().click();
    await page.waitForTimeout(6000);
  }

  return played;
}

async function run() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });

  const results = [];
  const consoleErrors = [];

  try {
    for (const theme of ['apartment', 'station']) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      const page = await context.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`[${theme}] ${m.text()}`);
      });
      page.on('pageerror', (e) => consoleErrors.push(`[${theme}] pageerror: ${e.message}`));

      log(`creating a ${theme} room…`);
      const roomId = await createRoom(page, theme);
      log(`  room ${roomId}`);

      // Give the map time to fetch its model packs and settle.
      await page.waitForTimeout(9000);

      const pieces = await checkPieces(page);
      log(`  pieces: ${pieces.verdict}`);
      if (!pieces.ok) consoleErrors.push(`[${theme}] pieces: ${pieces.verdict}`);

      const report = await page.evaluate(SCENE_REPORT);
      const shot = path.join(OUT, `${theme}.png`);
      await page.screenshot({ path: shot });
      log(`  ${theme}: ${JSON.stringify(report)}`);
      log(`  screenshot -> ${path.relative(REPO, shot)}`);
      results.push({ theme, report, shot });

      // Also capture the hidden-interface view, which is the pure scene.
      await page.keyboard.press('h');
      await page.waitForTimeout(700);
      const clean = path.join(OUT, `${theme}-clean.png`);
      await page.screenshot({ path: clean });
      results.push({ theme: `${theme} (no UI)`, report: null, shot: clean });

      await context.close();
    }

    // --- two-player match in isolated contexts --------------------------
    log('running a two-player match…');
    const hostCtx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
    const guestCtx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();
    hostCtx.on('weberror', (e) => consoleErrors.push(`[host] ${e.error().message}`));
    guest.on('pageerror', (e) => consoleErrors.push(`[guest] pageerror: ${e.message}`));

    const roomId = await createRoom(host, 'apartment');
    const code = await host.evaluate(async () => {
      const openRoom = document.querySelector('.hud__tool:nth-child(5)');
      openRoom?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return null;
    });
    void code;

    await guest.goto(`${BASE}/room/${roomId}`, { waitUntil: 'domcontentloaded' });
    await guest.waitForTimeout(2500);

    const seats = await host.evaluate(() => {
      const s = document.querySelectorAll('.playercard__name');
      return [...s].map((n) => n.textContent?.trim());
    });
    log(`  seats: ${JSON.stringify(seats)}`);

    // Host starts the game.
    const startBtn = host.getByRole('button', { name: 'Start game' });
    if (await startBtn.count()) {
      await startBtn.first().click();
      await host.waitForTimeout(1200);
      log('  game started');
    } else {
      log('  ! no Start game button visible');
    }

    const shot = path.join(OUT, 'match-host.png');
    await host.screenshot({ path: shot });
    results.push({ theme: 'match (host)', report: null, shot });

    const guestShot = path.join(OUT, 'match-guest.png');
    await guest.screenshot({ path: guestShot });
    results.push({ theme: 'match (guest)', report: null, shot: guestShot });

    await hostCtx.close();
    await guestCtx.close();

    // --- same-device game ------------------------------------------------
    log('checking same-device play…');
    {
      const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => consoleErrors.push(`[local] pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`[local] ${m.text()}`);
      });

      await page.goto(`${BASE}/create?mode=local`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.create__grid', { timeout: 20000 });
      await page.getByRole('button', { name: 'Create game' }).click();
      await page.waitForURL(/\/room\//, { timeout: 20000 });
      await page.waitForTimeout(7000);

      // One person, one tab, both colours. This is the thing that used to
      // sit forever waiting for a second player to join.
      const phase = await page.evaluate(() => document.body.innerText.includes('Start game') ? 'waiting' : 'active');
      const played = await playLocalMoves(page);
      log(`  phase on arrival: ${phase}; moves played: ${played}`);

      const shot = path.join(OUT, 'same-device.png');
      await page.screenshot({ path: shot });
      results.push({ theme: `same-device (${played} half-moves)`, report: null, shot });

      const spin = await checkBoardTurn(page);
      log(`  board turn: ${spin.verdict}`);
      if (spin.samples) log(`  angles: ${spin.samples.join(String.fromCharCode(44, 32))}`);
      if (!spin.ok) consoleErrors.push(`[local] board turn did not animate: ${spin.verdict}`);

      await context.close();
    }

    // --- level editor ----------------------------------------------------
    for (const theme of ['apartment', 'station']) {
      log(`checking the level editor on ${theme}…`);
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => consoleErrors.push(`[editor:${theme}] pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`[editor:${theme}] ${m.text()}`);
      });

      await page.goto(`${BASE}/editor?map=${theme}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ed-outliner__pick', { timeout: 20000 });
      await page.waitForTimeout(8000);

      // Select the first model so the gizmo and the outline are on screen.
      await page.locator('.ed-outliner__pick').first().click();
      await page.waitForTimeout(1200);

      const report = await page.evaluate(SCENE_REPORT);
      const gizmo = await page.evaluate(() => {
        const g = window.__gambit3d;
        if (!g) return null;
        let helpers = 0;
        let controls = 0;
        g.scene.traverse((o) => {
          if (o.type === 'BoxHelper') helpers++;
          if (o.type === 'TransformControlsGizmo' || o.constructor?.name?.includes('TransformControls')) controls++;
        });
        return { helpers, controls };
      });
      const count = await page.locator('.ed-outliner__pick').count();
      log(`  ${theme}: ${JSON.stringify(report)}`);
      log(`  outliner rows: ${count}; selection helpers: ${JSON.stringify(gizmo)}`);

      const shot = path.join(OUT, `editor-${theme}.png`);
      await page.screenshot({ path: shot });
      results.push({ theme: `editor ${theme}`, report, shot });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  log('');
  log('--- summary ---');
  const flat = [];
  for (const r of results) {
    const image = r.shot ? await describeImage(r.shot) : null;
    /**
     * `gl.info` reports the last pass only, so a scene rendered through the
     * post-processing composer shows the final fullscreen quad rather than the
     * scene. Say so instead of printing a number that means nothing.
     */
    const composited = r.report && r.report.drawCalls <= 2;
    const drawn = !r.report
      ? 'captured'
      : composited
        ? 'drawn through the grade (draw calls not measurable)'
        : `${r.report.drawCalls} draw calls, ${r.report.triangles} triangles`;
    const pixels = image ? `; ${image.size}, contrast ${image.spread}, mean ${image.mean}` : '';
    log(`${r.theme}: ${drawn}${pixels}`);
    if (image && image.spread < FLAT_THRESHOLD) flat.push(`${r.theme} (contrast ${image.spread})`);
  }
  if (flat.length > 0) {
    log('');
    log(`--- ${flat.length} frame(s) look blank ---`);
    for (const f of flat) log(f);
    process.exitCode = 1;
  }
  if (consoleErrors.length > 0) {
    log('');
    log(`--- ${consoleErrors.length} console error(s) ---`);
    for (const e of consoleErrors.slice(0, 20)) log(e);
  } else {
    log('no console errors');
  }
}

run().catch((error) => {
  console.error('[visual] failed:', error);
  process.exitCode = 1;
});
