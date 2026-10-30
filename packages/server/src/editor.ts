import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Express } from 'express';
import { sceneLayoutSchema } from '@gambit3d/shared';
import { config, REPO_ROOT } from './env.js';

/**
 * Level editor save endpoint.
 *
 * The editor itself is just a page - it works anywhere, and can always export a
 * layout as a download. This is the part that writes the file back into the
 * project, so it is off in production unless someone deliberately turns it on.
 *
 * The filename is never taken from the request. It comes from the validated
 * theme id, which is an enum, so no path can be smuggled in through the body.
 */

const BUILT_DIR = path.join(REPO_ROOT, 'packages', 'client', 'dist', 'layouts');

/** Paths shown to the user, relative to the repo, with forward slashes. */
function display(target: string): string {
  const relative = path.relative(REPO_ROOT, target);
  if (relative.startsWith('..')) return target.split(path.sep).join('/');
  return relative.split(path.sep).join('/');
}

export function registerEditorRoutes(app: Express): void {
  app.get('/api/editor/status', (_req, res) => {
    res.json({
      ok: true,
      data: {
        enabled: config.levelEditor,
        reason: config.levelEditor
          ? null
          : 'Saving is disabled. Set LEVEL_EDITOR=true, or use Download to export the layout.',
        directory: display(config.layoutDir),
      },
    });
  });

  app.post(
    '/api/editor/layout',
    // A full city is a few hundred kilobytes of JSON, well past the 32kb the
    // rest of the API allows.
    express.json({ limit: '512kb' }),
    async (req, res) => {
      if (!config.levelEditor) {
        res.status(403).json({
          ok: false,
          code: 'EDITOR_DISABLED',
          message: 'Layout saving is disabled on this server. Start it with LEVEL_EDITOR=true.',
        });
        return;
      }

      const parsed = sceneLayoutSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_LAYOUT',
          message: 'That layout did not validate.',
          issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        return;
      }

      const layout = parsed.data;
      const body = `${JSON.stringify(layout, null, 2)}\n`;
      const written: string[] = [];

      try {
        await mkdir(config.layoutDir, { recursive: true });
        const source = path.join(config.layoutDir, `${layout.theme}.json`);
        await writeFile(source, body, 'utf8');
        written.push(display(source));

        /**
         * A production server serves the built client, not `public/`. Writing
         * the built copy too means Save takes effect on a LAN box immediately
         * instead of silently waiting for the next build.
         */
        const savingToClientPublic =
          path.resolve(config.layoutDir) ===
          path.resolve(path.join(REPO_ROOT, 'packages', 'client', 'public', 'layouts'));
        if (savingToClientPublic && existsSync(path.dirname(BUILT_DIR))) {
          await mkdir(BUILT_DIR, { recursive: true });
          const built = path.join(BUILT_DIR, `${layout.theme}.json`);
          await writeFile(built, body, 'utf8');
          written.push(display(built));
        }
      } catch (error) {
        console.error('[editor] failed to write layout', error);
        res.status(500).json({
          ok: false,
          code: 'WRITE_FAILED',
          message: 'The layout could not be written to disk. Check the server log.',
        });
        return;
      }

      res.json({ ok: true, data: { theme: layout.theme, props: layout.props.length, written } });
    },
  );
}
