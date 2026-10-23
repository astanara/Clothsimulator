"""A stand-in for SMPL-X used by the tests: the generated body (tools/make_body.py) in a near T-pose with
analytic shape directions (height, chest/waist/hip girth, torso depth/width). Same array layout as SMPL-X."""
import numpy as np
import make_body


def build(voxel=0.012):
    m = dict(height=175, chest=96, waist=82, hip=96, upperHip=88, ribcage=88, shoulder=42, elbow=28, wrist=19,
             arm_angle=85, depth=dict(chest=0.7, waist=0.65, hip=0.65))
    V, F = make_body.build(m, voxel)
    V = V.astype(np.float64)
    H = V[:, 1].max()
    y = V[:, 1]

    def bump(f):
        return np.exp(-(((y / H) - f) / 0.05) ** 2)

    torso = (np.abs(V[:, 0]) < 0.3) & (y / H > 0.42) & (y / H < 0.8)
    D = np.zeros((len(V), 3, 6))
    D[:, 1, 0] = 0.05 * y  # height
    for k, f in ((1, 0.72), (2, 0.62), (3, 0.52)):  # girth at chest, waist, hip
        g = 0.06 * bump(f) * torso
        D[:, 0, k] = V[:, 0] * g
        D[:, 2, k] = V[:, 2] * g
    D[:, 2, 4] = 0.05 * V[:, 2] * torso  # depth
    D[:, 0, 5] = 0.05 * V[:, 0] * torso  # width
    return V, F, D
