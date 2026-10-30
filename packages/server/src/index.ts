import { createServer } from 'node:http';
import { config, describeConfig } from './env.js';
import { getDb, closeDb, pruneSessions } from './db.js';
import { createGateway } from './gateway.js';
import { createHttpApp } from './http.js';
import { buildJoinUrl, describeLan, getLanInfo } from './lan.js';
import { RoomManager } from './roomManager.js';

/**
 * Process entry point: wires the HTTP app and the socket gateway onto one
 * server so the client and the WebSocket share an origin (which is what makes
 * LAN play work without extra configuration).
 */

async function main(): Promise<void> {
  // Touch the database early so a bad path fails at boot, not mid-game.
  getDb();
  pruneSessions(30 * 24 * 60 * 60 * 1000);

  const rooms = new RoomManager();
  const app = createHttpApp({ rooms });
  const httpServer = createServer(app);
  const gateway = createGateway(httpServer, rooms);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  printBanner();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[server] ${signal} received, shutting down...`);
    await gateway.shutdown();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection', reason);
  });
}

function printBanner(): void {
  const lan = getLanInfo();
  const local = `http://localhost:${config.port}`;

  console.log('');
  console.log('  Gambit3D server');
  console.log('  ' + '-'.repeat(50));
  console.log(`  ${describeConfig()}`);
  console.log('');
  console.log(`  On this computer:  ${local}`);

  if (lan.reachableFromLan) {
    if (lan.primary) {
      console.log(`  On your Wi-Fi:     ${buildJoinUrl(lan.primary, config.port)}   (${lan.primary.iface})`);
    } else {
      console.log('  On your Wi-Fi:     unavailable - no private network address found');
    }
  } else {
    console.log('  On your Wi-Fi:     disabled - bound to ' + config.host);
    console.log('                     use "npm run start:lan" to allow other devices');
  }

  for (const warning of describeLan(lan)) {
    console.log(`  ! ${warning}`);
  }

  if (config.ephemeralSecret && config.isProduction) {
    console.log('  ! SESSION_SECRET is not set. Reconnection tokens will not survive a restart.');
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error('[server] failed to start', error);
  process.exitCode = 1;
});
