import importlib.util
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


layout = _load("make_test_layout")
check = _load("check_open_weights")


def test_snap_frames_to_8k_plus_1():
    assert [layout.snap_frames(n) for n in (65, 72, 97, 100, 1)] == [65, 65, 97, 97, 1]


def test_render_shape_and_not_mirrored():
    eye, target = layout.camera_path("dolly_in", 0.0)
    img = layout.render(eye, target, 128, 64, 45.0)
    assert img.shape == (64, 128, 3) and img.dtype == np.uint8
    # the tall building is at negative x, so near the top only the left half hits it (darker than sky)
    row = img[15, :, 0]
    assert row[:64].min() < row[64:].min() - 30


def test_plaza_horizon_is_low():
    eye, target = layout.camera_path("dolly_in", 0.0, "plaza")
    img = layout.render(eye, target, 128, 64, 50.0, "plaza")
    col = img[:, 4, 0].astype(int)  # far left: open sky down to the parapet
    horizon = int(np.argmax(np.abs(np.diff(col))))
    assert 40 <= horizon <= 54  # ~73% down the frame, like look_plaza.jpg


def test_camera_moves_start_and_end_differ():
    for move in ("dolly_in", "orbit", "crane_up", "truck"):
        assert not np.allclose(layout.camera_path(move, 0.0)[0], layout.camera_path(move, 1.0)[0])
    assert not np.allclose(layout.camera_path("dolly_in", 0.0, "plaza")[0], layout.camera_path("dolly_in", 1.0, "plaza")[0])


def test_rejects_dims_not_divisible_by_64():
    import pytest
    with pytest.raises(SystemExit):
        layout.main(["--width", "960", "--height", "544"])


def test_open_weights_checker(tmp_path):
    good = {"1": {"class_type": "KSampler"}, "2": {"class_type": "LTXVAddGuide"}}
    bad = {"1": {"class_type": "OpenAIDalle3"}, "2": {"class_type": "KlingTextToVideoNode"}}
    (tmp_path / "good.json").write_text(json.dumps(good))
    (tmp_path / "bad.json").write_text(json.dumps(bad))
    assert check.main([str(tmp_path / "good.json")]) == 0
    assert check.main([str(tmp_path / "bad.json")]) == 1
