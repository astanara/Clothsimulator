#!/usr/bin/env python3
"""Checks for tools/fit_body.py using a stand-in model. Run: python tools/test_fit_body.py"""
import math, os, sys, tempfile
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import fit_body, mock_model


def test_rodrigues_and_lbs():
    R = fit_body.rodrigues(np.array([0, 0, math.pi / 2]))
    assert np.allclose(R @ [1, 0, 0], [0, 1, 0], atol=1e-9)
    # two-joint chain: rotating the child about z by 90 degrees swings the vertex on it
    v = np.array([[0.0, 0, 0], [1.0, 0, 0], [2.0, 0, 0]])
    Jr = np.array([[1, 0, 0], [0, 1, 0]], float)  # joint0 = vertex0, joint1 = vertex1
    W = np.array([[1, 0], [0, 1], [0, 1]], float)
    aa = np.array([[0, 0, 0], [0, 0, math.pi / 2]])
    out = fit_body.lbs(v, Jr, W, np.array([-1, 0]), aa)
    assert np.allclose(out[0], [0, 0, 0], atol=1e-9)
    assert np.allclose(out[1], [1, 0, 0], atol=1e-9)  # the joint itself does not move
    assert np.allclose(out[2], [1, 1, 0], atol=1e-9)  # the far vertex swings up


def test_fit_recovers_measurements():
    V, F, D = mock_model.build()
    model = fit_body.ShapeModel(V, D, F, n_betas=6)
    true = np.array([0.8, -0.6, 0.4, 0.9, 0.3, -0.4])
    Vt = model.shaped(true)
    H0 = V[:, 1].max() - V[:, 1].min()
    rings = {k: fit_body.slice_ring(V, F, V[:, 1].min() + f * H0) for k, f in fit_body.LEVELS.items()}
    targets = {"height_cm": (Vt[:, 1].max() - Vt[:, 1].min()) * 100, "tape_cm": {}, "width_cm": {}, "depth_cm": {}}
    for k, ring in rings.items():
        c, w, d = fit_body.ring_metrics(Vt, ring)
        targets["tape_cm"][k], targets["width_cm"][k], targets["depth_cm"][k] = c * 100, w * 100, d * 100
    betas, s, rep = fit_body.fit(model, targets, verbose=False)
    for k in rings:
        assert abs(rep[k]["circumference_cm"] - targets["tape_cm"][k]) < 0.6, (k, rep[k], targets["tape_cm"][k])
        assert abs(rep[k]["width_cm"] - targets["width_cm"][k]) < 0.8, (k, rep[k])
        assert abs(rep[k]["depth_cm"] - targets["depth_cm"][k]) < 0.8, (k, rep[k])
    assert abs(rep["height_cm"] - targets["height_cm"]) < 0.8
    return rep


def test_export_obj():
    V, F, D = mock_model.build()
    path = os.path.join(tempfile.mkdtemp(), "b.obj")
    fit_body.write_obj(path, V.astype(np.float32), F)
    txt = open(path).read()
    assert txt.count("\nv ") == len(V) and txt.count("\nf ") == len(F)


if __name__ == "__main__":
    for t in (test_rodrigues_and_lbs, test_fit_recovers_measurements, test_export_obj):
        r = t()
        print("ok", t.__name__)
