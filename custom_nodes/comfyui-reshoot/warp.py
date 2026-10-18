"""Depth-based re-projection of video frames to a new camera.

Pure numpy so it can be unit-tested without ComfyUI or a GPU.
Depth inputs are disparity-like maps (near = bright), as produced by
Depth Anything. Metric scale is unknown, so we map disparity onto an
assumed [near, far] range; only the ratio far/near really matters.
"""

import numpy as np


def disparity_to_depth(disp, near=1.0, far=10.0, lo=None, hi=None):
    """Map a disparity map to depth. lo/hi fix the normalisation (pass clip-wide values)."""
    lo = np.percentile(disp, 1) if lo is None else lo
    hi = np.percentile(disp, 99) if hi is None else hi
    d = np.clip((disp - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    inv = d * (1.0 / near - 1.0 / far) + 1.0 / far
    return 1.0 / inv


def depth_to_disparity(depth, near=1.0, far=10.0):
    return np.clip((1.0 / np.maximum(depth, 1e-6) - 1.0 / far) / (1.0 / near - 1.0 / far), 0.0, 1.0)


def intrinsics(width, height, fov_deg):
    """Pinhole intrinsics from a horizontal field of view."""
    f = 0.5 * width / np.tan(np.radians(fov_deg) / 2.0)
    return f, f, (width - 1) / 2.0, (height - 1) / 2.0


def smooth_temporal(disp_frames, amount):
    """EMA over time to reduce depth flicker. amount=0 disables. Lags fast motion."""
    if amount <= 0:
        return disp_frames
    out = disp_frames.copy()
    for t in range(1, len(out)):
        out[t] = amount * out[t - 1] + (1.0 - amount) * disp_frames[t]
    return out


def dilate(mask, iterations):
    for _ in range(iterations):
        m = mask.copy()
        m[1:] |= mask[:-1]
        m[:-1] |= mask[1:]
        m[:, 1:] |= mask[:, :-1]
        m[:, :-1] |= mask[:, 1:]
        mask = m
    return mask


def fill_holes_background(depth, holes):
    """Fill holes row-wise with the farther of the nearest valid left/right neighbours.

    Disocclusions are almost always background, so the farther side is the better guess.
    """
    h, w = depth.shape
    valid = ~holes
    cols = np.arange(w)[None, :]
    left_idx = np.maximum.accumulate(np.where(valid, cols, 0), axis=1)
    right_idx = np.minimum.accumulate(np.where(valid, cols, w - 1)[:, ::-1], axis=1)[:, ::-1]
    left = np.where(np.take_along_axis(valid, left_idx, 1), np.take_along_axis(depth, left_idx, 1), np.nan)
    right = np.where(np.take_along_axis(valid, right_idx, 1), np.take_along_axis(depth, right_idx, 1), np.nan)
    with np.errstate(invalid="ignore"):
        fill = np.fmax(left, right)
    fallback = np.nanmax(depth[valid]) if valid.any() else 1.0
    fill = np.where(np.isnan(fill), fallback, fill)
    return np.where(holes, fill, depth)


def warp_frame(rgb, depth, R, C, K, splat=2):
    """Forward-splat one frame into the new camera with a z-buffer.

    rgb: (H, W, 3) float, depth: (H, W) float, R/C: pose from camera.camera_pose,
    K: (fx, fy, cx, cy). splat=2 writes each point to a 2x2 footprint to close cracks.
    Returns warped rgb, warped depth (inf in holes) and a boolean hole mask.
    """
    h, w = depth.shape
    fx, fy, cx, cy = K
    v, u = np.mgrid[0:h, 0:w].astype(np.float64)
    z = depth.astype(np.float64)
    pts = np.stack([(u - cx) * z / fx, (v - cy) * z / fy, z], axis=-1).reshape(-1, 3)
    pts = (pts - C) @ R  # == (R.T @ (X - C)) per row
    zn = pts[:, 2]
    front = zn > 1e-4
    zs = np.where(front, zn, 1.0)
    un = fx * pts[:, 0] / zs + cx
    vn = fy * pts[:, 1] / zs + cy
    colors = rgb.reshape(-1, rgb.shape[-1])
    out_rgb = np.zeros((h * w, colors.shape[-1]), dtype=rgb.dtype)
    out_depth = np.full(h * w, np.inf)
    n = len(zn)

    def splat_into(ui, vi, src, only_empty):
        keep = front[src] & (ui >= 0) & (ui < w) & (vi >= 0) & (vi < h)
        ui, vi, src = ui[keep], vi[keep], src[keep]
        target = vi * w + ui
        if only_empty:
            empty = np.isinf(out_depth[target])
            target, src = target[empty], src[empty]
        order = np.argsort(zn[src], kind="stable")  # nearest first
        target, src = target[order], src[order]
        first_target, first = np.unique(target, return_index=True)  # first hit = nearest
        out_rgb[first_target] = colors[src[first]]
        out_depth[first_target] = zn[src[first]]

    # Pass 1: each point to its nearest pixel. Exact for small moves, no edge bleed.
    splat_into(np.rint(un).astype(np.int64), np.rint(vn).astype(np.int64), np.arange(n), False)
    if splat == 2:
        # Pass 2: 2x2 footprint, only into pixels still empty, to close stretching cracks.
        u0, v0 = np.floor(un).astype(np.int64), np.floor(vn).astype(np.int64)
        offsets = ((0, 0), (1, 0), (0, 1), (1, 1))
        splat_into(np.concatenate([u0 + du for du, _ in offsets]),
                   np.concatenate([v0 + dv for _, dv in offsets]),
                   np.tile(np.arange(n), len(offsets)), True)
    holes = np.isinf(out_depth).reshape(h, w)
    return out_rgb.reshape(h, w, -1), out_depth.reshape(h, w), holes


def reshoot_clip(frames, disparity, poses, fov_deg=55.0, near=1.0, far=10.0,
                 depth_smoothing=0.3, mask_grow=4):
    """Warp a whole clip.

    frames: (T, H, W, 3) in [0, 1]; disparity: (T, H, W); poses: list of (R, C).
    Returns warped frames, warped disparity (holes filled from background) and hole masks.
    """
    t, h, w, _ = frames.shape
    disparity = smooth_temporal(disparity.astype(np.float64), depth_smoothing)
    lo, hi = np.percentile(disparity, 1), np.percentile(disparity, 99)
    K = intrinsics(w, h, fov_deg)

    warped = np.zeros_like(frames)
    warped_disp = np.zeros((t, h, w), dtype=np.float32)
    holes = np.zeros((t, h, w), dtype=bool)
    for i in range(t):
        depth = disparity_to_depth(disparity[i], near, far, lo, hi)
        R, C = poses[i]
        rgb, d, hole = warp_frame(frames[i], depth, R, C, K)
        warped[i] = rgb
        warped_disp[i] = depth_to_disparity(fill_holes_background(d, hole), near, far)
        holes[i] = dilate(hole, mask_grow)
    return warped, warped_disp, holes


def pivot_depth_for(disparity_frame, near=1.0, far=10.0, lo=None, hi=None):
    """Median depth of the central region: what the camera orbits around."""
    h, w = disparity_frame.shape
    centre = disparity_frame[h // 4: 3 * h // 4, w // 4: 3 * w // 4]
    return float(np.median(disparity_to_depth(centre, near, far, lo, hi)))
