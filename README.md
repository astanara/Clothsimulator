# Cloth Simulator

Browser-based simulator that drapes a garment from **photos** onto a parametric body or a **3D body scan**, so you can see how it fits.

```
npm install
npm run dev     # http://localhost:5173
npm test
npm run build
```

## Photos
Up to four photos per garment (plain background, or cut-out PNGs):

| Slot | Used for |
|---|---|
| **Flat-lay (unworn)** | The garment's true outline, so the sewing pattern. Preferred over *Front* for the shape. |
| **Front** | Texture of the front panel. If a flat-lay is also given, the front photo is registered onto the flat pattern (silhouette overlap fit) and used as the texture. |
| **Back** | Texture of the back panel. Registered as a mirror image of the pattern (auto-detected). Without it, the back is a darker copy of the front. |
| **Side** | Projected from the left/right onto surfaces that face sideways (sleeves, side seams). Tick *wearer faces right* if the front is on the right of the photo. Only garment pixels are projected. |

## How a photo becomes a garment
1. **Cut-out** (`src/image/segment.ts`): separates the garment from the backdrop (alpha channel, or colour distance to the backdrop with an automatic threshold, hole filling and gap closing for striped/patterned items).
2. **Pattern mesh** (`src/garment/pattern.ts`): traces the outline and triangulates the garment into a flat 2D sewing pattern.
3. **Registration** (`src/garment/align.ts`): front/back/side photos are fitted onto the pattern so each panel gets its own texture coordinates.
4. **Panels and seams** (`src/cloth.ts`): the pattern is a front and a back panel. Outline points are *sewn seams* (shared by both panels) or *openings* (hem, neck, cuffs, waist), chosen by the garment type preset (`src/garment/presets.ts`) and editable by painting on the 2D outline.
5. **Drape**: position-based-dynamics cloth with stretch, shear, bend, body collision and friction. Rest lengths come from the flat pattern at the real-world scale you give (length in cm x size), so a too-small garment is stretched.
6. **Fit**: ease at chest/waist/hip from the pattern against the body, plus tension and gap-to-body heatmaps.

Garment types: tops with sleeves, sleeveless tops/dresses, trousers/shorts, skirts, and a custom mode.

## Body scans
Load an OBJ, GLB/GLTF, PLY or STL (or try *Demo scan*). Code in `src/scan/`:
- **Normalise** (`normalize.ts`): finds the up axis (Z-up scans are fixed), the facing direction (toes point forward), scales to the height you enter and puts the feet on the floor. *Rotate 90°* fixes a wrong guess.
- **Collision** (`sdf.ts`): the mesh is voxelised (~0.9 cm) into a signed distance field (exact Euclidean distance transform) and the cloth collides against it. Watertight meshes work best; meshes with holes still collide (as a thin shell).
- **Measure** (`scanBody.ts`): chest/waist/hip/shoulder width are read from horizontal slices (tape measure = convex hull); arm angle, crotch and shoulder line are detected. The numbers fill the sliders, can be corrected, and feed the fit report.
- For skirts, dresses and long tops the gap between the legs is closed so the garment hangs from the hips. Sleeves of a flat-lay top are swung to match the scan's arm pose.

## Limitations / roadmap
- Photos must show the garment alone (flat, on a hanger or ghost mannequin). Photos of garments worn by a person would need a clothing-segmentation model to remove the person.
- The side photo is a projected texture; it does not change the garment's shape. The back panel reuses the front outline (no different back neckline yet).
- Garments with front openings (jackets, cardigans), voluminous or layered items, hats and shoes are not modelled; no cloth self-collision yet.
- Segmentation is colour based. For white-on-white or busy backgrounds use a cut-out PNG, or plug in an ML matting model in `segment.ts`.
- Scan measurement uses fixed height bands and assumes a standing pose with the arms away from the torso. Fit analysis assumes a flat-lay tube (2 x flat width). Stretch and stiffness are fabric presets.
