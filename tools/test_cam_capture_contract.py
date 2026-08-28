"""Contract checks for owner-only, local trail-cam deployment capture."""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


ROOT = Path(__file__).resolve().parents[1]


class CamCaptureContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (ROOT / "app.js").read_text(encoding="utf-8")
        cls.capture = (ROOT / "cam-capture.js").read_text(encoding="utf-8")
        cls.map_html = (ROOT / "map.html").read_text(encoding="utf-8")

    def test_sites_are_explicit_placeholders_and_manifested_as_optional(self) -> None:
        sites = json.loads(
            (ROOT / "data" / "cams" / "cam-sites.geojson").read_text(encoding="utf-8")
        )
        self.assertEqual("placeholder", sites["properties"]["position_status"])
        self.assertIn(len(sites["features"]), (5, 6))
        ids = []
        coordinates = []
        for feature in sites["features"]:
            self.assertEqual("Point", feature["geometry"]["type"])
            self.assertEqual("placeholder", feature["properties"]["status"])
            self.assertIn("Fake position", feature["properties"]["note"])
            ids.append(feature["properties"]["id"])
            coordinates.append(tuple(feature["geometry"]["coordinates"]))
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(coordinates), len(set(coordinates)))

        manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
        source = next(item for item in manifest["sources"] if item["key"] == "camSites")
        self.assertEqual("data/cams/cam-sites.geojson", source["path"])
        self.assertEqual("cam-site", source["feature_type"])
        self.assertEqual(["Point"], source["geometry_types"])
        self.assertFalse(source["required"])
        self.assertTrue(source["ids"])
        self.assertEqual(["id", "name", "status"], source["required_properties"])

    def test_owner_registry_is_filtered_before_panes_data_and_dom_are_created(self) -> None:
        definition = re.search(
            r'key:\s*"camSites"[\s\S]*?(?=\n\s*\{\n\s*key:\s*"liveLocation")',
            self.app,
        )
        self.assertIsNotNone(definition)
        block = definition.group(0)
        self.assertIn('label: "Trail cam sites"', block)
        self.assertIn('sources: ["camSites"]', block)
        self.assertIn('audiences: ["owner"]', block)
        self.assertIn('defaultVisible: { owner: false }', block)
        self.assertRegex(
            self.app,
            r"const paneDefinitions = LAYER_DEFINITIONS\s*"
            r"\.filter\(\(definition\) => definition\.audiences\.includes\(activeAudience\)\)\s*"
            r"\.flatMap",
        )
        self.assertIn("const tasks = getAudienceLayerDefinitions().map", self.app)
        self.assertIn('if (activeAudience === "owner" && camSitesGroup && window.CamCapture)', self.app)
        self.assertNotIn("cam-capture-panel", self.map_html)
        self.assertNotIn("Trail cam sites", self.map_html)

    def test_visual_pins_are_paint_and_hit_pins_use_the_shared_svg_pane(self) -> None:
        self.assertRegex(
            self.app,
            r"camSitesVisualLayer = L\.geoJSON\(null, \{[\s\S]*?"
            r"renderer: camSitesRenderer,[\s\S]*?interactive: false,",
        )
        self.assertRegex(
            self.app,
            r"camSitesInteractionLayer = L\.geoJSON\(null, \{[\s\S]*?"
            r"pane: MAP_PANES\.interactions,[\s\S]*?renderer: interactionsRenderer,",
        )
        self.assertIn("camSitesInteractionLayer.addData(camSites)", self.app)
        self.assertNotIn("camSitesInteractionsRenderer", self.app)

    def test_append_only_record_shape_and_reset_isolation_are_explicit(self) -> None:
        self.assertIn(
            'const CAM_RECORDS_KEY = "457-property-cam-deployments-v1";',
            self.capture,
        )
        self.assertRegex(
            self.capture,
            r"async function appendCamDeployment\(record\) \{\s*"
            r"const all = readCamDeployments\(\);\s*"
            r"all\.push\(record\);\s*"
            r"window\.localStorage\.setItem\(CAM_RECORDS_KEY, JSON\.stringify\(all\)\);\s*"
            r'return \{ stored: "local", count: all\.length \};\s*\}',
        )
        record = re.search(
            r"const record = \{([\s\S]*?)\n\s*\};\n\s*elements\.confirmButton",
            self.capture,
        )
        self.assertIsNotNone(record)
        for field in ("id", "site_id", "camera_id", "bearing_deg", "recorded_on", "note"):
            self.assertRegex(record.group(1), rf"\b{field}:")
        self.assertNotIn("fetch(", self.capture)
        self.assertNotIn("DeviceOrientation", self.capture)

        reset = re.search(
            r"function resetMapToDefaults\(\) \{([\s\S]*?)\n\}\n\nfunction saveMapPreferences",
            self.app,
        )
        self.assertIsNotNone(reset)
        self.assertNotIn("CAM_RECORDS_KEY", reset.group(1))
        self.assertNotIn("localStorage", reset.group(1))
        self.assertNotIn("removeItem", reset.group(1))
        self.assertNotIn("clear()", reset.group(1))

        cancel = re.search(
            r"function cancelCapture\(\) \{([\s\S]*?)\n\s*\}\n\n\s*function clearDraft",
            self.capture,
        )
        self.assertIsNotNone(cancel)
        self.assertNotIn("appendCamDeployment", cancel.group(1))
        self.assertNotIn("setItem", cancel.group(1))

    def test_bearing_export_and_popup_history_follow_the_capture_contract(self) -> None:
        self.assertIn("calculateTrueBearing,", self.app)
        self.assertIn("config.calculateTrueBearing(siteLatLng, event.latlng)", self.capture)
        self.assertIn("Math.round(bearing) % 360", self.capture)
        self.assertIn('textarea data-cam-export readonly', self.capture)
        self.assertIn("JSON.stringify(records, null, 2)", self.capture)
        self.assertIn("navigator.clipboard?.writeText", self.capture)
        self.assertIn("Clipboard access was blocked", self.capture)
        self.assertIn("selectable JSON remains below", self.capture)
        self.assertIn("iOS Safari may remove local records", self.capture)
        self.assertIn("localeCompare(String(first.recorded_on))", self.capture)
        self.assertIn("Deployments, newest first", self.capture)
        for camera_id in ("cam-1", "cam-2", "cam-3", "cam-4"):
            self.assertIn(f'"{camera_id}"', self.capture)


if __name__ == "__main__":
    unittest.main()
