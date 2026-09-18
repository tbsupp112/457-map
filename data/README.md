# Map Data Layers

Processed map data is organized by the type of feature shown in the layer picker. Coordinates use GeoJSON order: longitude, latitude (`EPSG:4326`). All phone-GPS-derived features are provisional orientation data, not survey data.

## Shared manifest and map audiences

`manifest.json` is the shared inventory used by the map and the Python intake tool. It declares each published data source, path, format, geometry type, required/optional status, id policy, and property names. Map styling, pane order, labels, defaults, and audience presentation remain in `app.js`; those browser-only concerns do not belong in the data manifest.

The map supports `visitor` and `owner` presentation audiences, with `visitor` as the first-load default and `?view=owner` as an opt-in remembered on that device. Public property layers are assigned to both audiences. The owner view also offers the off-by-default Trail cam sites test layer, which contains fake placeholder positions only. Audiences are a presentation convenience, **not a security boundary**: files committed here are publicly downloadable, and anyone can select either view. Data that must remain private must not be added to this repository.

Required source assignment: parcel boundaries, the powerline corridor, the driveway, trails, buildings, and zones. Optional source assignment: corner markers, non-building landmarks, route definitions, and intersections. A missing required source produces one quiet map notice while other sources continue loading; an optional 404 is silent. Malformed content is logged separately from a network failure.

## Feature-property schema

The machine-readable version of this schema is in `manifest.json`. **Authored** properties are the fields an owner may intentionally edit. **Generated** properties come from the GPX intake or geometry calculations and should be regenerated instead of hand-corrected. Optional properties may be omitted; the map must omit or replace the corresponding text rather than display `undefined`.

- **Parcel boundaries:** required `name`, `role`; optional authored `id`, `accuracy`, `note`, `popup_description`; generated `acres_computed`. Boundary ids are not required or validated because parcel behavior keys off `role`.
- **Corner markers:** required/authored `label`, `parcel`; no generated properties and no required id.
- **Powerline corridor:** required/authored `name`, `ownership`, `access`; optional authored `accuracy`; no required id.
- **Roads:** required/authored `id`, `name`, `type`; optional authored `status`, `note`, `provisional`, `condition`; generated `recorded_on`, `source_files`, `source_track_count`, `processing`, `length_m`, `length_ft`, `elevation_gain_ft`, `elevation_loss_ft`, `elevation_profile_ft`.
- **Trail segments:** required/authored `id`, `name`, `type`; optional authored `status`, `note`, `condition`; generated `recorded_on`, `source_files`, `source_track_count`, `processing`, `length_m`, `length_ft`, `elevation_gain_ft`, `elevation_loss_ft`, `elevation_profile_ft`. `condition` is `finished` or `unfinished`; omitted values display as finished for backward compatibility.
- **Routes:** required/authored `id`, `name`, `segments`, `segment_directions`, `shape`, `difficulty`; optional authored `description`, `status`. Length, gain/loss, and the full profile are derived in the browser from member segments and must not be cached in `routes.json`.
- **Buildings:** required/authored `id`, `name`, `type`; optional authored `status`, `note`, `prominence`; generated `recorded_on`, `source_files`, `source_track_count`, `processing`.
- **Other landmarks:** required/authored `id`, `name`, `type`; optional authored `status`, `note`, `prominence`; generated `recorded_on`. `prominence` is `major` or `minor`; omitted values display as minor.
- **Zones:** required/authored `id`, `name`, `type`; optional authored `status`, `note`; generated `recorded_on`, `source_files`, `source_track_count`, `processing`, `acres_computed`.
- **Intersections:** required/authored `id`, `name`, `type`, `features`; optional authored `status`, `note`; generated `recorded_on`, `map_offset_from_building_m`, `snap_adjustment_m`.

Ids must be present and unique across roads, trails, zones, buildings, landmarks, intersections, and routes. Boundary and corner records are intentionally excluded. Segment elevation profiles are arrays of elevation samples in feet; the segment's `length_m` spaces those samples along its centerline. Some older, currently unrouted segments have no elevation profile yet. A route using any elevation-less segment still loads and shows its derived distance, while its elevation panel reports that a profile is unavailable.

Authored `note` values are optional visitor-facing copy. Use them only when a short fact helps someone use the map; keep GPS methods, uncertainty calculations, joins, sample counts, and other provenance in generated fields such as `processing`, `source_files`, `source_track_count`, and `recorded_on`. Empty notes are valid and should produce no filler text in a popup.

`source_track_count` records individual traversals contributing to a consolidated feature, including separately detected outbound and return passes within one GPX file. It is reference metadata only and does not change map behavior or styling. Current inputs are phone GPS. If dedicated GPS data is later mixed in, its weighting should be explicitly stronger than phone data rather than inferred from track count alone.

## Property

- `property/boundaries.geojson` — Main Parcel and Sliver polygons.
- Parcel `id` and `role` values are stable internal identifiers used by interaction code; `name`, descriptions, and other visitor-facing text may be edited without changing either identifier.
- `property/corners.geojson` — optional named boundary corners.
- `property/powerline-corridor.geojson` — approximate unowned access corridor between the parcels.

## Roads

- `roads/driveway.geojson` — the independently labeled Driveway centerline and generated measurements.
- Driveway combines four phone-GPS traversals recorded August 5 and August 10. Its confirmed joins remain unchanged.

## Trails

- Main Loop Ext is an out-and-back recording. Its two directions are split into separate passes and consolidated into one centerline rather than displayed as two nearby trails.
- `trails/walking-trails.geojson` — walking-trail centerlines.
- Repeated passes were consolidated into median positions by distance along each trail, then lightly smoothed and simplified.
- Field Connector combines two phone-GPS files containing eleven complete traversals. `line`, displayed as Beeline, is a straight two-point centerline consolidated from four traversals and joined to The Barbershop and Main Loop Ext. Powerline Trail consolidates the two traversals in one recording; most of it is off-property but accessible.
- Back Cut Through combines four complete traversals and two partial traversals. The partial recordings reinforce only their overlapping section; its eastern endpoint shares a vertex with Main Loop Ext and its western endpoint remains free.
- Mountain Drive is a walking trail split at `[-73.8351907, 43.3596533]`: the lower `mountain-drive` segment is finished and the upper `mountain-drive-upper` segment is unfinished. The two exact endpoints form one continuous route.
- Barbershop Trail extends to the shared landmark coordinate so it meets Beeline without a visible gap. No separate intersection pin is added at that landmark because the symbols would overlap.
- The Pavilion-side intersection is placed 5 m northeast of the Pavilion point so the symbols do not overlap. The trail's other endpoint is snapped 1.5 m to Mountain Drive.
- After the owner manually refined Front Field Zone on August 4, Garden Cut Through was trimmed at its first west-to-east crossing of the revised boundary. The trail endpoint, an inserted zone-edge vertex, and the intersection marker share `[-73.8350683, 43.3590097]`; the inserted vertex does not change the owner-edited field shape.

### Routes and segments

- An `out-and-back` route's displayed length counts its member segments twice, once in each direction.
- Segment elevation profiles are sampled from recorded GPX elevations. The browser assembles each route profile in segment order and derives complete-route gain/loss from the segment totals; for an out-and-back, the profile and totals include the return trip.
- A **segment** is one continuous, actually walked piece of tread. Segments are the only trail data that carries geometry, each has a stable id in `trails/walking-trails.geojson`, and connectors and spurs are segments like any other.
- A **route** is a visitor-facing walk such as an Inner Loop or an out-and-back. It is an ordered list of mapped trail or road feature ids with descriptive attributes in `trails/routes.json`; routes deliberately have no geometry of their own.
- Routes reference segments, never the other way around. A segment may belong to more than one route, while an unassigned connector stays mapped without needing to be presented as a destination.
- Do not merge segment coordinates into route geometry. Map highlighting and labels should work from the route's member ids, so coordinates remain in one hand-editable source.

### Pin separation

- Keep no two pin features within 3 m of one another. When symbols would overlap, use a small logical offset along the associated road or trail so at least a corner of the lower-priority pin remains visible, as was already done for the Pavilion-side intersection.

## Landmarks

- `landmarks/buildings.geojson` — central point locations for mapped buildings.
- Cabin, Gravel Shed, Shed, Wood Shed, and Mystery Shack are approximate building centers derived from walked interior/exterior traces. The low-priority Mystery Shack point deliberately uses position-weighted cells so the minute left at its entrance does not dominate the result.
- `landmarks/landmarks.geojson` — non-building destinations such as the provisional landmark The Barbershop.
- Each occupied two-meter spatial cell from the walked building extent counts once. This prevents time spent standing in one location from biasing the result.
- Major landmarks (Home, Pavilion, and Cabin) appear by default with building pins. Minor landmarks use smaller dots in a separate layer that is off by default; both retain popup guidance and deep-link focus.
- Future natural landmarks and miscellaneous landmarks should use separate GeoJSON files in this folder. Empty placeholder files are intentionally avoided.
- Optional popup photos live in `../assets/points/`. The filename rule is exact and case-sensitive: use the point feature's lowercase id followed by lowercase `.jpg`, with no other extension. No manifest or data edit is needed. Keep photos roughly 1200 px wide or smaller and under 300 KB, and strip all EXIF metadata—especially GPS coordinates—before adding them. Replacing a photo under the same filename may require a browser hard reload because point-photo URLs are deliberately not cache-versioned.
- Current point-photo filenames are:

```text
assets/points/home.jpg
assets/points/pavilion.jpg
assets/points/cabin.jpg
assets/points/gravel-shed.jpg
assets/points/mystery-shack.jpg
assets/points/shed.jpg
assets/points/wood-shed.jpg
assets/points/the-barbershop.jpg
assets/points/main-loop-clearing.jpg
assets/points/main-loop-driveway.jpg
assets/points/main-loop-pavilion-side-trail.jpg
assets/points/mountain-drive-driveway.jpg
assets/points/mountain-drive-pavilion-side-trail.jpg
assets/points/pavilion-pavilion-side-trail.jpg
assets/points/field-connector-front-field-zone.jpg
assets/points/field-connector-main-loop-ext.jpg
assets/points/garden-cut-through-front-field-zone.jpg
assets/points/garden-cut-through-open-end.jpg
```

  `garden-cut-through-open-end.jpg` belongs to the junction displayed as *Garden Cut Through / Main Loop*; its stable feature id intentionally differs from its label.

## Zones

- `zones/zones.geojson` — approximate activity/land-use areas rather than routes or legal boundaries.
- Front Field Zone comes from one rough walked perimeter. Small start/finish crossings were untangled, minor GPS jitter removed, and the owner manually refined the current boundary on August 4; the shape remains provisional.
- Yard Area is withdrawn from publication and retained under sibling `_local/withdrawn/yard-area.geojson` for possible restoration.

## Intersections

- `intersections/intersections.geojson` — confirmed real-world connections between mapped features.
- This layer is hidden by default. Shared coordinates enforce clean topology and can later support intersection filtering or sign planning.
- Superseded open-connection markers are removed when a mapped adjoining feature creates a real shared join, as with Mountain Drive and Driveway.

## Reprocessing

`tools/process_gps.py` is a manifest-driven intake command. It reads one JSON manifest from `tools/intakes/`, validates its inputs and declared joins, and writes deterministic review files only under the sibling `_local/_candidates/` folder outside this publishable web folder. Raw source folders also live under that sibling `_local/` folder. A normal intake run never changes live map data.

Example staging command:

```text
python tools/process_gps.py tools/intakes/2026-08-05-loop-and-driveway.json
```

Review the console report and generated sibling `_local/_candidates/QA-YYYY-MM-DD.md`, compare each processed line with its raw track, and resolve every consolidated warning before promotion. The command reports raw and processed lengths, pass detection, speed-gate drops, elevation, station spread, closure, self-intersections, joins, route membership, and nearby mapped features.

Promotion is always separate and explicit:

```text
python tools/process_gps.py tools/intakes/2026-08-05-loop-and-driveway.json --promote --backup
```

The command first prints an id-by-id diff and asks for confirmation. Promotion merges by stable feature id, preserves untouched live features byte-for-byte, and can place pre-promotion copies under the ignored candidate backup folder. `--yes` is available only with `--promote` and counts as the explicit confirmation for that invocation.

Raw GPX folders, generated candidates, pre-promotion backups, and Python caches stay under the sibling `_local/` folder; they are local intake material rather than published map assets. The tools set Python's no-bytecode mode, and `python tools/run_tests.py` is the standard cache-free regression command. The August 4 manifest is retained as the first worked intake record, but its original raw folder must be restored under sibling `_local/Unprocessed GPS Files/` before that historical regression can run. It also predates the owner's later manual Front Field boundary refinement and must not be used to overwrite that edit.
