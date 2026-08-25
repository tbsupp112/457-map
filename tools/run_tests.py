"""Run the complete local regression suite without creating Python caches."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.dont_write_bytecode = True
TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent


def main() -> int:
    sys.path.insert(0, str(TOOLS))
    suite = unittest.defaultTestLoader.discover(
        start_dir=str(TOOLS),
        pattern="test_*.py",
    )
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
