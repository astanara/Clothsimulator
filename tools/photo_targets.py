#!/usr/bin/env python3
"""
Read torso widths (front photo) and depths (side photo) from two photos taken in fitted clothing
(sports bra + leggings work well: the clothing outlines the torso without the arms), and calibrate
the photo scale with tape measurements. Writes the targets file used by tools/fit_body.py.

  python tools/photo_targets.py --front front.jpg --side side.jpg --height 177 \
      --chest 96.5 --waist 80 --hip 94 --out tools/body_targets.json

Needs: numpy pillow scipy mediapipe. Two small model files are downloaded once to tools/.cache
(Google's person-segmentation and pose models). Photos are processed locally and never stored.
Photo tips: whole torso and hips in frame, standing straight, camera at about hip height, arms away
from the torso; a raised arm (phone selfie) is fine as long as it does not cover the bra or leggings.
"""
import argparse, json, math, os, sys, urllib.request
import numpy as np
from PIL import Image, ImageOps
from scipy.optimize import minimize_scalar

SEG_URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite"
POSE_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task"
CLOTHES = 4  # class id of "clothes" in the multiclass selfie segmenter


def fetch(url, name):
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    if not os.path.exists(path):
        print("downloading", name)
        urllib.request.urlretrieve(url, path)
    return path


def analyse(path):
    import mediapipe as mp
    from mediapipe.tasks import python as mpt
    from mediapipe.tasks.python import vision

    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    mi = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(im))
    seg = vision.ImageSegmenter.create_from_options(
        vision.ImageSegmenterOptions(base_options=mpt.BaseOptions(model_asset_path=fetch(SEG_URL, "seg.tflite")), output_category_mask=True)
    )
    pose = vision.PoseLandmarker.create_from_options(
        vision.PoseLandmarkerOptions(base_options=mpt.BaseOptions(model_asset_path=fetch(POSE_URL, "pose.task")), num_poses=1)
    )
    cat = np.squeeze(seg.segment(mi).category_mask.numpy_view().copy())
    res = pose.detect(mi)
    if not res.pose_landmarks:
        raise SystemExit(f"no person found in {path}")
    H, W = cat.shape
    lm = [(l.x * W, l.y * H) for l in res.pose_landmarks[0]]
    shoulder_y = (lm[11][1] + lm[12][1]) / 2
    hip_y = (lm[23][1] + lm[24][1]) / 2
    cx = (lm[11][0] + lm[12][0] + lm[23][0] + lm[24][0]) / 4
    return cat, shoulder_y, hip_y, cx


def runs(row, gap=10):
    xs = np.flatnonzero(row)
    if len(xs) == 0:
        return []
    out, s, p = [], xs[0], xs[0]
    for x in xs[1:]:
        if x - p > gap:
            out.append((s, p))
            s = x
        p = x
    out.append((s, p))
    return out


def torso_widths(cat, shoulder_y, hip_y, cx):
    """Width (px) of the clothing run nearest the body axis, per row, for the two garments (top, bottom)."""
    mask = cat == CLOTHES
    rows = {}
    for y in range(int(max(0, shoulder_y - 80)), min(cat.shape[0], int(hip_y + 0.9 * (hip_y - shoulder_y)))):
        best = None
        for a, b in runs(mask[y]):
            if b - a > 60 and (best is None or abs((a + b) / 2 - cx) < abs((best[0] + best[1]) / 2 - cx)):
                best = (a, b)
        if best:
            rows[y] = best[1] - best[0]
    ys = sorted(rows)
    groups, cur = [], [ys[0]]
    for y in ys[1:]:
        if y - cur[-1] > 40:
            groups.append(cur)
            cur = []
        cur.append(y)
    groups.append(cur)
    if len(groups) < 2:
        raise SystemExit("could not find both a top and a bottom garment (need e.g. sports bra + leggings)")
    top, bottom = groups[0], groups[-1]
    tl = hip_y - shoulder_y
    chest = max(rows[y] for y in top)
    # the waistband's top edge can be slanted in the side view: look a little below it
    waist = min(rows[y] for y in bottom if bottom[0] + 0.07 * tl <= y <= bottom[0] + 0.15 * tl)
    hip = max(rows[y] for y in bottom if y <= bottom[0] + 0.4 * tl)
    return {"chest": chest, "waist": waist, "hip": hip}, tl


def ellipse_perimeter(a, b):
    return math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--front", required=True)
    ap.add_argument("--side", required=True)
    ap.add_argument("--height", type=float, required=True)
    ap.add_argument("--chest", type=float, required=True)
    ap.add_argument("--waist", type=float, required=True)
    ap.add_argument("--hip", type=float, required=True)
    ap.add_argument("--shoulder", type=float, default=42.0, help="shoulder width in cm (default 42)")
    ap.add_argument("--out", default="tools/body_targets.json")
    a = ap.parse_args()
    tape = {"chest": a.chest, "waist": a.waist, "hip": a.hip}
    fw, f_len = torso_widths(*analyse(a.front))
    sd, s_len = torso_widths(*analyse(a.side))
    k = f_len / s_len  # side photo scale relative to front photo (same real torso length in both)

    def err(s):
        tot = 0.0
        for lvl, t in tape.items():
            c = ellipse_perimeter(fw[lvl] * s / 2, sd[lvl] * k * s / 2)
            tot += (c - t) ** 2
        return tot

    s = minimize_scalar(err, bounds=(0.005, 0.2), method="bounded").x
    out = {
        "_note": "Tape measurements (cm) and torso widths/depths (cm) read from front/side photos by tools/photo_targets.py. No photos are stored.",
        "height_cm": a.height,
        "tape_cm": tape,
        "width_cm": {l: round(fw[l] * s, 1) for l in tape},
        "depth_cm": {l: round(sd[l] * k * s, 1) for l in tape},
        "shoulder_cm": a.shoulder,
    }
    print(json.dumps(out, indent=2))
    print(f"photo scale: {s:.4f} cm/px (front); side/front scale ratio {k:.3f}")
    for l in tape:
        c = ellipse_perimeter(out["width_cm"][l] / 2, out["depth_cm"][l] / 2)
        print(f"  {l}: ellipse girth from photos {c:.1f} cm vs tape {tape[l]} cm")
    json.dump(out, open(a.out, "w"), indent=2)


if __name__ == "__main__":
    sys.exit(main())
