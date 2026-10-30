#!/usr/bin/env node
/**
 * Starts the server bound to every interface so other devices on the same
 * Wi-Fi can reach it, and prints the exact address to type on those devices.
 *
 * Builds first if the client bundle is missing, so a single command produces a
 * working, shareable game.
 *
 * Usage: node scripts/start-lan.mjs [--port 8787] [--skip-build]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? args[portIndex + 1] : (process.env.PORT ?? '8787');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, commandArgs, label) {
  console.log(`\n[lan] ${label}…`);
  const result = spawnSync(command, commandArgs, { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n[lan] ${label} failed. Fix the errors above and try again.`);
    process.exit(result.status ?? 1);
  }
}

const clientBundle = path.join(REPO, 'packages', 'client', 'dist', 'index.html');
const serverBundle = path.join(REPO, 'packages', 'server', 'dist', 'index.js');

if (!skipBuild && (!existsSync(clientBundle) || !existsSync(serverBundle))) {
  console.log('[lan] No production build found — building once so both devices get the same app.');
  run(npm, ['run', 'build'], 'Building');
} else if (!skipBuild) {
  console.log('[lan] Using the existing build. Pass --skip-build to skip this check, or run "npm run build" to refresh it.');
}

// Print the address before starting, so it is visible even if the server logs a lot.
spawnSync(process.execPath, [path.join(__dirname, 'lan-info.mjs'), '--port', String(port)], {
  stdio: 'inherit',
});

console.log('  Windows firewall: the first time you run this, Windows may ask whether to allow');
console.log('  Node.js through the firewall. Tick "Private networks" and click Allow.');
console.log('  If you miss the prompt, see LAN_SETUP.md for how to add the rule manually.');
console.log('');
console.log('  Press Ctrl+C to stop the server.');
console.log('');

const child = spawn(process.execPath, [serverBundle], {
  cwd: REPO,
  stdio: 'inherit',
  env: {
    ...process.env,
    // 0.0.0.0 is what makes the server reachable from other devices.
    HOST: '0.0.0.0',
    PORT: String(port),
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    // Accept private-network origins so phones can connect without extra config.
    ALLOW_LAN_ORIGINS: 'true',
  },
});

const stop = (signal) => {
  child.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

// Keep the hostname handy for people who prefer names to numbers.
process.on('spawn', () => {
  console.log(`[lan] Some devices can also reach this computer as http://${os.hostname()}.local:${port}`);
});
