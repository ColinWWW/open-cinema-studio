import json
import re
import unittest
from pathlib import Path

from server.mock_comfyui import REQUIRED, validate
from server.render import BANNED_WORDS, png_size, progress_fields, prompt_warnings, uses_stage2
from server.workflow import (LOOK_NODES, NODES, STAGE2_SIGMAS, WORKFLOW_FILES, build_look_still, build_stage1,
                             build_two_stage, check_dims, look_size, stage1_size)
from server.tests.pngs import gray_png

ROOT = Path(__file__).resolve().parents[2]


class WorkflowTest(unittest.TestCase):
    def test_graph_passes_mock_validation(self):
        g = build_stage1()
        errors = validate(g, inputs_dir=Path("/nonexistent"))
        # only the two input files are missing (nothing was uploaded)
        self.assertEqual(sorted(errors), [NODES["layout"], NODES["look"]])

    def test_settings_follow_model_card(self):
        g = build_stage1(prompt="a plaza", width=960, height=576, frames=97, seed=7)
        by = lambda ct: [n for n in g.values() if n["class_type"] == ct]
        self.assertEqual(by("LoraLoaderModelOnly")[0]["inputs"]["strength_model"], 1.0)
        self.assertEqual(by("KSamplerSelect")[0]["inputs"]["sampler_name"], "euler_ancestral")
        self.assertEqual(len(by("ManualSigmas")[0]["inputs"]["sigmas"].split(",")) - 1, 8)  # 8 steps
        guider = by("LTXVDualCFGGuider")[0]["inputs"]
        self.assertEqual((guider["video_cfg"], guider["audio_cfg"]), (1.0, 1.0))
        self.assertEqual(g[NODES["seed"]]["inputs"]["noise_seed"], 7)
        self.assertEqual(g[NODES["prompt"]]["inputs"]["text"], "a plaza")
        lat = g[NODES["latent"]]["inputs"]
        self.assertEqual((lat["width"], lat["height"], lat["length"]), (960, 576, 97))
        self.assertEqual(g[NODES["audio"]]["inputs"]["frames_number"], 97)
        # the layout clip is the IC-LoRA guide, with the LoRA's own parameters
        guide = by("LTXVAddGuide")[0]["inputs"]
        self.assertEqual(guide["image"][0], "11")
        self.assertEqual(g[guide["iclora_parameters"][0]]["class_type"], "GetICLoRAParameters")

    def test_only_core_nodes(self):
        self.assertTrue({n["class_type"] for n in build_stage1().values()} <= set(REQUIRED))

    def test_committed_json_is_current(self):
        for name, build in WORKFLOW_FILES.items():
            committed = json.loads((ROOT / "workflows" / name).read_text(encoding="utf-8"))
            self.assertEqual(committed, build(), f"{name} is stale, run: python -m server.workflow")

    def test_dims(self):
        check_dims(960, 576, 65)
        for bad in [(960, 544, 65), (1000, 576, 65), (960, 576, 64)]:
            with self.assertRaises(ValueError):
                check_dims(*bad)
        self.assertEqual(stage1_size(960, 576), (960, 576))
        self.assertEqual(stage1_size(1920, 1088), (960, 544))
        build_stage1(width=960, height=544)  # stage-1 latent only needs /32

    def test_png_size(self):
        self.assertEqual(png_size(gray_png(96, 64)), (96, 64))
        with self.assertRaises(ValueError):
            png_size(b"GIF89a" + bytes(30))


class TwoStageWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.g = build_two_stage(prompt="a plaza", frames=97, seed=7)

    def test_graph_passes_mock_validation(self):
        errors = validate(self.g, inputs_dir=Path("/nonexistent"))
        self.assertEqual(sorted(errors), [NODES["layout"], NODES["look"]])

    def test_only_core_nodes(self):
        self.assertTrue({n["class_type"] for n in self.g.values()} <= set(REQUIRED))

    def test_stage2_follows_stage1(self):
        g = self.g
        lat = g[NODES["latent"]]["inputs"]
        self.assertEqual((lat["width"], lat["height"], lat["length"]), (960, 544, 97))  # stage 1 at half size
        up = next(n["inputs"] for n in g.values() if n["class_type"] == "LTXVLatentUpsampler")
        self.assertEqual(g[up["samples"][0]]["class_type"], "LTXVCropGuides")  # guide frames dropped first
        sigmas = [n["inputs"]["sigmas"] for n in g.values() if n["class_type"] == "ManualSigmas"]
        self.assertEqual(sigmas[1], STAGE2_SIGMAS)
        self.assertEqual(len(STAGE2_SIGMAS.split(",")) - 1, 3)  # 3 refine steps
        # the decoders read stage 2's output, and the look still goes back on frame 0
        decode = next(n["inputs"] for n in g.values() if n["class_type"] == "VAEDecodeTiled")
        self.assertEqual(g[g[decode["samples"][0]]["inputs"]["av_latent"][0]]["_meta"]["title"], "Sample stage 2")
        self.assertEqual(len([n for n in g.values() if n["class_type"] == "LTXVImgToVideoInplace"]), 2)
        self.assertEqual(g[NODES["seed"]]["inputs"]["noise_seed"], 7)
        self.assertIn("two-stage", g[NODES["output"]]["inputs"]["filename_prefix"])

    def test_stage1_unchanged(self):
        self.assertNotIn("LTXVLatentUpsampler", {n["class_type"] for n in build_stage1().values()})

    def test_when_stage2_runs(self):
        self.assertTrue(uses_stage2(1920, 1088))
        self.assertFalse(uses_stage2(1920, 1088, two_stage=False))
        self.assertFalse(uses_stage2(960, 576))

    def test_progress_names_the_node(self):
        class Ev:
            value, current_node, step, steps = 0.5, "76", 2, 3
        self.assertEqual(progress_fields(Ev, {"76": "Sample stage 2"}),
                         {"stage": "rendering", "progress": 0.5, "node": "Sample stage 2", "step": 2, "steps": 3})
        Ev.current_node, Ev.steps = None, None
        self.assertEqual(progress_fields(Ev, {}), {"stage": "rendering", "progress": 0.5})


class LookStillWorkflowTest(unittest.TestCase):
    def test_graph_passes_mock_validation(self):
        errors = validate(build_look_still(), inputs_dir=Path("/nonexistent"))
        self.assertEqual(sorted(errors), [LOOK_NODES["depth"]])  # only the depth map isn't uploaded

    def test_only_core_nodes(self):
        self.assertTrue({n["class_type"] for n in build_look_still().values()} <= set(REQUIRED))

    def test_settings_follow_template(self):
        g = build_look_still(prompt="a plaza", width=960, height=576, seed=7, strength=0.8)
        by = lambda ct: [n["inputs"] for n in g.values() if n["class_type"] == ct]
        ks = g[LOOK_NODES["sampler"]]["inputs"]
        self.assertEqual((ks["steps"], ks["cfg"], ks["sampler_name"], ks["scheduler"], ks["seed"]),
                         (8, 1.0, "res_multistep", "simple", 7))
        self.assertEqual(by("ModelSamplingAuraFlow")[0]["shift"], 3.0)
        self.assertEqual(by("CLIPLoader")[0]["type"], "lumina2")
        cn = by("QwenImageDiffsynthControlnet")[0]
        self.assertEqual(cn["strength"], 0.8)
        # the depth map drives the ControlNet, scaled to the ~1 MP generation size
        scale = g[cn["image"][0]]["inputs"]
        self.assertEqual(scale["image"], [LOOK_NODES["depth"], 0])
        lat = g[LOOK_NODES["latent"]]["inputs"]
        self.assertEqual((scale["width"], scale["height"]), (lat["width"], lat["height"]))
        self.assertEqual((lat["width"], lat["height"]), look_size(960, 576))
        # the negative is the zeroed prompt (CFG 1), and the still comes back at the playblast size
        self.assertEqual(g[ks["negative"][0]]["class_type"], "ConditioningZeroOut")
        final = g[g[LOOK_NODES["output"]]["inputs"]["images"][0]]["inputs"]
        self.assertEqual((final["width"], final["height"], final["crop"]), (960, 576, "center"))
        self.assertEqual(g[LOOK_NODES["prompt"]]["inputs"]["text"], "a plaza")

    def test_look_size(self):
        for w, h in [(960, 576), (960, 512), (1920, 1088)]:
            gw, gh = look_size(w, h)
            self.assertEqual((gw % 16, gh % 16), (0, 0))
            self.assertLess(abs(gw * gh / 2**20 - 1), 0.1)  # about 1 MP
            self.assertLess(abs(gw / gh - w / h) / (w / h), 0.02)  # same shape within 2%
        with self.assertRaises(ValueError):
            look_size(1000, 576)

    def test_prompt_warnings(self):
        self.assertEqual(prompt_warnings("A sunny plaza at noon."), [])
        self.assertEqual(len(prompt_warnings("Clay boxes in 3D")), 2)
        self.assertEqual(len(prompt_warnings("Clay-like boxes; 3D/unreal look")), 3)  # split like the web
        self.assertEqual(prompt_warnings("A 3Dog bakery"), [])  # whole words only

    def test_banned_words_match_the_web(self):
        js = (Path(__file__).resolve().parents[2] / "web" / "src" / "render.js").read_text(encoding="utf-8")
        web = re.search(r"const BANNED = \[([^\]]*)\]", js).group(1)
        self.assertEqual(tuple(re.findall(r"'([^']+)'", web)), BANNED_WORDS)


if __name__ == "__main__":
    unittest.main()
