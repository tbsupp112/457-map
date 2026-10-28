"""Run behavioral weather checks when the local Node runtime is available."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


class WeatherRuntimeTests(unittest.TestCase):
    def test_shared_weather_runtime(self) -> None:
        node = os.environ.get("NODE_BINARY") or shutil.which("node")
        if not node:
            self.skipTest("Node.js is required for weather behavior checks.")
        script = Path(__file__).with_suffix(".cjs")
        result = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=30)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
