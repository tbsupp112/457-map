"""Checks for the approved county parcel subset and owner-only wiring."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_PROPERTIES = {"id", "pin", "owner_names", "size_acres", "size_basis"}


def coordinate_pairs(value):
    if isinstance(value, list):
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            yield value[0], value[1]
        else:
            for item in value:
                yield from coordinate_pairs(item)


class NearbyParcelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = ROOT / "data" / "property" / "nearby-parcels.geojson"
        cls.collection = json.loads(cls.path.read_text(encoding="utf-8"))
        cls.features = cls.collection["features"]
        cls.manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
        cls.source = next(source for source in cls.manifest["sources"] if source["key"] == "nearbyParcels")

    def test_approved_subset_and_manifest(self):
        self.assertEqual(153, len(self.features))
        self.assertEqual("data/property/nearby-parcels.geojson", self.source["path"])
        self.assertFalse(self.source["required"])
        self.assertEqual(["Polygon", "MultiPolygon"], self.source["geometry_types"])

    def test_exact_fields_unique_pins_and_approved_ids(self):
        pins = []
        owners_with_second_name = 0
        for feature in self.features:
            properties = feature["properties"]
            self.assertEqual(EXPECTED_PROPERTIES, set(properties))
            pin = properties["pin"]
            self.assertRegex(pin, re.compile(r"^\d{20}$"))
            self.assertEqual("warren-parcel-" + pin, feature["id"])
            self.assertEqual(feature["id"], properties["id"])
            self.assertIsInstance(properties["owner_names"], list)
            self.assertTrue(all(isinstance(name, str) and name.strip() for name in properties["owner_names"]))
            self.assertEqual(len(properties["owner_names"]), len(set(properties["owner_names"])))
            if len(properties["owner_names"]) > 1:
                owners_with_second_name += 1
            pins.append(pin)
        self.assertEqual(len(pins), len(set(pins)))
        self.assertEqual(43, owners_with_second_name)

    def test_acreage_fallback_and_known_records(self):
        by_pin = {feature["properties"]["pin"]: feature["properties"] for feature in self.features}
        tiny = by_pin["28502000010550000000"]
        self.assertEqual("GIS estimate", tiny["size_basis"])
        self.assertAlmostEqual(0.00275501, tiny["size_acres"])
        large = by_pin["28600000010810000000"]
        self.assertEqual("county", large["size_basis"])
        self.assertEqual(699.05, large["size_acres"])
        self.assertNotEqual(713.714, large["size_acres"])
        self.assertTrue(all(
            properties["size_basis"] in {"county", "GIS estimate", "unavailable"}
            and (
                (properties["size_basis"] == "unavailable" and properties["size_acres"] is None)
                or (
                    properties["size_basis"] in {"county", "GIS estimate"}
                    and properties["size_acres"] > 0
                )
            )
            for properties in by_pin.values()
        ))

    def test_geometry_types_bounds_and_closed_polygon_rings(self):
        geometry_type_counts = {"Polygon": 0, "MultiPolygon": 0}
        interior_ring_count = 0
        for feature in self.features:
            geometry = feature["geometry"]
            self.assertIn(geometry["type"], {"Polygon", "MultiPolygon"})
            geometry_type_counts[geometry["type"]] += 1
            polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
            self.assertGreaterEqual(len(polygons), 1)
            for polygon in polygons:
                self.assertGreaterEqual(len(polygon), 1)
                interior_ring_count += max(0, len(polygon) - 1)
                for ring in polygon:
                    self.assertGreaterEqual(len(ring), 4)
                    self.assertEqual(ring[0], ring[-1])
            for longitude, latitude in coordinate_pairs(geometry["coordinates"]):
                self.assertTrue(-73.9 <= longitude <= -73.75)
                self.assertTrue(43.3 <= latitude <= 43.45)
        self.assertEqual({"Polygon": 147, "MultiPolygon": 6}, geometry_type_counts)
        self.assertEqual(1, interior_ring_count)

    def test_owner_audience_only_and_no_unapproved_fetch_path(self):
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn('audiences: ["owner"]', app)
        self.assertIn('defaultVisible: { owner: false }', app)
        self.assertIn('optionalSources: ["nearbyParcels"]', app)
        self.assertIn('disableHoverTooltip: true', app)
        self.assertIn('popupClassName: "nearby-parcel-popup"', app)
        self.assertIn('map.removeLayer(nearbyParcelsGroup)', app)
        self.assertIn('"main-parcel": "28500000020220000000"', app)
        self.assertIn('sliver: "28500000020210000000"', app)
        self.assertIn('properties.size_basis === "GIS estimate"', app)
        styles = (ROOT / "styles.css").read_text(encoding="utf-8")
        self.assertIn('path.leaflet-interactive[fill="none"]', styles)
        self.assertIn("pointer-events: stroke", styles)
        self.assertIn("pointer-events: fill", styles)


if __name__ == "__main__":
    unittest.main()
