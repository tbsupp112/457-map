# Map Data Layers

Processed map data is organized by the type of feature shown in the layer picker. Coordinates use GeoJSON order: longitude, latitude (`EPSG:4326`). All phone-GPS-derived features are provisional orientation data, not survey data.

## Property

- `property/boundaries.geojson` — Main Parcel and Sliver polygons.
- `property/corners.geojson` — optional named boundary corners.
- `property/powerline-corridor.geojson` — approximate unowned access corridor between the parcels.

## Roads

- `roads/dirt-roads.geojson` — dirt roads, separate from walking trails.
- Mountain Drive combines `New_rd_down.gpx` and `New_Road_up.gpx`. Each pass contributes equally within six-meter distance bands so the noisier pass does not dominate. Status: work in progress; replace when better GPS data is available.

## Trails

- `trails/walking-trails.geojson` — walking-trail centerlines.
- Repeated passes were consolidated into median positions by distance along each trail, then lightly smoothed and simplified.
- The Pavilion-side intersection is placed 5 m northeast of the Pavilion point so the symbols do not overlap. The trail's other endpoint is snapped 1.5 m to Mountain Drive.
- After the owner manually refined Front Field Zone on August 4, Garden Cut Through was trimmed at its first west-to-east crossing of the revised boundary. The trail endpoint, an inserted zone-edge vertex, and the intersection marker share `[-73.8350683, 43.3590097]`; the inserted vertex does not change the owner-edited field shape.

## Landmarks

- `landmarks/buildings.geojson` — central point locations for Home and Pavilion.
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

`tools/process_gps.py` records the original August 4 intake when the seven source GPX files are present in `Unprocessed GPS Files`. It does not reproduce the owner's later manual Front Field boundary edit or the resulting Garden trail trim, and it writes directly over live files; treat it as an intake record rather than rerunning it against the current layers. The raw folder is not required by the published map and can be removed after the outputs are reviewed.
