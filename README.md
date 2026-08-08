# Keycap Forge

Generates a flat, square G20-profile keycap (16.3 × 16.3 × 4.5mm) with a
two-color pixel-art icon fused into the top face — pre-oriented flat-side-down
so it prints without supports, with a clean Cherry MX cross stem socket.

Runs entirely in the browser (Three.js). Nothing is uploaded to a server.

## How to use it

1. Upload a **square (1:1)** image — PNG, JPG, WebP or SVG. Transparent PNG/SVG
   gives the cleanest icon edges; for JPG/flat images the tool falls back to
   detecting the background from the four corner pixels.
2. Adjust icon size, pixel detail, and choose Black/White or the colors
   sampled from your upload.
3. Download `keycap-base.stl` and `keycap-icon.stl`.
4. Import both into Bambu Studio (or any multi-color slicer), assign one
   filament per object, and slice — no rotation, no supports needed.
5. Optionally import `keycap-print-settings.json` as a Bambu Studio process
   preset (8% infill, 2 walls) so it doesn't default to 100% density.

## Fixed specs (not adjustable in the UI — by design)

| Property | Value |
|---|---|
| Footprint | 16.3 × 16.3 mm |
| Total height | 4.5 mm |
| Profile | Flat / G20 |
| Icon layer thickness | 0.8 mm |
| Stem | Cherry MX cross, 4.0 × 4.0mm span, 1.3mm blade width, 3.5mm deep |
| Print orientation | Flat face baked in at Z=0 — icon side down on the bed |

## Deploy your own copy on GitHub Pages

1. **Create a GitHub account** at github.com if you don't have one (free).
2. **New repository**: click the **+** in the top right → **New repository**.
   Give it a name (e.g. `keycap-forge`), set it to **Public**, click
   **Create repository**.
3. **Upload the files**: on the empty repo page, click **uploading an
   existing file**, drag in `index.html`, `app.js` and `README.md`, then
   **Commit changes**.
4. **Enable Pages**: go to **Settings → Pages**. Under **Branch**, pick
   `main` / `(root)`, click **Save**.
5. Wait about a minute, refresh — you'll get a live link like
   `https://yourusername.github.io/keycap-forge/`.

Editing later: open the file in your repo, click the pencil (Edit) icon,
change it, **Commit changes**. Pages redeploys automatically within a minute.

## How the geometry is built

No CSG library is used. The Cherry MX cross cavity is built from 8
non-overlapping boxes tiled around the cross shape (the same "build with
individual blocks" approach as hand-placing pixel art in Tinkercad, just
applied to a cutout instead of a raised shape). The icon and base colors are
exported as two separate meshes/STLs, matching a standard multi-color
Bambu Studio workflow.
