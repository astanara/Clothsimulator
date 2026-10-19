# Cloth Simulator

Browser-based simulator for how a garment fits a person.

- **Parametric body** from measurements (height, chest, waist, hip, shoulders), modelled as a stack of elliptical cross-sections (`src/body.ts`).
- **Measurement fit** (`src/fit.ts`): ease per region, a fit verdict, and a size recommendation from a size chart.
- **Physics drape** (`src/cloth.ts`): position-based-dynamics cloth with stretch, shear and bend constraints, body collision and friction. The garment pattern sets the rest lengths, so a too-small size ends up stretched.
- **Heatmap**: fabric tension (red = tight) or gap to the body.

```
npm install
npm run dev     # http://localhost:5173
npm test
npm run build
```

## Current limits / roadmap
- Garment is a sleeveless tube top pinned at the shoulder line; no sleeves, trousers or dresses yet.
- Body is torso-only for collision (legs and arms are display-only), and cross-sections are elliptical.
- Next: sleeves and pants patterns, loading body meshes (OBJ/GLB/SMPL), mesh-based collision, garment pattern editor, per-fabric stretch/weight presets.
