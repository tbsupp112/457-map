"""Regression tests for the repository data validator."""

from __future__ import annotations

import json
import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

from validate_data import (  # noqa: E402
    FORBIDDEN_TERM_DIGESTS,
    ValidationReport,
    scan_forbidden_terminology,
    validate_repository,
)


class ValidateDataTests(unittest.TestCase):
    def test_current_repository_passes(self) -> None:
        report = validate_repository(ROOT)
        self.assertEqual([], report.errors)

    def validate_broken_copy(self, mutate) -> list[str]:
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary_directory:
            temporary_root = Path(temporary_directory)
            shutil.copytree(ROOT / "data", temporary_root / "data")
            shutil.copy2(ROOT / "app.js", temporary_root / "app.js")
            shutil.copy2(ROOT / "home.js", temporary_root / "home.js")
            mutate(temporary_root)
            return validate_repository(temporary_root).errors

    def test_duplicate_id_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            trails_path = root / "data" / "trails" / "walking-trails.geojson"
            driveway_path = root / "data" / "roads" / "driveway.geojson"
            trails = json.loads(trails_path.read_text(encoding="utf-8"))
            driveway = json.loads(driveway_path.read_text(encoding="utf-8"))
            driveway["features"][0]["properties"]["id"] = trails["features"][0]["properties"]["id"]
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

    def test_internal_handoff_document_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            nested = root / "notes"
            nested.mkdir()
            (nested / "PROJECT_HANDOFF_old.md").write_text("internal", encoding="utf-8")

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(any("Local-only item remains" in error for error in errors), errors)

    def test_point_photo_over_400_kb_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            photo_root = root / "assets" / "points"
            photo_root.mkdir(parents=True)
            (photo_root / "oversize.jpg").write_bytes(b"0" * (400 * 1024 + 1))

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(any("Point photo exceeds 400 KB" in error for error in errors), errors)

    def test_digest_scanner_handles_supported_separator_spellings(self) -> None:
        sentinel = "zzz sentinel"
        digest = hashlib.sha256(sentinel.encode("utf-8")).hexdigest()
        variants = (
            sentinel,
            sentinel.replace(" ", "-"),
            sentinel.replace(" ", "_"),
            sentinel.replace(" ", ""),
            sentinel.upper(),
        )
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary_directory:
            root = Path(temporary_directory)
            for index, variant in enumerate(variants):
                with self.subTest(variant=variant):
                    path = root / f"sentinel-{index}.txt"
                    path.write_text(variant, encoding="utf-8")
                    report = ValidationReport()
                    scan_forbidden_terminology(root, report, frozenset({digest}))
                    self.assertTrue(report.errors)
                    path.unlink()

    def test_real_digest_constant_is_lowercase_sha256(self) -> None:
        self.assertTrue(FORBIDDEN_TERM_DIGESTS)
        for digest in FORBIDDEN_TERM_DIGESTS:
            self.assertRegex(digest, r"^[0-9a-f]{64}$")

    def test_digest_scanner_accepts_current_tree(self) -> None:
        report = ValidationReport()
        scan_forbidden_terminology(ROOT, report)
        self.assertEqual([], report.errors)

    def test_manifest_source_reference_mismatches_fail_informatively(self) -> None:
        def mutate_missing_reference(root: Path) -> None:
            path = root / "home.js"
            source = path.read_text(encoding="utf-8")
            path.write_text(
                source.replace('"trails"', '"missingRoadSource"', 1),
                encoding="utf-8",
            )

        missing_errors = self.validate_broken_copy(mutate_missing_reference)
        self.assertTrue(
            any(
                "home.js references missing manifest source key 'missingRoadSource'" in error
                for error in missing_errors
            ),
            missing_errors,
        )

        def mutate_unused_source(root: Path) -> None:
            path = root / "data" / "manifest.json"
            manifest = json.loads(path.read_text(encoding="utf-8"))
            extra_source = dict(manifest["sources"][0])
            extra_source["key"] = "unusedBoundaries"
            extra_source["required"] = False
            manifest["sources"].append(extra_source)
            path.write_text(json.dumps(manifest), encoding="utf-8")

        unused_errors = self.validate_broken_copy(mutate_unused_source)
        self.assertTrue(
            any(
                "Manifest source key 'unusedBoundaries' is not referenced" in error
                for error in unused_errors
            ),
            unused_errors,
        )

    def test_non_placeholder_cam_site_positions_fail_informatively(self) -> None:
        def mutate(root: Path) -> None:
            path = root / "data" / "cams" / "cam-sites.geojson"
            data = json.loads(path.read_text(encoding="utf-8"))
            data["properties"]["position_status"] = "real"
            path.write_text(json.dumps(data), encoding="utf-8")

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(
            any(
                "position_status must remain 'placeholder'" in error
                for error in errors
            ),
            errors,
        )

    def test_stale_length_ft_fails_informatively(self) -> None:
        def mutate(root: Path) -> None:
            path = root / "data" / "trails" / "walking-trails.geojson"
            data = json.loads(path.read_text(encoding="utf-8"))
            feature = next(
                item for item in data["features"]
                if item["properties"]["id"] == "main-loop"
            )
            feature["properties"]["length_ft"] += 2
            path.write_text(json.dumps(data), encoding="utf-8")

        errors = self.validate_broken_copy(mutate)
        self.assertTrue(any("length_ft disagrees with length_m" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
