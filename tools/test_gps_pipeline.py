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

sys.dont_write_bytecode = True

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

from gps_lib import (  # noqa: E402
    TrackPoint,
    arc_length_centerline,
    closest_distance_between_lines,
    distance,
    elevation_gain,
    elevation_loss,
    consolidate_closed_laps,
    line_length,
    median_elevation_profile,
    outset_ring,
    read_gpx,
    ring_area,
    segment_intersection,
    self_intersection_count,
    split_out_and_back,
    straighten_line,
    to_xy,
)
from process_gps import (  # noqa: E402
    CANDIDATES,
    DATA,
    LOCAL,
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
    return {
        str(path.relative_to(CANDIDATES)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(CANDIDATES.rglob("*"))
        if path.is_file()
    }


class GeometryTests(unittest.TestCase):
    def test_elevation_profile_and_changes_preserve_endpoints(self) -> None:
        track = [
            TrackPoint(0, 0, 100),
            TrackPoint(10, 0, 105),
            TrackPoint(20, 0, 102),
            TrackPoint(30, 0, 110),
        ]
        self.assertEqual(elevation_gain(track), 13)
        self.assertEqual(elevation_loss(track), 3)
        profile = median_elevation_profile([track], spacing_m=10, smoothing_passes=1)
        self.assertEqual(profile[0], 100)
        self.assertEqual(profile[-1], 110)

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

    def test_straight_line_and_repeated_ring_options_preserve_intended_shapes(self) -> None:
        fitted = straighten_line([(0, 1), (10, -1), (20, 2), (30, 0)])
        self.assertEqual(len(fitted), 2)
        self.assertGreater(line_length(fitted), 29)

        square = [(0, 0), (20, 0), (20, 20), (0, 20)]
        expanded = outset_ring(square, 2)
        self.assertAlmostEqual(ring_area(expanded), 576, delta=0.1)
        self.assertEqual(self_intersection_count(expanded, closed=True), 0)

        repeated = square + [square[0]] + [(1, 0), (21, 0), (21, 20), (1, 20), (1, 0)]
        ring, boundaries, _ = consolidate_closed_laps(
            repeated, 2, spacing=5, smooth_passes=0, simplify_tolerance=0.1, pass_match_cap=5
        )
        self.assertEqual(boundaries, [4])
        self.assertEqual(self_intersection_count(ring, closed=True), 0)
        self.assertAlmostEqual(ring_area(ring), 400, delta=35)


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
            "source_dir": "../_local/Raw gaia gpx 8.5.26",
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
        source = LOCAL / "Raw gaia gpx 8.5.26"
        if not source.exists():
            self.skipTest("The local 8/5 raw GPX intake is not present")
        before = live_hashes()
        first = process_manifest(self.manifest)
        second = process_manifest(self.manifest)
        self.assertEqual(first.candidate_contents, second.candidate_contents)
        self.assertEqual(live_hashes(), before)

    def test_promotion_preview_targets_only_declared_live_files(self) -> None:
        source = LOCAL / "Raw gaia gpx 8.5.26"
        if not source.exists():
            self.skipTest("The local 8/5 raw GPX intake is not present")
        result = process_manifest(self.manifest)
        writes, summary = prepare_promotion(result, backup=False)
        self.assertTrue(summary)
        self.assertTrue(writes)
        self.assertTrue(all(DATA in path.parents for path in writes))
        self.assertTrue(all(CANDIDATES not in path.parents for path in writes))

    def test_reprocessing_promoted_intake_is_idempotent(self) -> None:
        current_manifest = TOOLS / "intakes" / "2026-09-18-gps-update.json"
        source = LOCAL / "Raw gaia gpx 9.18.26"
        if not source.exists():
            self.skipTest("The local 9/18 raw GPX intake is not present")
        result = process_manifest(current_manifest)
        writes, _ = prepare_promotion(result, backup=False)
        for path, content in writes.items():
            self.assertEqual(
                content,
                path.read_text(encoding="utf-8"),
                f"Repeated promotion would drift {path.relative_to(ROOT)}",
            )

    def test_missing_input_and_unknown_join_fail_without_partial_writes(self) -> None:
        source = LOCAL / "Raw gaia gpx 8.5.26"
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
        source = LOCAL / "Raw gaia gpx 8.5.26"
        if not source.exists():
            self.skipTest("The local 8/5 raw GPX intake is not present")
        result = process_manifest(self.manifest)

        def coordinates(feature_id: str):
            return result.catalog[feature_id].feature["geometry"]["coordinates"]

        clearing = coordinates("main-loop-clearing")
        extension = coordinates("main-loop-ext")
        barbershop = coordinates("barbershop-trail")
        self.assertEqual(extension[0], clearing)
        self.assertNotEqual(extension[-1], clearing)
        self.assertEqual(barbershop[0], clearing)

        main_loop = coordinates("main-loop")
        connector = coordinates("field-connector")
        driveway = coordinates("driveway")
        mountain_drive = coordinates("mountain-drive")
        self.assertEqual(main_loop[0], clearing)
        self.assertIn(main_loop[-1], driveway)
        self.assertIn(mountain_drive[0], driveway)
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

        the_barbershop = coordinates("the-barbershop")
        self.assertLess(
            abs(distance(to_xy(*the_barbershop), to_xy(*barbershop[-1])) - 5.0),
            0.02,
        )
        route = next(route for route in result.candidate_routes if route["id"] == "main-loop-route")
        self.assertEqual(route["difficulty"], "easy")
        self.assertEqual(route["shape"], "out-and-back")
        self.assertEqual(
            route["length_ft"],
            round(
                (
                    result.catalog["main-loop"].feature["properties"]["length_m"]
                    + result.catalog["main-loop-ext"].feature["properties"]["length_m"]
                )
                * 3.28084
                * 2
            ),
        )
        self.assertEqual(route["elevation_gain_ft"], route["elevation_loss_ft"])
        self.assertGreater(route["elevation_gain_ft"], 0)
        self.assertGreater(len(route["elevation_profile_ft"]), 20)
        self.assertEqual(route["elevation_profile_ft"][0][0], 0)
        self.assertAlmostEqual(
            route["elevation_profile_ft"][-1][0], route["length_ft"], delta=1
        )
        mountain_route = next(
            route for route in result.candidate_routes if route["id"] == "mountain-drive-route"
        )
        self.assertEqual(mountain_route["difficulty"], "moderate")
        self.assertEqual(mountain_route["shape"], "out-and-back")
        self.assertEqual(
            mountain_route["segments"],
            ["mountain-drive", "mountain-drive-upper"],
        )
        self.assertEqual(
            mountain_route["length_ft"],
            round(
                sum(
                    result.catalog[segment_id].feature["properties"]["length_m"]
                    for segment_id in mountain_route["segments"]
                )
                * 3.28084
                * 2
            ),
        )
        self.assertEqual(mountain_route["elevation_gain_ft"], 312)
        self.assertEqual(mountain_route["elevation_loss_ft"], 312)
        self.assertGreater(len(mountain_route["elevation_profile_ft"]), 20)
        self.assertNotIn("mountain-drive-southwest-end", result.catalog)

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


class August31IntakeIntegrationTests(unittest.TestCase):
    manifest = TOOLS / "intakes" / "2026-08-31-gps-update.json"

    def test_special_processing_and_track_counts_match_the_field_notes(self) -> None:
        source = LOCAL / "Raw gaia gpx through 8.31.26"
        if not source.exists():
            self.skipTest("The local 8/31 raw GPX intake is not present")
        result = process_manifest(self.manifest)

        line = result.catalog["line"].feature
        self.assertEqual(len(line["geometry"]["coordinates"]), 2)
        self.assertEqual(line["properties"]["source_track_count"], 2)

        self.assertNotIn("yard-area", result.catalog)

        driveway = result.catalog["driveway"].feature
        connector = result.catalog["field-connector"].feature
        self.assertEqual(driveway["properties"]["source_track_count"], 4)
        self.assertEqual(connector["properties"]["source_track_count"], 11)
        self.assertIn("removed 2 point(s) from the final 10 seconds", result.qa_text)


class September18IntakeIntegrationTests(unittest.TestCase):
    manifest = TOOLS / "intakes" / "2026-09-18-gps-update.json"

    def test_beeline_and_back_cut_through_follow_field_notes(self) -> None:
        source = LOCAL / "Raw gaia gpx 9.18.26"
        if not source.exists():
            self.skipTest("The local 9/18 raw GPX intake is not present")
        result = process_manifest(self.manifest)

        beeline = result.catalog["line"].feature
        self.assertEqual("Beeline", beeline["properties"]["name"])
        self.assertEqual(4, beeline["properties"]["source_track_count"])
        self.assertEqual(2, len(beeline["geometry"]["coordinates"]))
        self.assertEqual(419, beeline["properties"]["length_ft"])
        self.assertNotIn("elevation_profile_ft", beeline["properties"])

        back = result.catalog["back-cut-through"].feature
        self.assertEqual("finished", back["properties"]["condition"])
        self.assertEqual(6, back["properties"]["source_track_count"])
        self.assertIn("2 partial traversal(s)", back["properties"]["processing"])
        self.assertIn(
            back["geometry"]["coordinates"][-1],
            result.catalog["main-loop-ext"].feature["geometry"]["coordinates"],
        )
        self.assertNotIn(back["geometry"]["coordinates"][0], result.catalog["main-loop-ext"].feature["geometry"]["coordinates"])


if __name__ == "__main__":
    unittest.main()
