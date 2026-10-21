"""Our stage-1 Layout-to-Render workflow, built from ComfyUI core nodes only.

LTX-2.5 and its IC-LoRA guide nodes are native in ComfyUI core, so this graph needs no custom
nodes and copies nothing from Lightricks' workflow (which ships under the LTX license). The wiring
follows ComfyUI's own MIT templates (LTX-2.5 I2V + LTX-2.3 IC-LoRA) and the Layout-to-Render model
card: LoRA at 1.0, CFG 1, euler_ancestral, seed 42, 8 distilled steps, look still as frame 0.

    python -m server.workflow            # writes workflows/*_api.json (stage 1, two-stage, look still)

The server builds the graph at runtime and sets inputs by node id (see NODES); the JSON file is the
same graph with placeholder inputs, for loading in ComfyUI and for scripts/check_open_weights.py.
"""

import json
import sys
from pathlib import Path

MODELS = {
    "unet": "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
    "text_encoder": "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    "video_vae": "ltx-2.5-video-vae-bf16.safetensors",
    "audio_vae": "ltx-2.5-audio-vae-bf16.safetensors",
    "layout_lora": "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",
    "upscaler": "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",  # models/latent_upscale_models
}

# Distilled stage-1 schedule (8 steps), as in ComfyUI's LTX-2.5 template.
STAGE1_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
# Stage 2 refines the x2-upscaled latent in 3 steps, as in ComfyUI's two-stage LTX-2.5 I2V template.
STAGE2_SIGMAS = "0.85, 0.7250, 0.4219, 0.0"
NEGATIVE = "blurry, low quality, still frame, frames, watermark, overlay, titles, subtitles"

# Node ids the server sets inputs on.
NODES = {
    "layout": "10",   # LoadVideo.file
    "look": "12",     # LoadImage.image
    "prompt": "20",   # CLIPTextEncode.text
    "latent": "30",   # EmptyLTXVLatentVideo width/height/length
    "audio": "31",    # LTXVEmptyLatentAudio frames_number
    "seed": "40",     # RandomNoise.noise_seed
    "output": "60",   # SaveVideo
}

FPS = 24


def _link(node_id, slot=0):
    return [node_id, slot]


def build_stage1(layout="layout.mp4", look="look.png", prompt="", *, width=960, height=576,
                 frames=65, seed=42, models=None, filename_prefix="cinema-studio/stage1", stage2=False):
    """Return the API-format graph. `layout`/`look` are input filenames (or SDK asset handles).
    `width`/`height` are the stage-1 size; with `stage2` the clip comes out at twice that (see add_stage2)."""
    m = {**MODELS, **(models or {})}
    check_dims(width, height, frames, multiple=32)  # the latent only needs /32 (960x544 at stage 1)
    g = {
        # models
        "1": _node("UNETLoader", "Load LTX-2.5 (distilled)", unet_name=m["unet"], weight_dtype="default"),
        "2": _node("CLIPLoader", "Load Gemma text encoder", clip_name=m["text_encoder"], type="ltxv", device="default"),
        "3": _node("VAELoader", "Load video VAE", vae_name=m["video_vae"]),
        "4": _node("VAELoader", "Load audio VAE", vae_name=m["audio_vae"]),
        "5": _node("LoraLoaderModelOnly", "Layout-to-Render IC-LoRA", model=_link("1"),
                   lora_name=m["layout_lora"], strength_model=1.0),
        "6": _node("GetICLoRAParameters", "IC-LoRA parameters", iclora_model=_link("5")),
        # inputs
        NODES["layout"]: _node("LoadVideo", "Layout clip", file=layout),
        "11": _node("GetVideoComponents", "Layout frames", video=_link(NODES["layout"])),
        NODES["look"]: _node("LoadImage", "Look still (first frame)", image=look),
        "13": _node("LTXVPreprocess", "Look still preprocess", image=_link(NODES["look"]), img_compression=18),
        # text
        NODES["prompt"]: _node("CLIPTextEncode", "Prompt", text=prompt, clip=_link("2")),
        "21": _node("CLIPTextEncode", "Negative prompt", text=NEGATIVE, clip=_link("2")),
        "22": _node("LTXVConditioning", "Conditioning", positive=_link(NODES["prompt"]), negative=_link("21"),
                    frame_rate=float(FPS)),
        # latents: look still replaces frame 0, the layout clip goes in as the IC-LoRA guide
        NODES["latent"]: _node("EmptyLTXVLatentVideo", "Video latent", width=width, height=height,
                               length=frames, batch_size=1),
        NODES["audio"]: _node("LTXVEmptyLatentAudio", "Audio latent", frames_number=frames, frame_rate=FPS,
                              batch_size=1, audio_vae=_link("4")),
        "32": _node("LTXVImgToVideoInplace", "Look still -> frame 0", vae=_link("3"), image=_link("13"),
                    latent=_link(NODES["latent"]), strength=1.0, bypass=False),
        "33": _node("LTXVAddGuide", "Layout guide", positive=_link("22", 0), negative=_link("22", 1),
                    vae=_link("3"), latent=_link("32"), image=_link("11", 0), frame_idx=0, strength=1.0,
                    iclora_parameters=_link("6")),
        "34": _node("LTXVConcatAVLatent", "Join audio+video", video_latent=_link("33", 2),
                    audio_latent=_link(NODES["audio"])),
        # sampling
        NODES["seed"]: _node("RandomNoise", "Seed", noise_seed=seed),
        "41": _node("KSamplerSelect", "Sampler", sampler_name="euler_ancestral"),
        "42": _node("ManualSigmas", "Stage 1 sigmas (8 steps)", sigmas=STAGE1_SIGMAS),
        "43": _node("LTXVDualCFGGuider", "Guider (CFG 1)", model=_link("5"), positive=_link("33", 0),
                    negative=_link("33", 1), video_cfg=1.0, audio_cfg=1.0),
        "44": _node("SamplerCustomAdvanced", "Sample stage 1", noise=_link(NODES["seed"]), guider=_link("43"),
                    sampler=_link("41"), sigmas=_link("42"), latent_image=_link("34")),
        # decode
        "50": _node("LTXVSeparateAVLatent", "Split audio+video", av_latent=_link("44")),
        "51": _node("LTXVCropGuides", "Drop guide frames", positive=_link("33", 0), negative=_link("33", 1),
                    latent=_link("50", 0)),
        "52": _node("VAEDecodeTiled", "Decode video", samples=_link("51", 2), vae=_link("3"), tile_size=512,
                    overlap=64, temporal_size=64, temporal_overlap=16),
        "53": _node("LTXVAudioVAEDecode", "Decode audio", samples=_link("50", 1), audio_vae=_link("4")),
        "54": _node("CreateVideo", "Make video", images=_link("52"), audio=_link("53"), fps=float(FPS)),
        NODES["output"]: _node("SaveVideo", "Save render", video=_link("54"), filename_prefix=filename_prefix,
                               format="mp4", **{"format.codec": "auto"}),
    }
    if stage2:
        add_stage2(g, m)
    return g


def add_stage2(g, m):
    """Stage 2: upscale the stage-1 latent x2 (960x544 -> 1920x1088) and refine it in 3 steps.

    Follows the second stage of ComfyUI's MIT two-stage LTX-2.5 I2V template: LTXVLatentUpsampler,
    the look still put back on frame 0 at full size, stage 1's audio latent, the base distilled model,
    STAGE2_SIGMAS. The layout guide frames were cropped off after stage 1 (LTXVCropGuides), so stage 2
    runs without the IC-LoRA and keeps the layout through the upscaled latent itself. The decode nodes
    are rewired to stage 2's output."""
    g.update({
        "70": _node("LatentUpscaleModelLoader", "Load x2 latent upscaler", model_name=m["upscaler"]),
        "71": _node("LTXVLatentUpsampler", "Upscale latent x2", samples=_link("51", 2), upscale_model=_link("70"),
                    vae=_link("3")),
        "72": _node("LTXVImgToVideoInplace", "Look still -> frame 0 (full size)", vae=_link("3"), image=_link("13"),
                    latent=_link("71"), strength=1.0, bypass=False),
        "73": _node("LTXVConcatAVLatent", "Join audio+video (stage 2)", video_latent=_link("72"),
                    audio_latent=_link("50", 1)),
        "74": _node("ManualSigmas", "Stage 2 sigmas (3 steps)", sigmas=STAGE2_SIGMAS),
        "75": _node("LTXVDualCFGGuider", "Guider stage 2 (CFG 1)", model=_link("1"), positive=_link("51", 0),
                    negative=_link("51", 1), video_cfg=1.0, audio_cfg=1.0),
        "76": _node("SamplerCustomAdvanced", "Sample stage 2", noise=_link(NODES["seed"]), guider=_link("75"),
                    sampler=_link("41"), sigmas=_link("74"), latent_image=_link("73")),
        "77": _node("LTXVSeparateAVLatent", "Split audio+video (stage 2)", av_latent=_link("76")),
    })
    g["52"]["inputs"]["samples"] = _link("77", 0)
    g["53"]["inputs"]["samples"] = _link("77", 1)
    g[NODES["output"]]["inputs"]["filename_prefix"] = g[NODES["output"]]["inputs"]["filename_prefix"].replace(
        "stage1", "two-stage")


def build_two_stage(**kw):
    """The 1920x1088 graph: stage 1 at 960x544, then stage 2 (for workflows/two_stage_layout_api.json)."""
    return build_stage1(**{"width": 960, "height": 544, **kw, "stage2": True})


# ---------- look still: frame 0 art direction from the playblast's depth ----------
#
# Z-Image-Turbo + alibaba-pai's Fun ControlNet Union (depth), both Apache-2.0 and native in ComfyUI
# core (ModelPatchLoader + QwenImageDiffsynthControlnet). The wiring follows ComfyUI's MIT template
# image_z_image_turbo_fun_union_controlnet: AuraFlow shift 3, 8 steps, CFG 1, res_multistep/simple,
# zeroed negative. The depth map comes straight from the clay scene (near = white), so the still
# matches the layout's frame 0 box for box and the video render keeps both the look and the layout.

LOOK_MODELS = {
    "unet": "z_image_turbo_bf16.safetensors",
    "text_encoder": "qwen_3_4b.safetensors",
    "vae": "ae.safetensors",
    "controlnet": "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors",  # models/model_patches
}

LOOK_NODES = {
    "depth": "10",    # LoadImage.image (depth map of frame 0, output size)
    "prompt": "20",   # CLIPTextEncode.text
    "latent": "30",   # EmptySD3LatentImage width/height
    "sampler": "40",  # KSampler seed
    "output": "60",   # SaveImage
}

LOOK_PIXELS = 1024 * 1024  # Z-Image's native ~1 MP


def look_size(width, height):
    """Generation size for a still of `width`x`height`: about 1 MP, same aspect, divisible by 16."""
    if width % 64 or height % 64:
        raise ValueError(f"width and height must be divisible by 64, got {width}x{height}")
    scale = (LOOK_PIXELS / (width * height)) ** 0.5
    gw = max(16, round(width * scale / 16) * 16)
    gh = max(16, round(gw * height / width / 16) * 16)
    return gw, gh


def build_look_still(depth="depth.png", prompt="", *, width=960, height=576, seed=42, strength=1.0,
                     models=None, filename_prefix="cinema-studio/look"):
    """Return the API-format graph: depth map + prompt -> a still at exactly `width`x`height`."""
    m = {**LOOK_MODELS, **(models or {})}
    gw, gh = look_size(width, height)
    g = {
        # models
        "1": _node("UNETLoader", "Load Z-Image-Turbo", unet_name=m["unet"], weight_dtype="default"),
        "2": _node("CLIPLoader", "Load Qwen3 text encoder", clip_name=m["text_encoder"], type="lumina2",
                   device="default"),
        "3": _node("VAELoader", "Load VAE", vae_name=m["vae"]),
        "4": _node("ModelPatchLoader", "Load Fun ControlNet Union", name=m["controlnet"]),
        # depth control
        LOOK_NODES["depth"]: _node("LoadImage", "Depth map (frame 0)", image=depth),
        "11": _node("ImageScale", "Depth to generation size", image=_link(LOOK_NODES["depth"]),
                    upscale_method="bilinear", width=gw, height=gh, crop="center"),
        "5": _node("QwenImageDiffsynthControlnet", "Depth control", model=_link("1"), model_patch=_link("4"),
                   vae=_link("3"), image=_link("11"), strength=float(strength)),
        "6": _node("ModelSamplingAuraFlow", "Shift 3", model=_link("5"), shift=3.0),
        # text
        LOOK_NODES["prompt"]: _node("CLIPTextEncode", "Prompt", text=prompt, clip=_link("2")),
        "21": _node("ConditioningZeroOut", "Empty negative", conditioning=_link(LOOK_NODES["prompt"])),
        # sampling
        LOOK_NODES["latent"]: _node("EmptySD3LatentImage", "Image latent", width=gw, height=gh, batch_size=1),
        LOOK_NODES["sampler"]: _node("KSampler", "Sample (8 steps, CFG 1)", model=_link("6"), seed=seed, steps=8,
                                     cfg=1.0, sampler_name="res_multistep", scheduler="simple",
                                     positive=_link(LOOK_NODES["prompt"]), negative=_link("21"),
                                     latent_image=_link(LOOK_NODES["latent"]), denoise=1.0),
        # decode at the playblast's exact size
        "50": _node("VAEDecode", "Decode", samples=_link(LOOK_NODES["sampler"]), vae=_link("3")),
        "51": _node("ImageScale", "To playblast size", image=_link("50"), upscale_method="lanczos",
                    width=width, height=height, crop="center"),
        LOOK_NODES["output"]: _node("SaveImage", "Save look still", images=_link("51"),
                                    filename_prefix=filename_prefix),
    }
    return g


def _node(class_type, title, **inputs):
    return {"class_type": class_type, "inputs": inputs, "_meta": {"title": title}}


def check_dims(width, height, frames, multiple=64):
    """The Layout-to-Render recipe for layout clips: dims divisible by 64, 8k+1 frames."""
    if width % multiple or height % multiple:
        raise ValueError(f"width and height must be divisible by {multiple}, got {width}x{height}")
    if frames < 9 or (frames - 1) % 8:
        raise ValueError(f"frames must be 8k+1 (65, 97, 121...), got {frames}")


def stage1_size(width, height):
    """Stage 1 runs at the clip size up to 960 wide; bigger layouts run at half size (1920x1088 -> 960x544)."""
    while width > 960:
        width, height = width // 2, height // 2
    return width - width % 32, height - height % 32


WORKFLOW_FILES = {"stage1_layout_api.json": build_stage1, "two_stage_layout_api.json": build_two_stage,
                  "look_still_depth_api.json": build_look_still}


def main(out_dir="workflows"):
    for name, build in WORKFLOW_FILES.items():
        path = Path(out_dir) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(build(), indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path}")


if __name__ == "__main__":
    main(*sys.argv[1:])
