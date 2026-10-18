"""Reshoot web app: upload a clip, pick a camera move, get the re-shot clip back.

Run:  python app/app.py --comfy http://127.0.0.1:8188
"""

import argparse
import importlib.util
import random
import tempfile
from pathlib import Path

import gradio as gr

from comfy_client import ComfyClient, load_workflow, nodes_by_title, patch

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / "workflows" / "reshoot_api.json"

_spec = importlib.util.spec_from_file_location("reshoot_camera", ROOT / "custom_nodes" / "comfyui-reshoot" / "camera.py")
camera = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(camera)

DEFAULT_PROMPT = "cinematic shot, natural lighting, consistent subject, smooth camera motion, high detail"


def run(video, preset, strength, orbit, crane, dolly, truck, pedestal, mode, prompt, seed, comfy_url):
    if not video:
        raise gr.Error("Upload a video first.")
    if not WORKFLOW.exists():
        raise gr.Error(f"Missing {WORKFLOW.relative_to(ROOT)}. Export it from ComfyUI (see workflows/README.md).")

    client = ComfyClient(comfy_url)
    workflow = load_workflow(WORKFLOW)
    uploaded = client.upload(video)
    seed = int(seed) if seed >= 0 else random.randint(0, 2**31 - 1)

    wf = patch(workflow, {
        "RESHOOT_INPUT_VIDEO": {"video": uploaded, "file": uploaded},
        "RESHOOT_CAMERA": {"preset": preset, "strength": strength, "orbit_deg": orbit, "crane_deg": crane,
                           "dolly": dolly, "truck": truck, "pedestal": pedestal, "mode": mode},
        "RESHOOT_PROMPT": {"text": prompt or DEFAULT_PROMPT},
        "RESHOOT_SAMPLER": {"seed": seed, "noise_seed": seed},
    })
    prompt_id = client.queue(wf)
    entry = client.wait(prompt_id)

    out_dir = Path(tempfile.mkdtemp(prefix="reshoot_"))
    outputs = client.download_outputs(entry, nodes_by_title(wf, "RESHOOT_OUTPUT"), out_dir)
    videos = [p for p in outputs if p.suffix.lower() in (".mp4", ".webm", ".mov")]
    if not videos:
        raise gr.Error("The workflow finished but produced no video on the RESHOOT_OUTPUT node.")
    return str(videos[0]), f"seed {seed}"


def build_ui(comfy_url):
    with gr.Blocks(title="Reshoot") as demo:
        gr.Markdown("# Reshoot\nRe-film any clip from a new camera angle. Open-weights only: LTX-2 + Depth Anything.")
        with gr.Row():
            with gr.Column():
                video = gr.Video(label="Source clip", sources=["upload"])
                preset = gr.Dropdown(list(camera.PRESETS.keys()), value="orbit_right", label="Camera move")
                strength = gr.Slider(0, 2, value=1.0, step=0.05, label="Strength")
                mode = gr.Radio(["ramp", "constant"], value="ramp", label="Mode",
                                info="ramp: move during the shot. constant: whole shot from the new angle.")
                with gr.Accordion("Custom move (preset = custom)", open=False):
                    orbit = gr.Slider(-90, 90, value=0, step=0.5, label="Orbit (deg)")
                    crane = gr.Slider(-45, 45, value=0, step=0.5, label="Crane (deg)")
                    dolly = gr.Slider(-0.9, 0.9, value=0, step=0.01, label="Dolly")
                    truck = gr.Slider(-1, 1, value=0, step=0.01, label="Truck")
                    pedestal = gr.Slider(-1, 1, value=0, step=0.01, label="Pedestal")
                prompt = gr.Textbox(label="Describe the scene", placeholder=DEFAULT_PROMPT, lines=2)
                seed = gr.Number(value=-1, precision=0, label="Seed (-1 = random)")
                go = gr.Button("Reshoot", variant="primary")
            with gr.Column():
                result = gr.Video(label="Re-shot clip")
                info = gr.Markdown()
        url = gr.State(comfy_url)
        go.click(run, [video, preset, strength, orbit, crane, dolly, truck, pedestal, mode, prompt, seed, url],
                 [result, info])
    return demo


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--comfy", default="http://127.0.0.1:8188")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--share", action="store_true")
    args = ap.parse_args()
    build_ui(args.comfy).queue(max_size=8).launch(server_name=args.host, server_port=args.port, share=args.share)
