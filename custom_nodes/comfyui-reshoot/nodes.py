import numpy as np
import torch
import torch.nn.functional as F

from .camera import MOVE_KEYS, PRESETS, trajectory
from .warp import pivot_depth_for, reshoot_clip, smooth_temporal

CATEGORY = "Reshoot"


class ReshootCameraMove:
    """Describes the new camera path. Pick a preset, or 'custom' to use the sliders."""

    @classmethod
    def INPUT_TYPES(cls):
        move = {"default": 0.0, "step": 0.01}
        return {
            "required": {
                "preset": (list(PRESETS.keys()), {"default": "orbit_right"}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.05}),
                "orbit_deg": ("FLOAT", {**move, "min": -90.0, "max": 90.0, "step": 0.5}),
                "crane_deg": ("FLOAT", {**move, "min": -45.0, "max": 45.0, "step": 0.5}),
                "dolly": ("FLOAT", {**move, "min": -0.9, "max": 0.9}),
                "truck": ("FLOAT", {**move, "min": -1.0, "max": 1.0}),
                "pedestal": ("FLOAT", {**move, "min": -1.0, "max": 1.0}),
                "mode": (["ramp", "constant"], {"default": "ramp"}),
                "easing": (["ease_in_out", "ease_out", "linear"], {"default": "ease_in_out"}),
            }
        }

    RETURN_TYPES = ("RESHOOT_CAMERA",)
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(self, preset, strength, mode, easing, **values):
        move = {"preset": preset, "strength": strength, "mode": mode, "easing": easing}
        move.update({k: values[k] for k in MOVE_KEYS})
        return (move,)


class ReshootDepthWarp:
    """Re-renders the clip from the new camera using per-frame depth.

    Outputs the warped clip (with holes), depth from the new viewpoint (for a depth
    IC-LoRA guide) and a mask of regions the original camera never saw.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "depth": ("IMAGE", {"tooltip": "Disparity-style depth, near = bright (Depth Anything)."}),
                "camera": ("RESHOOT_CAMERA",),
                "fov_deg": ("FLOAT", {"default": 55.0, "min": 15.0, "max": 120.0, "step": 1.0}),
                "depth_range": ("FLOAT", {"default": 10.0, "min": 1.5, "max": 100.0, "step": 0.5,
                                          "tooltip": "far/near ratio. Higher = more parallax between fore- and background."}),
                "depth_smoothing": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 0.95, "step": 0.05}),
                "mask_grow": ("INT", {"default": 4, "min": 0, "max": 64}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("warped", "warped_depth", "holes")
    FUNCTION = "warp"
    CATEGORY = CATEGORY

    def warp(self, images, depth, camera, fov_deg, depth_range, depth_smoothing, mask_grow):
        t, h, w, _ = images.shape
        if depth.shape[1:3] != (h, w):
            depth = F.interpolate(depth.movedim(-1, 1), size=(h, w), mode="bilinear",
                                  align_corners=False).movedim(1, -1)
        frames = images.cpu().numpy().astype(np.float32)
        disp = smooth_temporal(depth[..., 0].cpu().numpy().astype(np.float64), depth_smoothing)
        if disp.shape[0] != t:
            raise ValueError(f"depth has {disp.shape[0]} frames but images has {t}")

        near, far = 1.0, float(depth_range)
        lo, hi = np.percentile(disp, 1), np.percentile(disp, 99)
        pivot = pivot_depth_for(disp[0], near, far, lo, hi)
        poses = trajectory(t, camera, pivot, camera.get("mode", "ramp"), camera.get("easing", "ease_in_out"))

        warped, warped_disp, holes = reshoot_clip(frames, disp, poses, fov_deg, near, far,
                                                  depth_smoothing=0.0, mask_grow=mask_grow)
        warped_depth = torch.from_numpy(warped_disp).unsqueeze(-1).repeat(1, 1, 1, 3)
        return (torch.from_numpy(warped), warped_depth.float(), torch.from_numpy(holes.astype(np.float32)))


class ReshootFitLTX:
    """Trims to 8n+1 frames and resizes to multiples of 32, as LTX expects."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "long_side": ("INT", {"default": 768, "min": 256, "max": 2048, "step": 32}),
                "max_frames": ("INT", {"default": 97, "min": 9, "max": 1001, "step": 8}),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT")
    RETURN_NAMES = ("images", "frames", "width", "height")
    FUNCTION = "fit"
    CATEGORY = CATEGORY

    def fit(self, images, long_side, max_frames):
        t, h, w, _ = images.shape
        n = min(t, max_frames)
        n = max(1, ((n - 1) // 8) * 8 + 1)
        scale = long_side / max(h, w)
        nh = max(32, int(round(h * scale / 32)) * 32)
        nw = max(32, int(round(w * scale / 32)) * 32)
        out = images[:n].movedim(-1, 1)
        out = F.interpolate(out, size=(nh, nw), mode="bilinear", align_corners=False, antialias=True)
        return (out.movedim(1, -1).clamp(0, 1), n, nw, nh)


NODE_CLASS_MAPPINGS = {
    "ReshootCameraMove": ReshootCameraMove,
    "ReshootDepthWarp": ReshootDepthWarp,
    "ReshootFitLTX": ReshootFitLTX,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ReshootCameraMove": "Reshoot Camera Move",
    "ReshootDepthWarp": "Reshoot Depth Warp",
    "ReshootFitLTX": "Reshoot Fit for LTX",
}
