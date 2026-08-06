*This is a self-contained planning handoff. Everything needed to understand the 457 Property web-map project and create good future Codex specifications is below.*

# 457 Property Visitor Map — Claude Planning Handoff

**Prepared:** 2026-08-04  
**Role for Claude:** product/UX planning and specification support. Do not assume Claude will modify the project directly; produce clear, scoped specs that the owner can give to Codex for implementation.

## 1. Project purpose and the visitor experience to protect

457 Property is an approximately 19-acre Adirondack woodland property near Lake Luzerne, New York. The map is a public, mobile-first orientation tool for friends, family, contractors, and eventually guests arriving through a QR code. The core experience is intentionally simple:

1. A visitor scans a QR code or opens a short link.
2. They land on a small home page and open **Property Map**.
3. They see approximate owned parcels, an explicitly unowned powerline corridor between them, satellite imagery by default, and can choose topo imagery.
4. They may tap the location arrow to show their own live position and accuracy circle.
5. Optional map layers let them view roads, trails, buildings, zones, corners, and intersection points.

The map is for practical orientation, not legal boundary work. It must remain obvious that all boundaries and phone-GPS-derived features are approximate. Visitors should never infer that the cleared utility corridor is owned, that the displayed lines are a survey, or that a location dot is exact.

The target is a pleasant, ordinary map-app experience on iPhone Safari first, while remaining clean on desktop. Zero recurring cost, no app install, no account, no login, and a public GitHub Pages site are deliberate choices. The owner values incremental, testable improvements over clever architecture.

Original target: a useful visitor v1 before guests arrive the week of 2026-09-19. The basic v1 is already useful; current work is refinement and expansion.

## 2. Important property and safety context

- Two owned pieces are mapped: the **Main Parcel** (computed 18.17 acres) and **Sliver** (computed 0.79 acres), for 18.96 acres total.
- A cleared National Grid powerline cut lies between them. It is **not owned** by the property owner. Access is described as allowed in the current map, but its visual extent and exact rights are approximate and not surveyed.
- The current displayed corridor polygon is about **1.72 acres**, but that is only the map’s approximate shaded cut area—not a legal easement or confirmed utility-right-of-way area.
- The property has a house, pavilion/cabin context, developing access routes and walking trails, a front field, a likely seep/wet areas, dead/declining beech hazards, and an active shooting range that fires uphill toward an Upper Region/backstop. Do not map or describe the range, safety zones, trails, or landmarks as exact unless the owner supplies reliable locations and approves public visibility.
- Content such as wifi passwords, codes, alarm details, or sensitive security information must never go on the public site.
- The property overview contains an old acreage phrasing that is not the current map truth: do not repeat “18.84-acre main area plus a sliver.” The validated coordinate geometry is Main 18.17 + Sliver 0.79 = 18.96 acres. The 18.84 figure likely relates to a tax record or total figure and is not a reason to re-derive boundaries.

## 3. What exists today

### Public locations

- Repository: `https://github.com/tbsupp112/457-map`
- GitHub Pages: `https://tbsupp112.github.io/457-map/`
- Current development source: the local `Web Map Interface` folder supplied with this handoff.

The owner performs every GitHub operation. Codex can edit and test the local folder but must not push, merge, alter remotes/settings, weaken protections, or access the private backup repository. The folder may not be a local Git working copy, so do not assume `git status` or branches are available locally.

### Pages and controls

**Home (`index.html`)**

- A deliberately sparse landing page, centered on a single large **Property Map** card using a simplified parcel-shaped SVG.
- The plan is for this to become the property’s small public hub: map remains the highlight, while future non-sensitive information pages can be added without redesigning the whole site.

**Map (`map.html`, `app.js`, `styles.css`)**

- Full-screen Leaflet map.
- Mobile and desktop use the same underlying experience, with CSS positioning differences rather than separate products.
- Home, Info, Layers, and Locate controls are compact icon buttons on the top-right; zoom remains on the upper-left.
- The Info button opens a dismissible approximate-boundary/not-a-survey overlay. It closes with X, a click/tap outside, or Escape.
- Locate is user-initiated. It starts with a practical quick fix and then watches high-accuracy position; it renders a blue location dot plus an accuracy circle. The owner has confirmed it works in Safari after granting permission.
- Location errors use short recovery wording. Do not show a separate accuracy-text bubble after a location fix; the accuracy circle itself is sufficient.
- Desktop controls are spaced evenly; Layers opens to the left and retains a visible Layers icon while expanded. This behavior was explicitly requested and matters on both phone and desktop.
- Native double-click zoom is enabled. A small mobile touch handler also recognizes a very rapid double tap (250 ms / 24 px threshold) and zooms one level. It suppresses a feature popup during that deliberate zoom gesture, so double-tapping a trail or zone does not both zoom and open information.
- Maximum zoom is 21. The imagery may be enlarged/pixelated beyond native tile resolution; this is acceptable for now because a closer view is useful once richer map data exists.

### Basemaps

- Default: NYS 2022 orthoimagery WMS tiles, with required attribution.
- Optional: OpenTopoMap.
- Both are switchable via Leaflet’s Layers control. No Google tiles are used.
- The default aerial/tile and topo styles must continue to include attribution.

### Boundary and corridor experience

- Owned Main Parcel and Sliver polygons use a consistent green outline/fill. Permanent parcel labels display names and computed acres.
- A dark halo improves visibility of owned boundary lines over aerial imagery.
- The surrounding non-owned area is subtly brightened and patterned with orange diagonal dashes. This is intentionally distinguishable but should not look more “off limits” than the powerline cut.
- The powerline corridor is a separate light-gray dashed/fill polygon. It shows a brief desktop hover tooltip and a mobile/desktop popup: it is not owned, access is allowed, and its edges are approximate/not surveyed.
- Main Parcel details must open **only when the actual boundary is clicked/tapped**, not from the parcel interior. This is implemented by keeping the visible Main polygon noninteractive and building a separate transparent `LineString` tap target from its boundary ring. Sliver retains a transparent polygon interaction target because its popup is less disruptive.
- Current popup copy:
  - Main: “Primary 18.2 acre parcel off Gailey Hill Road. Boundary is approximate, but fairly accurate. Borders currently not consistently posted.”
  - Sliver: “0.8 acres, across powerline corridor — no road access.”

### Layers and default settings

The Layers control offers:

- NYS aerial (default base)
- Topo map
- Corner markers (off by default)
- Dirt roads (on)
- Walking trails (on)
- Landmarks/buildings (on)
- Zones (on)
- Intersections (off by default)

The user explicitly likes preserved state. The chosen base map, layer visibility, center, and zoom are stored in browser `localStorage`, so a Home → Property Map round trip in the same browser/device returns to the recent view. This should be the standard behavior for new layers. It is intentionally not a cross-device or account-based setting.

The bottom of the Layers panel contains **Reset to default**, which restores aerial imagery, the normal property view, roads/trails/landmarks/zones shown, and corners/intersections hidden. It should remain a simple layperson default; refinement later is expected.

## 4. Data model and current mapped features

All data is GeoJSON in longitude/latitude order (`EPSG:4326`). Do not hardcode geographic features into HTML or JavaScript. A new map layer should normally mean a new appropriately named data file plus a small, clear loader/styling change—not copied coordinate arrays inside application code.

### Data organization

```
data/
  property/
    boundaries.geojson
    corners.geojson
    powerline-corridor.geojson
  roads/
    dirt-roads.geojson
  trails/
    walking-trails.geojson
  landmarks/
    buildings.geojson
    [future natural-landmarks.geojson, misc-landmarks.geojson only when needed]
  zones/
    zones.geojson
  intersections/
    intersections.geojson
```

`data/README.md` is the human-readable data guide and should be updated if a processing method or layer convention changes.

### Current visual conventions

- **Owned parcel boundary:** bright green solid line with dark halo; subtle green fill.
- **Powerline corridor:** light gray dashed outline and subtle gray fill; no orange hatching inside it.
- **Outside surrounding area:** subtle pale treatment with darker orange diagonal dashes.
- **Dirt roads:** warm tan/orange solid line with a dark halo. Separate from trails.
- **Walking trails:** unoutlined light/medium blue dashes. No dark halo.
- **Zones:** subtle pale-yellow fill and dotted yellow edge. Zones are conceptual/management areas, not routes or legal boundaries.
- **Buildings:** green supplied pin image, 20×27 px, taller than intersection dots but deliberately not large.
- **Intersections:** small purple circle with a white border. Optional/hidden by default.
- **Corners:** optional small white/dark point markers with labels.

### Existing features and their confidence

**Property boundaries**

- Derived from Warren County zoning-document corner coordinates supplied by the owner and validated earlier: ring closure, orientation, self-intersection, acreage, and corridor gap checks passed.
- They are still orientation-grade approximate boundaries, not a survey. Do not re-derive or casually edit these coordinates.

**Mountain Drive** (`data/roads/dirt-roads.geojson`)

- A provisional dirt road being built/continued along an old route.
- Created from one uphill and one downhill phone-GPS pass; the current line is useful but should be replaced when better coverage exists.
- The route is intentionally a road layer rather than walking-trail layer.

**Pavilion Side Trail and Garden Cut Through** (`data/trails/walking-trails.geojson`)

- Both are provisional walking-trail centerlines built from repeated phone passes.
- Pavilion Side Trail begins at an intersection offset 5 m northeast of the Pavilion building pin so the building and intersection markers do not overlap; its other end is snapped approximately 1.5 m to Mountain Drive.
- Garden Cut Through ends exactly on the Front Field Zone edge. The zone edge was locally inset by about 7.5 m total at this junction so the trail does not visually/structurally run through the zone. All other Garden trail vertices are outside the zone.

**Buildings** (`data/landmarks/buildings.geojson`)

- Home and Pavilion are point landmarks.
- Each came from walking the building extent rather than dropping one phone pin. The processing uses occupied two-meter spatial cells rather than samples/time, preventing the user pausing in one place from shifting the center.

**Front Field Zone** (`data/zones/zones.geojson`)

- A rough one-pass walking perimeter used as a test of zone representation.
- It is a management/activity zone, not a parcel/boundary claim.

**Intersections** (`data/intersections/intersections.geojson`)

- Three confirmed joins: Pavilion/Pavilion Side Trail; Garden Cut Through/Front Field Zone; Mountain Drive/Pavilion Side Trail.
- Two open connection points: the southwest end of Mountain Drive and the non-field end of Garden Cut Through. They are intentionally recorded even though the adjoining feature is not mapped yet.
- This separate data layer exists to preserve clean topology, future filtering, and possible sign-planning logic. Avoid placing intersection pins perfectly on top of a building landmark; infer a small logical offset along the trail/road if confidence allows, otherwise ask the owner.

## 5. GPS intake and processing workflow

The owner keeps original phone GPS files separately and may place a temporary `Unprocessed GPS Files` folder in the project for an intake. Raw source files are not meant for the public website and should not be committed/uploaded. The repeatable processor is `tools/process_gps.py`.

For the first intake it consumed these GPX sources:

- `New_rd_down.gpx` and `New_Road_up.gpx` → Mountain Drive.
- `Pavilion_side_trail.gpx` → Pavilion Side Trail.
- `Garden_cut_through.gpx` → Garden Cut Through.
- `Home_point.gpx` and `Pavilion_point.gpx` → building center points.
- `Front_field_zone.gpx` → Front Field Zone.

Processing principles implemented in the Python script:

- Works in local-meter coordinates around the property, then returns GeoJSON longitude/latitude.
- Road/trail centerlines: equal-pass median positions in distance bands, light smoothing, Ramer–Douglas–Peucker simplification. This prevents a noisier/longer track from dominating.
- Building centers: one vote per occupied 2 m grid cell, not per timestamp.
- Zones: untangle small self-crossings, remove low-area jitter, keep provisional status.
- Topology: when owner-confirmed features meet, shared coordinates are created and data records document small snapping/offset decisions. Significant changes should be discussed with the owner.

The raw GPX folder has been removed from the current project after processing because the owner maintains an external raw backup. To re-run the processor, the same named source files must temporarily exist in `Unprocessed GPS Files`. If new GPS is substantially better than current data, a Codex spec should say whether it replaces or supplements the feature and how existing confirmed intersections should be retained/recomputed.

Recommended owner input format for future mapping additions: feature name, intended type (road/trail/building/natural landmark/misc landmark/zone/intersection), raw GPX or coordinates, number of passes/direction if relevant, confirmed real-world joins, public/private visibility, and any accuracy caveats. The owner can give normal GPS coordinates; Codex can normalize them.

## 6. Technical architecture: what a Codex implementation must respect

This is a deliberately small static site:

- Plain HTML, CSS, JavaScript; no framework, build step, server, database, or API keys.
- Leaflet 1.9.4 is committed locally in `vendor/leaflet/` so the core map library is not CDN-dependent.
- `app.js` fetches GeoJSON files asynchronously and adds them to Leaflet `L.geoJSON` layers.
- `preferCanvas: true` is used for map paths.
- External map tiles still need internet. Offline/PWA support is deferred, not a current requirement.
- Browser geolocation only works correctly on HTTPS; GitHub Pages provides it.
- `map.html` cache-busts the current `styles.css` and `app.js` with query versions. Increment these when changing either file so the owner does not misdiagnose browser caching as a broken update.

Important implementation details in `app.js`:

- `outsideMaskLayer` uses an SVG even-odd polygon with parcel/corridor holes to render the surrounding-hatch effect.
- `boundaryHalo` and `boundaryLayer` are visible but noninteractive.
- `buildMainBoundaryLine()` converts the Main Parcel polygon ring into a separate transparent `LineString`; `mainBoundaryInteractionLayer` owns the Main Parcel popup. Do not replace this with a transparent polygon, which was tried and still allowed interior taps.
- `sliverInteractionLayer` is the separate transparent polygon popup target for Sliver.
- Map-feature popups on touch devices are delayed slightly. The rapid-double-tap handler cancels them before zooming. Preserve or deliberately revise this interaction as a unit; changing only one side can reintroduce the popup-on-zoom annoyance.
- Persistent settings use the key `457-property-map-preferences-v1`. New layer additions should be added to both `DEFAULT_OVERLAY_VISIBILITY` and the saved `overlays` object, then given a thoughtful default.
- Reset-to-default must update every layer it controls and use the normal property bounds.

### Relevant main files

- `index.html`, `home.css` — sparse public home page.
- `map.html` — map shell, controls, cache-busted CSS/JS references.
- `styles.css` — responsive controls, layer-panel behavior, popup and marker presentation.
- `app.js` — Leaflet setup, basemaps, data loading, state persistence, location, popups, layer reset, interaction behavior.
- `data/**` — feature data.
- `tools/process_gps.py` — GPX processing.
- `BACKLOG.md` — authoritative worklist: do not call work complete until owner confirms it on published GitHub Pages.
- `PUBLISHING.md` and `AGENTS.md` — operating/safety rules.

## 7. Product history and settled decisions

- GitHub Pages was selected over native apps, onX export, and Google My Maps as the primary delivery because visitors get a direct browser map with no install and the owner controls the UI.
- onX export and county tax-parcel GIS routes were dropped; the validated corner-coordinate geometry is the project’s map source.
- NYS aerial imagery and OpenTopoMap are already functional and confirmed by the owner.
- Mobile live location has been confirmed in Safari after permission was granted. VPN/location issues on laptop were expected and are not a map defect.
- QR code should eventually encode the final plain GitHub Pages URL directly. Use a static SVG/high-resolution image, not a redirect/expiring QR provider. Printing is later; no urgent QR work is needed today.
- Future optional per-sign QR visit logging can use distinct URL/sign IDs plus a small Google Apps Script endpoint to a private Google Sheet. It needs a visible privacy notice, retention decision, bot/link-preview filtering, and no secret in the public page. It should not collect precise location without explicit permission. This is long-term only.
- A visitor-added observation point/note feature is later. Local-only storage is easy but device-local; sharing/sending requires a deliberate privacy/backend decision.

## 8. Current backlog and sensible planning opportunities

The current detailed backlog is in `BACKLOG.md`. These are the meaningful next areas for planning, not automatic build instructions:

1. **Confirm recent map refinements on the published site.** The backlog intentionally retains items until the owner verifies live phone and desktop behavior. Current local changes include boundary-only popup targeting, rapid-double-tap popup suppression, Reset to default, and the further-inset Garden/field junction.
2. **Refine permanent parcel labels.** They currently obscure imagery at some zooms. A likely future is zoom-responsive labels while retaining click/tap details.
3. **Home page / visitor information.** Build out a minimal, coherent property hub and perhaps an information panel/page. Keep all content non-sensitive. Safety copy may eventually cover range rules, hazard trees, wet areas, and what guests may explore, but public wording must be owner-approved and not imply surveyed safety boundaries.
4. **Add trustworthy landmarks, roads, trails, zones, and intersections.** This is expected to be ongoing. Preserve data separation and topology discipline.
5. **Responsive navigation.** A mobile bottom bar is deferred until more real destinations exist; the floating Home control is adequate today.
6. **Legend/information design.** The current Info overlay is only a disclaimer. A future expanded legend should explain owned fill, approximate boundary, location accuracy circle, corridor, roads/trails/zones, and possibly intersection symbols without cluttering the map.
7. **Offline/PWA support.** Later, only if real signal problems justify the complexity.
8. **Permanent QR/signage and optional logging.** Later, after destination/content stabilizes.

For a Claude planning response, the most helpful output is likely a prioritized product plan that identifies 1–3 high-value next increments, their visitor benefit, their data/owner inputs, privacy or accuracy risks, and a Codex-ready implementation specification. Avoid making an attractive but broad design vision that requires a rewrite; this project benefits from small upgrades that can be visibly tested and rolled back independently.

## 9. How to write an effective Codex specification for this project

When proposing work for Codex, include:

1. **Outcome and visitor benefit** in plain language.
2. **Scope boundaries:** what must not change (especially existing data, disclaimer, mobile location, or public privacy limits).
3. **Exact UX behavior** on phone and desktop, including default/off states, click/tap behavior, and popup copy.
4. **Data contract:** GeoJSON file path, feature type, expected properties, which layer picker entry it belongs to, and whether it is public/optional/default visible.
5. **Implementation locations:** likely HTML/CSS/JS/data files, without requiring a particular algorithm when the current code can guide the choice.
6. **Acceptance criteria:** concrete phone and desktop checks. Example: “On a phone, a rapid double-tap over the zone increments zoom once and opens no popup; a single tap still opens the zone description.”
7. **Owner inputs/decisions** that are actually required before coding. Ask rather than invent sensitive locations, range zones, labels, access rights, or precision claims.
8. **Publishing scope:** expected files to add/replace/remove, one logical `update/YYYY-MM-DD-description` branch, and live verification before removing backlog items.

Good specifications should favor data-driven additions. For example, adding a new natural landmark should normally be a `data/landmarks/natural-landmarks.geojson` change plus a loader only if no generic natural-landmark loader already exists—not a new HTML element per point.

## 10. Files to provide Claude

Attach or share the current **entire `Web Map Interface` folder**, not just screenshots, if Claude will create coding specifications. At minimum Claude should have:

- This handoff: `PROJECT_HANDOFF_CLAUDE_08.04.26.md`.
- `README.md`, `BACKLOG.md`, `PUBLISHING.md`, `AGENTS.md`.
- `app.js`, `styles.css`, `map.html`, `index.html`, `home.css`.
- The complete `data/` folder and `tools/process_gps.py`.
- `assets/icons/building-pin.webp` if marker presentation is discussed.

Useful external reference files outside the web-map folder:

- `C:\Users\houghtond\Documents\Crap for AI Reference\handoff_457bounds_08.02.26.md` — founding project context, validated boundary background, original constraints, and deferred roadmap. Read fully for boundary, public-map, or safety/QR planning.
- `C:\Users\houghtond\Documents\Crap for AI Reference\457 Property Overview 8.2.26.md` — broader property, safety, ecology, land-management, and naming context. Use for visitor-content, zone, trail, or safety planning; observe the acreage correction noted above.
- `C:\Users\houghtond\Documents\Crap for AI Reference\457GIS.xls` — source/supporting GIS workbook. Do not modify or treat as an authoritative replacement for the current validated GeoJSON without owner direction.
- `C:\Users\houghtond\Documents\Crap for AI Reference\Map_pin_icon_green.svg.webp` — original supplied green building-pin asset, copied into the project as `assets/icons/building-pin.webp`.
- `C:\Users\houghtond\Documents\Crap for AI Reference\756045768_1042188731850203_1622697849043464107_n.jpg` — optional property visual reference; use only if it genuinely helps a design/landmark discussion.

Raw GPX tracks are retained by the owner elsewhere and are not currently in the project. Ask the owner to attach them only for a new mapping intake or a review of GPS processing.

## 11. Questions Claude may raise, and how to handle them

- **Could the map show range areas, routes, or landmarks?** Yes, but request owner-confirmed coordinates and public-display approval first. Do not infer sensitive/safety features from prose.
- **Could the map include more imagery or an alternate GIS layer?** Possibly. The owner’s spouse may have GIS tools/layers. Do not pursue paid imagery or complicated integration unless existing NYS aerial/topo becomes inadequate.
- **Should the site collect visitor data?** Not yet. QR visit logging is a later, explicit privacy/design decision.
- **Could a custom domain or offline app be added?** Both are deferred. The current free GitHub Pages URL is correct for now.
- **Can a feature be called complete when it works locally?** No. Keep it in `BACKLOG.md` until the owner confirms the published GitHub Pages version on relevant devices.

If a requested future feature materially changes public privacy, property-access messaging, safety guidance, hosting, or data collection, clearly surface it as an owner decision instead of assuming permission.
