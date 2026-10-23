# Plan: high quality body + photoreal render on PC

Goal: your measured body (not a generic mannequin) wearing a simulated garment, rendered at product-photo quality on a PC, with a way to view the result on a phone.

## Stage 1 - a real body model (the biggest quality jump)
Today the body is ellipses and capsules. Replace it with a proper human mesh (~10-20k vertices, smooth, watertight) that the app already knows how to use as a scan (OBJ -> signed distance field -> collision).

Options for producing the mesh from your data:

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Fit a statistical body model (SMPL-X) | Optimise its shape parameters so its silhouettes match the front/side masks already extracted from your photos and its circumferences match your tape measurements | Realistic anatomy, poseable, uses all of your data | Research licence (personal/non-commercial use only); needs a Python + PyTorch setup, GPU helps |
| B. MakeHuman / MB-Lab | Set the sliders from your measurements, export OBJ | Permissive licence for the output, no GPU, easy | Less faithful to your shape; manual tuning |
| C. Real scan | Phone photogrammetry/LiDAR scan app, export OBJ/GLB | Most faithful | Needs a good scan session; clothing-tight and A-pose |

Recommendation: **A, with B as a fallback.** Deliverables: `tools/fit_body.py` (photos + measurements -> `body.obj`), a fit report (circumference error at chest/waist/hips, silhouette overlap), and `body.obj` loaded through the existing scan path.

Inputs I already have: person/clothing masks and pose landmarks for the front and side photos, calibrated photo scale (about 0.04 cm/px), and the torso depth/width ratios.

## Stage 2 - garment pipeline on top of the new body
- Keep: photo -> pattern -> panels/seams -> cloth drape against the body's distance field.
- Improve: back/side photo registration; separate front/back outlines (e.g. different necklines); real straps as geometry; cloth self-collision; export of the draped, textured garment as GLB (already exists) at 1 cm triangles or finer.

## Stage 3 - offline photoreal render (Blender Cycles)
- `tools/render_blender.py`: imports the body and garment GLB, assigns materials (skin with subsurface scattering, leather/satin/knit shaders with real normal and roughness maps), HDRI studio lighting, soft shadows, 4K output; run with `blender -b -P tools/render_blender.py -- body.obj garment.glb out.png`.
- Camera presets: front, 3/4, side, back, plus a turntable.
- Needs a PC with Blender 4.x; a GPU makes a 4K frame take seconds to a minute instead of many minutes.

## Stage 4 - mobile
See the answer in chat: view and share from the phone rather than render on it.
1. Responsive web viewer: run `npm run dev -- --host` and open the PC's address on the phone (same Wi-Fi); or host the built site.
2. Send the finished GLB to the phone for AR (iOS Quick Look needs USDZ, Android Scene Viewer takes GLB).
3. Optional AI "polish": take a finished PNG to an image-to-image app by hand (see risks in the chat answer).

## Decisions I need from you
1. PC: OS and GPU (NVIDIA?), and is installing Blender and Python/PyTorch OK?
2. Body model: OK with SMPL-X (personal-use licence) or prefer MakeHuman?
3. Which extra photos can you take: arms-out A-pose front, side, and back in tight clothing, standing straight, whole body in frame, camera at hip height?
4. Privacy: all processing stays on your PC/this sandbox; confirm you do not want body photos sent to any online service.
