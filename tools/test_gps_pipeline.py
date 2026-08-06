"""Regression and safety checks for the manifest-driven GPX intake."""

from __future__ import annotations

import copy
import hashlib
import json
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

from gps_lib import (  # noqa: E402
    TrackPoint,
    arc_length_centerline,
    closest_distance_between_lines,
    distance,
    line_length,
    read_gpx,
    segment_intersection,
    split_out_and_back,
    to_xy,
)
from process_gps import (  # noqa: E402
    DATA,
    load_manifest,
    merge_geojson_preserving_features,
    prepare_promotion,
    process_job,
    process_manifest,
)


def point(x: float, y: float) -> TrackPoint:
    return TrackPoint(x, y)


def live_hashes() -> dict[str, str]:
    return {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(DATA.rglob("*"))
        if path.is_file() and "_candidates" not in path.parts
    }


def candidate_hashes() -> dict[str, str]:
    candidate_root = DATA / "_candidates"
    return {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(candidate_root.rglob("*"))
        if path.is_file()
    }


class GeometryTests(unittest.TestCase):
    def test_arc_length_centerline_keeps_a_single_pass_loop(self) -> None:
        loop = [
            point(0, 0), point(20, 0), point(20, 20), point(0, 20), point(0, 0)
        ]
        result = arc_length_centerline([[sample.xy for sample in loop]], spacing=5.0)
        self.assertGreater(line_length(result.points), 40.0)
        self.assertLess(line_length(result.points), 90.0)
        self.assertGreaterEqual(len(result.points), 4)

    def test_out_and_back_split_preserves_all_complete_legs(self) -> None:
        shuttle = [
            point(0, 0), point(10, 0), point(20, 0), point(30, 0),
            point(20, 0), point(10, 0), point(0, 0),
            point(10, 0), point(20, 0), point(30, 0),
            point(20, 0), point(10, 0), point(0, 0),
        ]
        result = split_out_and_back(shuttle, force=True)
        self.assertTrue(result.detected)
        self.assertEqual(len(result.legs), 4)
        self.assertTrue(all(line_length([sample.xy for sample in leg]) >= 29.0 for leg in result.legs))


class MergeSafetyTests(unittest.TestCase):
    def test_merge_replaces_by_id_without_reformatting_untouched_feature(self) -> None:
        untouched = '{"type":"Feature","properties":{"id":"keep","note":"spacing stays"},"geometry":{"type":"Point","coordinates":[1,2]}}'
        replace = '{"type":"Feature","properties":{"id":"replace"},"geometry":{"type":"Point","coordinates":[3,4]}}'
        live = '{\n  "type": "FeatureCollection",\n  "features": [\n    ' + untouched + ',\n    ' + replace + '\n  ]\n}\n'
        candidate = {
            "type": "Feature",
            "properties": {"id": "replace", "name": "Updated"},
            "geometry": {"type": "Point", "coordinates": [5, 6]},
        }
        merged = merge_geojson_preserving_features(live, [candidate])
        self.assertIn(untouched, merged)
        self.assertEqual(json.loads(merged)["features"][1]["geometry"]["coordinates"], [5, 6])

    def test_unknown_job_type_fails_before_candidate_or_live_writes(self) -> None:
        before = live_hashes()
        invalid_manifest = {
            "intake_date": "2026-08-05",
            "source_dir": "Raw gaia gpx 8.5.26",
            "jobs": [{
                "id": "bad",
                "name": "Bad",
                "type": "mystery",
                "inputs": ["main-loop.gpx"],
                "target": "trails/walking-trails.geojson",
                "properties": {},
            }],
        }
        with mock.patch.object(Path, "read_text", return_value=json.dumps(invalid_manifest)):
            with self.assertRaisesRegex(ValueError, "unknown type"):
                load_manifest(TOOLS / "in-memory-invalid.json")
        self.assertEqual(live_hashes(), before)

    def test_malformed_gpx_has_a_clear_parse_error(self) -> None:
        with mock.patch("gps_lib.ET.parse", side_effect=ET.ParseError("bad XML")):
            with self.assertRaisesRegex(ValueError, "Could not parse GPX file broken.gpx"):
                read_gpx(Path("broken.gpx"))


class IntakeIntegrationTests(unittest.TestCase):
    manifest = TOOLS / "intakes" / "2026-08-05-loop-and-driveway.json"

    def test_candidate_generation_is_deterministic_and_does_not_touch_live_data(self) -> None:
        source = ROOT / "Raw gaia gpx 8.5.26"
        if not source.exists():
            self.skipTest("The local 8/5 raw GPX intake is not present")
        before = live_hashes()
        first = process_manifest(self.manifest)
        second = process_manifest(self.manifest)
        self.assertEqual(first.candidate_contents, second.candidate_contents)
        self.assertEqual(live_hashes(), before)

    def test_promotion_preview_targets_only_declared_live_files(self) -> None:
        source = ROOT / "Raw gaia gpx 8.5.26"
        if not source.exists():
            self.skipTest("The local 8/5 raw GPX intake is not present")
        result = process_manifest(self.manifest)
        writes, summary = prepare_promotion(result, backup=False)
        self.assertTrue(summary)
        self.assertTrue(writes)
        self.assertTrue(all(DATA in path.parents for path in writes))
        self.assertTrue(all("_candidates" not in path.parts for path in writes))

    def test_reprocessing_promoted_intake_is_idempotent(self) -> None:
        source = ROOT / "Raw gaia gpx 8.5.26"
        if not source.exists():
            self.skipTest("The local 8/5 raw GPX intake is not present")
        result = process_manifest(self.manifest)
        writes, _ = prepare_promotion(result, backup=False)
        for path, content in writes.items():
            self.assertEqual(
                content,
                path.read_text(encoding="utf-8"),
                f"Repeated promotion would drift {path.relative_to(ROOT)}",
            )

    def test_missing_input_and_unknown_join_fail_without_partial_writes(self) -> None:
        source = ROOT / "Raw gaia gpx 8.5.26"
        if not source.exists():
            self.skipTest("The local 8/5 raw GPX intake is not present")
        before_live = live_hashes()
        before_candidates = candidate_hashes()
        manifest = load_manifest(self.manifest)

        missing = copy.deepcopy(manifest)
        missing["jobs"][0]["inputs"] = ["does-not-exist.gpx"]
        with mock.patch("process_gps.load_manifest", return_value=missing):
            with self.assertRaisesRegex(ValueError, "missing input file"):
                process_manifest(self.manifest)

        unknown_join = copy.deepcopy(manifest)
        unknown_join["joins"].append(
            {
                "id": "invalid-join",
                "feature": "main-loop",
                "target_feature": "does-not-exist",
                "target_kind": "line",
                "action": "snap",
            }
        )
        with mock.patch("process_gps.load_manifest", return_value=unknown_join):
            with self.assertRaisesRegex(ValueError, "references unknown id"):
                process_manifest(self.manifest)

        self.assertEqual(live_hashes(), before_live)
        self.assertEqual(candidate_hashes(), before_candidates)

    def test_declared_topology_clearances_and_local_zone_edit_are_exact(self) -> None:
        source = ROOT / "Raw gaia gpx 8.5.26"
        if not source.exists():
            self.skipTest("The local 8/5 raw GPX intake is not present")
        result = process_manifest(self.manifest)

        def coordinates(feature_id: str):
            return result.catalog[feature_id].feature["geometry"]["coordinates"]

        clearing = coordinates("main-loop-clearing")
        extension = coordinates("main-loop-ext")
        barbershop = coordinates("barbershop-trail")
        self.assertEqual(extension[0], clearing)
        self.assertEqual(extension[-1], clearing)
        self.assertEqual(barbershop[0], clearing)

        main_loop = coordinates("main-loop")
        connector = coordinates("field-connector")
        driveway = coordinates("driveway")
        self.assertEqual(main_loop[0], clearing)
        self.assertIn(main_loop[-1], driveway)
        self.assertIn(connector[-1], extension)

        manifest = load_manifest(self.manifest)
        driveway_job = next(job for job in manifest["jobs"] if job["id"] == "driveway")
        driveway_before_join, _ = process_job(driveway_job, source, manifest["intake_date"])
        original_driveway = driveway_before_join.feature["geometry"]["coordinates"]
        cursor = 0
        for coordinate in driveway:
            if cursor < len(original_driveway) and coordinate == original_driveway[cursor]:
                cursor += 1
        self.assertEqual(cursor, len(original_driveway), "The driveway shape may only gain a join vertex")

        shooting_range = coordinates("shooting-range")
        self.assertLess(
            abs(distance(to_xy(*shooting_range), to_xy(*barbershop[-1])) - 5.0),
            0.02,
        )
        route = next(route for route in result.candidate_routes if route["id"] == "main-loop-route")
        self.assertEqual(route["difficulty"], "easy")

        live_trails = json.loads((DATA / "trails" / "walking-trails.geojson").read_text(encoding="utf-8"))
        live_by_id = {item["properties"]["id"]: item for item in live_trails["features"]}
        garden_live = live_by_id["garden-cut-through"]["geometry"]["coordinates"]
        pavilion_live = live_by_id["pavilion-side-trail"]["geometry"]["coordinates"]
        self.assertEqual(coordinates("garden-cut-through"), garden_live)
        self.assertEqual(coordinates("pavilion-side-trail"), pavilion_live)

        live_zones = json.loads((DATA / "zones" / "zones.geojson").read_text(encoding="utf-8"))
        live_zone = next(
            item for item in live_zones["features"] if item["properties"]["id"] == "front-field-zone"
        )["geometry"]["coordinates"][0]
        candidate_zone = coordinates("front-field-zone")[0]
        self.assertEqual(candidate_zone, live_zone, "A repeated intake must not move the zone again")

        line_xy = [to_xy(*coordinate) for coordinate in connector]
        ring_xy = [to_xy(*coordinate) for coordinate in candidate_zone]
        driveway_xy = [to_xy(*coordinate) for coordinate in driveway]
        self.assertGreaterEqual(closest_distance_between_lines(driveway_xy, ring_xy), 2.0)
        crossings = []
        for start, end in zip(line_xy, line_xy[1:]):
            for left, right in zip(ring_xy, ring_xy[1:]):
                hit = segment_intersection(start, end, left, right)
                if hit and not any(distance(hit[0], existing) < 0.05 for existing in crossings):
                    crossings.append(hit[0])
        self.assertEqual(len(crossings), 1)
        self.assertLess(distance(crossings[0], line_xy[0]), 0.05)

        pin_points = []
        for path in sorted(DATA.rglob("*.geojson")):
            if "_candidates" in path.parts:
                continue
            for item in json.loads(path.read_text(encoding="utf-8")).get("features", []):
                if item.get("geometry", {}).get("type") == "Point":
                    pin_points.append((item["properties"].get("id"), to_xy(*item["geometry"]["coordinates"])))
        for candidate in result.candidate_features.get("intersections/intersections.geojson", []):
            candidate_point = to_xy(*candidate["geometry"]["coordinates"])
            nearest = min(
                distance(candidate_point, point_value)
                for point_id, point_value in pin_points
                if point_id != candidate["properties"]["id"]
            )
            self.assertGreaterEqual(nearest, 3.0)


if __name__ == "__main__":
    unittest.main()
