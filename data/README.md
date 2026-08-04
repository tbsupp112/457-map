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
- Pavilion Side Trail is snapped 3.4 m to the processed Pavilion point.
- Garden Cut Through is snapped 4.6 m to the processed Front Field Zone edge.

## Landmarks

- `landmarks/landmarks.geojson` — central point locations for Home and Pavilion.
- Each occupied two-meter spatial cell from the walked building extent counts once. This prevents time spent standing in one location from biasing the result.

## Zones

- `zones/zones.geojson` — approximate activity/land-use areas rather than routes or legal boundaries.
- Front Field Zone comes from one rough walked perimeter. Small start/finish crossings were untangled and minor GPS jitter removed; the shape remains provisional.

## Intersections

- `intersections/intersections.geojson` — confirmed real-world connections between mapped features.
- This layer is hidden by default. Shared coordinates enforce clean topology and can later support intersection filtering or sign planning.

## Reprocessing

`tools/process_gps.py` reproduces the phone-GPS-derived layers when the seven August 4 GPX files are present in `Unprocessed GPS Files`. The raw folder is not required by the published map and can be removed after the outputs are reviewed.
