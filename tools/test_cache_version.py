"""Regression checks for the unified browser/data cache version."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

from run_tests import cache_version_errors_from_sources, read_cache_version_errors  # noqa: E402


class CacheVersionTests(unittest.TestCase):
    def test_current_package_uses_one_cache_version(self) -> None:
        self.assertEqual([], read_cache_version_errors())

    def test_mismatch_names_every_disagreeing_file(self) -> None:
        sources = {
            "index.html": '<script src="app.js?v=20260828-4"></script>',
            "map.html": '<script src="app.js?v=20260828-3"></script>',
            "app.js": 'const DATA_CACHE_VERSION = "20260828-4";',
            "home.js": 'const DATA_CACHE_VERSION = "20260828-2";',
        }
        errors = cache_version_errors_from_sources(sources)
        joined = "\n".join(errors)
        for filename in sources:
            self.assertIn(filename, joined)


if __name__ == "__main__":
    unittest.main()
