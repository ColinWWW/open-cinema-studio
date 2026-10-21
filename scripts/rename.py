"""Switch the project name from "Open Cinema Studio" / "Name TBD" to the picked one.

    python scripts/rename.py Greycut --dry-run                  # print the diff, write nothing
    python scripts/rename.py Greycut                            # rename the title, page and writeup
    python scripts/rename.py Greycut --slug greycut --dry-run   # + the repo slug in URLs and the Pages base path

Touches the places docs/submission/NAMES.md lists: the README title and "Name TBD" status line, the
`<NAME>` placeholders in docs/submission/WRITEUP.md, the page <title> and header in web/index.html, and,
with --slug, the live-link and repo URLs, `BASE` in web/playwright.config.js and `BASE_PATH` in
.github/workflows/pages.yml (that one already follows the repo name, so it is only rewritten if it was
ever hard-coded). Renaming the GitHub repo itself is a Settings change, done by hand.
"""

import argparse
import difflib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD_NAME = "Open Cinema Studio"
OLD_SLUG = "open-cinema-studio"
OWNER = "ColinWWW"


def name_rules(name):
    """(file, pattern, replacement) for the project name. Patterns are regexes."""
    esc = name.replace("\\", r"\\")
    return [
        ("README.md", rf"\A# {OLD_NAME}$", f"# {esc}"),
        ("README.md", r" Name TBD\.", ""),
        # every <NAME> except the one quoted in backticks in the instructions at the top
        ("docs/submission/WRITEUP.md", r"(?<!`)<NAME>(?!`)", esc),
        ("web/index.html", rf"<title>{OLD_NAME}( —|</title>)", rf"<title>{esc}\1"),
        ("web/index.html", rf'(class="brand">){OLD_NAME}<', rf"\g<1>{esc}<"),
        ("scripts/demo/assemble.py", rf'^TITLE = "{OLD_NAME}"$', f'TITLE = "{esc}"'),  # the video's end card
    ]


def slug_rules(slug):
    pages = rf"colinwww\.github\.io/{OLD_SLUG}/"
    return [
        # WRITEUP gives the current Pages URL "until a rename": after one it is simply the URL
        ("docs/submission/WRITEUP.md", rf"\(https://{pages} until a rename\)", f"(https://colinwww.github.io/{slug}/)"),
        ("README.md", pages, f"colinwww.github.io/{slug}/"),
        *[(f, rf"github\.com/{OWNER}/{OLD_SLUG}\b", f"github.com/{OWNER}/{slug}") for f in ("README.md", "docs/submission/WRITEUP.md", "web/index.html")],
        ("web/playwright.config.js", rf"'/{OLD_SLUG}/'", f"'/{slug}/'"),
        ("web/playwright.config.js", rf"\(under /{OLD_SLUG}/\)", f"(under /{slug}/)"),
        (".github/workflows/pages.yml", rf"(BASE_PATH:\s*)/{OLD_SLUG}/", rf"\g<1>/{slug}/"),
        ("scripts/demo/assemble.py", rf'^LIVE_LINK = "colinwww\.github\.io/{OLD_SLUG}"$', f'LIVE_LINK = "colinwww.github.io/{slug}"'),
        ("scripts/demo/assemble.py", rf'^REPO = "github\.com/{OWNER}/{OLD_SLUG}"$', f'REPO = "github.com/{OWNER}/{slug}"'),
    ]


def plan(root, name, slug=None):
    """{relative path: (old text, new text)} for every file the rename changes, and a list of warnings."""
    rules = name_rules(name) + (slug_rules(slug) if slug else [])
    texts, warnings = {}, []
    for rel, pattern, repl in rules:
        path = root / rel
        if not path.exists():
            warnings.append(f"{rel}: missing, skipped")
            continue
        old, cur = texts.get(rel, (None, None))
        if cur is None:
            old = cur = path.read_text(encoding="utf-8")
        new, n = re.subn(pattern, repl, cur, flags=re.MULTILINE)
        if n == 0 and not (rel.endswith("pages.yml") and "repository.name" in cur):
            warnings.append(f"{rel}: nothing matched {pattern!r} (already renamed?)")
        texts[rel] = (old, new)
    return {rel: t for rel, t in texts.items() if t[0] != t[1]}, warnings


def unified(changes):
    out = []
    for rel, (old, new) in changes.items():
        out += difflib.unified_diff(old.splitlines(True), new.splitlines(True), f"a/{rel}", f"b/{rel}")
    return "".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", help='the new project name, e.g. "Greycut"')
    ap.add_argument("--slug", help="also switch the repo slug in URLs and the Pages base path, e.g. greycut")
    ap.add_argument("--dry-run", action="store_true", help="print the diff and write nothing")
    ap.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)  # tests run on a temp copy
    a = ap.parse_args(argv)

    name = a.name.strip()
    if not name or "\n" in name or "<" in name:
        ap.error("the name must be one line of plain text")
    if a.slug is not None and not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", a.slug):
        ap.error("the slug must be lower-case letters, digits and single hyphens, e.g. greycut")

    changes, warnings = plan(a.root, name, a.slug)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    if not changes:
        print("nothing to change", file=sys.stderr)
        return 1
    if a.dry_run:
        sys.stdout.write(unified(changes))
        return 0
    for rel, (_, new) in changes.items():
        (a.root / rel).write_text(new, encoding="utf-8")
        print(f"updated {rel}")
    if a.slug:
        print(f"Now rename the GitHub repo to {OWNER}/{a.slug} (Settings > General); GitHub redirects the old URL.")
    return 0


if __name__ == "__main__":
    # The diff has non-ASCII (▶, ×, —): print UTF-8 even on a Windows console whose default is cp1252.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
