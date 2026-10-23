#!/usr/bin/env python3
"""
Fit a statistical body model (SMPL-X) to tape measurements and to torso widths/depths read from
front/side photos, then export an OBJ that the app loads with "Load body scan...".

Only numpy and scipy are needed: for a fixed pose SMPL-X is linear in its shape parameters, so the
fit works directly on the model file's arrays. Get the model yourself (research licence, personal use):
register at https://smpl-x.is.tue.mpg.de/ and download "SMPL-X" (models_smplx_v1_1.zip); you need
SMPLX_NEUTRAL.npz (or _MALE / _FEMALE).

  python tools/fit_body.py --model models/smplx/SMPLX_NEUTRAL.npz --targets tools/body_targets.json \
         --out body_smplx.obj --arm-angle 35

The shape is fitted in the T-pose (arms out, so torso slices contain only the torso); the exported
mesh is then posed with the arms lowered, standing on the floor, facing +z, in metres.
"""
import argparse, json, math, sys
import numpy as np
from scipy.optimize import least_squares

LEVELS = {"chest": 0.72, "waist": 0.62, "hip": 0.52}  # height fractions, as in the app


# ----------------------------------------------------------------------------- model
class ShapeModel:
    """Arrays of an SMPL-X style model. Vertices for shape betas: v_template + shapedirs @ betas."""

    def __init__(self, v_template, shapedirs, faces, J_regressor=None, weights=None, parents=None, n_betas=10):
        self.v_template = np.asarray(v_template, np.float64)
        self.shapedirs = np.asarray(shapedirs, np.float64)[:, :, :n_betas]
        self.faces = np.asarray(faces, np.int64)
        self.J_regressor = J_regressor
        self.weights = weights
        self.parents = parents
        self.n_betas = self.shapedirs.shape[2]

    @classmethod
    def load(cls, path, n_betas=10):
        z = np.load(path, allow_pickle=True)
        parents = np.asarray(z["kintree_table"][0], np.int64) if "kintree_table" in z else None
        if parents is not None:
            parents[0] = -1
        J = z["J_regressor"] if "J_regressor" in z else None
        if J is not None and hasattr(J, "toarray"):
            J = J.toarray()
        return cls(z["v_template"], z["shapedirs"], z["f"], J, z["weights"] if "weights" in z else None, parents, n_betas)

    def shaped(self, betas):
        return self.v_template + self.shapedirs @ np.asarray(betas, np.float64)

    def pose(self, betas, axis_angle):
        """Linear blend skinning of the shaped model with per-joint axis-angle rotations (J,3)."""
        v = self.shaped(betas)
        if self.J_regressor is None or self.weights is None or self.parents is None:
            raise RuntimeError("model file has no skeleton; cannot pose")
        return lbs(v, self.J_regressor, self.weights, self.parents, axis_angle)


def rodrigues(r):
    th = np.linalg.norm(r)
    if th < 1e-9:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


def lbs(v_shaped, J_regressor, weights, parents, axis_angle):
    J = J_regressor @ v_shaped
    n = len(parents)
    R = [rodrigues(np.asarray(axis_angle[j], float)) for j in range(n)]
    G = np.zeros((n, 4, 4))
    for j in range(n):
        local = np.eye(4)
        local[:3, :3] = R[j]
        local[:3, 3] = J[j] - (J[parents[j]] if parents[j] >= 0 else 0)
        G[j] = local if parents[j] < 0 else G[parents[j]] @ local
    # remove the rest-pose joint position so G maps rest vertices to posed vertices
    for j in range(n):
        G[j][:3, 3] -= G[j][:3, :3] @ J[j]
    T = np.einsum("vj,jab->vab", weights, G)
    vh = np.concatenate([v_shaped, np.ones((len(v_shaped), 1))], axis=1)
    return np.einsum("vab,vb->va", T, vh)[:, :3]


# ----------------------------------------------------------------------------- rings
def slice_ring(V, F, y):
    """Ordered loop of edge crossings at height y closest to the body axis: [(i, j, w)], P=(1-w)Vi+wVj."""
    vi = V[:, 1] - y
    pts = {}
    segs = []
    for f in F:
        cross = []
        for a, b in ((f[0], f[1]), (f[1], f[2]), (f[2], f[0])):
            if vi[a] * vi[b] < 0:
                key = (min(a, b), max(a, b))
                if key not in pts:
                    i, j = key
                    pts[key] = (i, j, vi[i] / (vi[i] - vi[j]))
                cross.append(key)
        if len(cross) == 2:
            segs.append(tuple(cross))
    adj = {}
    for a, b in segs:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen, loops = set(), []
    for start in adj:
        if start in seen:
            continue
        loop, cur, prev = [start], start, None
        seen.add(start)
        while True:
            nxt = [n for n in adj[cur] if n != prev and n not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        loops.append(loop)

    def score(loop):
        P = np.array([point(V, pts[k]) for k in loop])
        return (len(loop), -abs(P[:, 0].mean()))

    # the torso loop: the long one nearest the body axis
    loops = [l for l in loops if len(l) > 20]
    if not loops:
        raise RuntimeError(f"no closed slice at y={y:.3f}")
    best = min(loops, key=lambda l: abs(np.mean([point(V, pts[k])[0] for k in l])) - 1e-4 * len(l))
    return [pts[k] for k in best]


def point(V, e):
    i, j, w = e
    return (1 - w) * V[i] + w * V[j]


def ring_metrics(V, ring):
    I = np.array([r[0] for r in ring])
    J = np.array([r[1] for r in ring])
    W = np.array([r[2] for r in ring])[:, None]
    P = (1 - W) * V[I] + W * V[J]
    d = np.linalg.norm(np.roll(P, -1, axis=0) - P, axis=1)
    return d.sum(), P[:, 0].max() - P[:, 0].min(), P[:, 2].max() - P[:, 2].min()


# ----------------------------------------------------------------------------- fit
def fit(model, targets, verbose=True):
    """Return (betas, scale, report). Units: metres internally, centimetres in the targets file."""
    H = targets["height_cm"] / 100.0
    V0 = model.shaped(np.zeros(model.n_betas))
    h0 = V0[:, 1].max() - V0[:, 1].min()
    ymin0 = V0[:, 1].min()
    rings = {k: slice_ring(V0, model.faces, ymin0 + f * h0) for k, f in LEVELS.items()}
    tape = targets["tape_cm"]
    wid = targets.get("width_cm", {})
    dep = targets.get("depth_cm", {})
    sh = targets.get("shoulder_cm")

    def residuals(p):
        betas, s = p[:-1], math.exp(p[-1])
        V = model.shaped(betas) * s
        res = [(V[:, 1].max() - V[:, 1].min() - H) * 100.0]
        for k, ring in rings.items():
            c, w, d = ring_metrics(V, ring)
            if k in tape:
                res.append((c * 100 - tape[k]) * 1.0)
            if k in wid:
                res.append((w * 100 - wid[k]) * 0.7)
            if k in dep:
                res.append((d * 100 - dep[k]) * 0.7)
        res.extend(0.4 * np.asarray(betas))  # stay close to an average body
        return np.asarray(res)

    p0 = np.zeros(model.n_betas + 1)
    sol = least_squares(residuals, p0, method="trf", bounds=(-np.r_[np.full(model.n_betas, 3.5), 0.3], np.r_[np.full(model.n_betas, 3.5), 0.3]))
    betas, s = sol.x[:-1], math.exp(sol.x[-1])
    V = model.shaped(betas) * s
    report = {"betas": betas.round(3).tolist(), "scale": round(s, 4), "height_cm": round((V[:, 1].max() - V[:, 1].min()) * 100, 1)}
    for k, ring in rings.items():
        c, w, d = ring_metrics(V, ring)
        report[k] = {"circumference_cm": round(c * 100, 1), "width_cm": round(w * 100, 1), "depth_cm": round(d * 100, 1)}
    if verbose:
        print(json.dumps(report, indent=1))
    return betas, s, report


# ----------------------------------------------------------------------------- export
def arm_pose(model, betas, angle_deg):
    """Axis-angle for SMPL-X with the arms lowered `angle_deg` from vertical (T-pose = 90)."""
    n = len(model.parents)
    phi = math.radians(90 - angle_deg)
    best = None
    for sign in (1, -1):
        aa = np.zeros((n, 3))
        aa[16] = (0, 0, -sign * phi)  # left shoulder (+x arm)
        aa[17] = (0, 0, sign * phi)  # right shoulder
        V = model.pose(betas, aa)
        # the sign that lowers the hands: the vertex farthest from the body axis ends up lowest
        hand_y = V[np.argmax(np.abs(V[:, 0]))][1]
        if best is None or hand_y < best[0]:
            best = (hand_y, aa)
    return best[1]


def write_obj(path, v, f):
    tri = v[f]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    vn = np.zeros_like(v)
    for k in range(3):
        np.add.at(vn, f[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    with open(path, "w") as fh:
        fh.write("# body fitted by tools/fit_body.py\no body\n")
        for p in v:
            fh.write(f"v {p[0]:.5f} {p[1]:.5f} {p[2]:.5f}\n")
        for n in vn:
            fh.write(f"vn {n[0]:.4f} {n[1]:.4f} {n[2]:.4f}\n")
        for t in f + 1:
            fh.write(f"f {t[0]}//{t[0]} {t[1]}//{t[1]} {t[2]}//{t[2]}\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="SMPLX_NEUTRAL.npz (or MALE/FEMALE)")
    ap.add_argument("--targets", default="tools/body_targets.json")
    ap.add_argument("--out", default="body_smplx.obj")
    ap.add_argument("--arm-angle", type=float, default=35.0, help="degrees from vertical")
    ap.add_argument("--betas", type=int, default=10, help="number of shape components to fit")
    ap.add_argument("--no-pose", action="store_true", help="export the T-pose fit without lowering the arms")
    a = ap.parse_args()
    targets = json.load(open(a.targets))
    model = ShapeModel.load(a.model, a.betas)
    betas, s, report = fit(model, targets)
    if a.no_pose or model.J_regressor is None:
        V = model.shaped(betas) * s
    else:
        V = model.pose(betas, arm_pose(model, betas, a.arm_angle)) * s
    V = V.copy()
    V[:, 1] -= V[:, 1].min()  # feet on the floor
    V[:, 0] -= (V[:, 0].max() + V[:, 0].min()) / 2
    write_obj(a.out, V, model.faces)
    json.dump(report, open(a.out.rsplit(".", 1)[0] + "_fit.json", "w"), indent=1)
    print(f"wrote {a.out}: {len(V)} vertices, {len(model.faces)} triangles")


if __name__ == "__main__":
    sys.exit(main())
