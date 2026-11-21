from __future__ import annotations

import subprocess
import shutil
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
APP = (ROOT / "app.js").read_text(encoding="utf-8")


def extract_function(name: str) -> str:
    start = APP.index(f"function {name}(")
    signature_end = APP.index(") {", start)
    opening = signature_end + 2
    depth = 0
    for index in range(opening, len(APP)):
        if APP[index] == "{":
            depth += 1
        elif APP[index] == "}":
            depth -= 1
            if depth == 0:
                return APP[start : index + 1]
    raise AssertionError(f"Could not find end of {name}()")


@unittest.skipUnless(shutil.which("node"), "Node.js is required for imagery state checks")
class HistoricalImageryTests(unittest.TestCase):
    def run_node(self, source: str) -> None:
        result = subprocess.run(
            [shutil.which("node"), "-e", source],
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_year_normalization_and_audience_preferences_preserve_base_identity(self) -> None:
        source = "\n".join(
            [
                'const HISTORICAL_IMAGERY_YEARS = Object.freeze(["2022", "2018", "2013", "2009"]);',
                'const DEFAULT_IMAGERY_YEAR = "2022";',
                "const MAP_PREFERENCES_VERSION = 2;",
                extract_function("normalizeHistoricalImageryYear"),
                extract_function("migrateMapPreferences"),
                extract_function("getAudiencePreferences"),
                r"""
const store = migrateMapPreferences({version:2,activeAudience:'owner',profiles:{
  owner:{baseMap:'topo',overlays:{nearbyParcels:true},imageryYear:'2018'},
  visitor:{baseMap:'aerial',overlays:{nearbyParcels:false},imageryYear:'2009'}
}});
const owner = getAudiencePreferences(store,'owner');
const visitor = getAudiencePreferences(store,'visitor');
const assert = require('node:assert/strict');
assert.deepEqual(
  [normalizeHistoricalImageryYear(undefined),normalizeHistoricalImageryYear('9999'),
   normalizeHistoricalImageryYear(2018),normalizeHistoricalImageryYear('2013')],
  ['2022','2022','2022','2013']);
assert.deepEqual(
  [owner.baseMap,owner.imageryYear,owner.overlays.nearbyParcels,
   visitor.baseMap,visitor.imageryYear,visitor.overlays.nearbyParcels],
  ['topo','2018',true,'aerial','2009',false]);
assert.equal(migrateMapPreferences({version:2,profiles:{owner:{baseMap:'topo'}}}).profiles.owner.baseMap,'topo');
""",
            ]
        )
        self.run_node(source)

    def test_year_selection_replaces_one_tile_layer_and_preserves_the_map_view(self) -> None:
        selection = extract_function("selectHistoricalImageryYear")
        source = r"""
const assert = require('node:assert/strict');
const year2022={year:'2022'}, year2018={year:'2018'}, year2013={year:'2013'};
const nysImageryLayers=new Map([['2022',year2022],['2018',year2018],['2013',year2013],['2009',{year:'2009'}]]);
let selectedImageryYear='2022'; let activeImageryLayer=year2022;
let imageryFallbackFromYear='2009'; let imageryGeneration=0;
const HISTORICAL_IMAGERY_YEARS=['2022','2018','2013','2009']; const DEFAULT_IMAGERY_YEAR='2022';
function normalizeHistoricalImageryYear(value){return typeof value==='string'&&HISTORICAL_IMAGERY_YEARS.includes(value)?value:DEFAULT_IMAGERY_YEAR}
const imageryLayerRuns=new WeakMap();
let historicalImagerySectionOpen=false;
let prefsSaved=0; let pickerUpdates=0; let baseEvents=[]; let satelliteBegins=[];
let topographicGround={};
let map={center:[43.3596,-73.835],zoom:18,layers:new Set(),hasLayer(x){return this.layers.has(x)},removeLayer(x){this.layers.delete(x)},addLayer(x){this.layers.add(x)},fire(name,event){baseEvents.push(event.name)}};
let nysAerial={layers:new Set([year2022]),hasLayer(x){return this.layers.has(x)},removeLayer(x){this.layers.delete(x)},addLayer(x){this.layers.add(x)}};
function beginImageryLoadRun(layer){satelliteBegins.push(layer.year)}
function setHistoricalImagerySectionOpen(open){historicalImagerySectionOpen=!!open}
function updateHistoricalImageryPicker(){pickerUpdates+=1}
function saveMapPreferences(){prefsSaved+=1}
""" + selection + r"""
map.layers.add(nysAerial);
selectHistoricalImageryYear('2018',{keepSectionOpen:true});
assert.deepEqual([...nysAerial.layers].map(layer=>layer.year),['2018']);
assert.equal(selectedImageryYear,'2018'); assert.equal(map.hasLayer(nysAerial),true);
assert.deepEqual(map.center,[43.3596,-73.835]); assert.equal(map.zoom,18);
assert.deepEqual(satelliteBegins,['2018']); assert.equal(historicalImagerySectionOpen,true);
map.layers.delete(nysAerial); map.layers.add(topographicGround);
selectHistoricalImageryYear('2013',{keepSectionOpen:true});
assert.equal(map.hasLayer(topographicGround),false); assert.equal(map.hasLayer(nysAerial),true);
assert.deepEqual([...nysAerial.layers].map(layer=>layer.year),['2013']);
assert.deepEqual(satelliteBegins,['2018','2013']);
assert.deepEqual(baseEvents,['Satellite map']); assert.equal(imageryFallbackFromYear,null);
assert.equal(prefsSaved,2); assert.ok(pickerUpdates>=2);
"""
        self.run_node(source)

    def test_tile_failure_requires_a_complete_retry_and_ignores_stale_runs(self) -> None:
        active_check = extract_function("imageryLoadRunIsCurrent")
        assess = extract_function("assessHistoricalImageryRun")
        source = r"""
const assert = require('node:assert/strict');
const layer={redraws:0,redraw(){this.redraws+=1}};
const nysAerial={hasLayer(candidate){return candidate===layer}};
let activeImageryLayer=layer, selectedImageryYear='2018', imageryGeneration=7;
let fallbackCount=0, timers=[];
const imageryLayerRuns=new WeakMap();
const map={hasLayer(candidate){return candidate===nysAerial}};
const window={setTimeout(fn){timers.push(fn);return timers.length}};
function handleUnavailableHistoricalImagery(){fallbackCount+=1}
""" + active_check + "\n" + assess + r"""
const run={year:'2018',generation:7,pass:0,started:4,loaded:2,failed:2,retryScheduled:false};
imageryLayerRuns.set(layer,run);
assessHistoricalImageryRun(layer,run);
assert.equal(timers.length,0,'partial tile failures do not switch vintages');
run.loaded=0; run.failed=4;
assessHistoricalImageryRun(layer,run);
assert.equal(timers.length,1,'an all-failed viewport gets one bounded retry');
timers.shift()();
assert.equal(layer.redraws,1); assert.equal(run.pass,1); assert.equal(fallbackCount,0);
run.started=3; run.failed=3;
assessHistoricalImageryRun(layer,run);
assert.equal(fallbackCount,1,'a complete second failure invokes one fallback');
imageryGeneration=8; run.generation=7; run.retryScheduled=true;
assessHistoricalImageryRun(layer,run);
assert.equal(fallbackCount,1,'late failures from a deselected run are ignored');
"""
        self.run_node(source)

    def test_picker_control_and_service_contract(self) -> None:
        self.assertIn('"Satellite map": nysAerial', APP)
        self.assertIn('"Topographic map": topographicGround', APP)
        self.assertIn('maxNativeZoom: 19', APP)
        self.assertIn('maxZoom: DEFAULT_MAX_ZOOM', APP)
        self.assertIn('let selectedImageryYear = normalizeHistoricalImageryYear(savedMapPreferences.imageryYear);', APP)
        self.assertIn('imageryYear: selectedImageryYear', APP)
        self.assertIn('const service = `https://orthos.its.ny.gov/arcgis/rest/services/wms/${year}/MapServer`;', APP)
        self.assertIn('textContent = "Exact capture month unavailable."', APP)
        self.assertIn('Historical imagery · Spring ${selectedImageryYear}', APP)
        self.assertIn('setHistoricalImagerySectionOpen(false)', APP)
        self.assertIn('baseLayers.append(historicalImagerySection)', APP)


if __name__ == "__main__":
    unittest.main()
