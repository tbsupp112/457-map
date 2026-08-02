# 457 Property Visitor Map — Backlog

Organized by intended timing rather than numeric priority. Within each section, items are roughly ordered by likely implementation sequence. Move an item to **Completed** only after the implementation has been verified.

## Now

- **Expand and shade the powerline-corridor gap.** Make the full approximate area between the Main Parcel and Sliver interactive, with a light gray fill and a visually distinct border. Hover on desktop or tap on mobile should explain: “National Grid powerline cut — not our land, but access is allowed.” Do not imply that the corridor edges have been surveyed.
- **Reverse the parcel emphasis.** Keep the owned parcels visually clear and lightly dim a limited surrounding area instead of tinting the parcel interiors. The corridor needs a separate gray treatment so it remains distinguishable from both owned and other unowned land.
- **Update parcel popup descriptions.** Sliver: “0.8 acres, across powerline corridor — no road access.” Main Parcel: “Primary 18.2 acre parcel off Gailey Hill Road. Boundary is approximate, but fairly accurate. Borders currently not consistently posted.”

## Soon

- **Refine parcel labels and acreage display.** Reduce how much imagery the permanent labels obscure. Likely make visibility respond to zoom while keeping parcel details available by tapping/clicking.
- **Create a responsive landing/home page.** Make the map the main feature while leaving room for owner-provided information and links to future pages. This would become the QR-code destination. Content and design direction still need to be defined.
- **Add responsive navigation.** On mobile, use a minimal bottom bar starting with Home and Info. Adapt the same navigation appropriately for desktop rather than maintaining a separate site.
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
