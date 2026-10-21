"""Minimal client for the ComfyUI HTTP API.

Workflows are API-format JSON (ComfyUI: Workflow > Export (API)). Inputs are
patched by node title (`_meta.title`), so the app only depends on a few titled
nodes, not on node ids or the rest of the graph.
"""

import copy
import json
import time
import uuid
from pathlib import Path

import requests


class ComfyClient:
    def __init__(self, base_url="http://127.0.0.1:8188", timeout=30):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.client_id = str(uuid.uuid4())

    def upload(self, path):
        """Upload a file into ComfyUI's input folder; returns the stored filename."""
        path = Path(path)
        with path.open("rb") as f:
            r = requests.post(f"{self.base}/upload/image",
                              files={"image": (path.name, f)},
                              data={"overwrite": "true"}, timeout=self.timeout * 4)
        r.raise_for_status()
        info = r.json()
        return f"{info['subfolder']}/{info['name']}" if info.get("subfolder") else info["name"]

    def queue(self, workflow):
        r = requests.post(f"{self.base}/prompt",
                          json={"prompt": workflow, "client_id": self.client_id}, timeout=self.timeout)
        if r.status_code != 200:
            raise RuntimeError(f"ComfyUI rejected the workflow: {r.text}")
        return r.json()["prompt_id"]

    def wait(self, prompt_id, poll=2.0, max_wait=3600):
        deadline = time.time() + max_wait
        while time.time() < deadline:
            r = requests.get(f"{self.base}/history/{prompt_id}", timeout=self.timeout)
            r.raise_for_status()
            entry = r.json().get(prompt_id)
            if entry:
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"ComfyUI run failed: {json.dumps(status.get('messages', []))[:2000]}")
                if status.get("completed", True):
                    return entry
            time.sleep(poll)
        raise TimeoutError(f"prompt {prompt_id} did not finish in {max_wait}s")

    def download_outputs(self, history_entry, node_ids, out_dir):
        """Download every file the given nodes produced (videos, gifs, images)."""
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        saved = []
        for node_id in node_ids:
            outputs = history_entry.get("outputs", {}).get(node_id, {})
            for key in ("videos", "gifs", "images"):
                for item in outputs.get(key, []):
                    params = {"filename": item["filename"], "subfolder": item.get("subfolder", ""),
                              "type": item.get("type", "output")}
                    r = requests.get(f"{self.base}/view", params=params, timeout=self.timeout * 4)
                    r.raise_for_status()
                    dest = out_dir / item["filename"]
                    dest.write_bytes(r.content)
                    saved.append(dest)
        return saved


def load_workflow(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def nodes_by_title(workflow, title):
    return [nid for nid, node in workflow.items() if node.get("_meta", {}).get("title") == title]


def patch(workflow, values_by_title):
    """Return a copy with inputs set on titled nodes. Only existing input names are changed."""
    wf = copy.deepcopy(workflow)
    for title, values in values_by_title.items():
        ids = nodes_by_title(wf, title)
        if not ids:
            raise KeyError(f"workflow has no node titled {title!r}")
        for nid in ids:
            inputs = wf[nid]["inputs"]
            for name, value in values.items():
                if name in inputs:
                    inputs[name] = value
    return wf
