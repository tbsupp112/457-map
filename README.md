# Map Data Layers

Processed map data is organized by the type of feature shown in the layer picker. Coordinates use GeoJSON order: longitude, latitude (`EPSG:4326`). All phone-GPS-derived features are provisional orientation data, not survey data.

## Property

- `property/boundaries.geojson` — Main Parcel and Sliver polygons.
- `property/corners.geojson` — optional named boundary corners.
- `property/powerline-corridor.geojson` — approximate unowned access corridor between the parcels.

## Roads

- Mountain Drive's south endpoint is extended to a shared vertex on the otherwise unchanged Driveway centerline, closing the small mapped gap between the two road recordings.
- `roads/dirt-roads.geojson` — dirt roads, separate from walking trails.
- Mountain Drive combines `New_rd_down.gpx` and `New_Road_up.gpx`. Each pass contributes equally within six-meter distance bands so the noisier pass does not dominate. Status: work in progress; replace when better GPS data is available.

## Trails

- Main Loop Ext is an out-and-back recording. Its two directions are split into separate passes and consolidated into one centerline rather than displayed as two nearby trails.
- `trails/walking-trails.geojson` — walking-trail centerlines.
- Repeated passes were consolidated into median positions by distance along each trail, then lightly smoothed and simplified.
- The Pavilion-side intersection is placed 5 m northeast of the Pavilion point so the symbols do not overlap. The trail's other endpoint is snapped 1.5 m to Mountain Drive.
- After the owner manually refined Front Field Zone on August 4, Garden Cut Through was trimmed at its first west-to-east crossing of the revised boundary. The trail endpoint, an inserted zone-edge vertex, and the intersection marker share `[-73.8350683, 43.3590097]`; the inserted vertex does not change the owner-edited field shape.

### Routes and segments

- An `out-and-back` route's displayed length counts its member segments twice, once in each direction.
- A **segment** is one continuous, actually walked piece of tread. Segments are the only trail data that carries geometry, each has a stable id in `trails/walking-trails.geojson`, and connectors and spurs are segments like any other.
- A **route** is a visitor-facing walk such as an Inner Loop or an out-and-back. It is an ordered list of segment ids with descriptive attributes in `trails/routes.json`; routes deliberately have no geometry of their own.
- Routes reference segments, never the other way around. A segment may belong to more than one route, while an unassigned connector stays mapped without needing to be presented as a destination.
- Do not merge segment coordinates into route geometry. Map highlighting and labels should work from the route's member ids, so coordinates remain in one hand-editable source.

### Pin separation

- Keep no two pin features within 3 m of one another. When symbols would overlap, use a small logical offset along the associated road or trail so at least a corner of the lower-priority pin remains visible, as was already done for the Pavilion-side intersection.

## Landmarks

- `landmarks/buildings.geojson` — central point locations for Home and Pavilion.
- `landmarks/landmarks.geojson` — non-building destinations such as the provisional Shooting Range location.
- Each occupied two-meter spatial cell from the walked building extent counts once. This prevents time spent standing in one location from biasing the result.
- Future natural landmarks and miscellaneous landmarks should use separate GeoJSON files in this folder. Empty placeholder files are intentionally avoided.

## Zones

- `zones/zones.geojson` — approximate activity/land-use areas rather than routes or legal boundaries.
- Front Field Zone comes from one rough walked perimeter. Small start/finish crossings were untangled, minor GPS jitter removed, and the owner manually refined the current boundary on August 4; the shape remains provisional.

## Intersections

- `intersections/intersections.geojson` — confirmed real-world connections between mapped features.
- This layer is hidden by default. Shared coordinates enforce clean topology and can later support intersection filtering or sign planning.
- It includes three confirmed joins plus two open connection points whose adjoining features have not yet been mapped.

## Reprocessing

`tools/process_gps.py` is a manifest-driven intake command. It reads one JSON manifest from `tools/intakes/`, validates its inputs and declared joins, and writes deterministic review files only under `data/_candidates/`. A normal intake run never changes live map data.

Example staging command:

```text
python tools/process_gps.py tools/intakes/2026-08-05-loop-and-driveway.json
```

Review the console report and generated `data/_candidates/QA-YYYY-MM-DD.md`, compare each processed line with its raw track, and resolve every consolidated warning before promotion. The command reports raw and processed lengths, pass detection, speed-gate drops, elevation, station spread, closure, self-intersections, joins, route membership, and nearby mapped features.

Promotion is always separate and explicit:

```text
python tools/process_gps.py tools/intakes/2026-08-05-loop-and-driveway.json --promote --backup
```

The command first prints an id-by-id diff and asks for confirmation. Promotion merges by stable feature id, preserves untouched live features byte-for-byte, and can place pre-promotion copies under the ignored candidate backup folder. `--yes` is available only with `--promote` and counts as the explicit confirmation for that invocation.

Raw GPX folders, generated candidates, and Python cache files are excluded by `.gitignore`; they are local intake material rather than published map assets. The August 4 manifest is retained as the first worked intake record, but its original raw folder is not present in this working copy, so that historical regression can run only after those files are restored locally. It also predates the owner's later manual Front Field boundary refinement and must not be used to overwrite that edit.
