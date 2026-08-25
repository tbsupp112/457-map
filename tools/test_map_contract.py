"""Regression checks for the published map's road and interaction contracts."""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


ROOT = Path(__file__).resolve().parents[1]


class MapContractTests(unittest.TestCase):
    def test_publish_folder_and_local_intake_paths_stay_separate(self) -> None:
        local = ROOT.parent / "_local"
        self.assertTrue((local / "Raw gaia gpx 8.5.26").is_dir())
        self.assertTrue((local / "_candidates").is_dir())
        self.assertFalse((ROOT / "Raw gaia gpx 8.5.26").exists())
        self.assertFalse((ROOT / "data" / "_candidates").exists())
        self.assertFalse((ROOT / "tools" / "__pycache__").exists())
        self.assertFalse((ROOT / "compass-test.html").exists())

        pipeline = (ROOT / "tools" / "process_gps.py").read_text(encoding="utf-8")
        self.assertIn('LOCAL = ROOT.parent / "_local"', pipeline)
        self.assertIn('CANDIDATES = LOCAL / "_candidates"', pipeline)
        self.assertIn("sys.dont_write_bytecode = True", pipeline)

    def test_roads_are_independent_sources_and_only_mountain_drive_is_routed(self) -> None:
        manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
        sources = {source["key"]: source for source in manifest["sources"]}
        self.assertEqual("data/roads/mountain-drive.geojson", sources["mountainDrive"]["path"])
        self.assertEqual("data/roads/driveway.geojson", sources["driveway"]["path"])
        self.assertFalse((ROOT / "data" / "roads" / "dirt-roads.geojson").exists())

        mountain = json.loads(
            (ROOT / sources["mountainDrive"]["path"]).read_text(encoding="utf-8")
        )["features"]
        driveway = json.loads(
            (ROOT / sources["driveway"]["path"]).read_text(encoding="utf-8")
        )["features"]
        self.assertEqual(["mountain-drive"], [item["properties"]["id"] for item in mountain])
        self.assertEqual(["driveway"], [item["properties"]["id"] for item in driveway])

        routes = json.loads(
            (ROOT / "data" / "trails" / "routes.json").read_text(encoding="utf-8")
        )["routes"]
        mountain_route = next(route for route in routes if route["id"] == "mountain-drive-route")
        self.assertEqual(["mountain-drive"], mountain_route["segments"])
        self.assertEqual("moderate", mountain_route["difficulty"])
        self.assertTrue(all("driveway" not in route["segments"] for route in routes))

    def test_invisible_road_interactions_are_above_trails_and_below_landmarks(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")

        def pane_order(key: str) -> int:
            match = re.search(
                rf'key:\s*"{re.escape(key)}"[^\n]+order:\s*(\d+)',
                app,
            )
            self.assertIsNotNone(match, f"Missing pane definition for {key}")
            return int(match.group(1))

        self.assertGreater(pane_order("roadInteractions"), pane_order("trails"))
        self.assertLess(pane_order("roadInteractions"), pane_order("naturalLandmarks"))

    def test_map_assets_share_one_cache_version(self) -> None:
        versions = []
        for name in ("index.html", "map.html"):
            versions.extend(
                re.findall(r'(?:css|js)\?v=([0-9-]+)', (ROOT / name).read_text(encoding="utf-8"))
            )
        self.assertTrue(versions)
        self.assertEqual(1, len(set(versions)))

    def test_guidance_visibility_contract_has_full_turn_range(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "styles.css").read_text(encoding="utf-8")

        self.assertIn("const GUIDANCE_MAX_ERROR_DEG = 180;", app)
        self.assertIn('{ error: 180, saturation: value("--guidance-saturation-180")', app)
        for instruction in ("turn left", "turn right", "turn around", "on course"):
            self.assertIn(f'"{instruction}"', app)

        opacity_values = {
            int(error): float(value)
            for error, value in re.findall(
                r"--guidance-opacity-(\d+):\s*([0-9.]+);",
                styles,
            )
        }
        blur_values = {
            int(error): float(value)
            for error, value in re.findall(
                r"--guidance-blur-(\d+):\s*([0-9.]+);",
                styles,
            )
        }
        self.assertEqual({0, 30, 60, 110, 180}, set(opacity_values))
        self.assertGreaterEqual(min(opacity_values.values()), 0.20)
        self.assertNotEqual(opacity_values[60], opacity_values[180])
        self.assertLessEqual(max(blur_values.values()), 12)
        self.assertRegex(
            styles,
            r"@media \(prefers-reduced-motion: reduce\)[\s\S]*?"
            r"\.guidance-tint[\s\S]*?animation:\s*none;",
        )
        self.assertRegex(
            styles,
            r"\.guidance-tint--active\s*\{[\s\S]*?"
            r"opacity:\s*var\(--guidance-opacity\);",
        )

        icon_match = re.search(
            r"const guidanceTargetIcon = L\.divIcon\(\{.*?"
            r"iconSize: \[(\d+), (\d+)\],\s*iconAnchor: \[(\d+), (\d+)\]",
            app,
            re.DOTALL,
        )
        self.assertIsNotNone(icon_match)
        width, height, anchor_x, anchor_y = map(int, icon_match.groups())
        self.assertEqual((width / 2, height / 2), (anchor_x, anchor_y))
        self.assertIn("pane: MAP_PANES.buildings", app)
        self.assertIn("zIndexOffset: -1000", app)


if __name__ == "__main__":
    unittest.main()
