# Asset credits and licences

Every third-party asset shipped with Gambit3D is listed here. Each entry was
downloaded from the source URL shown, and the licence was read on the source
site at download time (2026-08-19/20) rather than assumed.

Only optimised derivatives are copied into the project, by
[`scripts/build-assets.mjs`](scripts/build-assets.mjs) and
[`scripts/build-models.mjs`](scripts/build-models.mjs).

> **Attribution.** The one CC BY item, the ESO Milky Way plate, keeps its visible
> credit in-app on the Credits screen and in the Orbital Station map's info panel.

## Licence summary

| Licence | Items | Attribution required? | Redistribution allowed? |
|---|---|---|---|
| CC0 1.0 Universal | 8 packs / ~100 shipped files | No (given anyway) | Yes |
| CC BY 4.0 | 1 image | **Yes — shown in-app** | Yes |

---

## 3D models

All models are by **Quaternius** (quaternius.com), all **CC0 1.0**, verified both
on each pack page and in the `License.txt` bundled inside each download.

| Pack | Source | What it provides | Shipped as |
|---|---|---|---|
| Ultimate Modular Sci-Fi Pack | https://quaternius.com/packs/ultimatemodularscifi.html | Consoles, crates, pods, vessels, columns, pipes | `assets/models/station-props.glb` (570 KB, 14 nodes) |
| Ultimate Furniture Pack | https://quaternius.com/packs/ultimatefurniture.html | Sofas, tables, chairs, bookcases, desk | `assets/models/apartment-furniture.glb` (912 KB, 11 nodes) |
| Ultimate Space Kit | https://quaternius.com/packs/ultimatespacekit.html | Planets, geodesic dome, station hardware | `assets/models/space-scenery.glb` (345 KB, 7 nodes) |
| Cyberpunk Game Kit | https://quaternius.com/packs/cyberpunkgamekit.html | Neon signs, screens, aerials, AC units, cables, street lights | `assets/models/city-props.glb` (155 KB, 16 nodes) |
| Downtown City MegaKit (free/Standard) | https://quaternius.itch.io/downtown-city-megakit | Three complete city buildings with baked lit-window textures | `assets/models/city-buildings.glb` (4.2 MB, 3 nodes) |
| Chess Set | https://polyhaven.com/a/chess_set | The playable piece geometry | `assets/models/classic-pieces.glb` (633 KB, 6 nodes) |

**Chess Set** is by **Riley Queen**, via Poly Haven, **CC0 1.0** — verified at
https://polyhaven.com/license.

**Modifications.** Quaternius ships FBX/OBJ/Blend (and glTF for some packs).
`scripts/build-models.mjs` converts FBX with Blender in headless mode
(`scripts/lib/fbx_to_glb.py`), merges each group into a single GLB with named
nodes, deduplicates, welds, re-encodes textures to WebP and quantises vertex
attributes. For the chess set, the source scene places 32 pieces on a board; the
pipeline keeps one node per piece type, renames them `piece_p` … `piece_k`, and
discards the rest. The board is drawn procedurally instead so every square is an
individually interactive mesh.

Materials are also normalised. The FBX conversion produced a base-colour alpha
of 0 together with `alphaMode: MASK` for the *Ultimate Furniture Pack* and most
of the *Ultimate Modular Sci-Fi Pack*, which discards every fragment and makes
the models invisible. `scripts/repair-materials.mjs` sets those materials back
to opaque; nothing else about them is altered, and no colour, geometry or
texture is changed. This is a repair of a conversion artefact, not an artistic
modification of the original work.

### ⚠️ Correction about the neon signage

An earlier draft of this file claimed that *all* signage in the city map was
original to this project. That is **not** accurate for the current build. The
neon signs, screens and hazard plates visible through the apartment window are
the **Cyberpunk Game Kit's own textures by Quaternius**, which include invented
Japanese and Latin lettering authored by Quaternius, not by this project. They
are CC0, so there is no licensing problem — but the credit belongs to
Quaternius. No real brand, logo, or copyrighted character appears in the pack or
in this game.

---

## HDRI environment map

| Field | Value |
|---|---|
| Asset | Rooftop Night |
| Creator | Greg Zaal |
| Source | https://polyhaven.com/a/rooftop_night |
| Licence | **CC0 1.0** |
| Used by | Neon City Apartment — image-based lighting and reflections only (it is *not* drawn as the backdrop; the backdrop is the modelled city) |
| Shipped as | `assets/hdri/apartment-night.hdr` (1.5 MB, copied unmodified) |

**Also downloaded, no longer used:** `spruit_sunrise` (Greg Zaal, Poly Haven,
CC0) was fetched for the since-removed shrine map. It remains in the downloads
folder and is not shipped.

---

## Sky plate

### The Milky Way panorama — Orbital Station

| Field | Value |
|---|---|
| Credit | **ESO/S. Brunier** |
| Source | https://www.eso.org/public/images/eso0932a/ |
| Licence | **CC BY 4.0** — verified at https://www.eso.org/public/outreach/copyright/ |
| Used by | Orbital Station (equirectangular sky sphere) |
| Original | `eso/eso0932a_publicationjpg.jpg` (4000×2000), `_large.jpg` (6000×3000), `_screen.jpg` |
| Shipped as | `assets/textures/milkyway-4k.webp` (1.4 MB) and `milkyway-lod.webp` (51 KB, used at Low quality) |

**Attribution obligation.** CC BY 4.0 requires the credit to be clear and
visible. ESO's own guidance for games is that a credit shown to all users, for
example on a splash screen, satisfies this. Gambit3D shows **"ESO/S. Brunier"**
on the in-app Credits screen and in the Orbital Station map info panel. Do not
remove either without also removing this image.

**Modifications.** Resized to 4096 px wide and re-encoded to WebP. No cropping
or recolouring.

---

## PBR textures

All from **ambientCG**, all **CC0 1.0** — verified at
https://docs.ambientcg.com/license/. Creator: Lennart Demes (ambientCG).

| Asset | Source | Maps used | Used by | Shipped as |
|---|---|---|---|---|
| `Marble012` | https://ambientcg.com/a/Marble012 | Color, NormalGL, Roughness | Neon City Apartment (floor) | `textures/marble-*.webp` |
| `MetalPlates006` | https://ambientcg.com/a/MetalPlates006 | Color, NormalGL, Roughness, Metalness | Orbital Station (deck, walls, board) | `textures/metal-*.webp` |
| `Asphalt033` | https://ambientcg.com/a/Asphalt033 | Color, NormalGL, Roughness, AmbientOcclusion | Apartment (wall render, board surface) | `textures/asphalt-*.webp` |

**Modifications.** Resized to 1024², re-encoded to WebP.

**Also downloaded but not shipped:** `Metal032` and `Concrete034` were
downloaded, measured, and rejected — their normal maps had a standard deviation
below 1, i.e. they were effectively flat and added nothing.

---

## Sound effects

All from **Kenney**, all **CC0 1.0** — licence text ships inside each pack
(`License.txt`: *"License: (Creative Commons Zero, CC0)"*).
Creator: Kenney (kenney.nl).

| Pack | Source | Files | Used for |
|---|---|---|---|
| Interface Sounds | https://kenney.nl/assets/interface-sounds | 100 | UI clicks, errors, ticks (both maps) |
| Digital Audio | https://kenney.nl/assets/digital-audio | 63 | Apartment: zaps, power-ups, phase jumps |
| Sci-fi Sounds | https://kenney.nl/assets/sci-fi-sounds | 73 | Station: metal impacts, force fields, station tones |
| Impact Sounds | https://kenney.nl/assets/impact-sounds | 130 | (downloaded; used by the removed shrine map, now held in reserve) |
| UI Audio, Music Jingles, Casino Audio | kenney.nl | 190 | (downloaded; unused) |

24 individual `.ogg` files (12 cues × 2 maps) are copied into
`assets/sfx/<map>/<cue>.ogg`. The exact source file for each cue is the
`SOUND_MAP` table in `scripts/build-assets.mjs` — that table is the
machine-readable version of this credit.

**Security note.** Every archive was scanned before extraction: they contain only
`.ogg`, `.txt`, `.url` and `.ini` entries. No executables or scripts were present
or run. Only `.ogg` and `.txt` were extracted. The Downtown City MegaKit zip was
scanned the same way (306 FBX, 153 glTF, 153 bin, 71 PNG, 4 JPG, 3 HDR, 1 TXT —
no executables).

---

## Music

From **OpenGameArt.org**, both **CC0 1.0** (verified in each item's
*License(s)* field).

| Track | Composer | Source | Map | Shipped as |
|---|---|---|---|---|
| Robotic City V2 | **section31** | https://opengameart.org/content/robotic-city-v2 | Neon City Apartment | `assets/music/apartment-ambience.ogg` (3.8 MB) |
| Deep Space Array | **Tozan** | https://opengameart.org/content/deep-space-array | Orbital Station | `assets/music/station-ambience.ogg` (0.6 MB) |

**Also downloaded, not currently shipped** (kept as alternates, all CC0):

| Track | Composer | Source |
|---|---|---|
| Hot Springs Town | Kistol | https://opengameart.org/content/hot-springs-town |
| Lights at Night | Tsorthan Grove | https://opengameart.org/content/lights-at-night |
| Pondering the Cosmos | Ruskerdax | https://opengameart.org/content/pondering-the-cosmos |

---

## Original / procedural work

The following are **not** downloaded — they are generated by this project's own
code and carry no third-party licence:

- **The room interiors.** Floor, walls, ceiling, glazed wall, mullions, cove
  lighting and board plinth are all built at runtime in
  `packages/client/src/three/themes/RoomShell.tsx`.
- **The board.** All 64 squares, the frame and the coordinate labels are built at
  runtime so each square is independently interactive.
- **The stylised piece sets.** Lathe-and-extrude geometry generated in
  `packages/client/src/three/pieces.ts`. This is the fallback set used whenever
  `classic-pieces.glb` is unavailable, and the basis for each map's stylised
  variant (holographic, energy).
- **All ambient sound beds.** Rain and station-hum layers are synthesised from
  oscillators and filtered noise in `packages/client/src/audio/engine.ts`. Every
  sound effect also has a synthesised fallback, so audio still works with no
  downloaded files present.
- **All shaders**, including the procedural starfield/nebula that replaces the
  Milky Way plate if it fails to load.
- **Rain and low-gravity particle systems.**
- **All UI, iconography, layout and typography choices.**

## Fonts

The app uses system font stacks only (`system-ui`, `ui-monospace` and their
fallbacks). No web fonts are downloaded or bundled, so there is no font licence
to track.

---

## How to re-verify

```bash
node scripts/fetch-models.mjs --force && node scripts/build-models.mjs --force && node scripts/build-assets.mjs --force
```

Each script prints every file it writes and warns about any source it could not
find. Nothing is fabricated: if a source is missing, the corresponding manifest
entry is `null` and the game falls back to its procedural equivalent.
