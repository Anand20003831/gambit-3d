import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number.parseInt(process.env.E2E_PORT ?? '5199', 10);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * End-to-end configuration.
 *
 * The suite runs against the *production* build served by the real server on a
 * single origin, which is exactly how LAN play and a deployed instance work.
 * Running against the Vite dev server would not exercise that path.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          // Software GL keeps the 3D scene working on machines without a GPU,
          // and on CI runners.
          args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],

  webServer: {
    // Build once, then serve the built client and the socket server together.
    command: 'node scripts/e2e-server.mjs',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      DATABASE_PATH: ':memory:',
      SESSION_SECRET: 'e2e-secret-not-used-outside-tests',
      CORS_ORIGINS: '*',
      DISCONNECT_GRACE_MS: '2000',
      // Every request in the run comes from 127.0.0.1, so the per-IP caps
      // would otherwise throttle the suite rather than the app.
      MAX_ROOMS_PER_IP_PER_HOUR: '1000',
      RATE_LIMIT_CREATE_PER_MIN: '600',
      RATE_LIMIT_JOIN_PER_MIN: '600',
      RATE_LIMIT_HTTP_PER_MIN: '6000',
      // Exercise the level editor save path, which is off in production by
      // default. It writes to a scratch directory so a test run can never
      // overwrite a map somebody has dressed by hand.
      LEVEL_EDITOR: 'true',
      LAYOUT_DIR: path.join(tmpdir(), 'gambit3d-e2e-layouts'),
    },
  },
});
