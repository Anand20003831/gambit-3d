import { existsSync } from 'node:fs';
import path from 'node:path';
import compression from 'compression';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { registerEditorRoutes } from './editor.js';
import { config, isOriginAllowed, REPO_ROOT } from './env.js';
import { describeLan, getLanInfo } from './lan.js';
import { RateLimiter } from './rateLimit.js';
import type { RoomManager } from './roomManager.js';

/**
 * HTTP surface.
 *
 * Deliberately small: health, LAN discovery, and (in production) the built
 * client. All gameplay happens over the socket connection, where the
 * authoritative state lives.
 */

export interface HttpDeps {
  rooms: RoomManager;
}

export function createHttpApp({ rooms }: HttpDeps): Express {
  const app = express();

  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The 3D client compiles shaders and uses blob workers; the default CSP
      // is too tight for Vite's dev output and would break WebGL contexts.
      contentSecurityPolicy: config.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              // three.js spins up decoder workers from blob: URLs.
              scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'blob:'],
              styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
              fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
              imgSrc: ["'self'", 'data:', 'blob:'],
              mediaSrc: ["'self'", 'data:', 'blob:'],
              workerSrc: ["'self'", 'blob:'],
              // GLTFLoader fetches textures embedded in a GLB through blob:
              // URLs it creates itself, so connect-src has to allow them or
              // every model loads untextured.
              connectSrc: ["'self'", 'ws:', 'wss:', 'blob:', 'data:'],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) callback(null, true);
        else callback(new Error('Origin not allowed'));
      },
      credentials: true,
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '32kb' }));

  // --- Rate limiting ------------------------------------------------------
  const httpLimiter = new RateLimiter({ http: { perMinute: config.rateLimits.httpPerMin } });
  httpLimiter.startSweeping();

  app.use((req: Request, res: Response, next: NextFunction) => {
    const decision = httpLimiter.check('http', req.ip ?? 'unknown');
    if (!decision.allowed) {
      res.setHeader('Retry-After', Math.ceil(decision.retryAfterMs / 1000));
      res.status(429).json({ ok: false, code: 'RATE_LIMITED', message: 'Too many requests.' });
      return;
    }
    next();
  });

  // --- API ----------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      status: 'healthy',
      uptimeSeconds: Math.round(process.uptime()),
      rooms: rooms.size,
      env: config.nodeEnv,
    });
  });

  /**
   * LAN discovery. Used by the in-app LAN panel to show the correct address and
   * QR code. Loopback is never returned as `primary`.
   */
  app.get('/api/lan', (_req, res) => {
    const info = getLanInfo();
    res.json({ ok: true, data: { ...info, warnings: describeLan(info) } });
  });

  app.get('/api/rooms', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    res.json({ ok: true, data: rooms.publicSummaries(search ? { search } : {}) });
  });

  registerEditorRoutes(app);

  // --- Static client (production) -----------------------------------------

  const clientDist = path.join(REPO_ROOT, 'packages', 'client', 'dist');
  if (existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        index: false,
        maxAge: config.isProduction ? '1h' : 0,
        setHeaders: (res, filePath) => {
          // Hashed asset filenames may be cached hard; everything else must not.
          if (/\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpg|webp|glb|hdr|ogg|mp3)$/iu.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );

    // SPA fallback: any non-API path serves index.html so deep links work.
    app.get(/^\/(?!api\/|socket\.io\/).*/u, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.status(200).type('text/plain').send(
        'Gambit3D server is running.\n\n' +
          'The client has not been built yet. Run "npm run dev" for the dev server, ' +
          'or "npm run build" then "npm start" to serve the built client from here.\n',
      );
    });
  }

  // --- Errors -------------------------------------------------------------

  app.use((_req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'No such endpoint.' });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error.message === 'Origin not allowed') {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', message: 'Origin not allowed.' });
      return;
    }
    console.error('[http] unhandled error', error);
    res.status(500).json({ ok: false, code: 'INTERNAL', message: 'Something went wrong.' });
  });

  return app;
}
