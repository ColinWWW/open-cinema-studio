import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "custom_nodes" / "comfyui-reshoot"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


camera = _load("reshoot_camera", PACK / "camera.py")
warp = _load("reshoot_warp", PACK / "warp.py")
check = _load("check_open_weights", ROOT / "scripts" / "check_open_weights.py")


def scene(h=48, w=64):
    """Far textured wall with a near square in the middle."""
    rng = np.random.default_rng(0)
    rgb = rng.random((h, w, 3)).astype(np.float32)
    depth = np.full((h, w), 8.0)
    depth[h // 3: 2 * h // 3, w // 3: 2 * w // 3] = 2.0
    return rgb, depth


def test_identity_pose():
    R, C = camera.camera_pose(pivot_depth=3.0)
    assert np.allclose(R, np.eye(3)) and np.allclose(C, 0)


def test_identity_warp_is_exact():
    rgb, depth = scene()
    R, C = camera.camera_pose(pivot_depth=3.0)
    out, d, holes = warp.warp_frame(rgb, depth, R, C, warp.intrinsics(64, 48, 55))
    assert not holes.any()
    assert np.allclose(out, rgb) and np.allclose(d, depth)


def test_orbit_right_moves_camera_right_and_faces_pivot():
    R, C = camera.camera_pose(orbit_deg=30, pivot_depth=4.0)
    assert C[0] > 0
    forward = R @ np.array([0, 0, 1.0])
    to_pivot = np.array([0, 0, 4.0]) - C
    assert np.allclose(forward, to_pivot / np.linalg.norm(to_pivot))


def test_crane_up_moves_camera_up():
    _, C = camera.camera_pose(crane_deg=20, pivot_depth=4.0)
    assert C[1] < 0  # y is down


def test_ramp_trajectory():
    poses = camera.trajectory(9, {"preset": "orbit_right"}, pivot_depth=3.0, mode="ramp")
    assert np.allclose(poses[0][0], np.eye(3)) and np.allclose(poses[0][1], 0)
    R_full, C_full = camera.camera_pose(orbit_deg=25, pivot_depth=3.0)
    assert np.allclose(poses[-1][1], C_full)
    const = camera.trajectory(3, {"preset": "orbit_right"}, pivot_depth=3.0, mode="constant")
    assert all(np.allclose(c, C_full) for _, c in const)


def test_move_reveals_disocclusion_next_to_foreground():
    rgb, depth = scene()
    R, C = camera.camera_pose(truck=0.3, pivot_depth=4.0)
    _, d, holes = warp.warp_frame(rgb, depth, R, C, warp.intrinsics(64, 48, 55))
    assert holes.any()
    # parallax: near square shifts more than the wall, so holes open beside it
    assert holes[16:32].any()


def test_fill_holes_uses_background():
    depth = np.array([[2.0, 0, 0, 8.0]])
    holes = np.array([[False, True, True, False]])
    filled = warp.fill_holes_background(depth, holes)
    assert np.allclose(filled, [[2.0, 8.0, 8.0, 8.0]])


def test_reshoot_clip_shapes():
    rgb, depth = scene()
    frames = np.stack([rgb] * 9)
    disp = np.stack([1.0 / depth] * 9)
    poses = camera.trajectory(9, {"preset": "hero_arc"}, pivot_depth=3.0)
    warped, wdisp, holes = warp.reshoot_clip(frames, disp, poses)
    assert warped.shape == frames.shape and wdisp.shape == holes.shape == (9, 48, 64)
    assert not holes[0].any() and holes[-1].any()
    assert 0.0 <= wdisp.min() and wdisp.max() <= 1.0


def test_open_weights_checker(tmp_path):
    good = {"1": {"class_type": "KSampler"}, "2": {"class_type": "ReshootDepthWarp"}}
    bad = {"1": {"class_type": "OpenAIDalle3"}, "2": {"class_type": "KlingTextToVideoNode"}}
    (tmp_path / "good.json").write_text(json.dumps(good))
    (tmp_path / "bad.json").write_text(json.dumps(bad))
    assert check.main([str(tmp_path / "good.json")]) == 0
    assert check.main([str(tmp_path / "bad.json")]) == 1
