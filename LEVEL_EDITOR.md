# Level editor

Dress a map by dragging its models around inside the real scene, then save.

```bash
npm run dev
```

Then open **<http://localhost:5173/editor>** — or click **Level editor** at the
bottom of the main menu.

It edits scenery only. Nothing in here can change the rules, the board, the
clock, or anything a player can do.

---

## Why this rather than Blender

Both are reasonable ways to move a sofa. The editor wins for *this* job because
the thing you are judging — does the room look right — depends on the game's own
lighting rig, camera, fog, tone mapping and board position. A room that looks
balanced in Blender's viewport will not look balanced through a 46° lens sitting
at eye height behind a chess board, and you would not find that out until you
exported, re-optimised and reloaded.

So the editor renders **the actual map**: same models, same materials, same
lights, same board, same camera the game uses. What you see is what you will
play in.

Blender is still the right tool for *making* geometry. If you model something
new, put the source in `Chess Models/`, add it to a group in
`scripts/build-models.mjs`, run `npm run assets:models`, and it appears in the
editor's **Add model** palette like everything else.

---

## The screen

| Where | What |
|---|---|
| Top bar | Map, transform tool, axis space, snapping, camera presets, undo/redo, save |
| Left | **Scene** — everything in the map, grouped. **Add model** — every model in every pack |
| Right | The selected model's numbers |
| Bottom | Board / grid / work light toggles, model count, save state |

Click a model in the viewport or the outliner to select it. Drag the coloured
gizmo arrows to move it, or type exact numbers on the right — both write to the
same place.

### Keys

| Key | Does |
|---|---|
| `W` `E` `R` | Move / rotate / scale |
| `X` | World or local axes |
| `F` | Fly the camera to the selection |
| `L` | Work light on/off |
| `G` | Grid on/off |
| `U` | Hide the panels |
| `H` | Hide/show the selected model |
| `Del` | Remove the selected model |
| `Ctrl+D` | Duplicate |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+S` | Save |

Middle-drag or right-drag pans; the scroll wheel zooms. Unlike in-game, the
camera has no limits — you can go outside the room, under the floor, or out
among the buildings.

### Camera presets

- **Game view** — exactly where a player sits. Check your work here before saving.
- **Wide** — above the rear corner, looking down into the whole room.
- **Top** — straight down.

### Work light

Both maps are lit for atmosphere, which leaves the near corners nearly black —
fine to play in, impossible to arrange furniture in. The work light adds a flat
white fill so you can see what you are doing. It is an editing aid and is never
part of the map, so switch it off before judging how a change actually looks.

---

## The inspector

**Position / Rotation / Scale** — rotation is in degrees. Scale is a multiplier
on top of the model's base size.

**Fit height** — normalises the model to that many world units tall before Scale
is applied. This is how the furniture is authored: a chair is "1.1 units tall"
rather than "0.0137 × the size it happened to be exported at". Clear it to size
the model with **Base scale** instead.

**Sit base on Y** — re-origins the model so its lowest point sits at the Y you
set, rather than trusting the origin in the source file. The packs come from
several authors and their origins are not consistent, so leave this on for
anything standing on the floor. Turn it off for things that hang or float —
signage, planets, station hardware.

**Shows from quality** — the lowest graphics setting this model appears at. This
is how the maps stay playable on a weak machine: 8 towers on Low, 18 on Medium,
30 on High. Anything you add defaults to showing everywhere.

**Material** — brightness, tint, emissive colour and strength, roughness and
metalness, layered on top of whatever the model came with. Turn *Tone mapped*
off to make a neon sign punch past the tone mapper.

**Animation** — *Flicker* for signage (rate 0 breathes slowly, above 0 is a
failing tube) and *Spin* for planets drifting past the viewport.

---

## Saving

**Save** writes `packages/client/public/layouts/<map>.json`, and — if a built
client is present — a second copy into `packages/client/dist/layouts/`, so a
running server picks it up without a rebuild. The map loads that file next time
it starts.

Saving to disk is on in development and **off in production**. To turn it on for
a machine that serves the built client:

```bash
LEVEL_EDITOR=true npm start
```

`LAYOUT_DIR` overrides where layouts are written, if you want them somewhere
other than the client's public folder.

**Download** always works, server or not — it hands you the JSON to drop into
`packages/client/public/layouts/` yourself. **Import** reads one back.

**Reset** restores the layout the map shipped with. It only changes what is on
screen; save afterwards to keep it.

### Undoing everything

Delete `packages/client/public/layouts/<map>.json`. A missing file is normal —
the map falls back to the built-in layout in
`packages/client/src/three/layout/defaults.ts`.

A layout file is validated when it loads. An invalid one is reported in the
browser console and ignored, so a bad edit can never leave you with a black
screen.

---

## How it fits together

```
defaults.ts ──┐
              ├──▶ layout store ──▶ PropsLayer ──▶ the map you play in
layouts/*.json┘         ▲
                        │
                   level editor
```

- `packages/shared/src/layout.ts` — the shape of a layout, and its validator.
  Shared, so the save endpoint checks exactly what the renderer consumes.
- `packages/client/src/three/layout/defaults.ts` — the built-in layout for each
  map, generated from fixed seeds so the city is identical on every load.
- `packages/client/src/three/layout/store.ts` — the live layout, plus undo.
- `packages/client/src/three/layout/PropsLayer.tsx` — turns a layout into scene
  objects. Used by the maps and the editor alike.
- `packages/server/src/editor.ts` — the save endpoint. The filename comes from
  the validated map id, never from the request body.

---

## Adding new models

The palette lists whatever `assets/models/index.json` says was built, so new
models show up on their own once the pipeline has run:

```bash
npm run assets:models
```

If a model loads but draws nothing, check its materials:

```bash
npm run assets:repair
```

Several source packs convert with a base-colour alpha of 0 and `alphaMode: MASK`,
which discards every fragment — the model loads, measures and positions
correctly, and is completely invisible. That is what had happened to the
apartment furniture and most of the station fittings. `assets:repair` reports
the damage; `node scripts/repair-materials.mjs --write` fixes it, and the model
build now normalises it automatically.
