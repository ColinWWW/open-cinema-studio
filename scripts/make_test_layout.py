"""Render a grey-box layout clip for the LTX-2.5 Layout-to-Render go/no-go test.

Grey boxes on a floor plane, shot with a slow camera move, rendered deterministically
(numpy ray casting) and encoded to MP4 with ffmpeg at exact specs:
width/height divisible by 64, 8k+1 frames, 24 fps.

Usage:
  python scripts/make_test_layout.py                       # 960x576, 65 frames, dolly_in
  python scripts/make_test_layout.py --move orbit --frames 97 -o examples/layout_orbit.mp4
  python scripts/make_test_layout.py --scene plaza -o examples/layout_plaza_dolly_in.mp4
  python scripts/make_test_layout.py --scene-json examples/walk_scene.json -o examples/layout_walk.mp4

--scene-json renders a scene saved by the web editor: its boxes, persons and walls, moving stand-ins
following their keys (as web/src/objectPath.js), and the active shot's camera keys, easing, fov and lens
shift. Size and frame count come from the scene's output unless given. Persons are drawn as true capsules
(the editor's mesh is a 16-sided one), so edges differ by a pixel or so.

Also writes <output>_first.png (clay frame 0) and <output>_depth.png (frame 0's depth, the same map the
web tool exports, for `python -m server.look`). Don't use _first.png as the first-frame image:
the model needs a finished-looking image made *from* it, or the result comes out grey.
"""

import argparse
import json
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import numpy as np

# (min corner, max corner, grey level). y is up, units ~ metres.
BOXES = [
    ((-3.2, 0.0, 2.0), (-1.4, 3.4, 4.2), 0.78),   # building block, left
    ((1.6, 0.0, 3.0), (3.6, 2.2, 5.6), 0.72),     # building block, right
    ((-0.6, 0.0, 0.4), (0.2, 0.8, 1.2), 0.86),    # crate
    ((0.35, 0.0, 0.9), (0.85, 0.5, 1.4), 0.82),   # small crate
    ((-0.95, 0.0, -0.35), (-0.55, 1.75, 0.05), 0.92),  # person stand-in
]
# Matches examples/look_plaza.jpg (cropped to 960x576): level camera, horizon low in frame.
PLAZA_BOXES = [
    ((-24.1, 0.0, 40.0), (-10.4, 34.0, 94.0), 0.74),  # glass tower, left (far)
    ((-4.69, 0.0, 7.52), (-4.54, 3.8, 7.67), 0.9),   # lamp post
    ((-4.86, 3.8, 7.35), (-4.37, 4.74, 7.84), 0.88),  # lamp head
    ((-4.8, 0.0, 7.4), (-4.43, 0.3, 7.79), 0.8),     # lamp base
    ((-1.29, 0.0, 6.0), (0.39, 1.43, 7.5), 0.86),    # big crate
    ((0.3, 0.0, 6.5), (1.32, 1.03, 7.7), 0.82),      # small crate
    ((1.75, 0.0, 7.6), (4.78, 2.3, 9.1), 0.84),      # kiosk body
    ((1.2, 2.3, 7.45), (5.3, 2.6, 9.4), 0.92),       # kiosk roof overhang
    ((1.85, 2.6, 7.7), (4.7, 3.13, 9.0), 0.88),      # kiosk roof box
    ((-20.0, 0.0, 11.6), (20.0, 0.45, 12.0), 0.7),   # low parapet wall
]
SCENES = {
    # boxes, vertical lens shift (0 = horizon at frame centre), fog start/range in metres
    "blocks": dict(boxes=BOXES, shift=0.0, fog=(8.0, 30.0)),
    "plaza": dict(boxes=PLAZA_BOXES, shift=0.458, fog=(60.0, 120.0)),
}
FLOOR_GREY = 0.62
LIGHT = np.array([-0.45, 0.8, -0.4]) / np.linalg.norm([-0.45, 0.8, -0.4])
TARGET = np.array([0.0, 0.9, 1.0])


def snap_frames(n):
    return max(1, ((n - 1) // 8) * 8 + 1)


def ease(t):
    return t * t * (3.0 - 2.0 * t)


def camera_path(move, t, scene="blocks"):
    """(eye, target) at t in [0, 1]. "blocks" always looks at TARGET; "plaza" looks level down +z."""
    s = ease(t)
    if scene == "plaza":
        if move != "dolly_in":
            raise ValueError("the plaza scene only has dolly_in")
        eye = np.array([0.0, 1.6, 2.0 * s])
        return eye, eye + np.array([0.0, 0.0, 1.0])
    return _blocks_eye(move, s), TARGET


def _blocks_eye(move, s):
    if move == "dolly_in":
        return np.array([0.0, 1.6 - 0.2 * s, -7.5 + 3.0 * s])
    if move == "orbit":
        a = np.radians(-30 + 60 * s)
        r = 7.0
        return TARGET + np.array([r * np.sin(a), 0.9, -r * np.cos(a)])
    if move == "crane_up":
        return np.array([0.0, 1.0 + 3.0 * s, -6.5 + 0.5 * s])
    if move == "truck":
        return np.array([-2.5 + 5.0 * s, 1.5, -6.5])
    raise ValueError(f"unknown move {move}")


def ray_dirs(eye, target, width, height, fov_deg, shift=0.0):
    f = target - eye
    f /= np.linalg.norm(f)
    r = np.cross([0.0, 1.0, 0.0], f)  # y up, z forward -> x right
    r /= np.linalg.norm(r)
    u = np.cross(f, r)
    tan = np.tan(np.radians(fov_deg) / 2.0)
    xs = ((np.arange(width) + 0.5) / width * 2 - 1) * tan * width / height
    ys = (1 - (np.arange(height) + 0.5) / height * 2 + shift) * tan  # shift > 0 lowers the horizon
    X, Y = np.meshgrid(xs, ys)
    d = f + X[..., None] * r + Y[..., None] * u
    return (d / np.linalg.norm(d, axis=-1, keepdims=True)).reshape(-1, 3)


def hit_boxes(origins, dirs, boxes):
    """Nearest box hit per ray: (t, normal, grey). t = inf where nothing is hit."""
    n = len(dirs)
    best_t = np.full(n, np.inf)
    best_n = np.zeros((n, 3))
    best_g = np.zeros(n)
    with np.errstate(divide="ignore", invalid="ignore"):
        inv = 1.0 / dirs
        for lo, hi, grey in boxes:
            t1 = (np.array(lo) - origins) * inv
            t2 = (np.array(hi) - origins) * inv
            tnear = np.minimum(t1, t2)
            tmin = np.max(tnear, axis=1)
            tmax = np.min(np.maximum(t1, t2), axis=1)
            hit = (tmax >= np.maximum(tmin, 1e-4)) & (tmin > 1e-4) & (tmin < best_t)
            if not hit.any():
                continue
            axis = np.argmax(tnear[hit], axis=1)
            normal = np.zeros((hit.sum(), 3))
            normal[np.arange(len(axis)), axis] = -np.sign(dirs[hit, axis])
            best_t[hit], best_n[hit], best_g[hit] = tmin[hit], normal, grey
    return best_t, best_n, best_g


def hit_scene(origins, dirs, sc):
    """Nearest hit among a scene's axis-aligned boxes and posed solids (from --scene-json)."""
    t, normal, grey = hit_boxes(origins, dirs, sc["boxes"])
    for solid in sc.get("solids", ()):
        st, sn, sg = hit_solid(origins, dirs, solid)
        near = st < t
        t[near], normal[near], grey[near] = st[near], sn[near], sg
    return t, normal, grey


def _scene(scene):
    """A built-in scene's name, or a scene dict as scene_at() makes it."""
    return SCENES[scene] if isinstance(scene, str) else scene


def cast(eye, target, width, height, fov_deg, scene):
    """Ray directions and the nearest hit per pixel (objects or floor): (dirs, t, normal, grey)."""
    sc = _scene(scene)
    dirs = ray_dirs(eye, target, width, height, fov_deg, sc["shift"])
    origins = np.broadcast_to(eye, dirs.shape)
    t, normal, grey = hit_scene(origins, dirs, sc)

    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(dirs[:, 1] < 0, -eye[1] / dirs[:, 1], np.inf)
    floor = t_floor < t
    t = np.where(floor, t_floor, t)
    normal[floor] = (0.0, 1.0, 0.0)
    grey[floor] = FLOOR_GREY
    return dirs, t, normal, grey


def render(eye, target, width, height, fov_deg, scene="blocks"):
    sc = _scene(scene)
    dirs, t, normal, grey = cast(eye, target, width, height, fov_deg, scene)
    hit = np.isfinite(t)

    # sky: soft vertical gradient
    sky = 0.80 + 0.12 * np.clip(dirs[:, 1], 0, 1)
    shade = sky.copy()

    p = eye + dirs[hit] * t[hit, None]
    lambert = np.clip(normal[hit] @ LIGHT, 0, 1)
    shadow_t, _, _ = hit_scene(p + normal[hit] * 1e-3, np.broadcast_to(LIGHT, p.shape), sc)
    lit = np.where(np.isfinite(shadow_t), 0.0, 1.0)
    value = grey[hit] * (0.45 + 0.55 * lambert * lit)
    fog = np.clip((t[hit] - sc["fog"][0]) / sc["fog"][1], 0, 1)
    shade[hit] = value * (1 - fog) + sky[hit] * fog

    img = np.clip(shade * 255.0 + 0.5, 0, 255).astype(np.uint8).reshape(height, width)
    return np.repeat(img[..., None], 3, axis=-1)


def render_depth(eye, target, width, height, fov_deg, scene="blocks", percentile=0.005):
    """Depth map for the look still, as web/src/depth.js makes it: grey = nearZ / z of the view-space
    depth, so the nearest surface is white and the sky black; nearZ is a low percentile of the hits."""
    dirs, t, _, _ = cast(eye, target, width, height, fov_deg, scene)
    forward = (target - eye) / np.linalg.norm(target - eye)
    z = np.where(np.isfinite(t), t * (dirs @ forward), 0.0)
    valid = np.sort(z[z > 0])
    near = valid[min(len(valid) - 1, int(len(valid) * percentile))] if len(valid) else 1.0
    with np.errstate(divide="ignore"):
        grey = np.where(z > 0, np.round(255 * np.minimum(1, near / z)), 0).astype(np.uint8)
    return np.repeat(grey.reshape(height, width)[..., None], 3, axis=-1)


# ---------- scenes saved by the web editor (--scene-json) ----------
# The editor is three.js, whose x is the mirror of this script's (see the top of web/src/presets.js), so
# positions and targets get x negated and rotations are mirrored the same way. Shapes match clay.js:
# box = unit cube on its base, person = capsule r 0.25, 1.75 m tall, on its base, plane = 1x1 wall
# standing on its bottom edge; each is scaled, then rotated (Euler XYZ), then moved to its position.

MIRROR = np.diag([-1.0, 1.0, 1.0])
CAPSULE_R, CAPSULE_LO, CAPSULE_HI = 0.25, 0.25, 1.5  # radius, centres of the end spheres (y)


def euler_xyz(rx, ry, rz):
    """three.js Euler 'XYZ' as a matrix: Rx @ Ry @ Rz."""
    cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
    x = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    y = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    z = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return x @ y @ z


def make_solid(kind, position, rotation, scale, grey):
    """A posed solid in this script's coordinates, from an editor object's (three.js) pose."""
    m = MIRROR @ euler_xyz(*rotation) @ MIRROR @ np.diag(scale)  # every shape is symmetric in local x
    return dict(kind=kind, pos=MIRROR @ np.asarray(position, float), inv=np.linalg.inv(m), grey=grey)


def _slab(o, d, lo, hi):
    """Ray vs axis-aligned box: (tmin, tmax, tnear per axis)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        inv = 1.0 / d
        t1 = (np.asarray(lo) - o) * inv
        t2 = (np.asarray(hi) - o) * inv
    tnear = np.nan_to_num(np.minimum(t1, t2), nan=-np.inf)
    tfar = np.nan_to_num(np.maximum(t1, t2), nan=np.inf)
    return tnear.max(axis=1), tfar.min(axis=1), tnear


def _sphere(o, d, c, r):
    oc = o - c
    a = np.einsum("ij,ij->i", d, d)
    b = np.einsum("ij,ij->i", oc, d)
    disc = b * b - a * (np.einsum("ij,ij->i", oc, oc) - r * r)
    with np.errstate(invalid="ignore"):
        return np.where(disc >= 0, (-b - np.sqrt(disc)) / a, np.inf)


def hit_solid(origins, dirs, solid):
    """(t, world normal, grey) per ray for one posed solid; t = inf on a miss. Rays go into the solid's
    unscaled local frame without renormalising, so t stays the world distance along dirs."""
    o = (origins - solid["pos"]) @ solid["inv"].T
    d = dirs @ solid["inv"].T
    n = len(d)
    t = np.full(n, np.inf)
    local = np.zeros((n, 3))
    eps = 1e-4
    if solid["kind"] == "box":
        tmin, tmax, tnear = _slab(o, d, (-0.5, 0.0, -0.5), (0.5, 1.0, 0.5))
        hit = (tmin > eps) & (tmax >= tmin)
        axis = np.argmax(tnear[hit], axis=1)
        local[np.flatnonzero(hit), axis] = -np.sign(d[hit, axis])
        t[hit] = tmin[hit]
    elif solid["kind"] == "plane":
        with np.errstate(divide="ignore", invalid="ignore"):
            tp = -o[:, 2] / d[:, 2]
        p = o + d * np.nan_to_num(tp, nan=0.0, posinf=0.0, neginf=0.0)[:, None]
        hit = (tp > eps) & (np.abs(p[:, 0]) <= 0.5) & (p[:, 1] >= 0) & (p[:, 1] <= 1)
        local[hit, 2] = -np.sign(d[hit, 2])  # two-sided: face the ray
        t[hit] = tp[hit]
    elif solid["kind"] == "person":
        # side of the capsule: the y-axis cylinder between the two end spheres' centres
        a = d[:, 0] ** 2 + d[:, 2] ** 2
        b = o[:, 0] * d[:, 0] + o[:, 2] * d[:, 2]
        disc = b * b - a * (o[:, 0] ** 2 + o[:, 2] ** 2 - CAPSULE_R ** 2)
        with np.errstate(divide="ignore", invalid="ignore"):
            tc = np.where(disc >= 0, (-b - np.sqrt(np.maximum(disc, 0))) / a, np.inf)
        y = o[:, 1] + d[:, 1] * np.nan_to_num(tc, posinf=0.0, neginf=0.0)
        tc = np.where((tc > eps) & (y >= CAPSULE_LO) & (y <= CAPSULE_HI), tc, np.inf)
        ends = [_sphere(o, d, np.array([0.0, cy, 0.0]), CAPSULE_R) for cy in (CAPSULE_LO, CAPSULE_HI)]
        ends = [np.where(te > eps, te, np.inf) for te in ends]
        t = np.minimum(tc, np.minimum(*ends))
        hit = np.isfinite(t)
        p = o[hit] + d[hit] * t[hit, None]
        axis_y = np.clip(p[:, 1], CAPSULE_LO, CAPSULE_HI)  # nearest point on the core segment
        local[hit] = (p - np.stack([np.zeros_like(axis_y), axis_y, np.zeros_like(axis_y)], axis=1)) / CAPSULE_R
    else:
        raise ValueError(f"unknown object type {solid['kind']}")
    normal = local @ solid["inv"]  # inverse-transpose of the local->world matrix
    with np.errstate(invalid="ignore"):
        normal /= np.linalg.norm(normal, axis=1, keepdims=True)
    return t, np.nan_to_num(normal), solid["grey"]


def _lerp(a, b, s):
    return [x + (y - x) * s for x, y in zip(a, b)]


def _keys_around(keys, frame):
    """Sorted keys -> ("hold", key) before the first / after the last, else ("between", a, b, s)."""
    k = sorted(keys, key=lambda key: key["frame"])
    if frame <= k[0]["frame"]:
        return ("hold", k[0])
    if frame >= k[-1]["frame"]:
        return ("hold", k[-1])
    i = 0
    while k[i + 1]["frame"] <= frame:
        i += 1
    a, b = k[i], k[i + 1]
    return ("between", a, b, (frame - a["frame"]) / (b["frame"] - a["frame"]))


def object_pose(obj, frame):
    """(position, rotation) of an editor object at `frame`, as objectPoseAt in web/src/objectPath.js:
    linear between keys, turns the short way round, holding before the first key and after the last."""
    keys = obj.get("keys") or []
    if len(keys) < 2:
        return list(obj["position"]), list(obj["rotation"])
    span = _keys_around(keys, frame)
    if span[0] == "hold":
        return list(span[1]["position"]), list(span[1]["rotation"])
    _, a, b, s = span
    near = [y - 2 * np.pi * np.round((y - x) / (2 * np.pi)) for x, y in zip(a["rotation"], b["rotation"])]
    return _lerp(a["position"], b["position"], s), _lerp(a["rotation"], near, s)


def camera_pose(keys, frame, easing="smooth"):
    """(position, target) of the shot camera at `frame`, as poseAt in web/src/cameraPath.js."""
    span = _keys_around(keys, frame)
    if span[0] == "hold":
        return list(span[1]["position"]), list(span[1]["target"])
    _, a, b, u = span
    s = u if easing == "linear" else ease(u)
    return _lerp(a["position"], b["position"], s), _lerp(a["target"], b["target"], s)


def load_scene(path):
    """An editor scene file -> dict(objects, camera, fog, output), with the active shot's camera."""
    data = json.loads(Path(path).read_text())
    shots = data.get("shots") or []
    shot = data.get("shot", 0)
    camera = shots[shot]["camera"] if 0 <= shot < len(shots) else data.get("camera")
    if not camera or not camera.get("keys"):
        raise ValueError(f"{path}: the shot camera has no keyframes")
    objects = [o for o in data.get("objects", []) if o.get("type") in ("box", "person", "plane")]
    for o in objects:
        o.setdefault("rotation", [0, 0, 0])
        o.setdefault("scale", [1, 1, 1])
        o.setdefault("grey", 0.8)
    out = data.get("output") or {}
    return dict(objects=objects, camera=camera, fog=data.get("fog") or [8, 38],
                output=dict(width=out.get("width", 960), height=out.get("height", 576), frames=out.get("frames", 65)))


def scene_at(scene, frame):
    """(eye, target, render scene) for an editor scene on `frame`, in this script's coordinates.
    three.js fog is (near, far); this script's is (start, range)."""
    cam = scene["camera"]
    eye, target = camera_pose(cam["keys"], frame, cam.get("ease", "smooth"))
    solids = []
    for o in scene["objects"]:
        position, rotation = object_pose(o, frame)
        solids.append(make_solid(o["type"], position, rotation, o["scale"], o["grey"]))
    near, far = scene["fog"]
    sc = dict(boxes=[], solids=solids, shift=cam.get("lensShift", 0.0) or 0.0, fog=(near, max(far - near, 1e-6)))
    return MIRROR @ np.asarray(eye, float), MIRROR @ np.asarray(target, float), sc


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--output", default="examples/layout_dolly_in.mp4")
    ap.add_argument("--width", type=int, default=None, help="default 960, or the scene file's")
    ap.add_argument("--height", type=int, default=None, help="default 576, or the scene file's")
    ap.add_argument("--frames", type=int, default=None, help="default 65, or the scene file's")
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--fov", type=float, default=None, help="vertical fov in degrees (45 blocks, 50 plaza, else the scene file's)")
    ap.add_argument("--scene", choices=sorted(SCENES), default="blocks")
    ap.add_argument("--move", choices=["dolly_in", "orbit", "crane_up", "truck"], default="dolly_in")
    ap.add_argument("--scene-json", metavar="PATH", help="render a scene saved by the web editor (ignores --scene/--move)")
    args = ap.parse_args(argv)

    edited = load_scene(args.scene_json) if args.scene_json else None
    size = edited["output"] if edited else dict(width=960, height=576, frames=65)
    width, height = args.width or size["width"], args.height or size["height"]
    if width % 64 or height % 64:
        ap.error("width and height must be divisible by 64 (e.g. 960x576, 960x512, 1920x1088)")
    if edited:
        fov = args.fov or edited["camera"].get("fov", 45.0)
    else:
        fov = args.fov or (50.0 if args.scene == "plaza" else 45.0)
    asked = args.frames or size["frames"]
    frames = snap_frames(asked)
    if frames != asked:
        print(f"frames snapped {asked} -> {frames} (must be 8k+1)")

    def shot(i):
        """(eye, target, scene) for frame i: the editor's keys are on absolute frames, the built-in moves span the clip."""
        if edited:
            return scene_at(edited, i)
        return (*camera_path(args.move, i / max(frames - 1, 1), args.scene), args.scene)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("ffmpeg not found: install it, or `pip install imageio-ffmpeg`")

    cmd = [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{width}x{height}", "-r", str(args.fps), "-i", "-",
           "-frames:v", str(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "14",
           "-r", str(args.fps), str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i in range(frames):
        eye, target, scene = shot(i)
        frame = render(eye, target, width, height, fov, scene)
        if i == 0:
            write_png(out.with_name(out.stem + "_first.png"), frame)
            write_png(out.with_name(out.stem + "_depth.png"), render_depth(eye, target, width, height, fov, scene))
        proc.stdin.write(frame.tobytes())
        print(f"\rframe {i + 1}/{frames}", end="", flush=True)
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit("ffmpeg failed")
    print(f"\nwrote {out} ({width}x{height}, {frames} frames @ {args.fps} fps)")

if __name__ == "__main__":
    main()
