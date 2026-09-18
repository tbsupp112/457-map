"""Contract checks for the 2026-09-18 guest-ready map package."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SPLIT = [-73.8351907, 43.3596533]
BARBERSHOP = [-73.8338405, 43.3595731]
BEELINE_JUNCTION = [-73.8339724, 43.3584277]


def features(path: Path) -> dict[str, dict]:
    collection = json.loads(path.read_text(encoding="utf-8"))
    return {item["properties"]["id"]: item for item in collection["features"]}


class GuestReadyContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (ROOT / "app.js").read_text(encoding="utf-8")
        cls.home = (ROOT / "home.js").read_text(encoding="utf-8")
        cls.trails = features(DATA / "trails" / "walking-trails.geojson")
        cls.buildings = features(DATA / "landmarks" / "buildings.geojson")
        cls.landmarks = features(DATA / "landmarks" / "landmarks.geojson")

    def test_trail_conditions_and_traversal_counts_are_authored(self) -> None:
        expected_conditions = {
            "main-loop": "finished",
            "main-loop-ext": "finished",
            "barbershop-trail": "finished",
            "pavilion-side-trail": "finished",
            "garden-cut-through": "finished",
            "powerline-trail": "finished",
            "field-connector": "unfinished",
            "line": "unfinished",
            "mountain-drive": "finished",
            "mountain-drive-upper": "unfinished",
            "back-cut-through": "finished",
        }
        self.assertEqual(
            expected_conditions,
            {key: feature["properties"]["condition"] for key, feature in self.trails.items()},
        )
        self.assertEqual(11, self.trails["field-connector"]["properties"]["source_track_count"])
        self.assertEqual(4, self.trails["barbershop-trail"]["properties"]["source_track_count"])
        self.assertEqual(2, self.trails["powerline-trail"]["properties"]["source_track_count"])

    def test_mountain_drive_split_is_continuous_and_route_totals_are_preserved(self) -> None:
        lower = self.trails["mountain-drive"]
        upper = self.trails["mountain-drive-upper"]
        self.assertEqual(SPLIT, lower["geometry"]["coordinates"][-1])
        self.assertEqual(SPLIT, upper["geometry"]["coordinates"][0])
        self.assertEqual(
            lower["properties"]["elevation_profile_ft"][-1],
            upper["properties"]["elevation_profile_ft"][0],
        )
        self.assertAlmostEqual(206.2, lower["properties"]["length_m"] + upper["properties"]["length_m"])
        self.assertEqual(
            312,
            sum(
                feature["properties"]["elevation_gain_ft"]
                + feature["properties"]["elevation_loss_ft"]
                for feature in (lower, upper)
            ),
        )
        routes = json.loads((DATA / "trails" / "routes.json").read_text(encoding="utf-8"))["routes"]
        route = next(item for item in routes if item["id"] == "mountain-drive-route")
        self.assertEqual(["mountain-drive", "mountain-drive-upper"], route["segments"])
        self.assertEqual(["forward", "forward"], route["segment_directions"])
        self.assertEqual(
            1353,
            round(
                sum(
                    self.trails[segment_id]["properties"]["length_m"]
                    for segment_id in route["segments"]
                )
                * 3.28084
                * 2
            ),
        )

    def test_beeline_and_shared_junctions_use_exact_coordinates(self) -> None:
        beeline = self.trails["line"]
        self.assertEqual("Beeline", beeline["properties"]["name"])
        self.assertEqual(4, beeline["properties"]["source_track_count"])
        self.assertEqual(419, beeline["properties"]["length_ft"])
        self.assertNotIn("elevation_profile_ft", beeline["properties"])
        self.assertEqual(
            {tuple(BARBERSHOP), tuple(BEELINE_JUNCTION)},
            {tuple(coordinate) for coordinate in beeline["geometry"]["coordinates"]},
        )
        self.assertAlmostEqual(127.7, beeline["properties"]["length_m"])
        self.assertEqual(BARBERSHOP, self.landmarks["the-barbershop"]["geometry"]["coordinates"])
        self.assertEqual(BARBERSHOP, self.trails["barbershop-trail"]["geometry"]["coordinates"][-1])
        self.assertIn(BEELINE_JUNCTION, self.trails["main-loop-ext"]["geometry"]["coordinates"])

    def test_landmark_prominence_and_withdrawn_zone_contract(self) -> None:
        major = {"home", "pavilion", "cabin"}
        minor = {"the-barbershop", "shed", "wood-shed", "gravel-shed", "mystery-shack"}
        points = {**self.buildings, **self.landmarks}
        self.assertEqual(major, {key for key, item in points.items() if item["properties"]["prominence"] == "major"})
        self.assertEqual(minor, {key for key, item in points.items() if item["properties"]["prominence"] == "minor"})
        zones = features(DATA / "zones" / "zones.geojson")
        self.assertEqual({"front-field-zone"}, set(zones))
        self.assertTrue((ROOT.parent / "_local" / "withdrawn" / "yard-area.geojson").is_file())

    def test_layer_registry_keeps_minor_and_experimental_defaults_honest(self) -> None:
        self.assertIn('key: "minorLandmarks"', self.app)
        self.assertIn('className: "minor-landmark-marker"', self.app)
        self.assertIn('heading.textContent = "Experimental";', self.app)
        self.assertEqual(4, self.app.count("experimental: true"))
        self.assertIn('const isUnfinished = feature.properties?.condition === "unfinished";', self.app)
        self.assertIn('dashArray: isUnfinished ? "3 11" : "7 6"', self.app)
        self.assertIn('const requiredKeys = ["routes", "driveway", "trails"];', self.home)
        self.assertNotIn('"mountainDrive"', self.app)
        self.assertNotIn('"mountainDrive"', self.home)


if __name__ == "__main__":
    unittest.main()
