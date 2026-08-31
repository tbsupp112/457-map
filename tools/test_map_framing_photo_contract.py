"""Contract checks for map framing, route focus, and optional point photos."""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


ROOT = Path(__file__).resolve().parents[1]


class MapFramingPhotoContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (ROOT / "app.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "styles.css").read_text(encoding="utf-8")
        cls.index = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.data_readme = (ROOT / "data" / "README.md").read_text(encoding="utf-8")

    def test_pointer_focus_outline_rule_preserves_focus_visible(self) -> None:
        exact_rule = (
            ".leaflet-pane > svg path.leaflet-interactive:focus:not(:focus-visible) "
            "{ outline: none; }"
        )
        self.assertIn(exact_rule, self.styles)
        self.assertNotRegex(
            self.styles,
            r"path\.leaflet-interactive:focus\s*\{\s*outline:\s*none",
        )

    def test_home_property_link_uses_guarded_explicit_framing(self) -> None:
        self.assertIn('href="map.html?focus=property"', self.index)
        self.assertIn('const requestedMapFocus = new URLSearchParams', self.app)
        property_branch = re.search(
            r'if \(requestedMapFocus === "property"\) \{([\s\S]*?)'
            r'\} else if \(!hasExplicitMapFocus',
            self.app,
        )
        self.assertIsNotNone(property_branch)
        branch = property_branch.group(1)
        self.assertIn("focusRequestedBounds(boundaryLayer.getBounds()", branch)
        self.assertIn("paddingTopLeft: PROPERTY_BOUNDS_PADDING", branch)
        self.assertIn("paddingBottomRight: PROPERTY_BOUNDS_PADDING", branch)
        self.assertIn("zoomSnap: 0.5", branch)
        self.assertRegex(
            self.app,
            r"programmaticFocusViewActive = true;[\s\S]*?"
            r"if \(programmaticFocusViewActive && hasSavedMapView\(savedMapPreferences\)\)",
        )
        self.assertIn("const previousZoomSnap = map.options.zoomSnap;", self.app)
        self.assertIn("map.options.zoomSnap = previousZoomSnap;", self.app)

    def test_route_focus_unions_every_member_segment(self) -> None:
        route_focus = re.search(
            r"const route = routesById\.get\(requestedFeatureId\);([\s\S]*?)"
            r"\n\s*const match = focusableFeaturesById",
            self.app,
        )
        self.assertIsNotNone(route_focus)
        block = route_focus.group(1)
        self.assertIn("route.segments", block)
        self.assertIn("missingSegmentIds", block)
        self.assertIn("console.warn", block)
        self.assertIn("members.forEach", block)
        self.assertIn("bounds.extend(memberBounds)", block)
        self.assertIn("focusRequestedBounds(bounds", block)
        registry_load = re.search(
            r"async function loadLayerRegistry\(\) \{([\s\S]*?)\n\}",
            self.app,
        )
        self.assertIsNotNone(registry_load)
        load_block = registry_load.group(1)
        self.assertRegex(
            load_block,
            r"await Promise\.all\(tasks\);[\s\S]*?map\.invalidateSize"
            r"\(\{ pan: false \}\);[\s\S]*?tryFocusRequestedFeature\(\);",
        )

    def test_point_photos_are_optional_id_based_and_limited_to_authored_point_types(self) -> None:
        self.assertRegex(
            self.app,
            r"landmark:\s*true,\s*pointPhoto:\s*true,\s*"
            r"standardPopupWidth:\s*true,\s*focusOverlay:\s*landmarksLayer,",
        )
        self.assertRegex(
            self.app,
            r"bindMapFeature\(layer, feature, feature\.properties\.note, \{\s*"
            r"focusOverlay: intersectionsLayer,\s*pointPhoto: true,\s*"
            r"standardPopupWidth: true,",
        )
        self.assertIn('feature?.geometry?.type !== "Point"', self.app)
        self.assertIn('class="point-popup-photo"', self.app)
        self.assertIn('loading="lazy"', self.app)
        self.assertIn("assets/points/${encodeURIComponent(featureId)}.jpg", self.app)
        self.assertNotRegex(
            self.app,
            r"assets/points/[^\n]+DATA_CACHE_VERSION",
        )
        self.assertIn('figure.classList.add("is-loaded")', self.app)
        self.assertIn('photo.closest(".point-popup-photo")?.remove()', self.app)
        self.assertNotIn("syncPointPopupContent", self.app)
        self.assertNotIn("popup.setContent(content.outerHTML)", self.app)
        self.assertIn('map.on("popupopen", preparePointPopupPhoto)', self.app)
        self.assertIn("window.requestAnimationFrame(() => settlePointPopupPhoto(event.popup))", self.app)
        self.assertIn('() => handlePointPhotoLoad(photo, popup)', self.app)
        self.assertIn('() => handlePointPhotoError(photo, popup)', self.app)
        self.assertIn("pointPhotoBelongsToPopup(photo, popup)", self.app)
        self.assertIn("if (!photo.complete) return;", self.app)
        self.assertRegex(self.styles, r"\.point-popup-photo\s*\{[\s\S]*?aspect-ratio:\s*4 / 3;")
        self.assertRegex(self.styles, r"\.point-popup-photo\s*\{[\s\S]*?visibility:\s*hidden;")
        self.assertRegex(self.styles, r"\.point-popup-photo\.is-loaded\s*\{[\s\S]*?visibility:\s*visible;")
        self.assertRegex(self.styles, r"\.point-popup-photo img\s*\{[\s\S]*?object-fit:\s*cover;")
        self.assertTrue((ROOT / "assets" / "points" / "README.txt").is_file())
        for phrase in ("assets/points", "1200 px", "300 KB", "strip all EXIF", "hard reload"):
            self.assertIn(phrase, self.data_readme)

    def test_ordinary_popup_width_is_responsive_and_content_aware(self) -> None:
        self.assertIn("standardPopupWidth: true", self.app)
        self.assertIn("function shouldUseStandardPopupWidth", self.app)
        self.assertIn("if (options.pointPhoto) return true;", self.app)
        self.assertIn("titleLength > 18 || detailLength > 60", self.app)
        self.assertRegex(
            self.styles,
            r"\.map-popup-content--standard\s*\{\s*"
            r"width:\s*min\(210px, calc\(100vw - 108px\)\);",
        )
        self.assertRegex(
            self.app,
            r"if \(routes\.length === 0\) return \{ detail, standardPopupWidth: true \};",
        )
        self.assertIn("if (!options.standardPopupWidth || options.routes?.length) return false;", self.app)


if __name__ == "__main__":
    unittest.main()
