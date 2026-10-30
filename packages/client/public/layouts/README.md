# Scene layouts

One JSON file per map, naming every environment model and where it stands:

- `apartment.json` — Neon City Apartment
- `station.json` — Orbital Station

These are written by the level editor at `/editor`, and read by the map at
runtime. **A missing file is normal** — the map falls back to the layout built
into `packages/client/src/three/layout/defaults.ts`, which is what the game
shipped with.

So:

- **To undo everything** and go back to the original dressing, delete the file
  for that map. (Or press **Reset** in the editor and save.)
- **To share a layout**, copy the file. It is plain JSON with no absolute paths.
- **To hand-edit**, go ahead — the file is validated on load, and an invalid one
  is reported in the browser console and ignored rather than breaking the map.

The editor also writes a copy into `packages/client/dist/layouts/` when a built
client is present, so a save takes effect on a running server without a rebuild.
`npm run build` regenerates that copy from this folder.

See [LEVEL_EDITOR.md](../../../../LEVEL_EDITOR.md).
