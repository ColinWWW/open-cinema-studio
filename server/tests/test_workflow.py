import json
import unittest
from pathlib import Path

from server.mock_comfyui import REQUIRED, validate
from server.render import png_size, prompt_warnings
from server.workflow import (LOOK_NODES, NODES, WORKFLOW_FILES, build_look_still, build_stage1, check_dims,
                             look_size, stage1_size)
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


if __name__ == "__main__":
    unittest.main()
