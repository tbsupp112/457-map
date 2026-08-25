"""Regression tests for the repository data validator."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

from validate_data import validate_repository  # noqa: E402


class ValidateDataTests(unittest.TestCase):
    def test_current_repository_passes(self) -> None:
        report = validate_repository(ROOT)
        self.assertEqual([], report.errors)

    def validate_broken_copy(self, mutate) -> list[str]:
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary_directory:
            temporary_root = Path(temporary_directory)
            shutil.copytree(ROOT / "data", temporary_root / "data")
            mutate(temporary_root)
            return validate_repository(temporary_root).errors

    def test_duplicate_id_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            mountain_path = root / "data" / "roads" / "mountain-drive.geojson"
            driveway_path = root / "data" / "roads" / "driveway.geojson"
            mountain = json.loads(mountain_path.read_text(encoding="utf-8"))
            driveway = json.loads(driveway_path.read_text(encoding="utf-8"))
            driveway["features"][0]["properties"]["id"] = mountain["features"][0]["properties"]["id"]
            driveway_path.write_text(json.dumps(driveway), encoding="utf-8")

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(any("Duplicate id" in error for error in errors), errors)

    def test_dangling_route_segment_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            path = root / "data" / "trails" / "routes.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            data["routes"][0]["segments"][0] = "missing-segment"
            path.write_text(json.dumps(data), encoding="utf-8")

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(any("references missing segment" in error for error in errors), errors)

    def test_forbidden_terminology_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            forbidden_text = "".join(["shoot", "ing", " ", "range"])
            (root / "stale-note.txt").write_text(forbidden_text, encoding="utf-8")

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(any("Forbidden landmark terminology" in error for error in errors), errors)

    def test_missing_parcel_role_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            path = root / "data" / "property" / "boundaries.geojson"
            data = json.loads(path.read_text(encoding="utf-8"))
            data["features"][0]["properties"]["role"] = "renamed-role"
            path.write_text(json.dumps(data), encoding="utf-8")

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(any("exactly one 'main-parcel' role" in error for error in errors), errors)

    def test_local_only_publish_artifact_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            (root / "compass-test.html").write_text("temporary diagnostic", encoding="utf-8")

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(any("Local-only item remains" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
