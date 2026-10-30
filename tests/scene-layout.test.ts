import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  DETAIL_RANK,
  MAX_PROPS_PER_LAYOUT,
  MODEL_PACKS,
  THEME_IDS,
  parseSceneLayout,
  propVisibleAt,
  sceneLayoutSchema,
  type PlacedProp,
  type SceneLayout,
} from '@gambit3d/shared';
import { defaultLayout, GROUP_ORDER } from '../packages/client/src/three/layout/defaults.js';
import { startTestServer, type TestServer } from './helpers/server.js';

/**
 * Scene layouts: the data behind where every environment model stands, and the
 * endpoint the level editor saves them through.
 *
 * The layouts are what the maps render, so a malformed one is a black screen -
 * hence a strict schema, and a built-in fallback that must always satisfy it.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
/** Matches the scratch directory the test server points LAYOUT_DIR at. */
const LAYOUT_DIR = path.join(tmpdir(), 'gambit3d-test-layouts');

function sampleProp(overrides: Partial<PlacedProp> = {}): PlacedProp {
  return {
    id: 'test-prop',
    pack: 'apartment-furniture',
    node: 'sofa',
    group: 'Furniture',
    position: [0, -0.9, 4],
    rotation: [0, Math.PI, 0],
    scale: [1, 1, 1],
    fitHeight: 1.5,
    baseScale: 1,
    ground: true,
    castShadow: true,
    receiveShadow: true,
    minDetail: 'minimal',
    visible: true,
    locked: false,
    ...overrides,
  };
}

function sampleLayout(props: PlacedProp[] = [sampleProp()]): SceneLayout {
  return { version: 1, theme: 'apartment', props };
}

// ---------------------------------------------------------------------------

describe('built-in layouts', () => {
  for (const theme of THEME_IDS) {
    it(`${theme} validates against the schema`, () => {
      const result = sceneLayoutSchema.safeParse(defaultLayout(theme));
      if (!result.success) {
        throw new Error(`${theme} layout is invalid:\n${JSON.stringify(result.error.issues, null, 2)}`);
      }
      expect(result.success).toBe(true);
    });

    it(`${theme} has unique prop ids`, () => {
      const props = defaultLayout(theme).props;
      const ids = new Set(props.map((p) => p.id));
      expect(ids.size).toBe(props.length);
    });

    it(`${theme} only references known packs`, () => {
      for (const prop of defaultLayout(theme).props) {
        expect(MODEL_PACKS).toContain(prop.pack);
      }
    });

    it(`${theme} groups every prop under a known heading`, () => {
      const known = new Set(GROUP_ORDER[theme]);
      for (const prop of defaultLayout(theme).props) {
        expect(known.has(prop.group)).toBe(true);
      }
    });

    it(`${theme} is deterministic across calls`, () => {
      expect(JSON.stringify(defaultLayout(theme))).toBe(JSON.stringify(defaultLayout(theme)));
    });

    it(`${theme} hands back a fresh copy each time`, () => {
      const first = defaultLayout(theme);
      const firstProp = first.props[0];
      expect(firstProp).toBeDefined();
      firstProp!.position[0] = 999;
      expect(defaultLayout(theme).props[0]!.position[0]).not.toBe(999);
    });

    it(`${theme} stays under the layout cap`, () => {
      expect(defaultLayout(theme).props.length).toBeLessThanOrEqual(MAX_PROPS_PER_LAYOUT);
    });

    it(`${theme} keeps something visible at the lowest quality`, () => {
      const minimal = defaultLayout(theme).props.filter((p) => propVisibleAt(p, 'minimal'));
      expect(minimal.length).toBeGreaterThan(0);
    });
  }

  it('shows strictly more on higher quality settings', () => {
    for (const theme of THEME_IDS) {
      const props = defaultLayout(theme).props;
      const counts = (['minimal', 'standard', 'rich'] as const).map(
        (level) => props.filter((p) => propVisibleAt(p, level)).length,
      );
      expect(counts[0]!).toBeLessThanOrEqual(counts[1]!);
      expect(counts[1]!).toBeLessThanOrEqual(counts[2]!);
      // Rich draws everything.
      expect(counts[2]).toBe(props.length);
    }
  });

  it('keeps the apartment towers out of the corridor straight ahead', () => {
    // A tower is roughly 20 units across before scaling; anything close to the
    // centre line fills the window and blanks out the view.
    const towers = defaultLayout('apartment').props.filter((p) => p.pack === 'city-buildings');
    expect(towers.length).toBeGreaterThan(10);
    for (const tower of towers) {
      const [x, , z] = tower.position;
      if (z > -100) expect(Math.abs(x)).toBeGreaterThan(14);
    }
  });

  it('places the apartment furniture on the floor', () => {
    const furniture = defaultLayout('apartment').props.filter((p) => p.group === 'Furniture');
    expect(furniture.length).toBeGreaterThan(0);
    for (const item of furniture) {
      expect(item.position[1]).toBeCloseTo(-0.9, 5);
      expect(item.ground).toBe(true);
    }
  });

  it('puts the station scenery outside the room, beyond the glass', () => {
    const space = defaultLayout('station').props.filter((p) => p.group === 'Space');
    expect(space.length).toBeGreaterThan(0);
    for (const body of space) {
      expect(body.position[2]).toBeLessThan(-100);
      expect(body.ground).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('layout validation', () => {
  it('accepts a well-formed layout', () => {
    expect(parseSceneLayout(sampleLayout())).not.toBeNull();
  });

  it('rejects an unknown map', () => {
    expect(parseSceneLayout({ ...sampleLayout(), theme: 'shrine' })).toBeNull();
  });

  it('rejects an unknown pack', () => {
    expect(parseSceneLayout(sampleLayout([sampleProp({ pack: 'dragons' as never })]))).toBeNull();
  });

  it('rejects duplicate ids, which would move two models at once', () => {
    const twice = sampleLayout([sampleProp(), sampleProp()]);
    expect(parseSceneLayout(twice)).toBeNull();
  });

  it('rejects a node name that could escape the pack', () => {
    expect(parseSceneLayout(sampleLayout([sampleProp({ node: '../../etc/passwd' })]))).toBeNull();
  });

  it('rejects non-finite coordinates, which would poison a matrix', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      expect(parseSceneLayout(sampleLayout([sampleProp({ position: [bad, 0, 0] })]))).toBeNull();
    }
  });

  it('rejects a colour that is not #rrggbb', () => {
    const styled = sampleProp({ material: { tint: 'red' as never } });
    expect(parseSceneLayout(sampleLayout([styled]))).toBeNull();
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    const odd = { ...sampleProp(), rotationY: 3 } as unknown as PlacedProp;
    expect(parseSceneLayout(sampleLayout([odd]))).toBeNull();
  });

  it('rejects more props than the cap allows', () => {
    const many = Array.from({ length: MAX_PROPS_PER_LAYOUT + 1 }, (_, i) =>
      sampleProp({ id: `prop-${i}` }),
    );
    expect(parseSceneLayout(sampleLayout(many))).toBeNull();
  });

  it('accepts every animation kind', () => {
    for (const animation of [
      { kind: 'none' } as const,
      { kind: 'flicker', rate: 1.2, phase: 0.5 } as const,
      { kind: 'spin', speed: -0.004, phase: 1.7 } as const,
    ]) {
      expect(parseSceneLayout(sampleLayout([sampleProp({ animation })]))).not.toBeNull();
    }
  });

  it('hides a prop below its detail threshold', () => {
    const rich = sampleProp({ minDetail: 'rich' });
    expect(propVisibleAt(rich, 'minimal')).toBe(false);
    expect(propVisibleAt(rich, 'standard')).toBe(false);
    expect(propVisibleAt(rich, 'rich')).toBe(true);
  });

  it('hides a prop switched off in the editor at every quality level', () => {
    const hidden = sampleProp({ visible: false });
    for (const level of ['minimal', 'standard', 'rich'] as const) {
      expect(propVisibleAt(hidden, level)).toBe(false);
    }
  });

  it('ranks detail levels in increasing order', () => {
    expect(DETAIL_RANK.minimal).toBeLessThan(DETAIL_RANK.standard);
    expect(DETAIL_RANK.standard).toBeLessThan(DETAIL_RANK.rich);
  });
});

// ---------------------------------------------------------------------------

describe('editor save endpoint', () => {
  let server: TestServer;
  const written: string[] = [];

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.shutdown();
    // Only remove files this suite created; a hand-edited layout must survive.
    for (const file of written) await rm(file, { force: true });
  });

  async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${server.url}/api/editor/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('reports whether saving is available', async () => {
    const response = await fetch(`${server.url}/api/editor/status`);
    const body = (await response.json()) as { ok: boolean; data: { enabled: boolean; directory: string } };
    expect(body.ok).toBe(true);
    // NODE_ENV is 'test' here, so this is not a production server.
    expect(body.data.enabled).toBe(true);
    expect(body.data.directory.endsWith('gambit3d-test-layouts')).toBe(true);
  });

  it('writes a valid layout to the map it belongs to', async () => {
    const layout = sampleLayout([sampleProp({ id: 'saved-sofa', position: [1, -0.9, 2] })]);
    const { status, body } = await post(layout);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const file = path.join(LAYOUT_DIR, 'apartment.json');
    written.push(file);
    expect(existsSync(file)).toBe(true);

    const saved = JSON.parse(await readFile(file, 'utf8')) as SceneLayout;
    expect(saved.theme).toBe('apartment');
    expect(saved.props[0]?.id).toBe('saved-sofa');
    // Round-trips: what was written is what the client will load back.
    expect(parseSceneLayout(saved)).not.toBeNull();
  });

  it('refuses a layout that fails validation, and says why', async () => {
    const { status, body } = await post({ ...sampleLayout(), props: [{ id: 'broken' }] });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('INVALID_LAYOUT');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('refuses a body that is not a layout at all', async () => {
    expect((await post({ hello: 'world' })).status).toBe(400);
    expect((await post([1, 2, 3])).status).toBe(400);
  });

  it('takes the filename from the validated map id, not from the request', async () => {
    // A traversal attempt has to fail the enum before it reaches the filesystem.
    const { status } = await post({ ...sampleLayout(), theme: '../../../evil' });
    expect(status).toBe(400);
    expect(existsSync(path.join(REPO_ROOT, 'evil.json'))).toBe(false);
  });
});
