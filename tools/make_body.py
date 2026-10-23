#!/usr/bin/env python3
"""
Smooth, watertight body mesh from measurements (no licensed assets needed).

Torso cross-sections (circumference + front/back depth ratio at several heights), legs, arms,
hands, feet, neck and head are signed-distance primitives blended with a smooth union, then
meshed with marching cubes. Load the resulting OBJ in the app with "Load body scan...".

  python tools/make_body.py --out body.obj
  python tools/make_body.py --height 177 --chest 96.5 --waist 80 --hip 94 --out body.obj

All lengths in cm. Defaults are the measurements entered in the app.
"""
import argparse, json, math
import numpy as np
from skimage import measure


def ellipse_axes(circ, ratio):
    """Semi-axes a (width) and b (depth) of an ellipse with perimeter `circ` and b/a = ratio."""
    a = 1.0
    b = ratio
    per = math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))
    s = circ / per
    return a * s, b * s


def smin(a, b, k):
    """Polynomial smooth minimum (smooth union of two distance fields)."""
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def capsule(P, a, b, ra, rb):
    """Distance to a round cone from a (radius ra) to b (radius rb). P: (...,3)."""
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    ab = b - a
    t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
    c = a + t[..., None] * ab
    return np.linalg.norm(P - c, axis=-1) - (ra + (rb - ra) * t)


def ellipsoid(P, c, r):
    q = (P - np.asarray(c)) / np.asarray(r)
    k0 = np.linalg.norm(q, axis=-1)
    k1 = np.linalg.norm(q / np.asarray(r), axis=-1)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def build(m, voxel=0.005):
    H = m["height"] / 100.0
    cm = lambda v: v / 100.0
    dr = m["depth"]
    # torso keys: (height fraction, circumference m, depth/width)
    keys = [
        (0.47, cm(m["hip"]), dr["hip"]),
        (0.52, cm(m["hip"]), dr["hip"]),
        (0.57, cm(m["upperHip"]), (dr["hip"] + dr["waist"]) / 2),
        (0.62, cm(m["waist"]), dr["waist"]),
        (0.67, cm(m["ribcage"]), (dr["waist"] + dr["chest"]) / 2),
        (0.72, cm(m["chest"]), dr["chest"]),
        (0.82, max(cm(m["shoulder"]) * 2.15, cm(m["chest"]) * 0.97), 0.52),
        (0.86, 0.40, 0.85),
    ]
    fr = np.array([k[0] for k in keys])
    axes = np.array([ellipse_axes(k[1], k[2]) for k in keys])  # (n,2)

    def torso_axes(y):
        f = np.clip(y / H, 0.38, fr[-1])
        fk = np.clip(f, fr[0], fr[-1])
        a = np.interp(fk, fr, axes[:, 0])
        b = np.interp(fk, fr, axes[:, 1])
        # below the hips the pelvis tapers into the thighs (no ledge where legs start)
        t = np.interp(y / H, [0.40, 0.46, 0.52], [0.60, 0.86, 1.0])
        tb = np.interp(y / H, [0.40, 0.46, 0.52], [0.72, 0.92, 1.0])
        return a * t, b * tb

    hip_a = axes[0, 0]
    y_crotch, y_neck = 0.47 * H, 0.87 * H
    th = math.radians(m["arm_angle"])
    sh_y = 0.82 * H - 0.035
    sh_a = axes[6, 0]

    def field(P):
        x, y, z = P[..., 0], P[..., 1], P[..., 2]
        a, b = torso_axes(y)
        f = np.sqrt((x / a) ** 2 + (z / b) ** 2)
        d_xz = (f - 1.0) * np.minimum(a, b)
        d_torso = np.maximum.reduce([d_xz, y - y_neck, 0.42 * H - y])
        d = d_torso
        # glutes / pelvis fullness
        d = smin(d, ellipsoid(P, (0, 0.52 * H, -0.015), (hip_a * 0.98, 0.075 * H, axes[1, 1] * 1.05)), 0.05)
        # legs
        r_thigh = hip_a * 0.47
        for s in (-1, 1):
            hipj = (s * hip_a * 0.52, y_crotch + 0.06, 0.0)
            knee = (s * (hip_a * 0.5 + 0.015), 0.28 * H, 0.012)
            ankle = (s * (hip_a * 0.5 + 0.03), 0.045, 0.0)
            d = smin(d, capsule(P, hipj, knee, r_thigh * 1.08, r_thigh * 0.62), 0.09)
            d = smin(d, capsule(P, knee, ankle, r_thigh * 0.62, 0.036), 0.05)
            d = smin(d, ellipsoid(P, (s * (hip_a * 0.5 + 0.03), 0.04, 0.06), (0.045, 0.04, 0.13)), 0.03)  # foot
        # arms: shoulder cap, upper arm, forearm, hand
        r_elbow = cm(m["elbow"]) / (2 * math.pi)
        r_wrist = cm(m["wrist"]) / (2 * math.pi)
        for s in (-1, 1):
            j = np.array((s * (sh_a - 0.015), sh_y, 0.0))
            ua = 0.17 * H
            fa = 0.145 * H
            el = j + np.array((s * math.sin(th) * ua, -math.cos(th) * ua, 0.0))
            th2 = th * 0.7
            wr = el + np.array((s * math.sin(th2) * fa, -math.cos(th2) * fa, 0.012))
            d = smin(d, ellipsoid(P, j + np.array((s * 0.012, -0.012, 0)), (0.062, 0.075, 0.062)), 0.04)  # deltoid
            d = smin(d, capsule(P, j, el, r_elbow * 1.12, r_elbow * 0.92), 0.04)
            d = smin(d, capsule(P, el, wr, r_elbow * 0.92, r_wrist), 0.035)
            hd = wr + np.array((s * math.sin(th2) * 0.05, -math.cos(th2) * 0.05, 0.0))
            d = smin(d, ellipsoid(P, hd, (0.032, 0.058, 0.016)), 0.02)  # hand
        # neck + head
        d = smin(d, capsule(P, (0, 0.865 * H, -0.005), (0, 0.915 * H, 0.012), 0.058, 0.052), 0.05)
        d = smin(d, ellipsoid(P, (0, 0.945 * H, 0.012), (0.083, 0.108, 0.098)), 0.035)
        return d

    # grid
    xr, zr = 0.66, 0.26
    xs = np.arange(-xr, xr + voxel, voxel)
    ys = np.arange(0.0, H * 1.0 + voxel, voxel)
    zs = np.arange(-zr, zr + voxel, voxel)
    vol = np.empty((len(xs), len(ys), len(zs)), np.float32)
    for i in range(len(xs)):
        X, Y, Z = np.meshgrid(xs[i : i + 1], ys, zs, indexing="ij")
        P = np.stack([X, Y, Z], axis=-1)[0]
        vol[i] = field(P)
    verts, faces, normals, _ = measure.marching_cubes(vol, 0.0, spacing=(voxel, voxel, voxel))
    verts += np.array([-xr, 0.0, -zr])
    # light Taubin smoothing to remove marching-cubes stair-steps without shrinking
    verts = taubin(verts, faces, 8)
    return verts.astype(np.float32), faces.astype(np.int64)


def taubin(v, f, iters, lam=0.5, mu=-0.53):
    n = len(v)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    cnt = np.bincount(e[:, 0], minlength=n).astype(np.float64)
    for _ in range(iters):
        for w in (lam, mu):
            s = np.zeros_like(v, dtype=np.float64)
            np.add.at(s, e[:, 0], v[e[:, 1]])
            lap = s / np.maximum(cnt, 1)[:, None] - v
            v = v + w * lap
    return v


def write_obj(path, v, f):
    tri = v[f]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    vn = np.zeros_like(v, dtype=np.float64)
    for k in range(3):
        np.add.at(vn, f[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    with open(path, "w") as fh:
        fh.write("# body generated by tools/make_body.py\no body\n")
        for p in v:
            fh.write(f"v {p[0]:.5f} {p[1]:.5f} {p[2]:.5f}\n")
        for n in vn:
            fh.write(f"vn {n[0]:.4f} {n[1]:.4f} {n[2]:.4f}\n")
        for t in f + 1:
            fh.write(f"f {t[0]}//{t[0]} {t[1]}//{t[1]} {t[2]}//{t[2]}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="body.obj")
    ap.add_argument("--height", type=float, default=177)
    ap.add_argument("--chest", type=float, default=96.5)
    ap.add_argument("--waist", type=float, default=80)
    ap.add_argument("--hip", type=float, default=94)
    ap.add_argument("--upper-hip", type=float, default=86.4)
    ap.add_argument("--ribcage", type=float, default=86.4)
    ap.add_argument("--shoulder", type=float, default=42, help="shoulder width (cm)")
    ap.add_argument("--elbow", type=float, default=28)
    ap.add_argument("--wrist", type=float, default=19)
    ap.add_argument("--depth", default="0.70,0.62,0.60", help="depth/width at chest,waist,hip")
    ap.add_argument("--arm-angle", type=float, default=25)
    ap.add_argument("--voxel", type=float, default=0.005)
    a = ap.parse_args()
    dc, dw, dh = (float(x) for x in a.depth.split(","))
    m = dict(height=a.height, chest=a.chest, waist=a.waist, hip=a.hip, upperHip=a.upper_hip, ribcage=a.ribcage,
             shoulder=a.shoulder, elbow=a.elbow, wrist=a.wrist, arm_angle=a.arm_angle,
             depth=dict(chest=dc, waist=dw, hip=dh))
    v, f = build(m, a.voxel)
    write_obj(a.out, v, f)
    print(f"{a.out}: {len(v)} vertices, {len(f)} triangles")


if __name__ == "__main__":
    main()
