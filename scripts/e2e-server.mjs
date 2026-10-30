#!/usr/bin/env node
/**
 * Boots the production build for the end-to-end suite.
 *
 * Builds first if the output is missing, then starts the real server, which
 * serves the built client and the socket gateway from one origin. That is the
 * same shape as LAN play and a single-origin deployment, so the tests exercise
 * the real thing rather than the dev server.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const clientBundle = path.join(REPO, 'packages', 'client', 'dist', 'index.html');
const serverBundle = path.join(REPO, 'packages', 'server', 'dist', 'index.js');

if (!existsSync(clientBundle) || !existsSync(serverBundle) || process.env.E2E_FORCE_BUILD === '1') {
  console.log('[e2e] building…');
  const build = spawnSync(npm, ['run', 'build'], {
    cwd: REPO,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error('[e2e] build failed');
    process.exit(build.status ?? 1);
  }
}

console.log('[e2e] starting server…');
const child = spawn(process.execPath, [serverBundle], { cwd: REPO, stdio: 'inherit', env: process.env });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
