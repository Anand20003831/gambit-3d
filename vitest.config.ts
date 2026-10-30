import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Socket.IO integration tests bind real ports; running files in parallel
    // makes port reuse and timer interactions flaky.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/server/src/**', 'packages/shared/src/**'],
      exclude: ['**/*.d.ts'],
    },
  },
});
