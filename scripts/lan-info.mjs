#!/usr/bin/env node
/**
 * Prints this computer's usable LAN addresses.
 *
 * Deliberately refuses to present loopback as a shareable address - that is the
 * single most common reason "LAN play" appears broken.
 *
 * Usage: node scripts/lan-info.mjs [--port 8787] [--json]
 */

import os from 'node:os';

const args = process.argv.slice(2);
const json = args.includes('--json');
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] ?? '8787', 10) : Number.parseInt(process.env.PORT ?? '8787', 10);

const DEPRIORITISED = /(vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback|tailscale|zerotier|tap-|tun\d|utun|bridge\d|ppp|radmin|hamachi)/i;
const PREFERRED = /(wi-?fi|wlan|wireless|ethernet|en\d|eth\d|lan)/i;

function isPrivateV4(a) {
  if (a.startsWith('10.') || a.startsWith('192.168.')) return true;
  const m = /^172\.(\d{1,3})\./.exec(a);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    return n >= 16 && n <= 31;
  }
  return a.startsWith('169.254.');
}

function collect() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      const family = addr.family === 'IPv4' || addr.family === 4 ? 'IPv4' : addr.family === 'IPv6' || addr.family === 6 ? 'IPv6' : null;
      if (!family) continue;
      const isLoopback = addr.internal || addr.address === '127.0.0.1' || addr.address === '::1';
      const isPrivateLan =
        !isLoopback && (family === 'IPv4' ? isPrivateV4(addr.address) : /^f[cd]/i.test(addr.address));
      out.push({ address: addr.address, iface, family, isPrivateLan, isLoopback });
    }
  }
  return out;
}

function score(a) {
  if (a.isLoopback) return -1000;
  let s = 0;
  if (a.isPrivateLan) s += 100;
  if (a.family === 'IPv4') s += 50;
  if (a.address.startsWith('169.254.')) s -= 60;
  if (PREFERRED.test(a.iface)) s += 25;
  if (DEPRIORITISED.test(a.iface)) s -= 70;
  if (a.address.startsWith('192.168.')) s += 8;
  return s;
}

const candidates = collect().sort((a, b) => score(b) - score(a));
const usable = candidates.filter((c) => c.isPrivateLan && !c.isLoopback);
const primary = usable[0] ?? null;
const joinUrl = primary
  ? `http://${primary.family === 'IPv6' ? `[${primary.address}]` : primary.address}:${port}`
  : null;

if (json) {
  console.log(JSON.stringify({ port, hostname: os.hostname(), primary, candidates, joinUrl }, null, 2));
  process.exit(primary ? 0 : 1);
}

console.log('');
console.log(`  Computer:  ${os.hostname()}`);
console.log(`  Port:      ${port}`);
console.log('');

if (primary) {
  console.log(`  Share this address with other devices on your Wi-Fi:`);
  console.log('');
  console.log(`      ${joinUrl}`);
  console.log('');
  console.log(`  (found on the "${primary.iface}" adapter)`);
} else {
  console.log('  No private network address found.');
  console.log('  This computer does not appear to be connected to a Wi-Fi or wired network,');
  console.log('  so other devices cannot reach it. Connect to your network and try again.');
}

const others = usable.slice(1);
if (others.length > 0) {
  console.log('');
  console.log('  Other addresses that might work:');
  for (const o of others) console.log(`      http://${o.address}:${port}   (${o.iface})`);
}

const loopback = candidates.filter((c) => c.isLoopback);
if (loopback.length > 0) {
  console.log('');
  console.log('  Not usable from other devices (this computer only):');
  for (const l of loopback) console.log(`      ${l.address}   (${l.iface})`);
}

console.log('');
process.exit(primary ? 0 : 1);
