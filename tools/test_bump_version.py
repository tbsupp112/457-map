"""Tests for the unified cache-version maintenance command."""

from __future__ import annotations

import contextlib
import io
import shutil
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.dont_write_bytecode = True


TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

from bump_version import TARGET_FILES, bump_version, current_version, main, next_version  # noqa: E402


class BumpVersionTests(unittest.TestCase):
    def package_copy(self) -> tempfile.TemporaryDirectory[str]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        for filename in TARGET_FILES:
            shutil.copy2(ROOT / filename, root / filename)
        return temporary

    def test_automatic_bump_increments_same_day_and_reports_all_files(self) -> None:
        with self.package_copy() as temporary_path:
            root = Path(temporary_path)
            old_version = current_version(root)
            expected = next_version(old_version, date(2026, 8, 28))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = main([], root=root, today=date(2026, 8, 28))
            self.assertEqual(0, result)
            self.assertEqual(expected, current_version(root))
            report = output.getvalue()
            self.assertIn(f"{old_version} -> {expected}", report)
            for filename in TARGET_FILES:
                self.assertIn(filename, report)

    def test_explicit_version_rewrites_all_four_files(self) -> None:
        with self.package_copy() as temporary_path:
            root = Path(temporary_path)
            old_version = current_version(root)
            old, new, touched = bump_version("20990101-7", root=root)
            self.assertEqual(old_version, old)
            self.assertEqual("20990101-7", new)
            self.assertEqual(list(TARGET_FILES), touched)
            self.assertEqual("20990101-7", current_version(root))

    def test_date_rollover_starts_at_one(self) -> None:
        with self.package_copy() as temporary_path:
            root = Path(temporary_path)
            _, new, _ = bump_version(root=root, today=date(2026, 8, 29))
            self.assertEqual("20260829-1", new)

    def test_mismatch_fails_before_writing_any_file(self) -> None:
        with self.package_copy() as temporary_path:
            root = Path(temporary_path)
            old_version = current_version(root)
            home = root / "home.js"
            home.write_text(
                home.read_text(encoding="utf-8").replace(old_version, "19990101-9"),
                encoding="utf-8",
            )
            before = {name: (root / name).read_text(encoding="utf-8") for name in TARGET_FILES}
            with self.assertRaisesRegex(ValueError, "not unified"):
                bump_version(root=root, today=date(2026, 8, 28))
            after = {name: (root / name).read_text(encoding="utf-8") for name in TARGET_FILES}
            self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
