"""Contract checks for guest-facing text, legend, and information controls."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]


def load(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


class GuestTextLegendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (ROOT / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "map.html").read_text(encoding="utf-8")
        cls.css = (ROOT / "styles.css").read_text(encoding="utf-8")

    def test_guest_copy_is_intentional_and_concise(self) -> None:
        self.assertIn('? "Not finished yet."', self.app)
        self.assertNotIn("Approximate route.", self.app)
        self.assertIn('feature.properties.note || ""', self.app)
        self.assertNotIn("Approximate mapped feature.", self.app)
        self.assertNotIn("properties.status, properties.note", self.app)

        routes = {route["id"]: route for route in load("data/trails/routes.json")["routes"]}
        self.assertEqual(
            "Out and back from the driveway to the clearing.",
            routes["main-loop-route"]["description"],
        )
        self.assertEqual(
            "Out and back up Mountain Drive.",
            routes["mountain-drive-route"]["description"],
        )
        boundary = load("data/property/boundaries.geojson")["features"][0]["properties"]
        self.assertNotIn("Borders currently", boundary["popup_description"])

    def test_length_repairs_and_elevation_omission_are_preserved(self) -> None:
        trails = {
            feature["properties"]["id"]: feature["properties"]
            for feature in load("data/trails/walking-trails.geojson")["features"]
        }
        self.assertEqual(489, trails["main-loop"]["length_ft"])
        self.assertEqual(419, trails["line"]["length_ft"])
        for key in ("elevation_profile_ft", "elevation_gain_ft", "elevation_loss_ft"):
            self.assertNotIn(key, trails["line"])

    def test_legend_has_exact_phone_rows_and_style_backed_swatches(self) -> None:
        for label in (
            "Property boundary (approximate)",
            "Walking trail",
            "Unfinished trail",
            "Dirt road",
            "Not part of the property",
            "Powerline corridor (not owned, access allowed)",
            "Landmark",
            "Minor landmark",
        ):
            self.assertIn(label, self.app)
        self.assertIn("trailStyle({ properties: { condition: \"finished\" } })", self.app)
        self.assertIn("BOUNDARY_RENDER_CONFIG.style", self.app)
        self.assertIn("OUTSIDE_RENDER_CONFIG.hatch", self.app)
        self.assertIn("LANDMARK_RENDER_CONFIG.markerStyle", self.app)
        self.assertIn(".map-legend-row--desktop { display: none; }", self.css)
        self.assertIn("pointer-events: none", self.css)
        self.assertIn("pointer-events: auto", self.css)
        self.assertIn("Number(feature.properties?.length_ft)", self.app)

    def test_about_button_is_created_inside_layer_panel(self) -> None:
        self.assertNotIn('id="info-button"', self.html)
        self.assertIn('aboutButton.id = "info-button";', self.app)
        self.assertIn('aboutButton.setAttribute("aria-label", "About this map");', self.app)
        self.assertIn('aboutButton.className = "layer-about-button";', self.app)
        self.assertIn("decorateLayerControl(layerControl);", self.app)

    def test_mobile_controls_and_trail_interactions_have_durable_contracts(self) -> None:
        self.assertRegex(self.app, r'key: "roads",\s+label: null,')
        self.assertIn('legendDismissedForSession = false;', self.app)
        self.assertIn('button.setAttribute("aria-label", "Show map legend");', self.app)
        self.assertIn("showMapLegend();", self.app)
        self.assertIn('pane: MAP_PANES.trailInteractions', self.app)
        self.assertIn('interactionPriority: 100', self.app)
        self.assertIn('? 26 : ROAD_INTERACTION_WEIGHT_PX', self.app)
        self.assertIn('isUnfinished && aerialIsActive ? "#bed6df"', self.app)
        self.assertIn('weight: isUnfinished && isPhone ? 2.35 : 3', self.app)
        self.assertIn('map.on("baselayerchange", refreshTrailPresentation);', self.app)
        self.assertIn('scheduleLayerControlDecoration();', self.app)
        self.assertIn(".map-legend-restore", self.css)
        self.assertIn("z-index: 1200", self.css)


if __name__ == "__main__":
    unittest.main()
