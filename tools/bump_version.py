"""Advance the unified browser/data cache version in one operation."""

from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
TARGET_FILES = ("index.html", "map.html", "app.js", "home.js")
VERSION_PATTERN = re.compile(r"^\d{8}-\d+$")


def versions_by_file(root: Path) -> dict[str, set[str]]:
    versions: dict[str, set[str]] = {}
    for filename in TARGET_FILES:
        source = (root / filename).read_text(encoding="utf-8")
        if filename.endswith(".html"):
            matches = re.findall(r"[?&]v=([0-9]{8}-[0-9]+)", source)
        else:
            matches = re.findall(
                r'const\s+DATA_CACHE_VERSION\s*=\s*"([0-9]{8}-[0-9]+)";',
                source,
            )
        versions[filename] = set(matches)
    return versions


def current_version(root: Path = ROOT) -> str:
    versions = versions_by_file(root)
    problems = [
        f"{filename}={','.join(sorted(values)) or 'missing'}"
        for filename, values in versions.items()
        if len(values) != 1
    ]
    unique = set().union(*versions.values())
    if problems or len(unique) != 1:
        summary = "; ".join(
            f"{filename}={','.join(sorted(values)) or 'missing'}"
            for filename, values in versions.items()
        )
        raise ValueError(f"Cache versions are not unified: {summary}")
    return unique.pop()


def next_version(old_version: str, today: date | None = None) -> str:
    current_date = (today or date.today()).strftime("%Y%m%d")
    old_date, old_suffix = old_version.split("-", 1)
    suffix = int(old_suffix) + 1 if old_date == current_date else 1
    return f"{current_date}-{suffix}"


def bump_version(
    explicit_version: str | None = None,
    *,
    root: Path = ROOT,
    today: date | None = None,
) -> tuple[str, str, list[str]]:
    old_version = current_version(root)
    new_version = explicit_version or next_version(old_version, today)
    if not VERSION_PATTERN.fullmatch(new_version):
        raise ValueError("Version must use YYYYMMDD-N, for example 20260828-6.")
    if new_version == old_version:
        raise ValueError(f"Cache version is already {old_version}.")

    replacements: dict[str, str] = {}
    for filename in TARGET_FILES:
        path = root / filename
        source = path.read_text(encoding="utf-8")
        updated = source.replace(old_version, new_version)
        if updated == source:
            raise ValueError(f"{filename} did not contain {old_version}; no files were changed.")
        replacements[filename] = updated

    for filename, updated in replacements.items():
        (root / filename).write_text(updated, encoding="utf-8")
    return old_version, new_version, list(TARGET_FILES)


def main(
    arguments: list[str] | None = None,
    *,
    root: Path = ROOT,
    today: date | None = None,
) -> int:
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    if len(arguments) > 1:
        print("Usage: python tools/bump_version.py [YYYYMMDD-N]", file=sys.stderr)
        return 2
    try:
        old_version, new_version, touched = bump_version(
            arguments[0] if arguments else None,
            root=root,
            today=today,
        )
    except (OSError, ValueError) as error:
        print(f"Cache version bump failed: {error}", file=sys.stderr)
        return 1

    print(f"Cache version: {old_version} -> {new_version}")
    print("Files touched:")
    for filename in touched:
        print(f"  {filename}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
