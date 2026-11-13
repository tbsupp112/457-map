"""Regression checks for the published map's road and interaction contracts."""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
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

    def test_mountain_drive_is_a_split_trail_and_driveway_is_the_only_road(self) -> None:
        manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
        sources = {source["key"]: source for source in manifest["sources"]}
        self.assertNotIn("mountainDrive", sources)
        self.assertEqual("data/roads/driveway.geojson", sources["driveway"]["path"])
        self.assertFalse((ROOT / "data" / "roads" / "mountain-drive.geojson").exists())
        self.assertFalse((ROOT / "data" / "roads" / "dirt-roads.geojson").exists())

        trails = json.loads(
            (ROOT / sources["trails"]["path"]).read_text(encoding="utf-8")
        )["features"]
        trails_by_id = {item["properties"]["id"]: item for item in trails}
        driveway = json.loads(
            (ROOT / sources["driveway"]["path"]).read_text(encoding="utf-8")
        )["features"]
        self.assertEqual(["driveway"], [item["properties"]["id"] for item in driveway])
        lower = trails_by_id["mountain-drive"]
        upper = trails_by_id["mountain-drive-upper"]
        self.assertEqual(lower["geometry"]["coordinates"][-1], upper["geometry"]["coordinates"][0])
        self.assertEqual([-73.8351907, 43.3596533], lower["geometry"]["coordinates"][-1])
        self.assertEqual("finished", lower["properties"]["condition"])
        self.assertEqual("unfinished", upper["properties"]["condition"])

        routes = json.loads(
            (ROOT / "data" / "trails" / "routes.json").read_text(encoding="utf-8")
        )["routes"]
        mountain_route = next(route for route in routes if route["id"] == "mountain-drive-route")
        self.assertEqual(["mountain-drive", "mountain-drive-upper"], mountain_route["segments"])
        self.assertEqual(["forward", "forward"], mountain_route["segment_directions"])
        self.assertEqual("moderate", mountain_route["difficulty"])
        self.assertTrue(all("driveway" not in route["segments"] for route in routes))

    def test_shared_svg_interactions_are_above_visual_canvases_and_below_markers(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")

        def pane_order(key: str) -> int:
            match = re.search(
                rf'key:\s*"{re.escape(key)}"[^\n]+order:\s*(\d+)',
                app,
            )
            self.assertIsNotNone(match, f"Missing pane definition for {key}")
            return int(match.group(1))

        for visual_pane in ("zones", "corridor", "contourLabels", "boundary", "roads", "trails"):
            self.assertGreater(pane_order("interactions"), pane_order(visual_pane))
        self.assertLess(pane_order("interactions"), pane_order("naturalLandmarks"))
        self.assertIn("const interactionsRenderer = L.svg", app)
        self.assertNotIn("roadInteractionsRenderer", app)
        self.assertRegex(
            app,
            r"const intersectionsRenderer = L\.svg\(\{\s*"
            r"pane: MAP_PANES\.intersections,",
        )
        for layer_name in (
            "corridorInteractionLayer",
            "roadInteractionLayer",
            "trailInteractionLayer",
            "zonesInteractionLayer",
            "boundaryInteractionLayer",
        ):
            self.assertRegex(
                app,
                rf"const {layer_name} = L\.geoJSON\(null, \{{[\s\S]*?"
                rf"renderer: interactionsRenderer,",
            )
        for visual_layer in (
            "corridorLayer",
            "roadHalo",
            "roadsLayer",
            "trailsLayer",
            "zonesLayer",
            "boundaryHalo",
            "boundaryLayer",
        ):
            self.assertRegex(
                app,
                rf"const {visual_layer} = L\.geoJSON\(null, \{{[\s\S]*?"
                rf"interactive: false,",
            )
        self.assertIn("boundaryInteractionLayer.addData(buildBoundaryLines(boundaries))", app)

    def test_map_assets_share_one_cache_version(self) -> None:
        versions = []
        for name in ("index.html", "map.html"):
            versions.extend(
                re.findall(r'(?:css|js)\?v=([0-9-]+)', (ROOT / name).read_text(encoding="utf-8"))
            )
        self.assertTrue(versions)
        self.assertEqual(1, len(set(versions)))
        cache_version = versions[0]
        for name in ("app.js", "home.js"):
            source = (ROOT / name).read_text(encoding="utf-8")
            match = re.search(r'const DATA_CACHE_VERSION = "([0-9-]+)";', source)
            self.assertIsNotNone(match, f"Missing data cache version in {name}")
            self.assertEqual(cache_version, match.group(1))
            self.assertIn('versionedDataUrl("data/manifest.json")', source)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for contour placement checks")
    def test_contour_labels_are_bounded_and_clear_with_visibility_and_zoom(self) -> None:
        script = r"""
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const app = fs.readFileSync(process.argv[1] + '/app.js', 'utf8');
const source = app.slice(app.indexOf('function refreshContourLabels() {'), app.indexOf('function appendTerrainLegend('));
class Point {
  constructor(x, y) { this.x=x; this.y=y; }
  distanceTo(other) { return Math.hypot(this.x-other.x, this.y-other.y); }
  add(other) { return new Point(this.x+other.x, this.y+other.y); }
  subtract(other) { return new Point(this.x-other.x, this.y-other.y); }
  multiplyBy(value) { return new Point(this.x*value, this.y*value); }
}
const context = {
  contourLabelFeatures: [], mobileMapPanels: {matches:false}, MAP_PANES: {contourLabels:'contour-labels-pane'},
  terrainLayers: {contours:{}}, zoom:17, maxZoom:21, enabled:true,
  document: {createElement: ()=>({
    className:'', textContent:'', remove() {},
    getBoundingClientRect() { return {width:this.textContent.length*6,height:this.className.includes('--minor')?16:18}; },
  })},
  contourLabelGroup: {markers:[], clearLayers() { this.markers=[]; }},
  L: {divIcon: options=>options, marker: (latlng,options)=>({addTo(group) { group.markers.push({latlng,options}); }})},
};
context.map = {
  hasLayer: ()=>context.enabled, getZoom: ()=>context.zoom, getMaxZoom: ()=>context.maxZoom,
  options:{zoomDelta:0.5}, getSize: ()=>({x:1000,y:1000}), getContainer: ()=>({append() {}}),
  latLngToContainerPoint: ([y,x])=>new Point(x,y), containerPointToLatLng: point=>({lat:point.y,lng:point.x}),
};
vm.createContext(context); vm.runInContext(source, context);
const line = (elevation,y,end=900)=>({properties:{elevation},geometry:{type:'LineString',coordinates:[[80,y],[end,y]]}});
context.contourLabelFeatures = Array.from({length:18}, (_,i)=>line(250+5*i,50+i*45));
context.contourLabelFeatures.push(line(250,900));
context.refreshContourLabels();
assert.equal(context.contourLabelGroup.markers.length,12);
const labels = context.contourLabelGroup.markers;
assert.equal(new Set(labels.map(label=>label.options.icon.html)).size,labels.length);
for (const label of labels) {
  assert.match(label.options.icon.html,/\d+(?:\.\d+)? m/);
  assert.doesNotMatch(label.options.icon.html,/\.0 m|ft/);
  assert.equal(label.options.pane,'contour-labels-pane');
  assert.equal(label.options.interactive,false); assert.equal(label.options.keyboard,false);
  assert.ok(label.latlng.lng>=44 && label.latlng.lng<=956 && label.latlng.lat>=28 && label.latlng.lat<=972);
}
context.zoom=16.99; context.refreshContourLabels(); assert.equal(context.contourLabelGroup.markers.length,0);
context.zoom=17; context.refreshContourLabels(); assert.equal(context.contourLabelGroup.markers.length,12);
context.mobileMapPanels.matches=true; context.zoom=17; context.refreshContourLabels();
assert.equal(context.contourLabelGroup.markers.length,0);
for (const zoom of [18,18.49]) {
  context.zoom=zoom; context.refreshContourLabels();
  assert.equal(context.contourLabelGroup.markers.length,0);
}
context.zoom=18.5; context.refreshContourLabels(); assert.equal(context.contourLabelGroup.markers.length,8);
context.contourLabelFeatures.push(
  ...Array.from({length:18}, (_,i)=>line(250.5+i*5,70+i*45)),
  ...Array.from({length:18}, (_,i)=>line(251+i*5,80+i*45)),
);
for (const zoom of [20,20.49]) {
  context.zoom=zoom; context.refreshContourLabels();
  assert.equal(context.contourLabelGroup.markers.some(label=>!label.options.contourMajor),false);
}
for (const zoom of [20.5,21]) {
  context.zoom=zoom; context.refreshContourLabels();
  assert.ok(context.contourLabelGroup.markers.some(label=>!label.options.contourMajor));
  assert.ok(context.contourLabelGroup.markers.length>12,'old major cap starved close-zoom labels');
  assert.ok(context.contourLabelGroup.markers.every(label=>!label.options.icon.html.match(/\d+\.5 m/)), 'half-metre labels must be omitted');
  const firstMinor=context.contourLabelGroup.markers.findIndex(label=>!label.options.contourMajor);
  assert.ok(context.contourLabelGroup.markers.slice(firstMinor).every(label=>!label.options.contourMajor));
}
context.contourLabelFeatures=[line(250,100),line(251,160),line(250.5,220),line(252,280),line(253,340),line(254,400),line(255,460),line(251,620)];
context.zoom=20.5; context.refreshContourLabels();
const closeLabels=context.contourLabelGroup.markers.map(label=>label.options.icon.html);
for (const elevation of [250,251,252,253,254,255]) assert.ok(closeLabels.includes(`<span>${elevation} m</span>`),`missing whole-metre level ${elevation}`);
assert.equal(closeLabels.some(label=>/\d+\.5 m/.test(label)),false,'fragment order must not select half-metre levels');
context.maxZoom=22; context.map.options.zoomDelta=0.25; context.zoom=21.5;
context.refreshContourLabels(); assert.equal(context.contourLabelGroup.markers.some(label=>!label.options.contourMajor),false);
context.zoom=21.75; context.refreshContourLabels();
assert.ok(context.contourLabelGroup.markers.some(label=>!label.options.contourMajor));
context.enabled=false; context.refreshContourLabels(); assert.equal(context.contourLabelGroup.markers.length,0);
context.enabled=true; context.contourLabelFeatures=[line(300,100,120),line(305,10)];
context.refreshContourLabels(); assert.equal(context.contourLabelGroup.markers.length,0);
context.contourLabelFeatures=[line(300,100),line(305,100)]; context.refreshContourLabels();
const positions=context.contourLabelGroup.markers.map(label=>label.latlng);
for (let i=0;i<positions.length;i++) for (let j=0;j<i;j++) {
  const labels=context.contourLabelGroup.markers;
  const width=(labels[i].options.icon.iconSize[0]+labels[j].options.icon.iconSize[0])/2;
  assert.ok(Math.abs(positions[i].lng-positions[j].lng)>=width || Math.abs(positions[i].lat-positions[j].lat)>=18);
}
context.contourLabelFeatures=[{properties:{elevation:250.5},geometry:{type:'LineString',coordinates:[[-100,500],[1100,500]]}}];
context.refreshContourLabels(); assert.equal(context.contourLabelGroup.markers.length,0,'half-metre line should not receive a label');
context.contourLabelFeatures=[{properties:{elevation:251},geometry:{type:'LineString',coordinates:[[-100,500],[1100,500]]}}];
context.refreshContourLabels(); assert.equal(context.contourLabelGroup.markers.length,1,'long crossing segment was lost at close zoom');
assert.equal(context.contourLabelGroup.markers[0].options.icon.html,'<span>251 m</span>');
"""
        result = subprocess.run(
            [shutil.which("node"), "-e", script, str(ROOT)],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn('feature.properties?.elevation_unit === "m"', app)
        self.assertIn("elevation % 5 === 0", app)
        self.assertIn("Number.isInteger(elevation)", app)
        self.assertIn("map.getZoom() < (isPhone ? 18.5 : 17)", app)
        legend = app[app.index("function appendTerrainLegend("):app.index("function legendRows(")]
        self.assertIn('key === "contours"', legend)
        self.assertNotIn("Brown lines", legend)
        self.assertIn('map.getPane(MAP_PANES.contourLabels).style.pointerEvents = "none";', app)

    def test_compass_and_guidance_share_one_heading_lifecycle(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "styles.css").read_text(encoding="utf-8")

        for contract in (
            "function installMapCompassControl()",
            "document.createElementNS(\"http://www.w3.org/2000/svg\", \"svg\")",
            "function requestHeadingAccess()",
            "request = permissionRequest.call(orientationApi);",
            "function syncHeadingLifecycle(",
            "function getFreshHeading()",
            "latestHeadingAt: 0",
            "function handleHeadingFreshnessTimeout()",
            "const PREFERRED_ABSOLUTE_HEADING_WINDOW_MS = 1200;",
            "lastNativeAbsoluteAt",
            "function activateMobileHeadingSession()",
            "function updateMinimizedCompassHeading(",
            "function handleCompassViewportChange()",
            "mobileHeadingSessionActive && mobileMapPanels.matches",
            "awaitingFreshEventAfterResume",
            "guidanceStartPending",
            "function handleHeadingVisibilityChange()",
            "function handleHeadingScreenChange()",
        ):
            self.assertIn(contract, app)
        self.assertNotIn("androidAbsoluteSeen", app)
        self.assertIn("event.absolute === true", app)
        self.assertEqual(
            1,
            app.count('window.addEventListener(eventName, handleOrientationEvent, true);'),
            "both consumers should use the single orientation listener pipeline",
        )
        compass_open = app[app.index("function setMapCompassOpen("):app.index("function setCompassUnavailableMessage(")]
        self.assertIn('toggle.setAttribute("aria-expanded", String(compassPanelOpen));', compass_open)
        self.assertNotIn("requestInitialLocation", compass_open)
        self.assertNotIn("navigator.geolocation", compass_open)
        self.assertIn("North fixed · heading stale", app)
        self.assertIn("North fixed · motion access denied", app)
        self.assertIn("weather.before(compass)", app, "compass should precede weather in the control stack")
        self.assertIn("legend.before(weather)", app, "weather should precede legend in the control stack")
        self.assertIn("@media (prefers-reduced-motion: reduce)", styles)
        self.assertIn(".compass-heading-needle { transition: none; }", styles)

    def test_compass_design_uses_even_geometry_and_mobile_only_dismissal(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "styles.css").read_text(encoding="utf-8")
        artwork = app[app.index("function mapCompassRoseArtwork()"):app.index("function syncCompassDismissSurface(")]
        script = artwork + '\nconsole.log(`<svg xmlns="http://www.w3.org/2000/svg">${mapCompassRoseArtwork()}</svg>`);'
        result = subprocess.run(
            [shutil.which("node"), "-e", script],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        svg = ET.fromstring(result.stdout)
        namespace = {"svg": "http://www.w3.org/2000/svg"}
        ticks = svg.findall(".//svg:line[@data-angle]", namespace)
        self.assertEqual(16, len(ticks))
        for index, tick in enumerate(ticks):
            expected = index * 22.5
            self.assertAlmostEqual(expected, float(tick.get("data-angle")), places=4)
            dx = float(tick.get("x2")) - 100
            dy = float(tick.get("y2")) - 100
            actual = math.degrees(math.atan2(dx, -dy)) % 360
            error = abs((actual - expected + 180) % 360 - 180)
            self.assertLessEqual(error, 0.02)
            self.assertAlmostEqual(82, math.hypot(dx, dy), places=2)

        arms = svg.findall(".//svg:path[@data-bearing]", namespace)
        self.assertEqual(["0", "90", "180", "270"], [arm.get("data-bearing") for arm in arms])
        self.assertEqual(1, len({arm.get("d") for arm in arms}), "all cardinal arms use the same construction")
        self.assertEqual(
            ["rotate(0 100 100)", "rotate(90 100 100)", "rotate(180 100 100)", "rotate(270 100 100)"],
            [arm.get("transform") for arm in arms],
        )

        self.assertIn('rose.setAttribute("role", "button");', app)
        self.assertIn('rose.setAttribute("aria-label", "Minimize compass");', app)
        self.assertIn('document.activeElement === close || document.activeElement === document.body;', app)
        self.assertIn(".map-compass-rose:focus { outline: none; }", styles)
        self.assertIn(".map-compass-rose:focus .compass-rose-focus-ring", styles)
        self.assertIn('event.key !== "Enter" && event.key !== " "', app)
        self.assertIn("gesture.multiPointer", app)
        self.assertIn("distance > 8", app)
        self.assertRegex(styles, r"\.map-compass-rose\s*\{[^}]*pointer-events:\s*none;")
        mobile_start = styles.index("@media (max-width: 720px)")
        mobile_end = styles.index("@media", mobile_start + 1)
        mobile_styles = styles[mobile_start:mobile_end]
        self.assertIn(".map-compass-rose { pointer-events: none;", mobile_styles)
        self.assertIn('.map-compass-rose * { pointer-events: none; }', mobile_styles)
        self.assertIn('.compass-dismiss-disk { fill: transparent; pointer-events: all; }', mobile_styles)
        self.assertIn(".map-compass-readout { pointer-events: auto;", mobile_styles)
        self.assertIn(".map-compass-close { display: none; }", mobile_styles)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for gesture runtime checks")
    def test_compass_release_and_delayed_click_reject_invalid_gestures(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        start = app.index("    let compassPointerGesture =")
        gesture = app[start:app.index('    toggle.addEventListener("click",', start)]
        setup = r"""
const assert = require('node:assert/strict');
const handlers = new Map();
class Element {
  constructor(surface, box) { this.surface = surface; this.box = box; this.handlers = {}; }
  closest() { return this.surface ? this : null; }
  getBoundingClientRect() { return this.box; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
}
const rose = new Element(true, {left:0,top:0,width:200,height:200});
const readout = new Element(true, {left:0,top:210,right:200,bottom:240});
const outside = new Element(false, {});
const mobileMapPanels = {matches:true};
let compassPanelOpen = true, closes = 0;
function setMapCompassOpen(open) { compassPanelOpen = open; if (!open) closes++; }
const window = {addEventListener(type, handler) { handlers.set(type, handler); }};
function event(pointerId=1, x=100, y=100, target=rose) {
  return {pointerId,clientX:x,clientY:y,target,detail:1,type:'click',
    preventDefault(){this.prevented=true;},stopPropagation(){},stopImmediatePropagation(){this.stopped=true;}};
}
function emit(type, e) { handlers.get(type)(e); }
"""
        checks = r"""
emit('pointerdown', event()); emit('pointerup', event());
assert.equal(closes, 1); assert.equal(compassPanelOpen, false);
setTimeout(() => {
  const click = event(1,100,100,outside);
  emit('click', click);
  assert.ok(click.prevented && click.stopped, 'later compatibility click must not reach map');
  assert.equal(closes,1);
  for (const kind of ['drag','multi','cancel','outside']) {
    compassPanelOpen=true; const before=closes;
    emit('pointerdown',event());
    if(kind==='drag') emit('pointermove',event(1,125,100));
    if(kind==='multi') { emit('pointerdown',event(2)); emit('pointerup',event(2)); }
    emit(kind==='cancel'?'pointercancel':'pointerup',event(1,kind==='outside'?198:100,100));
    assert.equal(closes,before,kind);
    assert.ok(compassPanelOpen,kind);
  }
  emit('pointerdown',event(3,100,220,readout)); emit('pointerup',event(3,100,220,readout));
  assert.equal(closes,2,'readout release');
},20);
"""
        result = subprocess.run([shutil.which("node"), "-e", setup + gesture + checks],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_topographic_map_owns_contours_without_retired_provider_or_overlay(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "styles.css").read_text(encoding="utf-8")

        self.assertIn('"Satellite map": nysAerial', app)
        self.assertIn('"Topographic map": topographicGround', app)
        self.assertIn("const topographicGround = L.gridLayer({", app)
        self.assertIn("topographicGround.createTile = function createTopographicGroundTile()", app)
        self.assertNotIn("opentopomap.org", app.lower())
        self.assertNotIn("OpenTopoMap", app)
        self.assertNotIn('label: "Elevation contours"', app)
        self.assertIn('baseOnly: true, optionalSources: ["contours"]', app)
        self.assertIn("if (definition.baseOnly) return;", app)
        self.assertIn('savedMapPreferences.baseMap === "topo" ? topographicGround : nysAerial', app)
        self.assertIn('baseMap: map.hasLayer(topographicGround) ? "topo" : "aerial"', app)
        self.assertIn('map.on("baselayerchange", syncTopographicContours);', app)
        self.assertIn("function syncTopographicContours()", app)
        self.assertIn("Contours unavailable. Check data/manifest.json or data/terrain/contours.geojson.", app)
        self.assertIn("invalidOptionalSources.has(key) || !source", app)
        self.assertIn('const control = L.control({ position: "topleft" });', app)
        self.assertRegex(styles, r"\.topographic-source-status\s*\{[^}]*pointer-events:\s*none;")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for aspect compass geometry checks")
    def test_aspect_compass_uses_metadata_palette_and_eight_north_up_sectors(self) -> None:
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        aspect = json.loads((ROOT / "data" / "terrain" / "aspect.geojson").read_text(encoding="utf-8"))
        entries = aspect["features"][0]["properties"]["legend"]
        source = app[
            app.index("const ASPECT_DIRECTIONS ="):app.index("const LAYER_DEFINITIONS =")
        ] + app[
            app.index("function aspectCompassPoint("):app.index("function aspectDirectionTextColor(")
        ]
        script = source + r"""
const entries = JSON.parse(process.argv[1]);
console.log(JSON.stringify(createAspectCompassSectors(entries)));
"""
        result = subprocess.run(
            [shutil.which("node"), "-e", script, json.dumps(entries)],
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        sectors = json.loads(result.stdout)
        self.assertEqual(
            ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
            [sector["label"] for sector in sectors],
        )
        metadata_colors = {entry["label"]: entry["color"] for entry in entries}
        for index, sector in enumerate(sectors):
            bearing = index * 45
            self.assertEqual(bearing, sector["bearing"])
            self.assertEqual(bearing - 22.5, sector["startBearing"])
            self.assertEqual(bearing + 22.5, sector["endBearing"])
            self.assertEqual(metadata_colors[sector["label"]], sector["color"])
            radians = math.radians(bearing)
            self.assertAlmostEqual(48 + math.sin(radians) * 29, sector["labelPoint"]["x"], delta=0.01)
            self.assertAlmostEqual(48 - math.cos(radians) * 29, sector["labelPoint"]["y"], delta=0.01)
            self.assertTrue(sector["path"])
        self.assertTrue(sectors[0]["wrapsNorth"])
        self.assertEqual(-22.5, sectors[0]["startBearing"])
        self.assertEqual(22.5, sectors[0]["endBearing"])
        self.assertIn('wedge.setAttribute("d", sector.path);', app)
        self.assertIn('wedge.setAttribute("data-color", sector.color);', app)
        self.assertIn('pair.textContent = `${label}: ${color}`;', app)
        self.assertIn('accessiblePairs.className = "terrain-aspect-key-text";', app)
        self.assertIn('caption.textContent = "Downslope direction";', app)

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
