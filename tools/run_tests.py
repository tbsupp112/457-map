"""Run the complete local regression suite without creating Python caches."""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path


sys.dont_write_bytecode = True
TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent


def cache_version_errors_from_sources(sources: dict[str, str]) -> list[str]:
    versions_by_file: dict[str, set[str]] = {}
    for filename in ("index.html", "map.html"):
        versions_by_file[filename] = set(
            re.findall(r"[?&]v=([0-9-]+)", sources.get(filename, ""))
        )
    for filename in ("app.js", "home.js"):
        versions_by_file[filename] = set(
            re.findall(
                r'const\s+DATA_CACHE_VERSION\s*=\s*"([0-9-]+)";',
                sources.get(filename, ""),
            )
        )

    errors = []
    for filename, versions in versions_by_file.items():
        if len(versions) != 1:
            shown = ", ".join(sorted(versions)) or "missing"
            errors.append(f"{filename} has ambiguous cache versions: {shown}")
    unique_versions = set().union(*versions_by_file.values())
    if len(unique_versions) != 1:
        summary = "; ".join(
            f"{filename}={','.join(sorted(versions)) or 'missing'}"
            for filename, versions in versions_by_file.items()
        )
        errors.append(f"Cache versions disagree: {summary}")
    return errors


def read_cache_version_errors(root: Path = ROOT) -> list[str]:
    filenames = ("index.html", "map.html", "app.js", "home.js")
    sources = {
        filename: (root / filename).read_text(encoding="utf-8")
        for filename in filenames
    }
    return cache_version_errors_from_sources(sources)


def main() -> int:
    cache_errors = read_cache_version_errors()
    if cache_errors:
        print("Cache-version preflight: FAIL")
        for error in cache_errors:
            print(f"  ERROR: {error}")
        return 1
    sys.path.insert(0, str(TOOLS))
    suite = unittest.defaultTestLoader.discover(
        start_dir=str(TOOLS),
        pattern="test_*.py",
    )
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
