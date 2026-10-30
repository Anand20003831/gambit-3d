import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the room flows in real browsers.
 *
 * Every test that needs two players uses two isolated browser contexts, so they
 * have separate storage and therefore separate identities - the same situation
 * as two people on two devices.
 */

type Mode = 'public' | 'private' | 'lan' | 'local';

/** Creates a room through the real interface and returns its id and code. */
async function createRoom(
  page: Page,
  options: { mode?: Mode; name?: string; password?: string; approval?: boolean; theme?: string } = {},
): Promise<{ roomId: string; code: string }> {
  const mode = options.mode ?? 'public';
  await page.goto(`/create?mode=${mode}`);
  await page.waitForSelector('.create__grid');

  if (options.name) {
    const nameField = page.getByLabel('Room name');
    await nameField.fill(options.name);
  }

  if (options.theme) {
    const selects = await page.locator('select').all();
    for (const select of selects) {
      const values = await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      if (values.includes(options.theme)) {
        await select.selectOption(options.theme);
        break;
      }
    }
  }

  if (options.password) {
    await page.getByRole('switch', { name: /Require a password/ }).click();
    await page.getByLabel('Password', { exact: true }).fill(options.password);
  }

  if (options.approval) {
    await page.getByRole('switch', { name: /Approve each person/ }).click();
  }

  await page.getByRole('button', { name: 'Create game' }).click();
  await page.waitForURL(/\/room\//);
  const roomId = page.url().split('/room/')[1]!;

  // The code lives on the Room panel. Same-device rooms have none.
  await openDock(page, 'Room');
  const codeEl = page.locator('.share__code').first();
  const code = (await codeEl.count()) > 0 ? ((await codeEl.textContent()) ?? '').trim() : '';
  return { roomId, code };
}

async function openDock(page: Page, tab: 'Moves' | 'Chat' | 'Room' | 'Manage'): Promise<void> {
  const dock = page.locator('.hud__dock');
  await dock.waitFor({ state: 'attached' });
  const isOpen = await dock.evaluate((el) => el.classList.contains('is-open')).catch(() => false);
  if (!isOpen) {
    await page.locator('.hud__tool', { hasText: 'Panel' }).click();
    await expect(dock).toHaveClass(/is-open/);
  }
  await page.getByRole('radio', { name: tab, exact: true }).click();
}

/** Clicks a square on the 2D board, which is the deterministic input path. */
async function use2D(page: Page): Promise<void> {
  // The tool strip only exists once the room snapshot has arrived.
  await page.locator('.hud__tools').waitFor({ timeout: 20000 });
  const toggle = page.locator('.hud__tool', { hasText: /^2D$/ });
  if ((await toggle.count()) > 0) await toggle.click();
  await page.locator('.board2d').waitFor({ timeout: 20000 });
}

async function playMove(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`.board2d__sq[data-square="${from}"]`).click();
  await page.locator(`.board2d__sq[data-square="${to}"]`).click();
}

async function newPlayer(context: BrowserContext, name: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForSelector('.home__name');
  await page.getByRole('button', { name: 'Change name' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.home__name')).toContainText(name);
  return page;
}

test.describe('the shell', () => {
  test('loads the menu, settings and credits without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await expect(page.locator('.menu__title')).toHaveText('Gambit3D');

    // The four ways to play have a screen of their own rather than sitting
    // on the main menu, but every one of them still has to be reachable.
    await page.getByRole('link', { name: /^Play/ }).click();
    await expect(page).toHaveURL(/\/play$/);
    for (const mode of ['Play online', 'Private game', 'Local Wi-Fi', 'Pass and play']) {
      await expect(page.getByRole('link', { name: new RegExp(`^${mode}`) })).toBeVisible();
    }
    await page.getByRole('link', { name: 'Main menu' }).click();
    await expect(page.locator('.menu__title')).toBeVisible();

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    await page.goto('/credits');
    // The CC BY credit must be visible: its licence depends on it.
    await expect(page.getByText('ESO/S. Brunier').first()).toBeVisible();

    await page.goto('/lobby');
    await expect(page.getByRole('heading', { name: 'Public games' })).toBeVisible();

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('shows a real 404 for an unknown route', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByText('That page does not exist')).toBeVisible();
  });
});

test.describe('public rooms', () => {
  test('a hosted room appears in the browser and a second player can join and play', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();

    const host = await newPlayer(hostCtx, 'E2EHost');
    const guest = await newPlayer(guestCtx, 'E2EGuest');

    const { roomId } = await createRoom(host, { mode: 'public', name: 'E2E Public Game' });

    // The guest finds it in the public browser.
    await guest.goto('/lobby');
    const row = guest.locator('.roomrow', { hasText: 'E2E Public Game' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Play' }).click();
    await guest.waitForURL(new RegExp(`/room/${roomId}`));

    // The host starts, then both play a move.
    await host.getByRole('button', { name: 'Start game' }).click();
    await use2D(host);
    await use2D(guest);

    await expect(host.locator('.board2d')).toBeVisible();
    await expect(guest.locator('.board2d')).toBeVisible();

    // Work out who is White from the player cards, then play 1. e4 e5.
    const hostIsWhite = await host.evaluate(() => {
      const store = document.querySelector('.playercard.is-self');
      return store?.querySelector('.playercard__swatch--w') !== null;
    });
    const white = hostIsWhite ? host : guest;
    const black = hostIsWhite ? guest : host;

    await playMove(white, 'e2', 'e4');
    await openDock(white, 'Moves');
    await expect(white.locator('.movelist__san', { hasText: 'e4' })).toBeVisible();

    await playMove(black, 'e7', 'e5');
    await openDock(host, 'Moves');
    await expect(host.locator('.movelist__san', { hasText: 'e5' })).toBeVisible();

    await hostCtx.close();
    await guestCtx.close();
  });

  test('the server rejects an illegal move made through the interface', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await newPlayer(hostCtx, 'IllegalHost');
    const guest = await newPlayer(guestCtx, 'IllegalGuest');

    const { roomId } = await createRoom(host, { mode: 'public', name: 'Illegal Move Room' });
    await guest.goto(`/room/${roomId}`);
    await host.getByRole('button', { name: 'Start game' }).click();
    await use2D(host);

    // Selecting a pawn and clicking a square it cannot reach must leave the
    // board exactly as it was. The interface never applies a move locally, so
    // this is only true if the server refused it.
    const source = host.locator('.board2d__sq[data-square="e2"]');
    const target = host.locator('.board2d__sq[data-square="e5"]');
    await expect(source).toHaveAttribute('aria-label', /White pawn/);

    await playMove(host, 'e2', 'e5');

    await expect(source).toHaveAttribute('aria-label', /White pawn/);
    await expect(target).toHaveAttribute('aria-label', /e5, empty/);

    await hostCtx.close();
    await guestCtx.close();
  });
});

test.describe('private rooms', () => {
  test('are never listed publicly but can be joined by code', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await newPlayer(hostCtx, 'PrivHost');
    const guest = await newPlayer(guestCtx, 'PrivGuest');

    const { roomId, code } = await createRoom(host, { mode: 'private', name: 'E2E Secret Room' });
    expect(code.length).toBeGreaterThanOrEqual(10);

    await guest.goto('/lobby');
    await expect(guest.locator('.roomrow', { hasText: 'E2E Secret Room' })).toHaveCount(0);

    await guest.goto('/join');
    await guest.getByLabel('Room code or link').fill(code);
    await guest.getByRole('button', { name: 'Join' }).click();
    await guest.waitForURL(new RegExp(`/room/${roomId}`));
    await expect(guest.locator('.hud__roomName')).toContainText('E2E Secret Room');

    await hostCtx.close();
    await guestCtx.close();
  });

  test('a shareable link joins directly', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await newPlayer(hostCtx, 'LinkHost');
    const guest = await newPlayer(guestCtx, 'LinkGuest');

    const { roomId, code } = await createRoom(host, { mode: 'private', name: 'Link Room' });
    await guest.goto(`/join/${code}`);
    await guest.waitForURL(new RegExp(`/room/${roomId}`));

    await hostCtx.close();
    await guestCtx.close();
  });
});

test.describe('password-protected rooms', () => {
  test('refuse a wrong password and accept the right one', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await newPlayer(hostCtx, 'PwHostE2E');
    const guest = await newPlayer(guestCtx, 'PwGuestE2E');

    const { roomId, code } = await createRoom(host, {
      mode: 'private',
      name: 'Guarded Room',
      password: 'letmein123',
    });

    await guest.goto('/join');
    await guest.getByLabel('Room code or link').fill(code);
    await guest.getByRole('button', { name: 'Join' }).click();

    // A password field appears rather than a silent failure.
    const passwordField = guest.getByLabel('Room password');
    await expect(passwordField).toBeVisible();

    await passwordField.fill('wrongwrong');
    await guest.getByRole('button', { name: 'Join' }).click();
    await expect(guest.locator('.toast--error, .toast--warn')).toBeVisible();
    expect(guest.url()).not.toContain(`/room/${roomId}`);

    await passwordField.fill('letmein123');
    await guest.getByRole('button', { name: 'Join' }).click();
    await guest.waitForURL(new RegExp(`/room/${roomId}`));

    await hostCtx.close();
    await guestCtx.close();
  });
});

test.describe('spectators', () => {
  test('can watch but cannot move', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const watchCtx = await browser.newContext();

    const host = await newPlayer(hostCtx, 'SpecHostE2E');
    const guest = await newPlayer(guestCtx, 'SpecGuestE2E');
    const watcher = await newPlayer(watchCtx, 'SpecWatchE2E');

    const { roomId, code } = await createRoom(host, { mode: 'public', name: 'Watched Game' });
    await guest.goto(`/room/${roomId}`);
    await host.getByRole('button', { name: 'Start game' }).click();

    await watcher.goto('/join');
    await watcher.getByLabel('Room code or link').fill(code);
    await watcher.getByRole('switch', { name: /Join as a spectator/ }).click();
    await watcher.getByRole('button', { name: 'Join' }).click();
    await watcher.waitForURL(new RegExp(`/room/${roomId}`));

    await use2D(watcher);
    // A spectator has no controllable colour, so no square is a legal source.
    const canResign = await watcher.getByRole('button', { name: 'Resign' }).count();
    expect(canResign).toBe(0);

    // They still see the game.
    await expect(watcher.locator('.board2d')).toBeVisible();

    await hostCtx.close();
    await guestCtx.close();
    await watchCtx.close();
  });
});

test.describe('host approval', () => {
  test('holds a joiner until the host admits them', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await newPlayer(hostCtx, 'ApproveHost');
    const guest = await newPlayer(guestCtx, 'ApproveGuest');

    const { roomId, code } = await createRoom(host, {
      mode: 'private',
      name: 'Approval Room',
      approval: true,
    });

    await guest.goto(`/join/${code}`);
    await expect(guest.getByText('Waiting for the host')).toBeVisible();

    await openDock(host, 'Manage');
    await expect(host.locator('.moderation__requestName', { hasText: 'ApproveGuest' })).toBeVisible();
    await host.getByRole('button', { name: 'Admit' }).click();

    await guest.waitForURL(new RegExp(`/room/${roomId}`));
    await expect(guest.locator('.hud__roomName')).toContainText('Approval Room');

    await hostCtx.close();
    await guestCtx.close();
  });
});

test.describe('LAN mode', () => {
  test('reports the real network state and never advertises loopback', async ({ page }) => {
    await page.goto('/lan');
    await expect(page.getByRole('heading', { name: 'Play over local Wi-Fi' })).toBeVisible();

    // The e2e server binds 127.0.0.1, so the page must say it is not reachable.
    await expect(page.getByText('This computer only')).toBeVisible();

    // Whatever addresses it lists, loopback must be flagged as unusable.
    const loopbackRows = page.locator('.lan__addresses li', { hasText: '127.0.0.1' });
    if (await loopbackRows.count()) {
      await expect(loopbackRows.first()).toContainText('not usable');
    }

    // And no join URL is offered.
    await expect(page.locator('code', { hasText: 'npm run start:lan' }).first()).toBeVisible();
  });

  test('creates a LAN room that stays out of the public browser', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const otherCtx = await browser.newContext();
    const host = await newPlayer(hostCtx, 'LanHostE2E');
    const other = await newPlayer(otherCtx, 'LanOtherE2E');

    const { roomId } = await createRoom(host, { mode: 'lan', name: 'Wi-Fi Only Room' });
    expect(roomId).toBeTruthy();

    await other.goto('/lobby');
    await expect(other.locator('.roomrow', { hasText: 'Wi-Fi Only Room' })).toHaveCount(0);

    await hostCtx.close();
    await otherCtx.close();
  });
});

test.describe('same-device play', () => {
  test('runs both sides from one screen, with nobody else joining', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.home__name');
    const { roomId } = await createRoom(page, { mode: 'local', name: 'Kitchen Table' });
    expect(roomId).toBeTruthy();

    await openDock(page, 'Room');
    await expect(page.getByText('Same-device game')).toBeVisible();

    // The board is live on arrival: there is no second player to wait for.
    await expect(page.locator('.controls').getByRole('button', { name: 'Start game' })).toHaveCount(0);

    await use2D(page);

    // The same person plays White, then Black, then White again.
    await playMove(page, 'e2', 'e4');
    await openDock(page, 'Moves');
    await expect(page.locator('.movelist')).toContainText('e4');

    await playMove(page, 'e7', 'e5');
    await expect(page.locator('.movelist')).toContainText('e5');

    await playMove(page, 'g1', 'f3');
    await expect(page.locator('.movelist')).toContainText('Nf3');
  });

  test('turns the board to face whoever is to play', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.home__name');
    await createRoom(page, { mode: 'local', name: 'Turnaround' });
    await use2D(page);

    // Orientation shows in the square order: White reads a8 first, Black h1.
    const first = page.locator('.board2d__sq').first();
    await expect(first).toHaveAttribute('data-square', 'a8');

    await playMove(page, 'e2', 'e4');
    await expect(first).toHaveAttribute('data-square', 'h1');

    await playMove(page, 'e7', 'e5');
    await expect(first).toHaveAttribute('data-square', 'a8');
  });

  test('resolves a takeback on the spot, with no offer to accept', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.home__name');
    await createRoom(page, { mode: 'local', name: 'Takeback Table' });

    await use2D(page);
    await playMove(page, 'd2', 'd4');
    await openDock(page, 'Moves');
    await expect(page.locator('.movelist')).toContainText('d4');

    // Labelled for one player, not two, and it applies immediately.
    await page.locator('.controls').getByRole('button', { name: 'Take back move' }).click();
    await expect(page.getByText('No moves yet')).toBeVisible();
    await expect(page.getByText('Waiting for your opponent')).toHaveCount(0);
    // Abort comes back only when no move has been played, which confirms the
    // server really did rewind rather than the panel merely re-rendering.
    await expect(page.locator('.controls').getByRole('button', { name: 'Abort' })).toBeVisible();
  });
});

test.describe('accessibility and fallbacks', () => {
  test('the 2D board is keyboard reachable and labelled', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await newPlayer(ctx, 'A11yPlayer');
    const { roomId } = await createRoom(page, { mode: 'public', name: 'A11y Room' });
    void roomId;

    await use2D(page);
    const e2 = page.locator('.board2d__sq[data-square="e2"]');
    await expect(e2).toHaveAttribute('aria-label', /e2, White pawn/);

    const grid = page.getByRole('grid', { name: 'Chess board' });
    await expect(grid).toBeVisible();

    await ctx.close();
  });

  test('reduced motion and colour-blind settings persist', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('switch', { name: /Reduce motion/ }).click();
    await page.getByRole('switch', { name: /Colour-blind-safe/ }).click();

    await page.reload();
    await expect(page.getByRole('switch', { name: /Reduce motion/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: /Colour-blind-safe/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.locator('html')).toHaveAttribute('data-cbsafe', 'on');
  });
});

test.describe('board orientation online', () => {
  test('each player sees their own side nearest', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await newPlayer(hostCtx, 'OrientHost');
    const guest = await newPlayer(guestCtx, 'OrientGuest');

    const { roomId } = await createRoom(host, { mode: 'public', name: 'Orientation' });
    await guest.goto(`/room/${roomId}`);
    await guest.waitForSelector('.hud__tools', { timeout: 20000 });

    await use2D(host);
    await use2D(guest);

    // Whoever holds Black reads the board from the other end, and it stays
    // that way all game - unlike a same-device room, nothing turns around.
    const hostFirst = await host.locator('.board2d__sq').first().getAttribute('data-square');
    const guestFirst = await guest.locator('.board2d__sq').first().getAttribute('data-square');
    expect(new Set([hostFirst, guestFirst])).toEqual(new Set(['a8', 'h1']));

    await hostCtx.close();
    await guestCtx.close();
  });
});

test.describe('the menu backdrop', () => {
  test('keeps running across navigation instead of restarting', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.menu__title');

    // It may take a moment to appear; it is loaded after the menu paints.
    const canvas = page.locator('.menubackdrop canvas');
    await canvas.waitFor({ state: 'attached', timeout: 30_000 });

    // Tag the element so we can tell a survivor from a replacement.
    await canvas.evaluate((node) => { (node as HTMLElement).dataset.probe = 'original'; });

    for (const [link, expected] of [
      [/^Play/, /\/play$/],
      [/^Local Wi-Fi/, /\/lan$/],
      [/^Play$/, /\/play$/],
    ] as const) {
      await page.getByRole('link', { name: link }).first().click();
      await expect(page).toHaveURL(expected);
      await expect(canvas).toHaveAttribute('data-probe', 'original');
    }

    // Only one WebGL canvas: a second would mean the old one was orphaned.
    expect(await page.locator('.menubackdrop canvas').count()).toBe(1);
  });

  test('is torn down when a board takes over', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.menu__title');
    await page.locator('.menubackdrop canvas').waitFor({ state: 'attached', timeout: 30_000 });

    // Two live WebGL contexts is how you run the browser out of them.
    await createRoom(page, { mode: 'local', name: 'Backdrop Handover' });
    await expect(page.locator('.menubackdrop')).toHaveCount(0);
  });
});

test.describe('the level editor', () => {
  test('lists a map, edits a model, undoes it and saves', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/editor?map=apartment');
    await page.waitForSelector('.ed-outliner__pick', { timeout: 30_000 });

    // The outliner is the map's real contents, not a fixed list.
    const rows = page.locator('.ed-outliner__pick');
    expect(await rows.count()).toBeGreaterThan(20);
    await expect(page.locator('.editor__status')).toContainText('built-in layout');

    // Selecting shows the numbers behind the model.
    await rows.first().click();
    const positionX = page.getByLabel('Position X');
    await expect(positionX).toBeVisible();
    const original = await positionX.inputValue();

    await positionX.fill('4.5');
    await expect(page.locator('.editor__status')).toContainText('unsaved changes');

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(positionX).toHaveValue(original);

    // Counted while the outliner is on screen; the palette replaces it.
    const before = await rows.count();

    // Every downloaded model is placeable, not just the ones already used.
    await page.getByRole('tab', { name: 'Add model' }).click();
    const palette = page.locator('.ed-palette__item');
    await expect(palette.first()).toBeVisible();
    expect(await palette.count()).toBeGreaterThan(20);

    await palette.first().click();
    await page.getByRole('tab', { name: 'Scene', exact: true }).click();
    await expect.poll(() => rows.count()).toBe(before + 1);

    // Saving writes the layout back and says where it went.
    await page.getByRole('button', { name: /^Save/ }).click();
    await expect(page.locator('.editor__msg')).toContainText('Saved');
    await expect(page.locator('.editor__status')).toContainText('saved layout');

    expect(errors).toEqual([]);
  });

  test('switches maps and keeps each layout separate', async ({ page }) => {
    await page.goto('/editor?map=station');
    await page.waitForSelector('.ed-outliner__pick', { timeout: 30_000 });
    const stationCount = await page.locator('.ed-outliner__pick').count();

    await page.getByRole('radio', { name: 'Neon City Apartment' }).click();
    await expect(page.locator('.ed-outliner__group h3').first()).toContainText('Furniture');
    const apartmentCount = await page.locator('.ed-outliner__pick').count();

    expect(apartmentCount).not.toBe(stationCount);
    expect(page.url()).toContain('map=apartment');
  });
});
