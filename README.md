# Cloth Simulator

Browser-based simulator that drapes a garment from a **photo** onto a parametric body, so you can see how it fits.

## How a photo becomes a garment
1. **Cut-out** (`src/image/segment.ts`): separates the garment from the backdrop. Uses the alpha channel of cut-out PNGs, otherwise the colour distance to the backdrop colour (auto-threshold, hole filling, gap closing for striped/patterned items). A slider lets you adjust it.
2. **Pattern mesh** (`src/garment/pattern.ts`): traces the outline, then triangulates the garment (Delaunay over the outline plus an interior grid). The 2D triangle mesh is the garment's flat sewing pattern.
3. **Panels and seams** (`src/cloth.ts`): the pattern is used as a front and a back panel. Outline points are either *sewn seams* (front and back share them: sides, shoulders, inseam) or *openings* (hem, neck, cuffs, waist). Garment type presets choose them automatically (`src/garment/presets.ts`); you can repaint them by dragging on the outline in the 2D editor.
4. **Drape**: position-based-dynamics cloth with stretch, shear, bend, body collision (torso, arms, legs, head, floor) and friction. Rest lengths come from the flat pattern at the real-world scale you give (garment length in cm × size), so a garment that is too small is stretched.
5. **Photo on the mesh**: each vertex keeps its pixel position as a UV coordinate, so the original photo (prints, stripes, wrinkles) is texture-mapped onto the draped mesh. The back panel reuses the front photo, slightly darker.
6. **Fit**: ease at chest/waist/hip measured from the pattern against the body, plus a fabric-tension or gap-to-body heatmap.

Garment types: tops with sleeves, sleeveless tops/dresses, trousers/shorts, skirts, and a custom mode.

```
npm install
npm run dev     # http://localhost:5173
npm test
npm run build
```

## Photo tips
Flat-lay or ghost-mannequin front view, garment fully visible, plain contrasting background, sleeves laid out. A cut-out PNG with a transparent background is the most reliable.

## Limitations / roadmap
- One 2D photo cannot reveal the back or the 3D shape; the back is the mirrored front texture. A second (back) photo is a planned addition.
- Garments with front openings (jackets, cardigans), layered or very voluminous items (coats, gowns) and hats/shoes are not modelled; no cloth self-collision yet.
- Segmentation is colour based. For white-on-white or busy backgrounds use a cut-out PNG, or plug in an ML matting model (e.g. rembg / SAM) in `segment.ts`.
- Body is a parametric stack of ellipses + capsules; next: SMPL / OBJ / GLB body loading with mesh collision.
- Fit analysis assumes a flat-lay tube (2 × flat width); stretch/stiffness are presets rather than measured fabric properties.
