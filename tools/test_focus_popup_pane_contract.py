"""Regression checks for Part E focus, popup ownership, and marker hierarchy."""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


ROOT = Path(__file__).resolve().parents[1]


class FocusPopupPaneContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (ROOT / "app.js").read_text(encoding="utf-8")
        cls.agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        cls.data_readme = (ROOT / "data" / "README.md").read_text(encoding="utf-8")
        cls.publishing = (ROOT / "PUBLISHING.md").read_text(encoding="utf-8")

    def test_explicit_feature_focus_never_restores_or_saves_the_old_view_first(self) -> None:
        self.assertIn(
            'const hasExplicitMapFocus = requestedMapFocus === "property" || Boolean(requestedFeatureId);',
            self.app,
        )
        boundary = re.search(
            r"function applyBoundaryData\([^)]*\) \{([\s\S]*?)\n\}",
            self.app,
        )
        self.assertIsNotNone(boundary)
        block = boundary.group(1)
        self.assertIn("if (hasExplicitMapFocus) programmaticFocusViewActive = true;", block)
        self.assertIn("else if (!hasExplicitMapFocus && hasSavedMapView(savedMapPreferences))", block)
        self.assertIn("else if (!hasExplicitMapFocus)", block)
        self.assertRegex(
            self.app,
            r"await Promise\.all\(tasks\);[\s\S]*?requestAnimationFrame"
            r"[\s\S]*?tryFocusRequestedFeature\(\);",
        )
        self.assertRegex(
            self.app,
            r"missingSegmentIds\.length > 0[\s\S]*?console\.warn\("
            r"[\s\S]*?missing rendered segment layer",
        )

    def test_photo_handlers_are_bound_to_their_originating_popup_without_rerender(self) -> None:
        self.assertIn("function pointPhotoBelongsToPopup(photo, popup)", self.app)
        self.assertIn("popup?.getElement()?.contains(photo)", self.app)
        self.assertIn('() => handlePointPhotoLoad(photo, popup)', self.app)
        self.assertIn('() => handlePointPhotoError(photo, popup)', self.app)
        self.assertNotIn("syncPointPopupContent", self.app)
        for function_name in ("handlePointPhotoLoad", "handlePointPhotoError"):
            handler = re.search(
                rf"function {function_name}\([^)]*\) \{{([\s\S]*?)\n\}}",
                self.app,
            )
            self.assertIsNotNone(handler)
            self.assertNotIn("setContent(", handler.group(1))
        self.assertNotIn('addEventListener("load", handlePointPhotoLoad, true)', self.app)
        self.assertNotIn('addEventListener("error", handlePointPhotoError, true)', self.app)

    def test_marker_panes_are_contiguous_and_location_pins_win(self) -> None:
        def pane_order(key: str) -> int:
            match = re.search(
                rf'\{{ key: "{re.escape(key)}", name: "[^"]+", order: (\d+) \}}',
                self.app,
            )
            self.assertIsNotNone(match, f"Missing pane {key}")
            return int(match.group(1))

        keys = [
            "liveLocation",
            "interactions",
            "corners",
            "intersections",
            "naturalLandmarks",
            "buildings",
        ]
        orders = [pane_order(key) for key in keys]
        self.assertEqual(list(range(orders[0], orders[0] + len(orders))), orders)
        self.assertIn('markerPanes: { building: "buildings", landmark: "naturalLandmarks" }', self.app)
        self.assertIn("const intersectionsRenderer = L.svg", self.app)
        self.assertIn("pane: MAP_PANES.intersections", self.app)
        self.assertRegex(
            self.app,
            r"const markerPane = LANDMARK_RENDER_CONFIG\.markerPanes"
            r"\[feature\.properties\?\.type\]",
        )

    def test_durable_stacking_rules_and_exact_photo_names_are_documented(self) -> None:
        self.assertIn("## Map stacking order (bottom to top)", self.agents)
        for tier in (
            "Ground shading",
            "Areas",
            "Lines",
            "Live-location dot",
            "Interaction targets",
            "Minor markers",
            "Location pins",
        ):
            self.assertIn(f"**{tier}:", self.agents)
        filenames = (
            "home.jpg",
            "pavilion.jpg",
            "the-barbershop.jpg",
            "main-loop-clearing.jpg",
            "main-loop-driveway.jpg",
            "main-loop-pavilion-side-trail.jpg",
            "mountain-drive-driveway.jpg",
            "mountain-drive-pavilion-side-trail.jpg",
            "pavilion-pavilion-side-trail.jpg",
            "field-connector-front-field-zone.jpg",
            "field-connector-main-loop-ext.jpg",
            "garden-cut-through-front-field-zone.jpg",
            "garden-cut-through-open-end.jpg",
        )
        for filename in filenames:
            self.assertIn(f"assets/points/{filename}", self.data_readme)
        for phrase in ("case-sensitive", "lowercase `.jpg`", "strip all EXIF"):
            self.assertIn(phrase, self.data_readme)
        self.assertIn("Garden Cut Through / Main Loop", self.data_readme)
        self.assertRegex(
            self.publishing,
            r"## Routine update[\s\S]*?1\. [^\n]*run `python tools/bump_version\.py`",
        )


if __name__ == "__main__":
    unittest.main()
