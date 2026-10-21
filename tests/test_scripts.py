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


def _gray_png(path, width, height):
    import subprocess

    raw = subprocess.run([layout.find_ffmpeg(), "-loglevel", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(height, width).astype(int)


def _person_x(scene, frame, width=192, height=128):
    """Mean screen x of the pixels the walking person covers on `frame` (rendered with vs without it)."""
    eye, target, sc = layout.scene_at(scene, frame)
    fov = scene["camera"]["fov"]
    with_person = layout.render(eye, target, width, height, fov, sc)[..., 0]
    sc["solids"] = [s for s, o in zip(sc["solids"], scene["objects"]) if o["type"] != "person"]
    without = layout.render(eye, target, width, height, fov, sc)[..., 0]
    xs = np.nonzero(with_person != without)[1]
    assert len(xs) > 20, "the person should be in shot"
    return xs.mean() / width


def test_scene_json_person_walks_across_the_frame():
    # examples/walk_scene.json: the camera orbits left while the person walks the other way (three.js +x),
    # so in the editor they start right of centre and end up in the left part of the frame
    scene = layout.load_scene(ROOT / "examples/walk_scene.json")
    last = scene["output"]["frames"] - 1
    start, end = _person_x(scene, 0), _person_x(scene, last)
    assert start > 0.6 and end < 0.2


def test_scene_json_depth_matches_the_editor():
    # the editor's own depth export of the same shot; its person is a 16-sided capsule mesh, ours a true one
    scene = layout.load_scene(ROOT / "examples/walk_scene.json")
    eye, target, sc = layout.scene_at(scene, 0)
    ours = layout.render_depth(eye, target, 960, 576, scene["camera"]["fov"], sc)[..., 0].astype(int)
    web = _gray_png(ROOT / "examples/layout_plaza_walk_orbit_depth.png", 960, 576)
    assert np.abs(ours - web).mean() < 1.0
    assert (np.abs(ours - web) > 16).mean() < 0.005


def test_object_pose_follows_keys_like_the_editor():
    obj = {"position": [0, 0, 0], "rotation": [0, 0, 0], "keys": [
        {"frame": 10, "position": [0, 0, 0], "rotation": [0, np.radians(170), 0]},
        {"frame": 20, "position": [4, 0, 2], "rotation": [0, np.radians(-170), 0]},
    ]}
    assert layout.object_pose(obj, 0) == ([0, 0, 0], [0, np.radians(170), 0])  # holds before the first key
    assert layout.object_pose(obj, 30)[0] == [4, 0, 2]  # and after the last
    pos, rot = layout.object_pose(obj, 15)
    assert np.allclose(pos, [2, 0, 1])  # linear, not eased
    assert np.isclose(rot[1], np.radians(180))  # 170 -> -170 turns 20 degrees the short way


def test_scene_json_cli(tmp_path):
    out = tmp_path / "walk.mp4"
    layout.main(["--scene-json", str(ROOT / "examples/walk_scene.json"), "--width", "128", "--height", "64",
                 "--frames", "9", "-o", str(out)])
    assert out.stat().st_size > 0
    assert _gray_png(tmp_path / "walk_depth.png", 128, 64).max() == 255


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


def test_four_moves_commands_and_grid():
    moves = _load("four_moves")
    cmds = moves.render_commands()
    assert [c[1] if c[1].endswith(".py") else c[2] for c in cmds] == ["scripts/make_test_layout.py", "server.look", "server.render"] * 4
    for move, (layout, depth, look, out) in ((m, moves.paths(m)) for m in moves.CLIPS):
        draw, still, render = cmds[3 * list(moves.CLIPS).index(move):][:3]
        assert draw[draw.index("--move") + 1] == move and draw[-1] == str(layout)
        assert still[3] == str(depth) and still[still.index("-o") + 1] == str(look)
        assert render[3:5] == [str(layout), str(look)] and render[render.index("-o") + 1] == str(out)
        assert still[-1] == render[-1] == str(moves.CLIPS[move][2])  # same seed for the still and the clip
    f = moves.grid_filter(480)
    assert "xstack=inputs=4" in f and f.count("overlay=") == 4 and "palettegen" not in f
    assert "palettegen" in moves.grid_filter(320, fps=12, gif=True)


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
