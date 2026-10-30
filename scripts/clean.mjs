#!/usr/bin/env node
/** Removes build output. Never touches node_modules, .env, or the database. */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'packages/shared/dist',
  'packages/server/dist',
  'packages/client/dist',
  'coverage',
  'test-results',
  'playwright-report',
];

for (const target of targets) {
  await rm(path.join(REPO, target), { recursive: true, force: true });
  console.log(`[clean] removed ${target}`);
}
