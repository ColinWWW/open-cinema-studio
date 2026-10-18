"""Camera trajectories for Reshoot.

Coordinate frame is the original camera's: x right, y down, z forward.
A pose is (R, C): R's columns are the new camera's axes expressed in the
original frame, C is the new camera centre. A point X in original camera
coordinates maps to new camera coordinates as R.T @ (X - C).
"""

import numpy as np

PRESETS = {
    "custom": None,
    "orbit_left": dict(orbit_deg=-25.0),
    "orbit_right": dict(orbit_deg=25.0),
    "crane_up": dict(crane_deg=15.0, pedestal=0.15),
    "crane_down": dict(crane_deg=-12.0, pedestal=-0.1),
    "dolly_in": dict(dolly=0.3),
    "dolly_out": dict(dolly=-0.3),
    "truck_left": dict(truck=-0.25),
    "truck_right": dict(truck=0.25),
    "hero_arc": dict(orbit_deg=30.0, crane_deg=-8.0, dolly=0.15),
    "drone_reveal": dict(crane_deg=20.0, pedestal=0.3, dolly=-0.25),
}

MOVE_KEYS = ("orbit_deg", "crane_deg", "dolly", "truck", "pedestal")


def rot_x(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def rot_y(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def ease(t, easing):
    t = float(np.clip(t, 0.0, 1.0))
    if easing == "ease_in_out":
        return t * t * (3.0 - 2.0 * t)
    if easing == "ease_out":
        return 1.0 - (1.0 - t) ** 2
    return t


def camera_pose(orbit_deg=0.0, crane_deg=0.0, dolly=0.0, truck=0.0, pedestal=0.0, pivot_depth=1.0):
    """Pose of the new camera relative to the original one.

    orbit_deg > 0 swings the camera to the right around the pivot,
    crane_deg > 0 swings it up (looking down at the pivot).
    dolly / truck / pedestal are fractions of pivot_depth along the new
    camera's forward / right / up axes.
    """
    R = rot_y(-np.radians(orbit_deg)) @ rot_x(-np.radians(crane_deg))
    pivot = np.array([0.0, 0.0, pivot_depth])
    C = pivot + R @ np.array([0.0, 0.0, -pivot_depth])
    C = C + R @ (np.array([truck, -pedestal, dolly]) * pivot_depth)
    return R, C


def resolve_move(move):
    """Merge a preset (if any) with explicit values. Preset wins unless 'custom'."""
    preset = PRESETS.get(move.get("preset", "custom"))
    out = {k: float(move.get(k, 0.0)) for k in MOVE_KEYS}
    if preset:
        out = {k: float(preset.get(k, 0.0)) for k in MOVE_KEYS}
    strength = float(move.get("strength", 1.0))
    return {k: v * strength for k, v in out.items()}


def trajectory(n_frames, move, pivot_depth, mode="ramp", easing="ease_in_out"):
    """One (R, C) pose per frame.

    ramp: frame 0 is the original view, the last frame reaches the full move.
    constant: every frame is shot from the full move.
    """
    target = resolve_move(move)
    poses = []
    for i in range(n_frames):
        s = 1.0 if mode == "constant" or n_frames == 1 else ease(i / (n_frames - 1), easing)
        poses.append(camera_pose(pivot_depth=pivot_depth, **{k: v * s for k, v in target.items()}))
    return poses
