# 457 Property Visitor Map

A phone-friendly orientation map showing the approximate 457 Property boundaries and a visitor's live location.

> **Approximate boundary — not a survey.** This map is for orientation only and must not be used for legal, timber, or neighbor-boundary decisions.

## Project layout

- `index.html` — page structure
- `styles.css` — appearance and mobile layout
- `app.js` — map behavior and live location
- `data/boundary.geojson` — validated parcel polygons
- `data/corners.geojson` — optional labeled corner markers
- `vendor/leaflet/` — pinned local copy of the Leaflet map library

The boundary data remains separate from the page so future trails and landmarks can follow the same maintainable pattern.

## Preview locally

The map must be served by a web server; opening `index.html` directly will prevent the browser from loading the GeoJSON files. GitHub Pages is the intended preview and publishing method.

From this folder, run:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000`. Live location will work on the published HTTPS site; phone testing should be done there.

## Imagery

The default basemap is New York State's cached 2022 orthoimagery, approximately 12-inch resolution. USGS Topo is included as an optional reference basemap. Both require attribution, which the map displays automatically.
