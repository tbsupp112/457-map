# 457 Property Visitor Map — Backlog

Organized by intended timing rather than numeric priority. Within each section, items are roughly ordered by likely implementation sequence. Move an item to **Completed** only after the implementation has been verified.

## Now

- No unimplemented items currently. Pick the next item after the corridor update is live and reviewed.

## Soon

- **Refine parcel labels and acreage display.** Reduce how much imagery the permanent labels obscure. Likely make visibility respond to zoom while keeping parcel details available by tapping/clicking.
- **Add verified outbuildings and key landmarks.** Keep these in a separate data file so they can be updated without changing the map code. Owner can provide name, type, coordinates, notes, and any accuracy/source context.
- **Add recorded trails when reliable data is available.** Accept a walked GPS track (GPX preferred), convert it to GeoJSON, and establish the repeatable add-a-trail process before adding many trails.

## Later

- **Device-specific location recovery help.** When location fails, provide brief instructions suited to the visitor's device/browser without cluttering the normal experience.
- **Map information / legend.** Probably an Info button opening a collapsible panel or separate view. Explain owned fill, approximate boundary line, GPS accuracy circle, and the unowned corridor. Exact presentation is still undecided.
- **Permanent QR/signage.** Generate a static QR that directly encodes the final GitHub Pages URL—no redirect or expiring QR service. Print the URL beneath it as a fallback.
- **Protected GitHub workflow.** Protect the live branch and, if useful, connect Codex only to this repository so future changes remain reviewable and recoverable.

## Completed

### 2026-08-02

- **Approximate parcel boundaries.** Main Parcel and Sliver load from separate validated GeoJSON, with clear owned-area styling and the required not-a-survey notice.
- **Mobile live location.** User-initiated Find me flow, continuous high-accuracy updates, visible location dot, and GPS accuracy circle. Confirmed working in Safari by the owner.
- **Aerial and topo basemaps.** NYS 2022 orthoimagery is the default; OpenTopoMap is the optional topo view. Both confirmed live.
- **Optional corner markers.** Labeled corner-point layer confirmed live.
- **Non-intrusive corridor explanation.** Removed the persistent corridor indicator. Hovering the known parcel gap on desktop or tapping it on mobile shows: “National Grid powerline cut — not our land, but access is allowed.” The interaction does not represent surveyed corridor edges.
