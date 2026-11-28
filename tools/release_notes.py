"""Print the release notes for one version: its section of CHANGELOG.md, without the heading.

    python tools/release_notes.py            # the version in mammatus/__init__.py
    python tools/release_notes.py 1.3.0

Used by .github/workflows/release.yml to fill in the GitHub release. Exits with an error if the
changelog has no section for that version, so a release is never published without notes.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def current_version() -> str:
    text = (ROOT / "mammatus/__init__.py").read_text()
    m = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    if not m:
        sys.exit("no __version__ in mammatus/__init__.py")
    return m.group(1)


def notes(version: str) -> str:
    lines = (ROOT / "CHANGELOG.md").read_text().splitlines()
    head = re.compile(rf"^## {re.escape(version)}(\s|$)")
    start = next((i for i, line in enumerate(lines) if head.match(line)), None)
    if start is None:
        sys.exit(f"CHANGELOG.md has no section for {version}")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    return "\n".join(lines[start + 1:end]).strip() + "\n"


if __name__ == "__main__":
    v = sys.argv[1] if len(sys.argv) > 1 else current_version()
    if v == "--version":
        print(current_version())
    else:
        sys.stdout.write(notes(v.lstrip("v")))
