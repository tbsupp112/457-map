"""Exercise the shared distance labels against boundaries and authored segments."""

from __future__ import annotations

import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js is required for distance runtime checks")
class DistanceRuntimeTests(unittest.TestCase):
    def run_javascript(self, checks: str) -> None:
        bootstrap = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = process.argv[1];
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'route-details.js'), 'utf8'), context);
const api = context.window.RouteDetails;
"""
        result = subprocess.run(
            [shutil.which("node"), "-e", bootstrap + checks, str(ROOT)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_route_and_live_cutoffs_keep_exact_boundary_comparison(self) -> None:
        self.run_javascript(r"""
assert.equal(api.formatDistance(527.99), '176 yd');
assert.equal(api.formatDistance(528), '0.10 mi');
const live = { approximate: true, milesThresholdFeet: 792 };
assert.equal(api.formatDistance(791.99, live), 'about 260 yd');
assert.equal(api.formatDistance(792, live), 'about 0.15 mi');
assert.equal(api.distanceLabel({length_ft: 300, shape: 'out-and-back'}), '100 yd round trip');
assert.equal(api.formatDistance(14.99, {...live, hereThresholdFeet: 15}), "you're here");
assert.equal(api.formatDistance(15, {...live, hereThresholdFeet: 15}), 'about 5 yd');
""")

    def test_invalid_lengths_do_not_become_zero_or_negative_distances(self) -> None:
        self.run_javascript(r"""
for (const value of [null, undefined, '', ' ', NaN, Infinity, -1, 'bad', true, []]) {
  assert.equal(api.formatDistance(value), '', String(value));
}
assert.equal(api.formatDistance(0), '0 yd');
assert.equal(api.distanceLabel({}), '');
assert.equal(api.distanceLabel(null), '');
assert.equal(api.segmentDistanceLabel({geometry: {type: 'LineString', coordinates: [null, [0, 0]]}}), '');
assert.equal(api.segmentDistanceLabel({}), '');
""")

    def test_short_segments_with_meter_lengths_and_powerline_miles(self) -> None:
        self.run_javascript(r"""
const trails = JSON.parse(fs.readFileSync(path.join(root, 'data/trails/walking-trails.geojson'), 'utf8')).features;
const byId = new Map(trails.map(feature => [feature.properties.id, feature]));
assert.equal(api.segmentDistanceLabel(byId.get('pavilion-side-trail')), '47 yd');
assert.equal(api.segmentDistanceLabel(byId.get('garden-cut-through')), '28 yd');
assert.equal(api.segmentDistanceLabel(byId.get('powerline-trail')), '0.74 mi');
for (const feature of trails) assert.match(api.segmentDistanceLabel(feature), /(?: yd| mi)$/);
const geometryOnly = {geometry: {type: 'LineString', coordinates: [[0, 0], [0, 0.0001]]}};
assert.equal(api.segmentDistanceLabel(geometryOnly), '12 yd');
""")

    def test_route_metrics_and_vertical_elevation_units_are_preserved(self) -> None:
        self.run_javascript(r"""
function element() {
  return { children: [], attrs: {}, classList: {add() {}},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attrs[key] = value; },
    get childElementCount() { return this.children.length; } };
}
context.document = {createElement: element, createElementNS: element};
const feature = {properties: {length_m: 30.48, elevation_profile_ft: [100, 120], elevation_gain_ft: 20, elevation_loss_ft: 0},
  geometry: {type: 'LineString', coordinates: [[0, 0], [0, 0.0001]]}};
const route = api.deriveRouteMetrics({id: 'example', name: 'Example', shape: 'out-and-back', segments: ['a']}, new Map([['a', feature]]));
assert.equal(route.length_ft, 200);
assert.equal(route.elevation_gain_ft, 20);
assert.equal(route.elevation_loss_ft, 20);
const {details} = api.createPanel(route);
const nodes = [];
function walk(node) { nodes.push(node); (node.children || []).forEach(walk); }
walk(details);
assert.ok(nodes.some(node => node.textContent === '67 yd round trip'));
assert.ok(nodes.some(node => node.textContent === '120 ft'));
assert.ok(nodes.some(node => /\+20 ft/.test(node.innerHTML || '')));
assert.ok(nodes.some(node => /20 ft/.test(node.innerHTML || '')));
assert.ok(nodes.some(node => /100 to 120 feet/.test(node.attrs['aria-label'] || '')));
""")


if __name__ == "__main__":
    unittest.main()
