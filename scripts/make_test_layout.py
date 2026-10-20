"""Render a grey-box layout clip for the LTX-2.5 Layout-to-Render go/no-go test.

Grey boxes on a floor plane, shot with a slow camera move, rendered deterministically
(numpy ray casting) and encoded to MP4 with ffmpeg at exact specs:
width/height divisible by 64, 8k+1 frames, 24 fps.

Usage:
  python scripts/make_test_layout.py                       # 960x576, 65 frames, dolly_in
  python scripts/make_test_layout.py --move orbit --frames 97 -o examples/layout_orbit.mp4
  python scripts/make_test_layout.py --scene plaza -o examples/layout_plaza_dolly_in.mp4

Also writes <output>_first.png (clay frame 0). Don't use it as the first-frame image:
the model needs a finished-looking image made *from* it, or the result comes out grey.
"""

import argparse
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


def render(eye, target, width, height, fov_deg, scene="blocks"):
    sc = SCENES[scene]
    dirs = ray_dirs(eye, target, width, height, fov_deg, sc["shift"])
    origins = np.broadcast_to(eye, dirs.shape)
    t, normal, grey = hit_boxes(origins, dirs, sc["boxes"])

    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(dirs[:, 1] < 0, -eye[1] / dirs[:, 1], np.inf)
    floor = t_floor < t
    t = np.where(floor, t_floor, t)
    normal[floor] = (0.0, 1.0, 0.0)
    grey[floor] = FLOOR_GREY
    hit = np.isfinite(t)

    # sky: soft vertical gradient
    sky = 0.80 + 0.12 * np.clip(dirs[:, 1], 0, 1)
    shade = sky.copy()

    p = eye + dirs[hit] * t[hit, None]
    lambert = np.clip(normal[hit] @ LIGHT, 0, 1)
    shadow_t, _, _ = hit_boxes(p + normal[hit] * 1e-3, np.broadcast_to(LIGHT, p.shape), sc["boxes"])
    lit = np.where(np.isfinite(shadow_t), 0.0, 1.0)
    value = grey[hit] * (0.45 + 0.55 * lambert * lit)
    fog = np.clip((t[hit] - sc["fog"][0]) / sc["fog"][1], 0, 1)
    shade[hit] = value * (1 - fog) + sky[hit] * fog

    img = np.clip(shade * 255.0 + 0.5, 0, 255).astype(np.uint8).reshape(height, width)
    return np.repeat(img[..., None], 3, axis=-1)


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
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--height", type=int, default=576)
    ap.add_argument("--frames", type=int, default=65)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--fov", type=float, default=None, help="vertical fov in degrees (45 blocks, 50 plaza)")
    ap.add_argument("--scene", choices=sorted(SCENES), default="blocks")
    ap.add_argument("--move", choices=["dolly_in", "orbit", "crane_up", "truck"], default="dolly_in")
    args = ap.parse_args(argv)

    if args.width % 64 or args.height % 64:
        ap.error("width and height must be divisible by 64 (e.g. 960x576, 960x512, 1920x1088)")
    fov = args.fov or (50.0 if args.scene == "plaza" else 45.0)
    frames = snap_frames(args.frames)
    if frames != args.frames:
        print(f"frames snapped {args.frames} -> {frames} (must be 8k+1)")

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("ffmpeg not found: install it, or `pip install imageio-ffmpeg`")

    cmd = [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{args.width}x{args.height}", "-r", str(args.fps), "-i", "-",
           "-frames:v", str(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "14",
           "-r", str(args.fps), str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i in range(frames):
        eye, target = camera_path(args.move, i / max(frames - 1, 1), args.scene)
        frame = render(eye, target, args.width, args.height, fov, args.scene)
        if i == 0:
            write_png(out.with_name(out.stem + "_first.png"), frame)
        proc.stdin.write(frame.tobytes())
        print(f"\rframe {i + 1}/{frames}", end="", flush=True)
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit("ffmpeg failed")
    print(f"\nwrote {out} ({args.width}x{args.height}, {frames} frames @ {args.fps} fps)")


if __name__ == "__main__":
    main()
