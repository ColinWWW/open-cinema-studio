import importlib.util
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FILES = ["README.md", "docs/submission/WRITEUP.md", "web/index.html", "web/playwright.config.js", ".github/workflows/pages.yml",
         "scripts/demo/assemble.py"]

spec = importlib.util.spec_from_file_location("rename", ROOT / "scripts" / "rename.py")
rename = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rename)


@pytest.fixture
def copy(tmp_path):
    for rel in FILES:
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, tmp_path / rel)
    return tmp_path


def read(root, rel):
    return (root / rel).read_text(encoding="utf-8")


def test_dry_run_prints_a_diff_and_writes_nothing(copy, capsys):
    before = {rel: read(copy, rel) for rel in FILES}
    assert rename.main(["Greycut", "--slug", "greycut", "--dry-run", "--root", str(copy)]) == 0
    out, err = capsys.readouterr()
    assert "+# Greycut" in out and "+const BASE = '/greycut/';" in out
    assert "warning" not in err
    assert {rel: read(copy, rel) for rel in FILES} == before


def test_name_only(copy):
    assert rename.main(["Greycut", "--root", str(copy)]) == 0
    readme = read(copy, "README.md")
    assert readme.startswith("# Greycut\n") and "Name TBD" not in readme
    writeup = read(copy, "docs/submission/WRITEUP.md")
    assert "\nGreycut\n" in writeup and "I built Greycut to" in writeup
    assert writeup.count("<NAME>") == 1  # only the backticked one in the instructions
    html = read(copy, "web/index.html")
    assert "<title>Greycut — Blocking</title>" in html and 'class="brand">Greycut<' in html
    assert "Open Cinema Studio" not in html
    # no slug: URLs and base paths stay put
    assert "colinwww.github.io/open-cinema-studio/" in readme
    assert "'/open-cinema-studio/'" in read(copy, "web/playwright.config.js")


def test_with_slug(copy):
    assert rename.main(["Blocking Pass", "--slug", "blocking-pass", "--root", str(copy)]) == 0
    for rel in FILES:
        assert "open-cinema-studio" not in read(copy, rel), rel
    assert "**Live:** https://colinwww.github.io/blocking-pass/" in read(copy, "README.md")
    assert "(https://colinwww.github.io/blocking-pass/). It opens" in read(copy, "docs/submission/WRITEUP.md")
    assert "github.com/ColinWWW/blocking-pass#try-it" in read(copy, "web/index.html")
    assert "const BASE = '/blocking-pass/';" in read(copy, "web/playwright.config.js")
    # pages.yml takes the base path from the repo name, so a repo rename covers it
    assert read(copy, ".github/workflows/pages.yml") == read(ROOT, ".github/workflows/pages.yml")


def test_second_run_has_nothing_to_do(copy, capsys):
    assert rename.main(["Greycut", "--slug", "greycut", "--root", str(copy)]) == 0
    assert rename.main(["Greycut", "--slug", "greycut", "--root", str(copy)]) == 1
    assert "already renamed?" in capsys.readouterr().err


@pytest.mark.parametrize("args", [["Grey<cut>"], ["Greycut", "--slug", "Grey Cut"], ["Greycut", "--slug", "-greycut"]])
def test_bad_input_is_refused(copy, args):
    with pytest.raises(SystemExit):
        rename.main([*args, "--root", str(copy)])
