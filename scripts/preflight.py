"""Submission-night preflight: one ✅/❌ line per check, exit 1 on any ❌.

Usage: python scripts/preflight.py [--before-rename] [--offline] [--skip-build]
  --before-rename  placeholders (<NAME>, Name TBD, ...) are warnings, not failures
  --offline        skip the live-URL and last-CI checks (they need the network)
  --skip-build     skip `npm run build` in web/
⚠️ lines are warnings and skipped checks; they don't fail the run.
"""

import argparse
import fnmatch
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
MB = 1024 * 1024
EXAMPLE_MAX = 20 * MB
DIST_MAX = 25 * MB
PLACEHOLDERS = ["<NAME>", "Name TBD", "TODO (Colin)", "goes live on submission night"]
PRE_LIVE = "goes live on submission night"  # while the README says this, Pages isn't on yet

OK, FAIL, WARN = "ok", "fail", "warn"
ICON = {OK: "✅", FAIL: "❌", WARN: "⚠️ "}


# Markdown helpers

FENCE = re.compile(r"^\s*(```|~~~)")
CODE_SPAN = re.compile(r"`+[^`]*`+")
LINK = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
REF_DEF = re.compile(r"^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+\".*\")?\s*$")
HTML_ATTR = re.compile(r"<(?:img|a|source|video)\b[^>]*?\b(?:src|href)=[\"']([^\"']+)[\"']", re.IGNORECASE)


def prose_lines(text):
    """(line number, line) outside fenced code blocks, with inline code spans blanked."""
    fenced = False
    for n, line in enumerate(text.splitlines(), 1):
        if FENCE.match(line):
            fenced = not fenced
            continue
        if not fenced:
            yield n, CODE_SPAN.sub("``", line)


def link_targets(text):
    """(line number, target) for every Markdown link, image, reference definition and HTML src/href."""
    for n, line in prose_lines(text):
        m = REF_DEF.match(line)
        if m:
            yield n, m.group(1)
        for rx in (LINK, HTML_ATTR):
            for m in rx.finditer(line):
                yield n, m.group(1)


def is_relative(target):
    return not re.match(r"^([a-z][a-z0-9+.-]*:|#|//)", target, re.IGNORECASE)


def resolve(root, md_file, target):
    path = target.split("#", 1)[0].split("?", 1)[0]
    if not path:
        return None  # a same-page anchor
    path = unquote(path)
    return (root / path.lstrip("/")) if path.startswith("/") else (md_file.parent / path)


def section(text, heading):
    """The body of the `## heading` section, up to the next heading of the same or higher level."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^(#+)\s+(.*?)\s*$", line)
        if m and m.group(2).lower() == heading.lower():
            level = len(m.group(1))
            body = []
            for nxt in lines[i + 1:]:
                h = re.match(r"^(#+)\s", nxt)
                if h and len(h.group(1)) <= level:
                    break
                body.append(nxt)
            return "\n".join(body)
    return None


def rel(root, path):
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)


# Checks. Each returns a list of (status, label, details).

def check_links(root, _opts):
    files = [root / "README.md"] + sorted((root / "docs").rglob("*.md"))
    broken = []
    for md in files:
        if not md.is_file():
            continue
        for n, target in link_targets(md.read_text(encoding="utf-8")):
            if not is_relative(target):
                continue
            path = resolve(root, md, target)
            if path is not None and not path.exists():
                broken.append(f"{rel(root, md)}:{n}: {target}")
    label = f"Relative links and images in README.md and docs/ ({len(files)} files)"
    return [(FAIL, label, broken) if broken else (OK, label, [])]


def occurrences(line, s):
    i = line.find(s)
    while i >= 0:
        yield i
        i = line.find(s, i + 1)


def quoted(line, i):
    """Is position i inside "...", “...” or `...` on this line? Then the line names the placeholder (e.g.
    'README says "Name TBD"' in the checklist) rather than being one, and it stays after the rename."""
    before = line[:i]
    return before.count('"') % 2 == 1 or before.count("`") % 2 == 1 or before.count("“") > before.count("”")


def check_placeholders(root, opts):
    files = [root / "README.md"]
    sub = root / "docs" / "submission"
    if sub.is_dir():
        files += sorted(p for p in sub.rglob("*") if p.is_file())
    hits = []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        for n, line in prose_lines(text):
            if re.match(r"^\s*[-*] \[[xX]\]", line):
                continue  # a ticked checklist item that names the placeholder it removed
            for p in PLACEHOLDERS:
                if any(not quoted(line, i) for i in occurrences(line, p)):
                    hits.append(f"{rel(root, f)}:{n}: {p}")
    label = "No placeholders left in README.md and docs/submission/"
    if not hits:
        return [(OK, label, [])]
    return [(WARN if opts.before_rename else FAIL, label + (" (--before-rename: warning only)" if opts.before_rename else ""), hits)]


def check_examples(root, _opts):
    readme = root / "README.md"
    body = section(readme.read_text(encoding="utf-8"), "Examples") if readme.is_file() else None
    label = "Files linked from the README's Examples section exist and are under 20 MB"
    if body is None:
        return [(FAIL, label, ["README.md has no '## Examples' section"])]
    problems, count = [], 0
    for _, target in link_targets(body):
        if not is_relative(target):
            continue
        path = resolve(root, readme, target)
        if path is None:
            continue
        count += 1
        if not path.is_file():
            problems.append(f"missing: {target}")
        elif path.stat().st_size >= EXAMPLE_MAX:
            problems.append(f"{target}: {path.stat().st_size / MB:.1f} MB")
    label += f" ({count} links)"
    return [(FAIL, label, problems) if problems else (OK, label, [])]


def run(cmd, cwd, timeout=600):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def tail(text, n=15):
    return text.strip().splitlines()[-n:]


def check_workflows(root, _opts):
    out = []
    files = sorted(str(p.relative_to(root)) for p in (root / "workflows").glob("*.json"))
    label = "Open weights: scripts/check_open_weights.py workflows/*.json"
    if not files:
        out.append((FAIL, label, ["no workflows/*.json"]))
    else:
        r = run([sys.executable, "scripts/check_open_weights.py", *files], root)
        out.append((OK, label, []) if r.returncode == 0 else (FAIL, label, tail(r.stdout + r.stderr)))

    # The same drift check CI runs, but into a temp dir so the working tree stays untouched
    label = "workflows/*.json match server/workflow.py"
    with tempfile.TemporaryDirectory() as tmp:
        r = run([sys.executable, "-m", "server.workflow", tmp], root)
        if r.returncode != 0:
            out.append((FAIL, label, tail(r.stdout + r.stderr)))
            return out
        stale = []
        for gen in sorted(Path(tmp).glob("*.json")):
            committed = root / "workflows" / gen.name
            if not committed.is_file():
                stale.append(f"workflows/{gen.name}: not committed")
            elif committed.read_bytes().replace(b"\r\n", b"\n") != gen.read_bytes().replace(b"\r\n", b"\n"):
                stale.append(f"workflows/{gen.name}: differs (run python -m server.workflow and commit)")
        out.append((FAIL, label, stale) if stale else (OK, label, []))
    return out


MEDIA_EXT = re.compile(r"\.(png|jpe?g|gif|webp|mp4|webm|mov)$", re.IGNORECASE)


def expand_braces(pattern):
    m = re.search(r"\{([^{}]*)\}", pattern)
    if not m:
        return [pattern]
    return [x for alt in m.group(1).split(",") for x in expand_braces(pattern[:m.start()] + alt + pattern[m.end():])]


def check_licences(root, _opts):
    out = [(OK, "LICENSE exists", []) if (root / "LICENSE").is_file() else (FAIL, "LICENSE exists", ["no LICENSE at the repo root"])]
    audit = root / "docs" / "submission" / "LICENCE_AUDIT.md"
    label = "docs/submission/LICENCE_AUDIT.md lists every file in examples/"
    if not audit.is_file():
        return out + [(FAIL, label, ["no docs/submission/LICENCE_AUDIT.md"])]
    patterns, named = [], []
    for line in audit.read_text(encoding="utf-8").splitlines():
        for token in re.findall(r"`([^`]+)`", line):
            for p in expand_braces(token.strip()):
                p = p.removeprefix("examples/")
                patterns.append(p)
                if "*" not in p and MEDIA_EXT.search(p) and "removed" not in line:
                    named.append(p)
    examples = sorted(p.name for p in (root / "examples").glob("*") if p.is_file()) if (root / "examples").is_dir() else []
    missing = [f"examples/{name}" for name in examples if not any(fnmatch.fnmatchcase(name, p) for p in patterns)]
    out.append((FAIL, label + f" ({len(examples)} files)", missing) if missing else (OK, label + f" ({len(examples)} files)", []))
    gone = sorted({p for p in named if not ((root / p).exists() if "/" in p else (root / "examples" / p).exists())})
    if gone:
        out.append((WARN, "LICENCE_AUDIT.md names files that aren't in the repo (stale rows?)", gone))
    return out


def dir_size(path):
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def check_build(root, opts):
    label = "web/ builds (npm run build) and dist/ is under 25 MB"
    if opts.skip_build:
        return [(WARN, label + ": skipped (--skip-build)", [])]
    npm = shutil.which("npm")
    if not npm:
        return [(FAIL, label, ["npm not found: install Node 20+"])]
    web = root / "web"
    if not (web / "node_modules").is_dir():
        r = run([npm, "ci"], web)
        if r.returncode != 0:
            return [(FAIL, label, ["npm ci failed:"] + tail(r.stdout + r.stderr))]
    r = run([npm, "run", "build"], web)
    if r.returncode != 0:
        return [(FAIL, label, tail(r.stdout + r.stderr))]
    dist = web / "dist"
    if not dist.is_dir():
        return [(FAIL, label, ["npm run build made no web/dist/"])]
    size = dir_size(dist)
    detail = f"web/dist/ is {size / MB:.1f} MB"
    return [(OK, label + f" ({detail})", [])] if size < DIST_MAX else [(FAIL, label, [detail])]


def check_live(root, opts):
    readme = root / "README.md"
    text = readme.read_text(encoding="utf-8") if readme.is_file() else ""
    m = re.search(r"\*\*Live:\*\*\s*<?(https?://[^\s>)]+)", text)
    if not m:
        return [(FAIL, "Live URL in the README answers 200", ["no '**Live:** https://...' line in README.md"])]
    url = m.group(1)
    label = f"Live URL answers 200: {url}"
    if opts.offline:
        return [(WARN, label + ": skipped (--offline)", [])]
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "preflight"}), timeout=15) as resp:
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    except (urllib.error.URLError, OSError) as e:
        return [(WARN, label + ": skipped, offline?", [str(getattr(e, "reason", e))])]
    if status == 200:
        return [(OK, label, [])]
    if PRE_LIVE in text:
        return [(WARN, label + f": HTTP {status}, skipped (the README says Pages isn't on yet)", [])]
    return [(FAIL, label, [f"HTTP {status}"])]


def check_git(root, opts):
    out = []
    label = "git status is clean"
    try:
        r = run(["git", "status", "--porcelain"], root, timeout=60)
    except FileNotFoundError:
        r = None
    if r is None or r.returncode != 0:
        out.append((FAIL, label, ["git status failed" + (f": {r.stderr.strip()}" if r else ": git not found")]))
    else:
        dirty = r.stdout.splitlines()
        out.append((FAIL, label, dirty[:20] + ([f"... and {len(dirty) - 20} more"] if len(dirty) > 20 else [])) if dirty else (OK, label, []))

    label = "Last CI run on main passed"
    gh = shutil.which("gh")
    if opts.offline:
        out.append((WARN, label + ": skipped (--offline)", []))
    elif not gh:
        out.append((WARN, label + ": skipped (gh not installed)", []))
    else:
        r = run([gh, "run", "list", "--branch", "main", "--workflow", "ci.yml", "--limit", "1",
                 "--json", "status,conclusion,url,headSha"], root, timeout=60)
        if r.returncode != 0:
            out.append((WARN, label + ": skipped (gh run list failed; gh auth login?)", tail(r.stderr, 3)))
        else:
            runs = json.loads(r.stdout or "[]")
            if not runs:
                out.append((FAIL, label, ["no CI runs on main"]))
            elif runs[0]["status"] != "completed":
                out.append((WARN, label + f": still {runs[0]['status']}", [runs[0]["url"]]))
            elif runs[0]["conclusion"] == "success":
                out.append((OK, label + f" ({runs[0]['headSha'][:7]})", []))
            else:
                out.append((FAIL, label, [f"{runs[0]['conclusion']}: {runs[0]['url']}"]))
    return out


# git first, before the build writes anything (dist/ is ignored, but just in case)
CHECKS = [check_git, check_links, check_placeholders, check_examples, check_workflows, check_licences,
          check_build, check_live]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--before-rename", action="store_true", help="placeholders are warnings, not failures")
    ap.add_argument("--offline", action="store_true", help="skip the live-URL and last-CI checks")
    ap.add_argument("--skip-build", action="store_true", help="skip npm run build")
    ap.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    opts = ap.parse_args(argv)
    root = opts.root.resolve()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # the icons, in a Windows console

    results = []
    for check in CHECKS:
        try:
            results += check(root, opts)
        except Exception as e:  # a crashed check is a failed check, and the rest still run
            results.append((FAIL, check.__name__, [f"{type(e).__name__}: {e}"]))
    for status, label, details in results:
        print(f"{ICON[status]} {label}")
        for d in details:
            print(f"     {d}")
    fails = sum(s == FAIL for s, _, _ in results)
    warns = sum(s == WARN for s, _, _ in results)
    print(f"\n{len(results) - fails - warns} passed, {fails} failed, {warns} warnings")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
