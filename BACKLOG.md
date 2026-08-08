# 457 Property Visitor Map — Backlog

Organized by intended timing rather than numeric priority. Within each section, items are roughly ordered by likely implementation sequence. Move an item to **Completed** only after the implementation has been verified live.

## Now

- **Confirm the August 7 annotated map refinements live.** Driveway and Mountain Drive names should appear on desktop hover; route and landmark hit targets should be easier to acquire without interfering with nearby features; clickable map features should receive a subtle hover emphasis; active landmark guidance should visibly pulse around its destination; and route popups should show the standard green-circle/blue-square/diamond difficulty mark plus length in feet below 0.15 mile or miles otherwise. Confirm that Main Loop Ext now appears as one consolidated out-and-back centerline and that Mountain Drive joins the unchanged driveway alignment cleanly.
- **Confirm the August 5 GPX intake pipeline and map additions live.** The manifest-driven tool, safety tests, candidate QA report, new trails and driveway, owner-confirmed shared clearing, clean Main Loop/driveway connection, field-zone clearance, Shooting Range landmark, easy Main Loop Route, home route list, and reusable `?feature=` map focus are implemented in the local publishing package. Pre-promotion target backups remain in the ignored candidate area. Keep here until the geometry, route link, landmark, and phone/desktop presentation are confirmed on the published site.
- **Confirm the processed GPS feature layers live.** Mountain Drive remains a provisional dirt road; the two walking trails use unhaloed light-blue dashes; Home and Pavilion use green building pins; Front Field is a subtle dotted/shaded zone; and the owner confirmed that the optional intersection markers display correctly when their layer is selected. Confirm the Pavilion symbol separation, Mountain Drive/Pavilion Side Trail join, newly inset Garden/field junction, and all endpoint positions on phone and desktop.
- **Confirm the corrected powerline corridor live.** The southern connector now runs directly from `SL_SCorner` to `MP_WCorner`, with the remaining edges following parcel vertices. The corridor has a light-gray treatment and explains on desktop hover or mobile tap: “National Grid powerline cut — not our land, but access is allowed.” Confirm the shape and that mobile shows only one explanation popup.
- **Confirm the revised outside-area hatching live.** Owned parcels and the powerline corridor remain clear while a limited surrounding area is lightly brightened with darker orange diagonal dashes. Confirm that the outside area is distinct without looking off-limits on both aerial and topo views.
- **Update parcel popup descriptions.** Sliver: “0.8 acres, across powerline corridor — no road access.” Main Parcel: “Primary 18.2 acre parcel off Gailey Hill Road. Boundary is approximate, but fairly accurate. Borders currently not consistently posted.”
- **Confirm the cleaned-up landing page and map controls live.** Desktop home content is centered and the unnecessary footer warning is removed. On the map, Home, Info, Layers, and Locate use a compact icon layout; the Layers icon remains visible while its panel opens to the left; and the disclaimer appears only through Info and closes by X, outside tap, or Escape. Keep here until phone and desktop are confirmed on the published site.
- **Confirm map interaction refinements live.** The Main Parcel description now uses a true line-only tap target and should never open from the parcel interior. Rapid double-taps on a trail, zone, or other feature should zoom without also opening its popup. The owner confirmed the zoom level, double-tap zoom, and saved layer/view settings; a Layers-panel button now resets the map to the simple default view.

## Soon

- **Refine parcel labels and acreage display.** Reduce how much imagery the permanent labels obscure. Likely make visibility respond to zoom while keeping parcel details available by tapping/clicking.
- **Expand responsive navigation when more destinations exist.** The current map has a floating Home link. Consider a minimal mobile bottom bar once Info or other destinations are added; adapt navigation appropriately for desktop rather than maintaining a separate site.
- **Expand verified outbuildings and key landmarks.** Home and Pavilion are the first provisional point landmarks. Add others in the same layer with name, type, coordinates, notes, and accuracy/source context.
- **Expand the trail and intersection network.** The repeatable GPX-to-GeoJSON process and hidden intersection dataset now exist. Add trails and confirmed intersections only when their real locations are sufficiently reliable.

## Later

- **Switch landmark distances to miles at the half-mile mark.** The landmark popup and guidance pill currently show feet at all distances. Once a distance reaches 0.5 miles (2,640 ft), display it in miles instead, rounded coarsely in keeping with the rest of the map's approximate phrasing. Feet remain correct below that threshold.
- **Re-center on the property when opening the map from far away.** Arriving at the map while off-property — for example while travelling — restores the saved view, which can leave the property off screen and hard to find. Reset to default already fixes this manually, but it lives inside the Layers panel and also discards the chosen base map and layer visibility, so it is a heavier tool than the problem needs. Narrowest useful version: **on map load only**, if no part of the property is in view, fit the property bounds; otherwise change nothing. No new control, and it can never interfere on-property because the property is always in view there. Reset to default remains the manual escape hatch.
- **Device-specific location recovery help.** When location fails, provide brief instructions suited to the visitor's device/browser without cluttering the normal experience.
- **Map information / legend.** Probably an Info button opening a collapsible panel or separate view. Explain owned fill, approximate boundary line, GPS accuracy circle, and the unowned corridor. Exact presentation is still undecided.
- **Extend the corridor/walking-path context farther along the powerline.** Add only after the owner supplies a GPS track or enough coordinates to avoid guessing the path or corridor extent.
- **Replace Mountain Drive with stronger GPS coverage.** Current line combines one uphill and one downhill pass and is intentionally marked provisional/work in progress.
- **Visitor-added observation points.** Let a visitor drop a point and add a note for an animal sighting, fallen tree, or similar observation. Local-only storage is easy but remains on that device; sending it to the owner requires a deliberate sharing or backend approach. A “drop point + note + Share” workflow may be the simplest privacy-conscious version.
- **Permanent QR/signage.** Generate a static QR that directly encodes the final GitHub Pages URL—no redirect or expiring QR service. Print the URL beneath it as a fallback.
- **Optional per-sign QR visit log in Google Sheets.** Give each sign a distinct URL/ID and use a small Google Apps Script endpoint to append visits to a private Sheet. Easy default fields: timestamp, sign ID, destination page, browser/device category, language, screen size, timezone, and referrer when available. Precise GPS would remain optional and permission-based. Before implementation, decide what notice visitors see, how long records are kept, and how to reduce bot/link-preview false positives; the public page must not contain a secret that grants Sheet access.

## Completed

### 2026-08-02

- **Approximate parcel boundaries.** Main Parcel and Sliver load from separate validated GeoJSON, with clear owned-area styling and the required not-a-survey notice.
- **Mobile live location.** User-initiated Find me flow, continuous high-accuracy updates, visible location dot, and GPS accuracy circle. Confirmed working in Safari by the owner.
- **Aerial and topo basemaps.** NYS 2022 orthoimagery is the default; OpenTopoMap is the optional topo view. Both confirmed live.
- **Optional corner markers.** Labeled corner-point layer confirmed live.

### 2026-08-03

- **Protected, user-controlled GitHub workflow.** The owner created a stable pre-access release, protected the live branch, and created a separate private backup repository. Direct work-account connector access is not assumed; local changes are reviewed and published by the owner, with stable releases and isolated backup ZIPs used for recovery.
