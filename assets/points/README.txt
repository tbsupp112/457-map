Point popup photos

Add one JPEG per public point feature using its lowercase feature id:
  assets/points/pavilion.jpg
  assets/points/the-barbershop.jpg

The map checks for the matching file only when that point popup opens. A missing
photo stays invisible. Keep images roughly 1200 px wide or smaller and under
300 KB. Strip EXIF metadata, especially GPS coordinates, before publishing.

Current supported photo targets (stable feature IDs)

Buildings:
  home
  pavilion (has pic)
  cabin (has pic)
  gravel-shed (has pic)
  mystery-shack
  shed (has pic)
  wood-shed (has pic)

Natural landmarks:
  the-barbershop

Intersections:
  pavilion-pavilion-side-trail
  garden-cut-through-front-field-zone
  mountain-drive-pavilion-side-trail
  garden-cut-through-open-end
  field-connector-front-field-zone
  field-connector-main-loop-ext
  main-loop-clearing
  main-loop-driveway
  main-loop-pavilion-side-trail
  mountain-drive-driveway
  beeline-main-loop-ext
  back-cut-through-main-loop-ext

Only these public point popups currently request photos. Routes, trail/road
segments, zones, property corners, and camera sites do not request them.
The '(has pic)' marks the supported JPEG files present in this inventory.
