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
hero = _load("make_hero")
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


def test_depth_matches_the_web_export():
    # examples/layout_plaza_dolly_in_depth.png is the web tool's own depth map of the same shot
    import subprocess

    eye, target = layout.camera_path("dolly_in", 0.0, "plaza")
    ours = layout.render_depth(eye, target, 960, 576, 50.0, "plaza")[..., 0].astype(int)
    raw = subprocess.run([layout.find_ffmpeg(), "-loglevel", "error", "-i", str(ROOT / "examples/layout_plaza_dolly_in_depth.png"),
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    web = np.frombuffer(raw, np.uint8).reshape(576, 960).astype(int)
    assert np.abs(ours - web).mean() < 0.5
    assert ours[0, 480] == 0 and ours[-1, 480] > 200  # sky black, near floor bright


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


def test_hero_gif(tmp_path, monkeypatch):
    assert "hstack=inputs=2" in hero.hero_filter(480, 12)
    out = tmp_path / "hero.gif"
    monkeypatch.setattr("sys.argv", ["make_hero.py", "-o", str(out), "--width", "160", "--fps", "6"])
    hero.main()
    data = out.read_bytes()
    assert data[:6] == b"GIF89a"
    assert int.from_bytes(data[6:8], "little") == 320  # two 160-wide halves


looks = _load("three_looks")


def test_three_looks_match_the_app_prompts():
    prompts = (ROOT / "web" / "src" / "prompts.js").read_text()
    assert len(looks.LOOKS) == 3
    for prompt in looks.LOOKS.values():
        assert prompt in prompts


def test_three_looks_commands_and_grid():
    cmds = looks.render_commands(seed=7)
    assert [c[2] for c in cmds] == ["server.look", "server.render"] * 3
    assert all(c[-2:] == ["--seed", "7"] for c in cmds)
    # each render uses the look still made just before it
    assert cmds[1][4] == cmds[0][cmds[0].index("-o") + 1]
    assert looks.DEPTH.exists() and looks.LAYOUT.exists()
    f = looks.grid_filter(480)
    assert "xstack=inputs=4" in f and "palettegen" not in f
    assert "palettegen" in looks.grid_filter(320, fps=12, gif=True)
