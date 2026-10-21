import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("preflight", ROOT / "scripts" / "preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

README = """# Tiny

**Live:** https://example.invalid/tiny/ *(goes live on submission night)*

See [docs](docs/submission/CHECKLIST.md) and <img src="docs/media/hero.gif">.

## Examples

| a | b |
|---|---|
| <img src="examples/still.png"> | [`clip.mp4`](examples/clip.mp4) |

## License

[LICENSE](LICENSE), and `[not a link](nowhere.md)` in code.

```bash
cat [x](also_nowhere.md)
```
"""

CHECKLIST = """# Checklist

- [x] Project name decided (README said "Name TBD")
- [ ] Run `python scripts/preflight.py`
"""

AUDIT = """# Licence audit

| Files | Status |
|---|---|
| `still.png`, `clip.mp4` | ours |
| `ref_street*` | removed |
"""

# A stand-in generator, run as `python -m server.workflow <out_dir>` like the real one
WORKFLOW_PY = """import json
import sys
from pathlib import Path

GRAPH = {"1": {"class_type": "KSampler", "inputs": {}}}


def main(out_dir="workflows"):
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    (Path(out_dir) / "tiny_api.json").write_text(json.dumps(GRAPH, indent=2) + "\\n", encoding="utf-8")


if __name__ == "__main__":
    main(*sys.argv[1:])
"""


def write(root, rel, text):
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_text(text, encoding="utf-8")


@pytest.fixture
def repo(tmp_path):
    write(tmp_path, "README.md", README)
    write(tmp_path, "LICENSE", "MIT\n")
    write(tmp_path, "docs/submission/CHECKLIST.md", CHECKLIST)
    write(tmp_path, "docs/submission/LICENCE_AUDIT.md", AUDIT)
    write(tmp_path, "docs/media/hero.gif", "GIF89a")
    write(tmp_path, "examples/still.png", "png")
    write(tmp_path, "examples/clip.mp4", "mp4")
    write(tmp_path, "server/workflow.py", WORKFLOW_PY)
    (tmp_path / "scripts").mkdir()
    shutil.copy(ROOT / "scripts" / "check_open_weights.py", tmp_path / "scripts")
    subprocess.run([preflight.sys.executable, "-m", "server.workflow"], cwd=tmp_path, check=True)
    return tmp_path


class Opts:
    before_rename = False
    offline = True
    skip_build = True


def statuses(results):
    return [s for s, _, _ in results]


def details(results):
    return [d for _, _, ds in results for d in ds]


def test_tiny_repo_passes_offline_before_rename(repo, capsys):
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    (repo / ".gitignore").write_text("*\n")  # nothing to commit, so git status is clean
    code = preflight.main(["--root", str(repo), "--before-rename", "--offline", "--skip-build"])
    out = capsys.readouterr().out
    assert code == 0, out
    assert "❌" not in out
    assert "README.md:3: goes live on submission night" in out  # a warning, with --before-rename


def test_placeholders_fail_without_before_rename(repo):
    results = preflight.check_placeholders(repo, Opts)
    assert statuses(results) == [preflight.FAIL]
    # the ticked checklist line and backticked text don't count
    assert details(results) == ["README.md:3: goes live on submission night"]
    write(repo, "docs/submission/WRITEUP.md", "I built <NAME>.\nReplace `<NAME>` on the night. TODO (Colin)\n")
    assert details(preflight.check_placeholders(repo, Opts))[1:] == [
        "docs/submission/WRITEUP.md:1: <NAME>", "docs/submission/WRITEUP.md:2: TODO (Colin)"]


def test_broken_links_and_images(repo):
    assert statuses(preflight.check_links(repo, Opts)) == [preflight.OK]  # code spans and blocks are skipped
    (repo / "docs/media/hero.gif").unlink()
    write(repo, "docs/PLAN.md", "[up](../README.md#tiny) [gone](submission/GONE.md) [web](https://x.invalid) [here](#top)\n")
    results = preflight.check_links(repo, Opts)
    assert statuses(results) == [preflight.FAIL]
    assert details(results) == ["README.md:5: docs/media/hero.gif", "docs/PLAN.md:1: submission/GONE.md"]


def test_examples_missing_and_too_big(repo):
    assert statuses(preflight.check_examples(repo, Opts)) == [preflight.OK]
    (repo / "examples/clip.mp4").unlink()
    with open(repo / "examples/still.png", "wb") as f:
        f.truncate(preflight.EXAMPLE_MAX)
    assert sorted(details(preflight.check_examples(repo, Opts))) == ["examples/still.png: 20.0 MB", "missing: examples/clip.mp4"]


def test_workflow_drift_and_api_nodes(repo):
    assert statuses(preflight.check_workflows(repo, Opts)) == [preflight.OK, preflight.OK]
    write(repo, "workflows/tiny_api.json", '{"1": {"class_type": "OpenAIImageNode"}}\n')
    results = preflight.check_workflows(repo, Opts)
    assert statuses(results) == [preflight.FAIL, preflight.FAIL]
    assert "suspicious node OpenAIImageNode" in "\n".join(results[0][2])
    assert results[1][2] == ["workflows/tiny_api.json: differs (run python -m server.workflow and commit)"]


def test_licence_audit_coverage(repo):
    assert statuses(preflight.check_licences(repo, Opts)) == [preflight.OK, preflight.OK]
    write(repo, "examples/new_render.mp4", "mp4")
    (repo / "examples/still.png").unlink()
    (repo / "LICENSE").unlink()
    results = preflight.check_licences(repo, Opts)
    assert statuses(results) == [preflight.FAIL, preflight.FAIL, preflight.WARN]
    assert results[1][2] == ["examples/new_render.mp4"]
    assert results[2][2] == ["still.png"]  # named in the audit but gone


def test_brace_patterns_cover_files(repo):
    write(repo, "docs/submission/LICENCE_AUDIT.md", AUDIT + "| `stage1_{day,night}_*.mp4`, `look_*` | ours |\n")
    for name in ("stage1_day_a40.mp4", "stage1_night_a40.mp4", "look_x.png"):
        write(repo, f"examples/{name}", "x")
    assert statuses(preflight.check_licences(repo, Opts)) == [preflight.OK, preflight.OK]
    write(repo, "examples/stage1_snow_a40.mp4", "x")
    assert preflight.check_licences(repo, Opts)[1][2] == ["examples/stage1_snow_a40.mp4"]


def test_dirty_git_status_fails(repo):
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    results = preflight.check_git(repo, Opts)
    assert results[0][0] == preflight.FAIL and "?? LICENSE" in results[0][2]
    assert results[1][0] == preflight.WARN  # last CI run: skipped offline


def test_live_url_skipped_offline_or_before_pages(repo, monkeypatch):
    assert statuses(preflight.check_live(repo, Opts)) == [preflight.WARN]

    class Online(Opts):
        offline = False

    def http(code):
        def urlopen(*_a, **_k):
            raise preflight.urllib.error.HTTPError("u", code, "x", {}, None)
        return urlopen

    monkeypatch.setattr(preflight.urllib.request, "urlopen", http(404))
    assert statuses(preflight.check_live(repo, Online)) == [preflight.WARN]  # README still says not live yet
    write(repo, "README.md", README.replace(" *(goes live on submission night)*", ""))
    assert statuses(preflight.check_live(repo, Online)) == [preflight.FAIL]

    def no_network(*_a, **_k):
        raise preflight.urllib.error.URLError("no route")
    monkeypatch.setattr(preflight.urllib.request, "urlopen", no_network)
    assert statuses(preflight.check_live(repo, Online)) == [preflight.WARN]


@pytest.mark.skipif(not shutil.which("npm"), reason="needs npm")
def test_build_and_dist_size(repo):
    write(repo, "web/package.json", '{"scripts": {"build": "node -e \\"require(\'fs\').mkdirSync(\'dist\');'
          'require(\'fs\').writeFileSync(\'dist/index.html\', \'hi\')\\""}}\n')
    (repo / "web/node_modules").mkdir()

    class Build(Opts):
        skip_build = False

    results = preflight.check_build(repo, Build)
    assert statuses(results) == [preflight.OK], results
    assert "web/dist/ is 0.0 MB" in results[0][1]
