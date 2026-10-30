import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PieceType } from '@gambit3d/shared';

/**
 * Procedural chess pieces.
 *
 * Each piece is a lathed silhouette plus a few solid details. This exists for
 * three reasons: it is the guaranteed fallback when no model file is available,
 * it lets every map have its own silhouette without shipping three model sets,
 * and it scales its own tessellation to the quality budget.
 *
 * Geometry is cached per (style, type, segments) because a game shows up to 32
 * pieces built from only six shapes.
 */

export type PieceStyle = 'classic' | 'toon' | 'holo' | 'energy';

/**
 * Heights in world units, one square = 1 unit.
 *
 * Matched to the sculpted set so the board does not visibly change size if
 * the model file is missing and these stand in for it.
 */
export const PIECE_HEIGHTS: Record<PieceType, number> = {
  p: 0.85,
  n: 1.18,
  b: 1.36,
  r: 0.96,
  q: 1.43,
  k: 1.5,
};

/**
 * Lathe profiles: [radius, height] pairs from the base upward, normalised so
 * the tallest point is 1.0. Multiplied by PIECE_HEIGHTS at build time.
 */
type Profile = [number, number][];

const CLASSIC_PROFILES: Record<PieceType, Profile> = {
  p: [
    [0.00, 0.00], [0.30, 0.00], [0.30, 0.05], [0.26, 0.09], [0.19, 0.14],
    [0.16, 0.26], [0.19, 0.36], [0.14, 0.42], [0.13, 0.46], [0.22, 0.54],
    [0.24, 0.66], [0.20, 0.80], [0.12, 0.92], [0.00, 1.00],
  ],
  r: [
    [0.00, 0.00], [0.34, 0.00], [0.34, 0.06], [0.30, 0.11], [0.24, 0.17],
    [0.22, 0.55], [0.24, 0.66], [0.31, 0.72], [0.33, 0.78], [0.33, 1.00],
    [0.25, 1.00], [0.25, 0.86], [0.00, 0.86],
  ],
  n: [
    [0.00, 0.00], [0.33, 0.00], [0.33, 0.06], [0.29, 0.11], [0.23, 0.18],
    [0.21, 0.34], [0.22, 0.44], [0.00, 0.46],
  ],
  b: [
    [0.00, 0.00], [0.32, 0.00], [0.32, 0.06], [0.28, 0.11], [0.21, 0.17],
    [0.17, 0.34], [0.20, 0.44], [0.24, 0.49], [0.15, 0.54], [0.13, 0.58],
    [0.21, 0.66], [0.23, 0.78], [0.16, 0.88], [0.07, 0.94], [0.05, 0.96],
    [0.00, 0.97],
  ],
  q: [
    [0.00, 0.00], [0.37, 0.00], [0.37, 0.06], [0.32, 0.12], [0.24, 0.19],
    [0.19, 0.42], [0.22, 0.52], [0.27, 0.57], [0.16, 0.62], [0.14, 0.66],
    [0.25, 0.74], [0.30, 0.86], [0.28, 0.90], [0.20, 0.92], [0.16, 0.96],
    [0.00, 0.99],
  ],
  k: [
    [0.00, 0.00], [0.38, 0.00], [0.38, 0.06], [0.33, 0.12], [0.25, 0.19],
    [0.20, 0.44], [0.23, 0.54], [0.28, 0.59], [0.17, 0.64], [0.15, 0.68],
    [0.26, 0.76], [0.30, 0.86], [0.27, 0.90], [0.19, 0.92], [0.00, 0.93],
  ],
};

/**
 * The toon set is chunkier and rounder, with wider bases and softer shoulders -
 * the silhouette reads clearly under a cel-shaded material.
 */
const TOON_PROFILES: Record<PieceType, Profile> = {
  p: [
    [0.00, 0.00], [0.34, 0.00], [0.34, 0.08], [0.27, 0.16], [0.21, 0.30],
    [0.24, 0.44], [0.17, 0.52], [0.26, 0.62], [0.27, 0.76], [0.18, 0.90],
    [0.00, 1.00],
  ],
  r: [
    [0.00, 0.00], [0.38, 0.00], [0.38, 0.09], [0.30, 0.18], [0.26, 0.58],
    [0.30, 0.70], [0.36, 0.78], [0.36, 1.00], [0.27, 1.00], [0.27, 0.88],
    [0.00, 0.88],
  ],
  n: [
    [0.00, 0.00], [0.37, 0.00], [0.37, 0.09], [0.29, 0.18], [0.25, 0.36],
    [0.26, 0.46], [0.00, 0.48],
  ],
  b: [
    [0.00, 0.00], [0.36, 0.00], [0.36, 0.09], [0.28, 0.18], [0.21, 0.36],
    [0.25, 0.48], [0.29, 0.53], [0.17, 0.59], [0.25, 0.70], [0.27, 0.80],
    [0.18, 0.90], [0.08, 0.96], [0.00, 0.98],
  ],
  q: [
    [0.00, 0.00], [0.41, 0.00], [0.41, 0.09], [0.34, 0.19], [0.23, 0.44],
    [0.27, 0.56], [0.32, 0.61], [0.19, 0.67], [0.29, 0.78], [0.34, 0.88],
    [0.24, 0.94], [0.00, 1.00],
  ],
  k: [
    [0.00, 0.00], [0.42, 0.00], [0.42, 0.09], [0.35, 0.19], [0.24, 0.46],
    [0.28, 0.58], [0.33, 0.63], [0.20, 0.69], [0.30, 0.80], [0.34, 0.90],
    [0.23, 0.94], [0.00, 0.95],
  ],
};

/**
 * The holographic set is faceted and angular: tapered prisms rather than lathes,
 * so it reads as projected rather than carved.
 */
const HOLO_PROFILES: Record<PieceType, Profile> = {
  p: [[0.00, 0.00], [0.30, 0.02], [0.24, 0.10], [0.14, 0.48], [0.22, 0.58], [0.20, 0.74], [0.00, 1.00]],
  r: [[0.00, 0.00], [0.34, 0.02], [0.26, 0.12], [0.24, 0.72], [0.34, 0.80], [0.34, 1.00], [0.00, 1.00]],
  n: [[0.00, 0.00], [0.33, 0.02], [0.26, 0.12], [0.22, 0.40], [0.24, 0.48], [0.00, 0.50]],
  b: [[0.00, 0.00], [0.33, 0.02], [0.25, 0.12], [0.16, 0.46], [0.24, 0.56], [0.14, 0.64], [0.20, 0.82], [0.00, 1.00]],
  q: [[0.00, 0.00], [0.37, 0.02], [0.28, 0.14], [0.17, 0.52], [0.28, 0.62], [0.16, 0.70], [0.30, 0.88], [0.00, 1.00]],
  k: [[0.00, 0.00], [0.38, 0.02], [0.29, 0.14], [0.18, 0.54], [0.29, 0.64], [0.17, 0.72], [0.31, 0.90], [0.00, 0.96]],
};

/** The energy set is slender and tapering, like a contained plasma column. */
const ENERGY_PROFILES: Record<PieceType, Profile> = {
  p: [[0.00, 0.00], [0.26, 0.01], [0.28, 0.06], [0.13, 0.20], [0.11, 0.60], [0.17, 0.74], [0.09, 0.88], [0.00, 1.00]],
  r: [[0.00, 0.00], [0.30, 0.01], [0.32, 0.07], [0.18, 0.20], [0.17, 0.70], [0.28, 0.82], [0.30, 1.00], [0.00, 1.00]],
  n: [[0.00, 0.00], [0.29, 0.01], [0.31, 0.07], [0.18, 0.22], [0.17, 0.42], [0.20, 0.50], [0.00, 0.52]],
  b: [[0.00, 0.00], [0.29, 0.01], [0.31, 0.07], [0.15, 0.22], [0.12, 0.52], [0.20, 0.62], [0.10, 0.70], [0.14, 0.86], [0.00, 1.00]],
  q: [[0.00, 0.00], [0.33, 0.01], [0.35, 0.07], [0.16, 0.24], [0.13, 0.58], [0.24, 0.70], [0.12, 0.78], [0.22, 0.92], [0.00, 1.00]],
  k: [[0.00, 0.00], [0.34, 0.01], [0.36, 0.07], [0.17, 0.26], [0.14, 0.60], [0.25, 0.72], [0.13, 0.80], [0.23, 0.94], [0.00, 0.98]],
};

const PROFILE_SETS: Record<PieceStyle, Record<PieceType, Profile>> = {
  classic: CLASSIC_PROFILES,
  toon: TOON_PROFILES,
  holo: HOLO_PROFILES,
  energy: ENERGY_PROFILES,
};

/** Radial segment count per style; the holo set is deliberately low-poly. */
function radialSegments(style: PieceStyle, budget: number): number {
  if (style === 'holo') return Math.max(6, Math.round(budget / 4));
  if (style === 'energy') return Math.max(8, Math.round(budget / 2));
  return Math.max(10, budget);
}

const cache = new Map<string, THREE.BufferGeometry>();

/**
 * Builds (or returns a cached) geometry for one piece.
 * The result is centred on X/Z with its base at y = 0.
 */
export function pieceGeometry(type: PieceType, style: PieceStyle, segments: number): THREE.BufferGeometry {
  const key = `${style}:${type}:${segments}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const height = PIECE_HEIGHTS[type];
  const profile = PROFILE_SETS[style][type];
  const seg = radialSegments(style, segments);

  const points = profile.map(([r, h]) => new THREE.Vector2(Math.max(0.0008, r), h * height));
  const body = new THREE.LatheGeometry(points, seg);

  const parts: THREE.BufferGeometry[] = [body];
  for (const detail of pieceDetails(type, style, height, seg)) parts.push(detail);

  const merged = parts.length > 1 ? (mergeGeometries(parts, false) ?? body) : body;
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  // Dispose the intermediates we merged away.
  if (merged !== body) {
    for (const part of parts) part.dispose();
  }

  cache.set(key, merged);
  return merged;
}

/**
 * Per-piece details that a lathe cannot express: the rook's crenellations, the
 * bishop's mitre slit, the knight's head, and the crosses/coronets on the royals.
 */
function pieceDetails(
  type: PieceType,
  style: PieceStyle,
  height: number,
  seg: number,
): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const faceted = style === 'holo';

  switch (type) {
    case 'r': {
      // Four merlons around the rim.
      const count = faceted ? 4 : 5;
      const w = faceted ? 0.14 : 0.12;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2;
        const notch = new THREE.BoxGeometry(w, height * 0.2, w * 1.6);
        notch.translate(0, height * 0.94, 0.28);
        notch.rotateY(angle);
        out.push(notch);
      }
      break;
    }
    case 'b': {
      // The diagonal slit in the mitre.
      const slit = new THREE.BoxGeometry(0.055, height * 0.2, 0.36);
      slit.translate(0, height * 0.82, 0);
      slit.rotateY(Math.PI / 4);
      out.push(slit);
      // Finial.
      const finial = new THREE.SphereGeometry(0.055, Math.max(6, seg / 2), Math.max(5, seg / 3));
      finial.translate(0, height * 1.0, 0);
      out.push(finial);
      break;
    }
    case 'n': {
      out.push(...knightHead(height, faceted));
      break;
    }
    case 'q': {
      // Coronet points.
      const count = faceted ? 5 : 8;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2;
        const spike = new THREE.ConeGeometry(0.05, height * 0.13, faceted ? 4 : 6);
        spike.translate(0, height * 1.0, 0.2);
        spike.rotateY(angle);
        out.push(spike);
      }
      const orb = new THREE.SphereGeometry(0.075, Math.max(6, seg / 2), Math.max(5, seg / 3));
      orb.translate(0, height * 1.02, 0);
      out.push(orb);
      break;
    }
    case 'k': {
      // Cross.
      const vertical = new THREE.BoxGeometry(0.065, height * 0.19, 0.065);
      vertical.translate(0, height * 1.0, 0);
      const horizontal = new THREE.BoxGeometry(0.17, 0.065, 0.065);
      horizontal.translate(0, height * 1.01, 0);
      out.push(vertical, horizontal);
      break;
    }
    case 'p':
    default:
      break;
  }
  return out;
}

/**
 * The knight's head, built from a few boxes and a wedge.
 * It faces -Z, which is toward the opponent for White.
 */
function knightHead(height: number, faceted: boolean): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const baseY = height * 0.46;

  // Neck, angled forward.
  const neck = new THREE.BoxGeometry(0.26, height * 0.34, 0.24);
  neck.translate(0, baseY + height * 0.16, 0.02);
  neck.rotateX(-0.24);
  out.push(neck);

  // Muzzle.
  const muzzle = new THREE.BoxGeometry(0.22, height * 0.15, 0.3);
  muzzle.translate(0, baseY + height * 0.34, -0.16);
  muzzle.rotateX(0.16);
  out.push(muzzle);

  // Crest / mane.
  const mane = new THREE.BoxGeometry(0.09, height * 0.2, 0.3);
  mane.translate(0, baseY + height * 0.36, 0.14);
  mane.rotateX(0.5);
  out.push(mane);

  if (!faceted) {
    // Ears.
    for (const x of [-0.08, 0.08]) {
      const ear = new THREE.ConeGeometry(0.045, height * 0.1, 5);
      ear.translate(x, baseY + height * 0.46, 0.04);
      out.push(ear);
    }
  }
  return out;
}

/**
 * A flat "shadow disc" used under a piece at Low quality, where real shadow
 * mapping is off but pieces still need to feel grounded.
 */
export function contactDiscGeometry(): THREE.CircleGeometry {
  const geo = new THREE.CircleGeometry(0.36, 20);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function disposePieceCache(): void {
  for (const geo of cache.values()) geo.dispose();
  cache.clear();
}

