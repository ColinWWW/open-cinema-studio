"""server.doctor: the checks that run before spending GPU time (no ComfyUI needed)."""

import unittest

from server.doctor import check_graphs, combo_options, target_checks
from server.workflow import MODELS, build_stage1


def object_info_for(graph, drop=()):
    """A fake /object_info that accepts exactly `graph` (minus node classes in `drop`)."""
    info = {}
    for node in graph.values():
        if node["class_type"] in drop:
            continue
        spec = info.setdefault(node["class_type"], {"input": {"required": {}}})["input"]["required"]
        for key, value in node["inputs"].items():
            if isinstance(value, str) and key.endswith("_name"):  # model files: collect every one used
                spec.setdefault(key, [[], {}])[0].append(value)
            else:
                spec[key] = ["STRING", {}]
    return info


class DoctorTest(unittest.TestCase):
    def setUp(self):
        self.graph = build_stage1()

    def test_all_present(self):
        self.assertEqual(check_graphs(object_info_for(self.graph), {"stage1": self.graph}), [])

    def test_missing_node(self):
        problems = check_graphs(object_info_for(self.graph, drop={"GetICLoRAParameters"}), {"stage1": self.graph})
        self.assertEqual(len(problems), 1)
        self.assertIn("GetICLoRAParameters", problems[0])
        self.assertIn("update ComfyUI", problems[0])

    def test_missing_model_file(self):
        info = object_info_for(self.graph)
        info["LoraLoaderModelOnly"]["input"]["required"]["lora_name"] = [["something_else.safetensors"], {}]
        problems = check_graphs(info, {"stage1": self.graph})
        self.assertEqual(len(problems), 1)
        self.assertIn(MODELS["layout_lora"], problems[0])
        self.assertIn("setup_pod.sh", problems[0])

    def test_job_inputs_are_not_model_files(self):
        info = object_info_for(self.graph)
        info["LoadImage"]["input"]["required"]["image"] = [["something.png"], {}]
        self.assertEqual(check_graphs(info, {"stage1": self.graph}), [])

    def test_unknown_input(self):
        info = object_info_for(self.graph)
        del info["RandomNoise"]["input"]["required"]["noise_seed"]
        problems = check_graphs(info, {"stage1": self.graph})
        self.assertEqual(problems, ["stage1: RandomNoise (Seed) has no input 'noise_seed': ComfyUI version mismatch?"])

    def test_combo_formats(self):
        self.assertEqual(combo_options([["a", "b"], {}]), ["a", "b"])
        self.assertEqual(combo_options(["COMBO", {"options": ["a"]}]), ["a"])
        self.assertIsNone(combo_options(["INT", {"default": 1}]))

    def test_target(self):
        self.assertTrue(target_checks({"COMFY_BASE_URL": "http://127.0.0.1:8189"})[0][0])
        self.assertTrue(target_checks({"COMFY_API_KEY": "x"})[0][0])
        ok, msg = target_checks({})[0]
        self.assertFalse(ok)
        self.assertIn("COMFY_API_KEY", msg)


if __name__ == "__main__":
    unittest.main()
