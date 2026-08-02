# 457 Property Visitor Map — Backlog

Organized by intended timing rather than numeric priority. Within each section, items are roughly ordered by likely implementation sequence. Move an item to **Completed** only after the implementation has been verified live.

## Now

- **Confirm the corrected powerline corridor live.** The southern connector now runs directly from `SL_SCorner` to `MP_WCorner`, with the remaining edges following parcel vertices. The corridor has a light-gray treatment and explains on desktop hover or mobile tap: “National Grid powerline cut — not our land, but access is allowed.” Confirm the shape and that mobile shows only one explanation popup.
- **Confirm the outside-area hatching live.** Owned parcels remain clear while a limited surrounding area has a subtle dark-orange tint and diagonal dashed hatching. Confirm that it is distinct but not aggressive on both aerial and topo views.
- **Update parcel popup descriptions.** Sliver: “0.8 acres, across powerline corridor — no road access.” Main Parcel: “Primary 18.2 acre parcel off Gailey Hill Road. Boundary is approximate, but fairly accurate. Borders currently not consistently posted.”
- **Confirm the landing page and map navigation live.** The root URL now opens a mostly open, responsive home page with a Main Parcel-shaped Property Map link. The map has a floating Home link on phone and desktop. Keep here until both directions are confirmed on the published site.

## Soon

- **Refine parcel labels and acreage display.** Reduce how much imagery the permanent labels obscure. Likely make visibility respond to zoom while keeping parcel details available by tapping/clicking.
- **Expand responsive navigation when more destinations exist.** The current map has a floating Home link. Consider a minimal mobile bottom bar once Info or other destinations are added; adapt navigation appropriately for desktop rather than maintaining a separate site.
- **Add verified outbuildings and key landmarks.** Keep these in a separate data file so they can be updated without changing the map code. Owner can provide name, type, coordinates, notes, and any accuracy/source context.
- **Add recorded trails when reliable data is available.** Accept a walked GPS track (GPX preferred), convert it to GeoJSON, and establish the repeatable add-a-trail process before adding many trails.

## Later

- **Device-specific location recovery help.** When location fails, provide brief instructions suited to the visitor's device/browser without cluttering the normal experience.
- **Map information / legend.** Probably an Info button opening a collapsible panel or separate view. Explain owned fill, approximate boundary line, GPS accuracy circle, and the unowned corridor. Exact presentation is still undecided.
- **Extend the corridor/walking-path context farther along the powerline.** Add only after the owner supplies a GPS track or enough coordinates to avoid guessing the path or corridor extent.
- **Visitor-added observation points.** Let a visitor drop a point and add a note for an animal sighting, fallen tree, or similar observation. Local-only storage is easy but remains on that device; sending it to the owner requires a deliberate sharing or backend approach. A “drop point + note + Share” workflow may be the simplest privacy-conscious version.
- **Permanent QR/signage.** Generate a static QR that directly encodes the final GitHub Pages URL—no redirect or expiring QR service. Print the URL beneath it as a fallback.
- **Protected GitHub workflow.** Protect the live branch and, if useful, connect Codex only to this repository so future changes remain reviewable and recoverable.

## Completed

### 2026-08-02

- **Approximate parcel boundaries.** Main Parcel and Sliver load from separate validated GeoJSON, with clear owned-area styling and the required not-a-survey notice.
- **Mobile live location.** User-initiated Find me flow, continuous high-accuracy updates, visible location dot, and GPS accuracy circle. Confirmed working in Safari by the owner.
- **Aerial and topo basemaps.** NYS 2022 orthoimagery is the default; OpenTopoMap is the optional topo view. Both confirmed live.
- **Optional corner markers.** Labeled corner-point layer confirmed live.
