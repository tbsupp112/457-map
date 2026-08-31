# Repository Working Rules

- Codex may edit and test files in the local working copy.
- Do not run `git push`, publish releases, merge pull requests, change remotes, or modify GitHub repository settings. The owner performs all publishing actions.
- Do not bypass or weaken branch/tag protections.
- Do not access, modify, automate, or request credentials for the private `457-map-backup` repository.
- Use a short-lived `update/YYYY-MM-DD-description` branch for each logical change set once this folder is a Git working copy.
- Keep requested work in `BACKLOG.md` until the owner confirms it on the published site, except for changes with essentially no meaningful failure risk.
- Follow `PUBLISHING.md` for review, rollback, stable-release, and backup procedures.
- Never use or describe the property's former sensitive landmark terminology; the landmark is named `The Barbershop` throughout this repository.

## Map stacking order (bottom to top)

1. **Base and accuracy:** base tiles provide context; the live-location accuracy circle stays below property and route layers.
2. **Ground shading:** outside-property shading is the lowest authored map treatment.
3. **Areas:** zones and corridor fills sit above ground shading but below mapped lines.
4. **Lines:** corridor edges, boundaries, roads, and trails remain visually ordered without covering markers.
5. **Live-location dot:** the blue location dot stays above lines but below interaction targets and every mapped pin.
6. **Interaction targets:** forgiving invisible hit paths sit above visual canvases but below all minor markers and location pins.
7. **Minor markers:** corner dots sit below intersection dots; neither may cover a location pin.
8. **Location pins:** natural landmarks and buildings are the highest mapped markers, so a location pin always wins an overlap.
