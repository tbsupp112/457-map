# 457 Property Visitor Map

A phone-friendly landing page and orientation map showing the approximate 457 Property boundaries and a visitor's live location.

> **Approximate boundary — not a survey.** This map is for orientation only and must not be used for legal, timber, or neighbor-boundary decisions.

## Project layout

- `index.html` — responsive landing page
- `home.css` — landing-page appearance
- `map.html` — interactive map page
- `styles.css` — map appearance, responsive icon controls, and Info overlay
- `app.js` — map behavior and live location
- `BACKLOG.md` — living feature and improvement list
- `PUBLISHING.md` — user-controlled publishing, rollback, and backup procedure
- `AGENTS.md` — durable safety rules for Codex and other coding agents
- `data/` — human-organized GeoJSON layers for property, roads, trails, landmarks, zones, and intersections; see `data/README.md`
- `assets/icons/` — reusable map marker images, currently the green building pin
- `tools/process_gps.py` — repeatable conversion of the August 4 raw GPX survey into provisional feature layers
- `vendor/leaflet/` — pinned local copy of the Leaflet map library

Every mapped feature type remains separate from the page and from unrelated layers, so trails, roads, landmarks, zones, intersections, and property data can be maintained independently.

Publishing remains user-controlled. See `PUBLISHING.md` for the branch, pull-request, rollback, and stable-backup workflow.

## Preview locally

The site must be served by a web server; opening `map.html` directly will prevent the browser from loading the GeoJSON files. GitHub Pages is the intended preview and publishing method.

From this folder, run:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000`. Live location will work on the published HTTPS site; phone testing should be done there.

## Imagery

The default basemap is New York State's cached 2022 orthoimagery, approximately 12-inch resolution. OpenTopoMap is included as an optional reference basemap. Both require attribution, which the map displays automatically.



<!-- Pages rebuild trigger: 2026-08-06 -->
