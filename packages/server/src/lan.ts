import os from 'node:os';
import type { LanAddress, LanInfo } from '@gambit3d/shared';
import { config } from './env.js';

/**
 * LAN address discovery.
 *
 * The rule this module exists to enforce: loopback is never reported as the
 * LAN address. If the machine genuinely has no private-network address we say
 * so rather than handing out `127.0.0.1` and letting the user wonder why their
 * phone cannot connect.
 */

const PRIVATE_V4 = [
  { prefix: '10.', label: 'RFC1918 10/8' },
  { prefix: '192.168.', label: 'RFC1918 192.168/16' },
] as const;

function isPrivateV4(address: string): boolean {
  if (PRIVATE_V4.some((p) => address.startsWith(p.prefix))) return true;
  // 172.16.0.0 - 172.31.255.255
  const m = /^172\.(\d{1,3})\./u.exec(address);
  if (m) {
    const second = Number.parseInt(m[1] as string, 10);
    return second >= 16 && second <= 31;
  }
  return false;
}

/** 169.254/16 - self-assigned when DHCP failed. Reachable, but a bad sign. */
function isLinkLocalV4(address: string): boolean {
  return address.startsWith('169.254.');
}

function isPrivateV6(address: string): boolean {
  const a = address.toLowerCase();
  return /^f[cd]/u.test(a); // unique local addresses fc00::/7
}

/**
 * Interfaces we never want to advertise: virtual switches, VPN adapters and
 * container bridges are reachable from this machine but usually not from the
 * phone on the sofa.
 */
const DEPRIORITISED_IFACE = /(vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback|tailscale|zerotier|tap-|tun\d|utun|bridge\d|ppp|radmin|hamachi)/iu;

/** Interfaces most likely to be the real household network. */
const PREFERRED_IFACE = /(wi-?fi|wlan|wireless|ethernet|en\d|eth\d|lan)/iu;

export function collectAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      const family = normaliseFamily(addr.family);
      if (!family) continue;
      const isLoopback = addr.internal || addr.address === '127.0.0.1' || addr.address === '::1';
      const isPrivateLan =
        !isLoopback &&
        (family === 'IPv4' ? isPrivateV4(addr.address) || isLinkLocalV4(addr.address) : isPrivateV6(addr.address));
      out.push({
        address: addr.address,
        iface,
        family,
        isPrivateLan,
        isLoopback,
      });
    }
  }
  return out;
}

function normaliseFamily(family: string | number): 'IPv4' | 'IPv6' | null {
  if (family === 'IPv4' || family === 4) return 'IPv4';
  if (family === 'IPv6' || family === 6) return 'IPv6';
  return null;
}

/**
 * Ranks candidates so the most plausible household address wins:
 * IPv4 private beats IPv6 private, a preferred adapter name beats an unknown
 * one, an unknown one beats a virtual adapter, and link-local is last.
 */
function score(addr: LanAddress): number {
  if (addr.isLoopback) return -1000;
  let s = 0;
  if (addr.isPrivateLan) s += 100;
  if (addr.family === 'IPv4') s += 50;
  if (isLinkLocalV4(addr.address)) s -= 60;
  if (PREFERRED_IFACE.test(addr.iface)) s += 25;
  if (DEPRIORITISED_IFACE.test(addr.iface)) s -= 70;
  // Prefer the common home ranges over 10/8, which is more often corporate/VPN.
  if (addr.address.startsWith('192.168.')) s += 8;
  return s;
}

export function pickPrimary(candidates: LanAddress[]): LanAddress | null {
  const usable = candidates.filter((c) => !c.isLoopback && c.isPrivateLan);
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function getLanInfo(port = config.port, boundHost = config.host): LanInfo {
  const candidates = collectAddresses();
  const primary = pickPrimary(candidates);
  const reachableFromLan = boundHost === '0.0.0.0' || boundHost === '::';

  return {
    port,
    primary,
    candidates: [...candidates].sort((a, b) => score(b) - score(a)),
    joinUrl: primary ? buildJoinUrl(primary, port) : null,
    hostname: os.hostname(),
    boundHost,
    reachableFromLan,
  };
}

export function buildJoinUrl(addr: LanAddress, port: number): string {
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return `http://${host}:${port}`;
}

/** Human-readable diagnosis, used by the CLI helper and the in-app LAN panel. */
export function describeLan(info: LanInfo): string[] {
  const lines: string[] = [];
  if (!info.reachableFromLan) {
    lines.push(
      `Server is bound to ${info.boundHost}, so only this computer can reach it. ` +
        `Start it with HOST=0.0.0.0 (or use "npm run start:lan") to allow other devices.`,
    );
  }
  if (!info.primary) {
    lines.push(
      'No private network address was found. This computer does not appear to be ' +
        'connected to a Wi-Fi or wired LAN, so other devices cannot reach it.',
    );
  } else if (isLinkLocalV4(info.primary.address)) {
    lines.push(
      `The only address found (${info.primary.address}) is self-assigned, which usually ` +
        'means DHCP failed. Reconnect to your Wi-Fi before sharing this link.',
    );
  }
  return lines;
}
