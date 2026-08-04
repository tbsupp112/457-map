"""Convert the August 4 phone GPX survey into provisional map layers.

The raw folder is intentionally temporary. Outputs contain source names and
processing descriptions so the processed GeoJSON remains understandable.
"""

from __future__ import annotations

import json
import math
import statistics
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "Unprocessed GPS Files"
DATA = ROOT / "data"
REF_LAT = 43.3596
REF_LON = -73.8350
M_PER_LAT = 111_132.0
M_PER_LON = 111_320.0 * math.cos(math.radians(REF_LAT))


def read_track(filename: str) -> list[tuple[float, float]]:
    root = ET.parse(SOURCE / filename).getroot()
    return [
        to_xy(float(node.attrib["lon"]), float(node.attrib["lat"]))
        for node in root.iter()
        if node.tag.endswith("trkpt")
    ]


def to_xy(lon: float, lat: float) -> tuple[float, float]:
    return (lon - REF_LON) * M_PER_LON, (lat - REF_LAT) * M_PER_LAT


def to_lonlat(point: tuple[float, float]) -> list[float]:
    return [round(REF_LON + point[0] / M_PER_LON, 7), round(REF_LAT + point[1] / M_PER_LAT, 7)]


def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def mean_point(points: list[tuple[float, float]]) -> tuple[float, float]:
    return statistics.fmean(p[0] for p in points), statistics.fmean(p[1] for p in points)


def median_point(points: list[tuple[float, float]]) -> tuple[float, float]:
    return statistics.median(p[0] for p in points), statistics.median(p[1] for p in points)


def spatially_weighted_center(points: list[tuple[float, float]], cell_size: float = 2.0) -> tuple[float, float]:
    cells: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for point in points:
        cell = math.floor(point[0] / cell_size), math.floor(point[1] / cell_size)
        cells.setdefault(cell, []).append(point)
    occupied_positions = [mean_point(cell_points) for cell_points in cells.values()]
    return mean_point(occupied_positions)


def principal_axis(points: list[tuple[float, float]]) -> tuple[float, float]:
    center = mean_point(points)
    dx = [p[0] - center[0] for p in points]
    dy = [p[1] - center[1] for p in points]
    xx = statistics.fmean(v * v for v in dx)
    yy = statistics.fmean(v * v for v in dy)
    xy = statistics.fmean(a * b for a, b in zip(dx, dy))
    angle = 0.5 * math.atan2(2 * xy, xx - yy)
    axis = math.cos(angle), math.sin(angle)
    return axis if axis[1] >= 0 else (-axis[0], -axis[1])


def smooth(points: list[tuple[float, float]], passes: int = 1) -> list[tuple[float, float]]:
    result = points[:]
    for _ in range(passes):
        if len(result) < 3:
            break
        result = [result[0]] + [
            ((result[i - 1][0] + 2 * result[i][0] + result[i + 1][0]) / 4,
             (result[i - 1][1] + 2 * result[i][1] + result[i + 1][1]) / 4)
            for i in range(1, len(result) - 1)
        ] + [result[-1]]
    return result


def distance_binned_centerline(
    tracks: list[list[tuple[float, float]]],
    spacing: float,
    smooth_passes: int = 1,
) -> list[tuple[float, float]]:
    combined = [point for track in tracks for point in track]
    axis = principal_axis(combined)
    center = mean_point(combined)

    def station(point: tuple[float, float]) -> float:
        return (point[0] - center[0]) * axis[0] + (point[1] - center[1]) * axis[1]

    track_stations = [[station(point) for point in track] for track in tracks]
    low = min(min(values) for values in track_stations)
    high = max(max(values) for values in track_stations)
    count = max(2, math.ceil((high - low) / spacing))
    stations = [low + (high - low) * i / count for i in range(count + 1)]
    half_window = spacing * 0.72
    line = []
    for target in stations:
        per_track = []
        for track, values in zip(tracks, track_stations):
            nearby = [point for point, value in zip(track, values) if abs(value - target) <= half_window]
            if nearby:
                per_track.append(median_point(nearby))
        if per_track:
            line.append(mean_point(per_track))
    if line[0][1] > line[-1][1]:
        line.reverse()
    return rdp(smooth(line, smooth_passes), spacing * 0.28)


def perpendicular_distance(point, start, end) -> float:
    dx, dy = end[0] - start[0], end[1] - start[1]
    if dx == 0 and dy == 0:
        return distance(point, start)
    t = max(0.0, min(1.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)))
    projected = start[0] + t * dx, start[1] + t * dy
    return distance(point, projected)


def rdp(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    if len(points) <= 2:
        return points[:]
    distances = [perpendicular_distance(point, points[0], points[-1]) for point in points[1:-1]]
    if not distances or max(distances) <= tolerance:
        return [points[0], points[-1]]
    split = distances.index(max(distances)) + 1
    return rdp(points[: split + 1], tolerance)[:-1] + rdp(points[split:], tolerance)


def orient(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_cross(a, b, c, d) -> bool:
    return orient(a, b, c) * orient(a, b, d) < 0 and orient(c, d, a) * orient(c, d, b) < 0


def untangle_ring(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    ring = points[:]
    changed = True
    while changed:
        changed = False
        n = len(ring)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            for j in range(i + 2, n):
                if (j + 1) % n == i:
                    continue
                c, d = ring[j], ring[(j + 1) % n]
                if segments_cross(a, b, c, d):
                    ring[i + 1 : j + 1] = reversed(ring[i + 1 : j + 1])
                    changed = True
                    break
            if changed:
                break
    return ring


def simplify_closed(points: list[tuple[float, float]], area_threshold: float = 5.0) -> list[tuple[float, float]]:
    ring = untangle_ring(points)
    while len(ring) > 8:
        areas = []
        for i, point in enumerate(ring):
            prev = ring[i - 1]
            nxt = ring[(i + 1) % len(ring)]
            areas.append(abs(orient(prev, point, nxt)) / 2)
        smallest = min(areas)
        if smallest >= area_threshold:
            break
        ring.pop(areas.index(smallest))
    return untangle_ring(ring)


def closest_point_on_ring(point, ring):
    best_point, best_distance, best_segment = None, math.inf, None
    for index, (start, end) in enumerate(zip(ring, ring[1:] + ring[:1])):
        dx, dy = end[0] - start[0], end[1] - start[1]
        denominator = dx * dx + dy * dy
        t = 0 if denominator == 0 else max(0, min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator))
        candidate = start[0] + t * dx, start[1] + t * dy
        candidate_distance = distance(point, candidate)
        if candidate_distance < best_distance:
            best_point, best_distance, best_segment = candidate, candidate_distance, index
    return best_point, best_distance, best_segment


def closest_point_on_line(point, line):
    best_point, best_distance, best_segment = None, math.inf, None
    for index, (start, end) in enumerate(zip(line, line[1:])):
        dx, dy = end[0] - start[0], end[1] - start[1]
        denominator = dx * dx + dy * dy
        t = 0 if denominator == 0 else max(0, min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator))
        candidate = start[0] + t * dx, start[1] + t * dy
        candidate_distance = distance(point, candidate)
        if candidate_distance < best_distance:
            best_point, best_distance, best_segment = candidate, candidate_distance, index
    return best_point, best_distance, best_segment


def move_toward(start, target, amount):
    total = distance(start, target)
    if total == 0:
        return start
    ratio = min(1.0, amount / total)
    return start[0] + (target[0] - start[0]) * ratio, start[1] + (target[1] - start[1]) * ratio


def line_length(points):
    return sum(distance(a, b) for a, b in zip(points, points[1:]))


def write_collection(relative_path: str, title: str, features: list[dict]) -> None:
    path = DATA / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    content = {"type": "FeatureCollection", "properties": {"title": title}, "features": features}
    path.write_text(json.dumps(content, indent=2) + "\n", encoding="utf-8")


def feature(geometry_type: str, coordinates, properties: dict) -> dict:
    return {"type": "Feature", "properties": properties, "geometry": {"type": geometry_type, "coordinates": coordinates}}


def main() -> None:
    home_raw = read_track("Home_point.gpx")
    pavilion_raw = read_track("Pavilion_point.gpx")
    field_raw = read_track("Front_field_zone.gpx")
    garden_raw = read_track("Garden_cut_through.gpx")
    pavilion_trail_raw = read_track("Pavilion_side_trail.gpx")
    road_down = read_track("New_rd_down.gpx")
    road_up = read_track("New_Road_up.gpx")

    home = spatially_weighted_center(home_raw)
    pavilion = spatially_weighted_center(pavilion_raw)
    field_ring = simplify_closed(field_raw)
    mountain_drive = distance_binned_centerline([road_down, road_up], spacing=6.0, smooth_passes=1)
    garden = distance_binned_centerline([garden_raw], spacing=3.0, smooth_passes=1)
    pavilion_trail = distance_binned_centerline([pavilion_trail_raw], spacing=3.0, smooth_passes=1)

    pavilion_endpoint = min((0, len(pavilion_trail) - 1), key=lambda index: distance(pavilion_trail[index], pavilion))
    pavilion_neighbor = 1 if pavilion_endpoint == 0 else len(pavilion_trail) - 2
    pavilion_intersection = move_toward(pavilion, pavilion_trail[pavilion_neighbor], 5.0)
    pavilion_trail[pavilion_endpoint] = pavilion_intersection

    pavilion_road_endpoint = len(pavilion_trail) - 1 if pavilion_endpoint == 0 else 0
    road_trail_intersection, road_trail_snap_distance, road_segment = closest_point_on_line(
        pavilion_trail[pavilion_road_endpoint], mountain_drive
    )
    pavilion_trail[pavilion_road_endpoint] = road_trail_intersection
    if distance(road_trail_intersection, mountain_drive[road_segment]) > 0.05 and distance(road_trail_intersection, mountain_drive[road_segment + 1]) > 0.05:
        mountain_drive.insert(road_segment + 1, road_trail_intersection)

    garden_endpoint = min((0, len(garden) - 1), key=lambda index: closest_point_on_ring(garden[index], field_ring)[1])
    garden_intersection, garden_snap_distance, field_segment = closest_point_on_ring(garden[garden_endpoint], field_ring)
    garden[garden_endpoint] = garden_intersection
    segment_end = (field_segment + 1) % len(field_ring)
    if distance(garden_intersection, field_ring[field_segment]) > 0.05 and distance(garden_intersection, field_ring[segment_end]) > 0.05:
        field_ring.insert(field_segment + 1, garden_intersection)
        garden_intersection_index = field_segment + 1
    else:
        garden_intersection_index = min(range(len(field_ring)), key=lambda index: distance(field_ring[index], garden_intersection))

    field_center = mean_point(field_ring)
    for offset in (-1, 0, 1):
        index = (garden_intersection_index + offset) % len(field_ring)
        field_ring[index] = move_toward(field_ring[index], field_center, 3.5)
    garden_intersection = field_ring[garden_intersection_index]
    garden[garden_endpoint] = garden_intersection

    write_collection("roads/dirt-roads.geojson", "Dirt roads", [
        feature("LineString", [to_lonlat(p) for p in mountain_drive], {
            "id": "mountain-drive",
            "name": "Mountain Drive",
            "type": "dirt road",
            "status": "work in progress",
            "provisional": True,
            "recorded_on": "2026-08-04",
            "source_files": ["New_rd_down.gpx", "New_Road_up.gpx"],
            "processing": "Equal-pass median centerline in 6 m distance bands; lightly smoothed and simplified. Combined extent retained. A vertex was inserted at the Pavilion Side Trail junction.",
            "length_m": round(line_length(mountain_drive), 1),
            "note": "New/continued dirt road following an older route. Replace when better GPS coverage is available."
        })
    ])

    write_collection("trails/walking-trails.geojson", "Walking trails", [
        feature("LineString", [to_lonlat(p) for p in pavilion_trail], {
            "id": "pavilion-side-trail",
            "name": "Pavilion Side Trail",
            "type": "walking trail",
            "status": "provisional",
            "recorded_on": "2026-08-04",
            "source_files": ["Pavilion_side_trail.gpx"],
            "processing": "Repeated passes consolidated with a median centerline in 3 m distance bands. South endpoint placed 5 m from the Pavilion point along the trail; north endpoint snapped to Mountain Drive.",
            "length_m": round(line_length(pavilion_trail), 1)
        }),
        feature("LineString", [to_lonlat(p) for p in garden], {
            "id": "garden-cut-through",
            "name": "Garden Cut Through",
            "type": "walking trail",
            "status": "provisional",
            "recorded_on": "2026-08-04",
            "source_files": ["Garden_cut_through.gpx"],
            "processing": "Repeated passes consolidated with a median centerline in 3 m distance bands. Field endpoint moved with the local inward zone-edge adjustment so the trail ends cleanly at the boundary.",
            "length_m": round(line_length(garden), 1)
        })
    ])

    write_collection("landmarks/buildings.geojson", "Building landmarks", [
        feature("Point", to_lonlat(home), {
            "id": "home",
            "name": "Home",
            "type": "building",
            "status": "provisional",
            "recorded_on": "2026-08-04",
            "source_files": ["Home_point.gpx"],
            "processing": "Position-weighted center: each occupied 2 m spatial cell counted once, preventing stationary dwell samples from dominating."
        }),
        feature("Point", to_lonlat(pavilion), {
            "id": "pavilion",
            "name": "Pavilion",
            "type": "building",
            "status": "provisional",
            "recorded_on": "2026-08-04",
            "source_files": ["Pavilion_point.gpx"],
            "processing": "Position-weighted center: each occupied 2 m spatial cell counted once, preventing repeated samples from dominating."
        })
    ])

    write_collection("zones/zones.geojson", "Zones", [
        feature("Polygon", [[to_lonlat(p) for p in field_ring + [field_ring[0]]]], {
            "id": "front-field-zone",
            "name": "Front Field Zone",
            "type": "zone",
            "status": "rough / provisional",
            "recorded_on": "2026-08-04",
            "source_files": ["Front_field_zone.gpx"],
            "processing": "Single walked perimeter; small start/finish crossings untangled and low-area GPS jitter removed. Three edge vertices at Garden Cut Through moved 3.5 m inward so the trail ends cleanly at the zone boundary.",
            "note": "Rough test zone; not a surveyed or exact boundary."
        })
    ])

    write_collection("intersections/intersections.geojson", "Confirmed feature intersections", [
        feature("Point", to_lonlat(pavilion_intersection), {
            "id": "pavilion-pavilion-side-trail",
            "name": "Pavilion / Pavilion Side Trail",
            "type": "confirmed intersection",
            "features": ["pavilion", "pavilion-side-trail"],
            "status": "confirmed in person; mapped approximately",
            "map_offset_from_building_m": 5.0,
            "note": "Placed 5 m northeast of the Pavilion point along the trail so the building and intersection symbols remain distinct."
        }),
        feature("Point", to_lonlat(garden_intersection), {
            "id": "garden-cut-through-front-field-zone",
            "name": "Garden Cut Through / Front Field Zone",
            "type": "confirmed intersection",
            "features": ["garden-cut-through", "front-field-zone"],
            "status": "confirmed in person; mapped approximately",
            "local_inward_adjustment_m": 3.5,
            "note": "Trail endpoint and the locally inset zone boundary share this exact coordinate for clean topology."
        }),
        feature("Point", to_lonlat(road_trail_intersection), {
            "id": "mountain-drive-pavilion-side-trail",
            "name": "Mountain Drive / Pavilion Side Trail",
            "type": "confirmed intersection",
            "features": ["mountain-drive", "pavilion-side-trail"],
            "status": "confirmed in person; mapped approximately",
            "snap_adjustment_m": round(road_trail_snap_distance, 1),
            "note": "The trail endpoint and an inserted Mountain Drive vertex share this exact coordinate."
        }),
        feature("Point", to_lonlat(mountain_drive[0]), {
            "id": "mountain-drive-southwest-end",
            "name": "Mountain Drive Southwest Connection",
            "type": "open connection point",
            "features": ["mountain-drive"],
            "status": "adjoining feature not yet mapped",
            "note": "Known connection point at the southwest end of Mountain Drive; the intersecting feature will be added later."
        }),
        feature("Point", to_lonlat(garden[len(garden) - 1 if garden_endpoint == 0 else 0]), {
            "id": "garden-cut-through-open-end",
            "name": "Garden Cut Through Open Connection",
            "type": "open connection point",
            "features": ["garden-cut-through"],
            "status": "adjoining feature not yet mapped",
            "note": "Known connection point at the non-field end of Garden Cut Through; the intersecting feature will be added later."
        })
    ])

    summary = {
        "home": to_lonlat(home),
        "pavilion": to_lonlat(pavilion),
        "mountain_drive_length_m": round(line_length(mountain_drive), 1),
        "pavilion_trail_length_m": round(line_length(pavilion_trail), 1),
        "garden_cut_through_length_m": round(line_length(garden), 1),
        "pavilion_intersection_offset_m": 5.0,
        "road_trail_snap_adjustment_m": round(road_trail_snap_distance, 1),
        "garden_field_snap_adjustment_m": round(garden_snap_distance, 1),
        "garden_zone_inward_adjustment_m": 3.5,
        "field_vertices": len(field_ring),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
