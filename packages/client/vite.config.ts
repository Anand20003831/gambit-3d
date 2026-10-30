import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // Read env from the repo root so one .env drives both packages.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const env = loadEnv(mode, repoRoot, '');

  const clientPort = Number.parseInt(env.VITE_PORT ?? '5173', 10) || 5173;
  const serverPort = Number.parseInt(env.PORT ?? '8787', 10) || 8787;
  const serverTarget = `http://127.0.0.1:${serverPort}`;

  return {
    envDir: repoRoot,
    server: {
      port: clientPort,
      // Bind everywhere so a phone on the same Wi-Fi can load the dev client.
      host: true,
      strictPort: false,
      proxy: {
        '/api': { target: serverTarget, changeOrigin: true },
        '/socket.io': { target: serverTarget, ws: true, changeOrigin: true },
      },
    },
    preview: { port: clientPort, host: true },
    plugins: [react()],
    build: {
      target: 'es2022',
      sourcemap: mode !== 'production',
      chunkSizeWarningLimit: 1400,
      rollupOptions: {
        output: {
          // Keep the 3D stack in its own chunk so the lobby loads fast and the
          // heavy renderer is fetched only when a board is shown.
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (/three|@react-three|postprocessing/.test(id)) return 'three';
              if (/react-dom|react-router|scheduler/.test(id)) return 'react';
              if (/socket\.io|engine\.io/.test(id)) return 'net';
              if (/chess\.js/.test(id)) return 'chess';
              if (/qrcode/.test(id)) return 'qr';
            }
            return undefined;
          },
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
    },
  };
});
