"""Flag API/partner nodes in a ComfyUI workflow (Open Weights Only rule).

Usage: python scripts/check_open_weights.py workflows/reshoot_api.json workflows/reshoot.json
Heuristic: matches node class names against known API/partner families. Review hits by hand.
"""

import json
import re
import sys
from pathlib import Path

SUSPECT = re.compile(
    r"(api|partner|openai|gpt|dall|gemini|imagen|veo|kling|runway|luma|minimax|hailuo|pika|ideogram|"
    r"recraft|stability|bfl|flux.?(pro|kontext|ultra)|moonvalley|tripo|rodin|bytedance|seedance|seedream|"
    r"vidu|pixverse|topaz|elevenlabs|claude|anthropic)",
    re.IGNORECASE,
)


def class_types(data):
    if "nodes" in data:  # UI format
        return [n.get("type", "") for n in data["nodes"]]
    return [n.get("class_type", "") for n in data.values() if isinstance(n, dict)]  # API format


def main(paths):
    bad = 0
    for p in paths:
        hits = sorted({c for c in class_types(json.loads(Path(p).read_text(encoding="utf-8"))) if SUSPECT.search(c)})
        for c in hits:
            print(f"{p}: suspicious node {c}")
        bad += len(hits)
    print("OK: no API/partner nodes found" if not bad else f"{bad} node type(s) to review")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
