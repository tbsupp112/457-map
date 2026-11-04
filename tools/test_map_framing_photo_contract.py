"""Contract checks for map framing, route focus, and optional point photos."""

from __future__ import annotations

import re
import shutil
import subprocess
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
        self.assertIn("focusRequestedBounds(propertyContextBounds()", branch)
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

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for geographic context checks")
    def test_property_context_expands_each_side_by_metres_without_mutating_boundary(self) -> None:
        script = r"""
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync(process.argv[1]+'/app.js','utf8');
const helper=app.slice(app.indexOf('function propertyContextBounds('),app.indexOf('function combineFeatureCollections('));
function bounds(southWest,northEast) {
  return {getSouth:()=>southWest[0],getWest:()=>southWest[1],getNorth:()=>northEast[0],getEast:()=>northEast[1],
    getCenter:()=>({lat:(southWest[0]+northEast[0])/2,lng:(southWest[1]+northEast[1])/2}),isValid:()=>true};
}
const original=bounds([43.3575,-73.837],[43.3611,-73.833]);
const context={PROPERTY_CONTEXT_METERS:60.96,L:{latLngBounds:bounds},boundaryLayer:{getBounds:()=>original}};
vm.createContext(context);vm.runInContext(helper,context);
const expanded=context.propertyContextBounds();
const radians=Math.PI/180;
function distance(first,second) {
  const a=Math.sin((second[0]-first[0])*radians/2)**2+
    Math.cos(first[0]*radians)*Math.cos(second[0]*radians)*Math.sin((second[1]-first[1])*radians/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
const center=original.getCenter();
for(const [start,end] of [
  [[original.getSouth(),center.lng],[expanded.getSouth(),center.lng]],
  [[original.getNorth(),center.lng],[expanded.getNorth(),center.lng]],
  [[center.lat,original.getWest()],[center.lat,expanded.getWest()]],
  [[center.lat,original.getEast()],[center.lat,expanded.getEast()]],
]) assert.ok(Math.abs(distance(start,end)-60.96)<0.1);
assert.equal(original.getSouth(),43.3575);assert.equal(original.getWest(),-73.837);
const invalid={isValid:()=>false};assert.equal(context.propertyContextBounds(invalid),invalid);
"""
        result = subprocess.run(
            [shutil.which("node"), "-e", script, str(ROOT)],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(2, self.app.count("map.fitBounds(propertyContextBounds(),"))
        self.assertIn("map.setView(savedMapPreferences.center, savedMapPreferences.zoom)", self.app)

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
            r"standardPopupWidth:\s*true,\s*focusOverlay:\s*layerGroup,",
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
