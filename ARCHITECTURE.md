# Architecture

How Gambit3D is put together: what talks to what, where game state lives, how
permissions are enforced, and how assets load.

---

## The shape of it

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Browser                    │         │  Node process                │
│                             │         │                              │
│  React + Three.js           │◄───────►│  Express (static + /api)     │
│    renders RoomView         │  HTTP   │  Socket.IO gateway           │
│    sends move intentions    │   WS    │    ↓                         │
│                             │         │  RoomManager → Room          │
│  chess.js (advisory only)   │         │    ChessEngine (chess.js)    │
│                             │         │    GameClock                 │
└─────────────────────────────┘         │    ↓                         │
                                        │  node:sqlite                 │
                                        └──────────────────────────────┘
```

Three packages:

- **`packages/shared`** — the contract. Types, zod schemas, the permission
  matrix, Elo. Both sides import it, so a mismatch is a compile error.
- **`packages/server`** — authoritative. Owns the board, the clocks, membership,
  moderation and persistence.
- **`packages/client`** — presentation and input. Renders what the server sends
  and forwards intent.

---

## Networking

### One origin

The Node process serves the built client *and* the WebSocket. That is why LAN
play needs no configuration: the phone loads the page from
`http://192.168.x.x:8787` and the client derives its socket URL from
`window.location.origin`, so it talks back to the same address.

`serverUrl()` in `packages/client/src/net/socket.ts` only overrides this when
`VITE_SERVER_URL` is set explicitly, for split deployments. Hard-coding
`localhost` there is the classic bug that makes LAN mode appear broken.

### Request/response, not fire-and-forget

Every client action is a Socket.IO call with an acknowledgement callback,
wrapped by `rpc()` which adds a timeout and returns a discriminated
`Result<T>`:

```ts
type Result<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string }
```

Callers must handle both branches. There is no path where a failure is silently
swallowed and the interface pretends something happened.

### Per-viewer snapshots

The server never broadcasts one shared room object. On every state change it
builds a **separate `RoomView` per member** and pushes it to that member's
sockets:

```
broadcastRoom(room) → for each member → room.viewFor(member.id) → socket.emit('room:state', view)
```

Two viewers of the same room legitimately see different data:

| Field | Who sees it |
|---|---|
| `game.legalMoves` | Only the seated player whose turn it is |
| `game.moves`, `game.pgn` | Players and staff always; spectators only if the host allows it |
| `pendingRequests` | Host and moderators only |
| `bans` | Host and moderators only |
| `code` | Members only — for a private room this is the join secret |
| `you.can` | Computed for that specific viewer |

This is why redaction is not a client concern: a spectator who is not entitled to
the legal-move map is never sent one, so there is nothing to hide.

### Events

Client → server (all acknowledged): `identify`, `lan:info`, `lobby:list`,
`lobby:subscribe`, `room:create`, `room:join`, `room:leave`, `room:get`,
`room:updateSettings`, `room:lock`, `room:respondJoin`, `room:kick`, `room:ban`,
`room:unban`, `room:mute`, `room:transferHost`, `room:setModerator`,
`room:setSeat`, `game:start`, `game:abort`, `game:move`, `game:resign`,
`game:offer`, `game:respondOffer`, `game:claimDraw`, `chat:send`.

Server → client: `room:state`, `room:removed`, `room:joinRequest`,
`room:joinResolved`, `game:moved`, `game:started`, `game:over`, `clock:sync`,
`chat:message`, `notice`, `lobby:rooms`.

---

## Game state

### Where it lives

The authoritative board is a `ChessEngine` inside a `Room`, held in memory by the
`RoomManager`. Rooms hold live timers and an in-progress position, so they are
not reconstructed per request.

What is persisted to SQLite:

| Table | Why |
|---|---|
| `users` | Guest identities, Elo, games played |
| `sessions` | Hashed reconnection-token nonces, so a token can be revoked |
| `rooms` | Room definition, settings and password hash |
| `room_bans` | Bans outlive a member leaving |
| `games` | Finished games with PGN, result and rating deltas |

An in-progress position is deliberately *not* persisted move-by-move. If the
server restarts mid-game the game is lost; rooms are short-lived and this keeps
the hot path free of disk writes. `ChessEngine.restore()` exists and is tested,
so adding that later is a small change.

### The move path

1. Client sends `game:move { roomId, from, to, promotion?, expectedPly? }`.
2. Gateway rate-limits, then parses with `moveRequestSchema`. Malformed input
   never reaches game logic.
3. `Room.move()` checks: are they a member, is the game active, are they seated,
   is it their turn, and does `expectedPly` match. A mismatch means the client
   computed the move against a stale board.
4. A flag that fell while the move was in flight is settled *first* and takes
   precedence.
5. The clock commits the mover's elapsed time and awards the increment.
6. `ChessEngine.applyMove()` validates against chess.js. **If it rejects, the
   clock is rolled back** — the move never happened, so the time must not be
   spent.
7. Terminal conditions are checked, the move is recorded, and every member gets
   a fresh snapshot.

`expectedPly` is what stops a laggy client from having a move applied to a
different position than the one it was looking at.

### Clocks

`GameClock` holds remaining milliseconds plus the timestamp of the last
reconciliation. Nothing counts down on a timer; elapsed time is computed on
demand from wall-clock differences.

- Flag falls are detected by a `setTimeout` armed for exactly the remaining time,
  and re-checked on the periodic sweep, so a missed timer cannot hang a game.
- Clients receive a `clock:sync` every three seconds and interpolate between
  them purely for display. A client that lies about elapsed time changes nothing.
- A flag fall against an opponent with no mating material is a **draw**, not a
  loss.
- Takebacks return the time spent *and* remove the increment, so a takeback
  cannot be farmed for extra time.

### Draws

Claimable and automatic draws are kept separate, because the rules do:

- **Claimable** (`game:claimDraw`, by the side to move): threefold repetition,
  fifty-move rule.
- **Automatic**: stalemate, insufficient material, fivefold repetition,
  seventy-five-move rule.

Repetition is counted over the first four FEN fields — placement, side to move,
castling rights, en passant target — as the rules require, rather than trusting a
library helper whose behaviour varies by build.

---

## Permissions

### One function, two uses

`computeCapabilities(subject, context)` in `packages/shared/src/permissions.ts`
returns a flat `Capabilities` record. The server calls it twice:

1. To build `you.can` for each viewer's snapshot — the interface renders from it.
2. Inside `Room.deny()` before performing any action.

Because both come from the same function, the interface can never offer
something the server will refuse, and a tampered client gains nothing: flipping
`can.kick` in devtools just makes a button appear that the server declines.

### Roles

| | Player | Spectator | Moderator | Host |
|---|---|---|---|---|
| Move | ✔ (own turn) | ✘ | ✘ | ✔ if seated |
| Chat | player channel | spectator channel | ✔ | ✔ |
| Offer draw / takeback / rematch | ✔ | ✘ | ✘ | ✔ if seated |
| See legal moves | ✔ (own turn) | ✘ | ✘ | ✔ if seated |
| See move list | ✔ | host's choice | ✔ | ✔ |
| Approve joins | ✘ | ✘ | ✔ | ✔ |
| Kick / ban / mute | ✘ | ✘ | ✔ | ✔ |
| Lock room | ✘ | ✘ | ✔ | ✔ |
| Change settings | ✘ | ✘ | ✘ | ✔ |
| Transfer host / set moderators | ✘ | ✘ | ✘ | ✔ |

`canActOn()` adds the hierarchy rules: nobody can act on themselves, nobody can
act on the host, and a moderator cannot discipline another moderator — only the
host can.

### Settings cannot change mid-match

`mutableSettingKeys(phase, movesPlayed)` returns the editable set. Once a move
has been played it collapses to presentation and access only:

**Frozen:** time control, rated, takebacks, draw offers, rematches, premoves,
guest policy, colours, host role, rating range.
**Still editable:** room name, spectators on/off, both chat channels, spectator
move-list visibility, spectator cap, join approval.

`mode` is never editable — it decides discoverability and is baked into the
room's code strategy.

The client renders the same function's output, so the interface disables exactly
what the server will reject, and says why.

---

## Security

| Concern | How it is handled |
|---|---|
| Input validation | Every inbound payload is parsed by a zod schema before touching state |
| Private room ids | 18 random bytes → 24 base64url chars (~144 bits) |
| Private join codes | 10 CSPRNG characters from an unambiguous alphabet (~50 bits), rate-limited |
| Passwords | scrypt with a per-room salt, from `node:crypto`. Never sent to clients |
| Reconnection tokens | `userId.nonce.HMAC-SHA256`. The nonce is stored hashed, so a token can be revoked without rotating the secret |
| Name/chat spoofing | Control characters, zero-width characters and bidi overrides stripped. Chat keeps newlines and tabs; names do not |
| XSS | React escapes on render; the server never emits HTML |
| Rate limiting | Token buckets per action per identity, plus a sliding window on room creation per IP, plus an HTTP limiter |
| Origin control | Explicit allowlist, with an opt-in for private-network origins so LAN works without enumerating device addresses |
| Secrets | `.env` is gitignored; `SESSION_SECRET` is generated at boot if unset, with a warning in production |

No bespoke cryptography — everything composes `node:crypto` primitives.

### Disconnects

- A socket dropping detaches it from the member. Other tabs for the same
  identity keep the member present.
- With no sockets left, the member is marked disconnected and a grace timer
  starts. Their clock keeps running, as it should.
- After the grace period, if their opponent is present, the game is awarded by
  abandonment. If nobody is there to receive the win, nothing happens.
- A host who leaves hands the room to a connected seated player, then any
  connected member.
- Leaving a live game outright forfeits it.
- Empty rooms are swept after `ROOM_EMPTY_TTL_MS`, and every room after
  `ROOM_MAX_AGE_MS`.

---

## The client

### State

`useStore` (zustand) holds the latest `RoomView` plus purely local concerns —
selection, a queued premove, toasts. There is no client-side game model: the
snapshot is the truth.

A local `chess.js` instance exists for exactly two jobs: deciding whether a click
is a promotion (so it can ask which piece), and validating a premove before
firing it. Neither decides legality for scoring.

### Rendering

The scene fills the viewport; the interface floats above it in pointer-transparent
zones so the board can be orbited from almost anywhere.

`ThemeModule` is the map contract: environment component, board materials, piece
style, highlight palette, interface skin, audio voice, camera rig, fog, exposure.
The scene composes them and knows nothing map-specific.

Both maps share `RoomShell` — a room with one glazed wall. It is deliberately
asymmetric: the window sits close in front of the board, the room runs back
behind the player.

**The board rotates, not the camera.** With an asymmetric room, mirroring the
camera for Black would put it outside the window looking back at the building, so
`Scene` wraps the board and pieces in a group rotated by the seat yaw instead.

That rotation is animated, and the rotation is set imperatively rather than
passed as a prop - a prop would be re-applied on every render, and a live game
re-renders on every clock tick. In a same-device game the board comes round
after every move; snapping it 180 degrees reads as though something else moved
the pieces, which is exactly how it was first reported.

The camera targets the *near* half of the board rather than a point past its far
edge. Since the board turns so your own pieces are always nearest, that puts the
side you are actually playing in the middle of the frame.

### Quality tiers

`QUALITY_BUDGETS` maps Low/Medium/High to concrete numbers: DPR cap, shadows and
shadow-map size, antialiasing, a particle multiplier, reflections, post-processing,
environment map size, environment detail, piece tessellation, anisotropy. `Auto`
picks from WebGL version, core count, device memory, max texture size and whether
the renderer is a software rasteriser.

Low reduces what is drawn. It never changes the rules, the board, or what a
player can do.

### Degradation

Every step has a defined fallback:

| Failure | What happens |
|---|---|
| No WebGL | 2D board, with a message saying why |
| WebGL context lost | Switches to the 2D board mid-game |
| Canvas mounts but never produces a renderer | Watchdog switches to 2D after 6s |
| Model pack missing or corrupt | Procedural geometry; the skyline gets a simple stand-in |
| Milky Way plate missing | Procedural starfield-and-nebula shader |
| Sound file missing | Synthesised cue from the same code path |
| Music file missing | Synthesised ambient bed only |
| Asset manifest missing | Everything procedural; the game is fully playable |

The last row is the one that matters: `packages/client/public/assets` can be
deleted entirely and the game still runs.

---

## Assets

Three stages, each independently runnable:

1. **`scripts/fetch-models.mjs`** — downloads the CC0 packs into the downloads
   folder. Originals are never modified.
2. **`scripts/build-models.mjs`** — converts FBX with headless Blender, merges
   each group into one GLB with named nodes, dedupes, welds, compresses textures
   to WebP and quantises. Writes `models/index.json`.
3. **`scripts/build-assets.mjs`** — textures, HDRIs, sound cues and music. Writes
   `assets/manifest.json`.

At runtime, `three/assets.ts` reads the manifest and `three/models.ts` loads and
caches packs. Every lookup can return null and every caller has a fallback.

`cloneNode()` re-grounds and rescales each model when it is cloned rather than
trusting the source file, because the packs come from different authors with
different conventions.

The FBX conversion can also produce materials that are silently undrawable —
base-colour alpha 0 with `alphaMode: MASK`, which discards every fragment. The
model then loads, measures and positions correctly and draws nothing at all.
`build-models.mjs` normalises those, and `scripts/repair-materials.mjs` fixes
packs that were built before the check existed.

---

## Scene layouts

Where every environment model stands is **data, not code**.

```
defaults.ts ──┐
              ├──▶ layout store ──▶ PropsLayer ──▶ the map
layouts/*.json┘         ▲
                        │
                   level editor
```

A `SceneLayout` is a list of `PlacedProp`s: which node from which pack, its
transform, how it should be grounded and scaled, material overrides, an
optional animation, and the lowest quality tier it appears at. The shape and
its zod validator live in `packages/shared/src/layout.ts`, so the save endpoint
validates exactly what the renderer consumes rather than a parallel definition
that can drift.

On mount a map fetches `/layouts/<theme>.json`. A missing or malformed file is
a supported state, not an error: the built-in layout in
`three/layout/defaults.ts` takes over, which is the same "assets are optional"
rule the rest of the renderer follows. The built-in layouts generate their
scattered props (towers, signage, station hardware) from fixed seeds, so the
city is identical on every load and on every device.

Quality scaling is per-prop rather than per-loop: each prop declares the lowest
environment-detail tier it appears at, so Low draws 8 towers, Medium 18 and
High 30 from one list — and each of those towers stays individually editable,
which placing them in a loop never allowed.

`PropsLayer` renders a layout for both the game and the editor. Picking and
selection outlines switch on from the layout store, so a map does not need to
know the editor exists. Transforms live on a wrapper `<group>` that React owns,
and the model itself is memoised on the fields that change its geometry — so
dragging the gizmo never reloads a model.

`packages/server/src/editor.ts` writes layouts back. It is off in production
unless `LEVEL_EDITOR=true`, the body is validated by the shared schema before
anything is written, and the filename comes from the validated theme id — an
enum — so no path can be smuggled in through the request.

See [LEVEL_EDITOR.md](LEVEL_EDITOR.md).

---

## Testing

| Layer | Where | What it covers |
|---|---|---|
| Rules | `tests/chess-rules.test.ts` | Castling, en passant, promotion, mates, every draw condition, takebacks, replay |
| Clock and Elo | `tests/clock-and-rating.test.ts` | Increment, flag fall, pause, takeback restore, rating maths |
| Permissions | `tests/permissions.test.ts` | The capability matrix, the settings freeze, sanitisation, schema validation |
| Rooms | `tests/rooms.test.ts` | Real sockets: identity, matchmaking, passwords, approval, spectators, moderation |
| Gameplay | `tests/gameplay.test.ts` | Real sockets: a full game, offers, clocks, reconnection, abandonment, ratings |
| Same-device | `tests/local-play.test.ts` | One player moving both colours: auto-start, immediate offers, no false forfeit |
| Layouts | `tests/scene-layout.test.ts` | The built-in layouts, the schema, and the editor save endpoint |
| End-to-end | `tests/e2e/rooms.spec.ts` | Real browsers, two isolated contexts, against a production build |

The socket tests boot a real server on an ephemeral port with an in-memory
database. Nothing is stubbed.

`scripts/visual-check.mjs` is separate: it drives both maps, a two-player match,
a same-device game and the level editor in a real browser, then reports draw
calls, triangle counts and per-frame image contrast alongside the screenshots.

The contrast figure matters more than it looks. Draw-call counts can lie - the
editor's axis gizmo renders a second pass and leaves its own numbers in
`gl.info` - so the check also measures the captured pixels and fails when a
frame comes out flat. A scene that failed to draw cannot hide from that.
