"""Dependency-free geometry helpers for repeatable GPX intake.

Coordinates are projected into a small local metre grid for processing. Raw
GPX order is preserved unless a manifest explicitly requests pass splitting or
direction normalization.
"""

from __future__ import annotations

import math
import statistics
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence

REF_LAT = 43.3596
REF_LON = -73.8350
M_PER_LAT = 111_132.0
M_PER_LON = 111_320.0 * math.cos(math.radians(REF_LAT))
MPH_TO_MPS = 0.44704

XY = tuple[float, float]


@dataclass(frozen=True)
class TrackPoint:
    x: float
    y: float
    elevation: float | None = None
    time: datetime | None = None

    @property
    def xy(self) -> XY:
        return self.x, self.y


@dataclass
class ParsedGPX:
    path: Path
    segments: list[list[TrackPoint]]
    dropped_speed_points: int
    point_kind: str
    raw_segment_points: list[int]
    raw_segment_lengths: list[float]


@dataclass
class SplitResult:
    legs: list[list[TrackPoint]]
    detected: bool
    candidate_lengths: list[float]
    warning: str | None = None


@dataclass
class CenterlineResult:
    points: list[XY]
    station_spreads: list[float]
    reversed_passes: list[bool]


def to_xy(lon: float, lat: float) -> XY:
    return (lon - REF_LON) * M_PER_LON, (lat - REF_LAT) * M_PER_LAT


def to_lonlat(point: XY) -> list[float]:
    return [
        round(REF_LON + point[0] / M_PER_LON, 7),
        round(REF_LAT + point[1] / M_PER_LAT, 7),
    ]


def distance(a: XY, b: XY) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def mean_point(points: Sequence[XY]) -> XY:
    if not points:
        raise ValueError("Cannot average an empty point collection")
    return statistics.fmean(p[0] for p in points), statistics.fmean(p[1] for p in points)


def median_point(points: Sequence[XY]) -> XY:
    if not points:
        raise ValueError("Cannot find the median of an empty point collection")
    return statistics.median(p[0] for p in points), statistics.median(p[1] for p in points)


def spatially_weighted_center(points: Sequence[XY], cell_size: float = 2.0) -> XY:
    cells: dict[tuple[int, int], list[XY]] = {}
    for point in points:
        cell = math.floor(point[0] / cell_size), math.floor(point[1] / cell_size)
        cells.setdefault(cell, []).append(point)
    return mean_point([mean_point(cell_points) for cell_points in cells.values()])


def occupied_cell_spread(points: Sequence[XY], center: XY, cell_size: float = 2.0) -> float:
    cells: dict[tuple[int, int], list[XY]] = {}
    for point in points:
        cell = math.floor(point[0] / cell_size), math.floor(point[1] / cell_size)
        cells.setdefault(cell, []).append(point)
    radii = sorted(distance(center, mean_point(cell_points)) for cell_points in cells.values())
    if not radii:
        return 0.0
    return radii[min(len(radii) - 1, max(0, math.ceil(len(radii) * 0.68) - 1))]


def principal_axis(points: Sequence[XY]) -> XY:
    center = mean_point(points)
    dx = [point[0] - center[0] for point in points]
    dy = [point[1] - center[1] for point in points]
    xx = statistics.fmean(value * value for value in dx)
    yy = statistics.fmean(value * value for value in dy)
    xy = statistics.fmean(a * b for a, b in zip(dx, dy))
    angle = 0.5 * math.atan2(2 * xy, xx - yy)
    axis = math.cos(angle), math.sin(angle)
    return axis if axis[1] >= 0 else (-axis[0], -axis[1])


def smooth(points: Sequence[XY], passes: int = 1) -> list[XY]:
    result = list(points)
    for _ in range(passes):
        if len(result) < 3:
            break
        result = [result[0]] + [
            (
                (result[index - 1][0] + 2 * result[index][0] + result[index + 1][0]) / 4,
                (result[index - 1][1] + 2 * result[index][1] + result[index + 1][1]) / 4,
            )
            for index in range(1, len(result) - 1)
        ] + [result[-1]]
    return result


def perpendicular_distance(point: XY, start: XY, end: XY) -> float:
    projected, _, _ = closest_point_on_segment(point, start, end)
    return distance(point, projected)


def rdp(points: Sequence[XY], tolerance: float) -> list[XY]:
    points = list(points)
    if len(points) <= 2:
        return points
    distances = [perpendicular_distance(point, points[0], points[-1]) for point in points[1:-1]]
    if not distances or max(distances) <= tolerance:
        return [points[0], points[-1]]
    split = distances.index(max(distances)) + 1
    return rdp(points[: split + 1], tolerance)[:-1] + rdp(points[split:], tolerance)


def orient(a: XY, b: XY, c: XY) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_cross(a: XY, b: XY, c: XY, d: XY) -> bool:
    return orient(a, b, c) * orient(a, b, d) < 0 and orient(c, d, a) * orient(c, d, b) < 0


def segment_intersection(a: XY, b: XY, c: XY, d: XY) -> tuple[XY, float, float] | None:
    rx, ry = b[0] - a[0], b[1] - a[1]
    sx, sy = d[0] - c[0], d[1] - c[1]
    denominator = rx * sy - ry * sx
    if abs(denominator) < 1e-9:
        return None
    qx, qy = c[0] - a[0], c[1] - a[1]
    t = (qx * sy - qy * sx) / denominator
    u = (qx * ry - qy * rx) / denominator
    if -1e-9 <= t <= 1 + 1e-9 and -1e-9 <= u <= 1 + 1e-9:
        return (a[0] + t * rx, a[1] + t * ry), t, u
    return None


def self_intersection_count(points: Sequence[XY], closed: bool = False) -> int:
    segments = list(zip(points, points[1:]))
    if closed and len(points) > 2 and points[0] != points[-1]:
        segments.append((points[-1], points[0]))
    count = 0
    for left_index, (a, b) in enumerate(segments):
        for right_index in range(left_index + 1, len(segments)):
            if abs(left_index - right_index) <= 1:
                continue
            if closed and {left_index, right_index} == {0, len(segments) - 1}:
                continue
            c, d = segments[right_index]
            if segments_cross(a, b, c, d):
                count += 1
    return count


def untangle_ring(points: Sequence[XY]) -> list[XY]:
    ring = list(points)
    if len(ring) > 1 and distance(ring[0], ring[-1]) < 0.01:
        ring.pop()
    changed = True
    while changed:
        changed = False
        for left_index in range(len(ring)):
            a, b = ring[left_index], ring[(left_index + 1) % len(ring)]
            for right_index in range(left_index + 2, len(ring)):
                if (right_index + 1) % len(ring) == left_index:
                    continue
                c, d = ring[right_index], ring[(right_index + 1) % len(ring)]
                if segments_cross(a, b, c, d):
                    ring[left_index + 1 : right_index + 1] = reversed(
                        ring[left_index + 1 : right_index + 1]
                    )
                    changed = True
                    break
            if changed:
                break
    return ring


def signed_ring_area(points: Sequence[XY]) -> float:
    ring = list(points)
    if len(ring) > 1 and distance(ring[0], ring[-1]) < 0.01:
        ring.pop()
    return sum(
        start[0] * end[1] - end[0] * start[1]
        for start, end in zip(ring, ring[1:] + ring[:1])
    ) / 2


def simplify_closed(points: Sequence[XY], area_threshold: float = 5.0) -> list[XY]:
    ring = untangle_ring(points)
    while len(ring) > 8:
        areas = []
        for index, point in enumerate(ring):
            previous = ring[index - 1]
            following = ring[(index + 1) % len(ring)]
            areas.append(abs(orient(previous, point, following)) / 2)
        smallest = min(areas)
        if smallest >= area_threshold:
            break
        ring.pop(areas.index(smallest))
    ring = untangle_ring(ring)
    if signed_ring_area(ring) < 0:
        ring.reverse()
    return ring


def ring_area(points: Sequence[XY]) -> float:
    return abs(signed_ring_area(points))


def line_length(points: Sequence[XY]) -> float:
    return sum(distance(start, end) for start, end in zip(points, points[1:]))


def ring_perimeter(points: Sequence[XY]) -> float:
    ring = list(points)
    if not ring:
        return 0.0
    return line_length(ring) + (0 if distance(ring[0], ring[-1]) < 0.01 else distance(ring[-1], ring[0]))


def cumulative_lengths(points: Sequence[XY]) -> list[float]:
    result = [0.0]
    for start, end in zip(points, points[1:]):
        result.append(result[-1] + distance(start, end))
    return result


def point_at_station(points: Sequence[XY], station: float) -> XY:
    if not points:
        raise ValueError("Cannot station an empty line")
    lengths = cumulative_lengths(points)
    station = max(0.0, min(station, lengths[-1]))
    for index in range(len(points) - 1):
        if station <= lengths[index + 1] or index == len(points) - 2:
            span = lengths[index + 1] - lengths[index]
            ratio = 0.0 if span == 0 else (station - lengths[index]) / span
            return (
                points[index][0] + (points[index + 1][0] - points[index][0]) * ratio,
                points[index][1] + (points[index + 1][1] - points[index][1]) * ratio,
            )
    return points[-1]


def resample_line(points: Sequence[XY], spacing: float) -> list[XY]:
    total = line_length(points)
    if total == 0:
        return [points[0]]
    count = max(1, math.ceil(total / spacing))
    return [point_at_station(points, total * index / count) for index in range(count + 1)]


def closest_point_on_segment(point: XY, start: XY, end: XY) -> tuple[XY, float, float]:
    dx, dy = end[0] - start[0], end[1] - start[1]
    denominator = dx * dx + dy * dy
    ratio = 0.0 if denominator == 0 else max(
        0.0,
        min(1.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator),
    )
    projected = start[0] + ratio * dx, start[1] + ratio * dy
    return projected, distance(point, projected), ratio


def closest_point_on_line(point: XY, line: Sequence[XY]) -> tuple[XY, float, int]:
    best_point, best_distance, best_segment = line[0], math.inf, 0
    for index, (start, end) in enumerate(zip(line, line[1:])):
        candidate, candidate_distance, _ = closest_point_on_segment(point, start, end)
        if candidate_distance < best_distance:
            best_point, best_distance, best_segment = candidate, candidate_distance, index
    return best_point, best_distance, best_segment


def closest_point_on_ring(point: XY, ring: Sequence[XY]) -> tuple[XY, float, int]:
    open_ring = list(ring)
    if len(open_ring) > 1 and distance(open_ring[0], open_ring[-1]) < 0.01:
        open_ring.pop()
    best_point, best_distance, best_segment = open_ring[0], math.inf, 0
    for index, (start, end) in enumerate(zip(open_ring, open_ring[1:] + open_ring[:1])):
        candidate, candidate_distance, _ = closest_point_on_segment(point, start, end)
        if candidate_distance < best_distance:
            best_point, best_distance, best_segment = candidate, candidate_distance, index
    return best_point, best_distance, best_segment


def insert_vertex(line: list[XY], point: XY, segment_index: int, closed: bool = False) -> int:
    if distance(point, line[segment_index]) <= 0.05:
        return segment_index
    next_index = (segment_index + 1) % len(line)
    if distance(point, line[next_index]) <= 0.05:
        return next_index
    line.insert(segment_index + 1, point)
    return segment_index + 1


def move_toward(start: XY, target: XY, amount: float) -> XY:
    total = distance(start, target)
    if total == 0:
        return start
    ratio = min(1.0, amount / total)
    return start[0] + (target[0] - start[0]) * ratio, start[1] + (target[1] - start[1]) * ratio


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _element_point(node: ET.Element) -> TrackPoint:
    try:
        lon = float(node.attrib["lon"])
        lat = float(node.attrib["lat"])
    except (KeyError, ValueError) as error:
        raise ValueError("GPX point is missing a valid latitude or longitude") from error
    elevation = None
    point_time = None
    for child in node:
        if _local_name(child.tag) == "ele" and child.text:
            try:
                elevation = float(child.text)
            except ValueError:
                elevation = None
        elif _local_name(child.tag) == "time":
            point_time = parse_time(child.text)
    x, y = to_xy(lon, lat)
    return TrackPoint(x, y, elevation, point_time)


def _speed_filter(points: Sequence[TrackPoint], max_speed_mps: float) -> tuple[list[TrackPoint], int]:
    if len(points) < 3:
        return list(points), 0
    dropped_indexes: set[int] = set()
    for index in range(1, len(points) - 1):
        previous, point, following = points[index - 1], points[index], points[index + 1]
        if not (previous.time and point.time and following.time):
            continue
        before_seconds = (point.time - previous.time).total_seconds()
        after_seconds = (following.time - point.time).total_seconds()
        skip_seconds = (following.time - previous.time).total_seconds()
        if before_seconds <= 0 or after_seconds <= 0 or skip_seconds <= 0:
            continue
        before_speed = distance(previous.xy, point.xy) / before_seconds
        after_speed = distance(point.xy, following.xy) / after_seconds
        skip_speed = distance(previous.xy, following.xy) / skip_seconds
        detour = distance(previous.xy, point.xy) + distance(point.xy, following.xy)
        direct = max(distance(previous.xy, following.xy), 0.1)
        if (
            before_speed > max_speed_mps
            and after_speed > max_speed_mps
            and skip_speed <= max_speed_mps
            and detour / direct >= 1.5
        ):
            dropped_indexes.add(index)
    return [point for index, point in enumerate(points) if index not in dropped_indexes], len(dropped_indexes)


def read_gpx(path: Path, max_speed_mph: float = 8.0) -> ParsedGPX:
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as error:
        raise ValueError(f"Could not parse GPX file {path.name}: {error}") from error

    raw_segments: list[list[TrackPoint]] = []
    for segment in (node for node in root.iter() if _local_name(node.tag) == "trkseg"):
        points = [_element_point(node) for node in segment if _local_name(node.tag) == "trkpt"]
        if points:
            raw_segments.append(points)
    point_kind = "trkpt"

    if not raw_segments:
        for route in (node for node in root.iter() if _local_name(node.tag) == "rte"):
            points = [_element_point(node) for node in route if _local_name(node.tag) == "rtept"]
            if points:
                raw_segments.append(points)
        point_kind = "rtept"

    if not raw_segments:
        waypoints = [_element_point(node) for node in root.iter() if _local_name(node.tag) == "wpt"]
        if waypoints:
            raw_segments.append(waypoints)
        point_kind = "wpt"

    if not raw_segments:
        raise ValueError(f"GPX file {path.name} contains no trkpt, rtept, or wpt points")

    raw_segment_points = [len(segment) for segment in raw_segments]
    raw_segment_lengths = [track_length(segment) for segment in raw_segments]
    segments: list[list[TrackPoint]] = []
    dropped = 0
    for segment in raw_segments:
        filtered, segment_dropped = _speed_filter(segment, max_speed_mph * MPH_TO_MPS)
        dropped += segment_dropped
        if filtered:
            segments.append(filtered)
    if not segments:
        raise ValueError(f"All points in {path.name} were removed by the speed gate")
    return ParsedGPX(
        path,
        segments,
        dropped,
        point_kind,
        raw_segment_points,
        raw_segment_lengths,
    )


def bridge_segments(
    segments: Sequence[Sequence[TrackPoint]], bridge_cap: float = 15.0
) -> tuple[list[TrackPoint], list[float]]:
    if not segments:
        raise ValueError("Cannot bridge an empty GPX")
    combined = list(segments[0])
    bridges: list[float] = []
    for segment in segments[1:]:
        if not segment:
            continue
        gap = distance(combined[-1].xy, segment[0].xy)
        bridges.append(gap)
        if gap > bridge_cap:
            raise ValueError(
                f"Track-segment bridge is {gap:.1f} m, above the {bridge_cap:.1f} m safety cap"
            )
        combined.extend(segment)
    return combined, bridges


def track_length(points: Sequence[TrackPoint]) -> float:
    return line_length([point.xy for point in points])


def elevation_gain(points: Sequence[TrackPoint]) -> float | None:
    elevations = [point.elevation for point in points]
    if sum(value is not None for value in elevations) < 2:
        return None
    gain = 0.0
    previous = None
    for value in elevations:
        if value is None:
            continue
        if previous is not None and value > previous:
            gain += value - previous
        previous = value
    return gain


def _first_sustained_radial_turn(points: Sequence[TrackPoint], threshold: float) -> int | None:
    start = points[0].xy
    peak_value = 0.0
    peak_index = 0
    for index, point in enumerate(points[1:], 1):
        value = distance(start, point.xy)
        if value > peak_value:
            peak_value = value
            peak_index = index
        elif peak_value - value >= threshold and peak_index >= 2:
            return peak_index
    return None


def _progress_turns(progress: Sequence[float], threshold: float) -> list[int]:
    turns = [0]
    direction = 0
    extreme_value = progress[0]
    extreme_index = 0
    anchor = progress[0]
    for index, value in enumerate(progress[1:], 1):
        if direction == 0:
            if value - anchor >= threshold:
                direction = 1
                extreme_value, extreme_index = value, index
            elif anchor - value >= threshold:
                direction = -1
                extreme_value, extreme_index = value, index
            continue
        if direction > 0:
            if value >= extreme_value:
                extreme_value, extreme_index = value, index
            elif extreme_value - value >= threshold:
                turn_index = max(turns[-1] + 1, index - 1)
                if turn_index > turns[-1]:
                    turns.append(turn_index)
                direction = -1
                extreme_value, extreme_index = value, index
        else:
            if value <= extreme_value:
                extreme_value, extreme_index = value, index
            elif value - extreme_value >= threshold:
                turn_index = max(turns[-1] + 1, index - 1)
                if turn_index > turns[-1]:
                    turns.append(turn_index)
                direction = 1
                extreme_value, extreme_index = value, index
    if turns[-1] != len(progress) - 1:
        turns.append(len(progress) - 1)
    return turns


def split_out_and_back(
    points: Sequence[TrackPoint],
    min_leg_length: float = 15.0,
    reversal_threshold: float = 8.0,
    match_cap: float = 12.0,
    force: bool = False,
) -> SplitResult:
    track = list(points)
    if len(track) < 5:
        return SplitResult([track], False, [track_length(track)])
    turn_index = _first_sustained_radial_turn(track, reversal_threshold)
    if turn_index is None:
        return SplitResult([track], False, [track_length(track)])

    reference = [point.xy for point in track[: turn_index + 1]]
    progress = []
    reference_lengths = cumulative_lengths(reference)
    for point in track:
        projected, _, segment_index = closest_point_on_line(point.xy, reference)
        progress.append(reference_lengths[segment_index] + distance(reference[segment_index], projected))
    turns = _progress_turns(progress, reversal_threshold)
    candidate_legs = [track[start : end + 1] for start, end in zip(turns, turns[1:]) if end > start]
    candidate_lengths = [track_length(leg) for leg in candidate_legs]
    legs = [leg for leg, length in zip(candidate_legs, candidate_lengths) if length >= min_leg_length]
    if len(legs) < 2:
        return SplitResult([track], False, candidate_lengths)

    reference_line = [point.xy for point in legs[0]]
    match_distances = []
    for leg in legs[1:]:
        per_point = [closest_point_on_line(point.xy, reference_line)[1] for point in leg]
        match_distances.append(statistics.median(per_point) if per_point else math.inf)
    if not force and any(value > match_cap for value in match_distances):
        return SplitResult(
            [track],
            False,
            candidate_lengths,
            "Reversal-like shape was retained as one path because its branches do not retrace each other.",
        )
    return SplitResult(legs, True, candidate_lengths)


def point_at_fraction(points: Sequence[XY], fraction: float) -> XY:
    return point_at_station(points, line_length(points) * max(0.0, min(1.0, fraction)))


def normalize_pass_direction(reference: Sequence[XY], candidate: Sequence[XY]) -> tuple[list[XY], bool]:
    fractions = [index / 20 for index in range(21)]
    forward = sum(
        distance(point_at_fraction(reference, fraction), point_at_fraction(candidate, fraction))
        for fraction in fractions
    )
    reversed_candidate = list(reversed(candidate))
    backward = sum(
        distance(point_at_fraction(reference, fraction), point_at_fraction(reversed_candidate, fraction))
        for fraction in fractions
    )
    return (reversed_candidate, True) if backward < forward else (list(candidate), False)


def _nearest_monotonic(
    point: XY, line: Sequence[XY], minimum_station: float
) -> tuple[XY, float, float]:
    lengths = cumulative_lengths(line)
    best_point, best_distance, best_station = line[-1], math.inf, lengths[-1]
    for index, (start, end) in enumerate(zip(line, line[1:])):
        segment_start = lengths[index]
        segment_end = lengths[index + 1]
        if segment_end + 1e-9 < minimum_station:
            continue
        candidate, candidate_distance, ratio = closest_point_on_segment(point, start, end)
        station = segment_start + ratio * (segment_end - segment_start)
        if station < minimum_station and segment_end > segment_start:
            station = minimum_station
            candidate = point_at_station(line, station)
            candidate_distance = distance(point, candidate)
        if candidate_distance < best_distance:
            best_point, best_distance, best_station = candidate, candidate_distance, station
    return best_point, best_distance, best_station


def arc_length_centerline(
    passes: Sequence[Sequence[XY]],
    spacing: float = 3.0,
    smooth_passes: int = 1,
    simplify_tolerance: float = 0.8,
    pass_match_cap: float = 12.0,
) -> CenterlineResult:
    if not passes:
        raise ValueError("A path job needs at least one pass")
    if len(passes) == 1:
        processed = rdp(smooth(passes[0], smooth_passes), simplify_tolerance)
        return CenterlineResult(processed, [0.0] * len(processed), [False])

    reference_index = max(range(len(passes)), key=lambda index: line_length(passes[index]))
    reference = list(passes[reference_index])
    normalized: list[list[XY]] = []
    reversed_flags: list[bool] = []
    for index, current_pass in enumerate(passes):
        if index == reference_index:
            normalized.append(reference)
            reversed_flags.append(False)
        else:
            oriented, reversed_pass = normalize_pass_direction(reference, current_pass)
            normalized.append(oriented)
            reversed_flags.append(reversed_pass)

    stations = resample_line(reference, spacing)
    pass_stations = [0.0 for _ in normalized]
    raw_line: list[XY] = []
    spreads: list[float] = []
    for station_point in stations:
        contributors = [station_point]
        for index, current_pass in enumerate(normalized):
            if index == reference_index:
                continue
            candidate, candidate_distance, station = _nearest_monotonic(
                station_point, current_pass, pass_stations[index]
            )
            if candidate_distance <= pass_match_cap:
                contributors.append(candidate)
                pass_stations[index] = station
        center = median_point(contributors)
        raw_line.append(center)
        spreads.append(statistics.median(distance(point, center) for point in contributors))

    processed = rdp(smooth(raw_line, smooth_passes), simplify_tolerance)
    return CenterlineResult(processed, spreads, reversed_flags)


def trim_track_endpoint_to_point(
    track: Sequence[TrackPoint], target: XY, endpoint: str
) -> tuple[list[TrackPoint], float]:
    points = list(track)
    line = [point.xy for point in points]
    projected, _, segment_index = closest_point_on_line(target, line)
    projected_point = TrackPoint(projected[0], projected[1])
    if endpoint == "end":
        removed = line_length(line[segment_index + 1 :]) + distance(line[segment_index], projected)
        return points[: segment_index + 1] + [projected_point], max(0.0, removed)
    if endpoint == "start":
        removed = line_length(line[: segment_index + 1]) + distance(projected, line[segment_index + 1])
        return [projected_point] + points[segment_index + 1 :], max(0.0, removed)
    raise ValueError("Trim endpoint must be start or end")


def choose_endpoint(line: Sequence[XY], endpoint: str, target: Sequence[XY] | None = None) -> int:
    if endpoint == "start":
        return 0
    if endpoint == "end":
        return len(line) - 1
    if endpoint == "nearest" and target:
        start_distance = closest_point_on_line(line[0], target)[1]
        end_distance = closest_point_on_line(line[-1], target)[1]
        return 0 if start_distance <= end_distance else len(line) - 1
    raise ValueError("Endpoint must be start, end, or nearest")


def endpoint_name(index: int, line: Sequence[XY]) -> str:
    return "start" if index == 0 else "end"


def ray_intersection_with_line(origin: XY, outward: XY, target: Sequence[XY]) -> tuple[XY, float, int] | None:
    best: tuple[XY, float, int] | None = None
    ray_end = origin[0] + outward[0] * 10_000, origin[1] + outward[1] * 10_000
    for index, (start, end) in enumerate(zip(target, target[1:])):
        intersection = segment_intersection(origin, ray_end, start, end)
        if not intersection:
            continue
        point, ray_ratio, _ = intersection
        forward_distance = ray_ratio * 10_000
        if forward_distance < 0:
            continue
        if best is None or forward_distance < best[1]:
            best = point, forward_distance, index
    return best


def extend_endpoint_to_line(
    source: list[XY], endpoint_index: int, target: list[XY], max_extension: float = 15.0
) -> tuple[XY, float, int, bool]:
    endpoint = source[endpoint_index]
    nearest, existing_separation, existing_segment = closest_point_on_line(endpoint, target)
    if existing_separation <= 0.05:
        insert_vertex(target, nearest, existing_segment)
        return endpoint, 0.0, existing_segment, False

    neighbor_index = 1 if endpoint_index == 0 else len(source) - 2
    neighbor = source[neighbor_index]
    length = distance(neighbor, endpoint)
    outward = (endpoint[0] - neighbor[0]) / length, (endpoint[1] - neighbor[1]) / length
    ray_hit = ray_intersection_with_line(endpoint, outward, target)
    used_fallback = False
    if ray_hit:
        point, movement, target_segment = ray_hit
    else:
        point, movement, target_segment = closest_point_on_line(endpoint, target)
        used_fallback = True
    if movement > max_extension:
        raise ValueError(
            f"Required extension is {movement:.1f} m, above the {max_extension:.1f} m safety cap"
        )
    if endpoint_index == 0:
        source.insert(0, point)
    else:
        source.append(point)
    insert_vertex(target, point, target_segment)
    return point, movement, target_segment, used_fallback


def move_endpoint_to_node(
    line: list[XY], endpoint_index: int, node: XY, approach_length: float = 3.0
) -> float:
    original = line[endpoint_index]
    movement = distance(original, node)
    neighbor_index = 1 if endpoint_index == 0 else len(line) - 2
    neighbor = line[neighbor_index]
    tangent_length = distance(neighbor, original)
    if tangent_length == 0:
        if endpoint_index == 0:
            line[0] = node
        else:
            line[-1] = node
        return movement
    outward = (
        (original[0] - neighbor[0]) / tangent_length,
        (original[1] - neighbor[1]) / tangent_length,
    )
    approach = min(approach_length, max(1.0, tangent_length * 0.45))
    control = node[0] - outward[0] * approach, node[1] - outward[1] * approach
    if endpoint_index == 0:
        line[0] = control
        line.insert(0, node)
    else:
        line[-1] = control
        line.append(node)
    return movement


def trim_line_to_ring(
    line: list[XY], endpoint_index: int, ring: list[XY]
) -> tuple[XY, float, int]:
    open_ring = ring[:-1] if len(ring) > 1 and distance(ring[0], ring[-1]) < 0.01 else ring
    source_lengths = cumulative_lengths(line)
    intersections: list[tuple[float, XY, int, int]] = []
    for source_index, (start, end) in enumerate(zip(line, line[1:])):
        segment_length = distance(start, end)
        for ring_index, (ring_start, ring_end) in enumerate(
            zip(open_ring, open_ring[1:] + open_ring[:1])
        ):
            hit = segment_intersection(start, end, ring_start, ring_end)
            if hit:
                point, source_ratio, _ = hit
                station = source_lengths[source_index] + source_ratio * segment_length
                intersections.append((station, point, source_index, ring_index))
    if not intersections:
        raise ValueError("Trim requested, but the source line does not cross the target ring")
    selected = min(intersections, key=lambda item: item[0]) if endpoint_index == 0 else max(
        intersections, key=lambda item: item[0]
    )
    station, point, source_segment, ring_segment = selected
    total = source_lengths[-1]
    movement = station if endpoint_index == 0 else total - station
    if endpoint_index == 0:
        line[:] = [point] + line[source_segment + 1 :]
    else:
        line[:] = line[: source_segment + 1] + [point]
    insert_vertex(open_ring, point, ring_segment, closed=True)
    ring[:] = open_ring
    return point, movement, ring_segment


def closest_distance_between_lines(left: Sequence[XY], right: Sequence[XY]) -> float:
    return min(
        min(closest_point_on_line(point, right)[1] for point in left),
        min(closest_point_on_line(point, left)[1] for point in right),
    )


def enforce_ring_clearance_from_line(
    ring: Sequence[XY], line: Sequence[XY], minimum_clearance: float
) -> tuple[list[XY], float, float]:
    """Move only conflicting ring vertices away from a non-crossing line.

    This is intentionally conservative: it handles a nearby management-zone
    edge, but refuses a true crossing because choosing which polygon arc to
    rebuild would require an owner-directed geometry decision.
    """
    if minimum_clearance <= 0:
        raise ValueError("Clearance must be greater than zero")
    adjusted = list(ring)
    closed_ring = adjusted + [adjusted[0]]
    for line_start, line_end in zip(line, line[1:]):
        for ring_start, ring_end in zip(closed_ring, closed_ring[1:]):
            if segment_intersection(line_start, line_end, ring_start, ring_end):
                raise ValueError(
                    "Line crosses the zone edge; a clearance join cannot choose a polygon arc automatically"
                )

    target = minimum_clearance + 0.2
    original = list(adjusted)
    for _ in range(8):
        changed = False
        for index, current in enumerate(adjusted):
            nearest, separation, _ = closest_point_on_line(current, line)
            if separation >= target:
                continue
            if separation < 1e-6:
                raise ValueError("Zone vertex lies directly on the line; clearance direction is ambiguous")
            scale = (target - separation) / separation
            adjusted[index] = (
                current[0] + (current[0] - nearest[0]) * scale,
                current[1] + (current[1] - nearest[1]) * scale,
            )
            changed = True
        if not changed:
            break

    final_clearance = closest_distance_between_lines(line, adjusted + [adjusted[0]])
    if final_clearance + 1e-6 < minimum_clearance:
        raise ValueError(
            f"Could not establish the requested {minimum_clearance:.1f} m zone clearance; "
            f"computed {final_clearance:.1f} m"
        )
    maximum_movement = max(distance(before, after) for before, after in zip(original, adjusted))
    return adjusted, maximum_movement, final_clearance


def flatten_coordinates(geometry: dict) -> list[list[float]]:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates", [])
    if geometry_type == "Point":
        return [coordinates]
    if geometry_type == "LineString":
        return coordinates
    if geometry_type == "Polygon":
        return [point for ring in coordinates for point in ring]
    if geometry_type == "MultiLineString":
        return [point for line in coordinates for point in line]
    if geometry_type == "MultiPolygon":
        return [point for polygon in coordinates for ring in polygon for point in ring]
    return []


def geometry_vertex_count(geometry: dict) -> int:
    return len(flatten_coordinates(geometry))


def geometry_measure(geometry: dict) -> tuple[str, float]:
    geometry_type = geometry.get("type")
    if geometry_type == "LineString":
        return "length_m", line_length([to_xy(*point) for point in geometry["coordinates"]])
    if geometry_type == "Polygon":
        return "area_m2", ring_area([to_xy(*point) for point in geometry["coordinates"][0]])
    return "none", 0.0


def max_vertex_displacement(old_geometry: dict, new_geometry: dict) -> float:
    old_points = [to_xy(*point) for point in flatten_coordinates(old_geometry)]
    new_points = [to_xy(*point) for point in flatten_coordinates(new_geometry)]
    if not old_points or not new_points:
        return 0.0
    return max(min(distance(point, old) for old in old_points) for point in new_points)
