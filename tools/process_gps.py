"""Manifest-driven GPX intake with candidate-only output and safe promotion."""

from __future__ import annotations

import argparse
import copy
import json
import math
import re
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from gps_lib import (
    CenterlineResult,
    XY,
    arc_length_centerline,
    bridge_segments,
    choose_endpoint,
    closest_distance_between_lines,
    closest_point_on_line,
    closest_point_on_ring,
    distance,
    elevation_gain,
    enforce_ring_clearance_from_line,
    endpoint_name,
    extend_endpoint_to_line,
    flatten_coordinates,
    geometry_measure,
    geometry_vertex_count,
    insert_vertex,
    line_length,
    max_vertex_displacement,
    mean_point,
    move_endpoint_to_node,
    move_toward,
    occupied_cell_spread,
    rdp,
    read_gpx,
    ring_area,
    ring_perimeter,
    self_intersection_count,
    simplify_closed,
    smooth,
    spatially_weighted_center,
    split_out_and_back,
    to_lonlat,
    to_xy,
    track_length,
    trim_line_to_ring,
    trim_track_endpoint_to_point,
)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CANDIDATES = DATA / "_candidates"
INTERSECTIONS_TARGET = "intersections/intersections.geojson"
ALLOWED_JOB_TYPES = {"point", "path", "zone"}
COMPUTED_FIELDS = {
    "length_m",
    "length_ft",
    "elevation_gain_ft",
    "acres_computed",
    "processing",
    "source_files",
    "recorded_on",
}


@dataclass
class WorkingFeature:
    id: str
    target: str
    feature: dict[str, Any]
    from_job: bool = False
    modified: bool = False


@dataclass
class JobReport:
    id: str
    name: str
    type: str
    inputs: list[str]
    file_lines: list[str] = field(default_factory=list)
    output_lines: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class PipelineResult:
    manifest: dict[str, Any]
    catalog: dict[str, WorkingFeature]
    candidate_features: dict[str, list[dict[str, Any]]]
    candidate_routes: list[dict[str, Any]]
    qa_text: str
    warnings: list[str]
    candidate_contents: dict[Path, str]


def json_text(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def feature(geometry_type: str, coordinates: Any, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {"type": geometry_type, "coordinates": coordinates},
    }


def safe_target(value: str) -> str:
    relative = PurePosixPath(value)
    if relative.is_absolute() or ".." in relative.parts or relative.suffix not in {".json", ".geojson"}:
        raise ValueError(f"Unsafe data target: {value}")
    candidate = (CANDIDATES / Path(*relative.parts)).resolve()
    if CANDIDATES.resolve() not in candidate.parents:
        raise ValueError(f"Target escapes data/_candidates: {value}")
    return relative.as_posix()


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not read manifest {path}: {error}") from error
    if not isinstance(manifest.get("jobs"), list) or not manifest.get("intake_date"):
        raise ValueError("Manifest needs intake_date and a jobs array")
    job_ids: set[str] = set()
    for job in manifest["jobs"]:
        missing = [key for key in ("id", "name", "type", "inputs", "target", "properties") if key not in job]
        if missing:
            raise ValueError(f"Job is missing required fields: {', '.join(missing)}")
        if job["type"] not in ALLOWED_JOB_TYPES:
            raise ValueError(f"Job {job['id']} has unknown type {job['type']!r}")
        if job["id"] in job_ids:
            raise ValueError(f"Duplicate job id: {job['id']}")
        if not isinstance(job["inputs"], list) or not job["inputs"]:
            raise ValueError(f"Job {job['id']} needs at least one input")
        safe_target(job["target"])
        job_ids.add(job["id"])
    return manifest


def load_live_catalog() -> tuple[dict[str, WorkingFeature], dict[str, dict[str, Any]]]:
    catalog: dict[str, WorkingFeature] = {}
    collections: dict[str, dict[str, Any]] = {}
    for path in sorted(DATA.rglob("*.geojson")):
        if CANDIDATES in path.parents:
            continue
        relative = path.relative_to(DATA).as_posix()
        try:
            collection = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"Malformed live GeoJSON {relative}: {error}") from error
        collections[relative] = collection
        for current_feature in collection.get("features", []):
            feature_id = current_feature.get("properties", {}).get("id")
            if feature_id:
                if feature_id in catalog:
                    raise ValueError(f"Duplicate live feature id {feature_id}")
                catalog[feature_id] = WorkingFeature(
                    feature_id,
                    relative,
                    copy.deepcopy(current_feature),
                )
    return catalog, collections


def line_xy(current_feature: dict[str, Any]) -> list[XY]:
    if current_feature["geometry"]["type"] != "LineString":
        raise ValueError(f"Feature {current_feature['properties'].get('id')} is not a line")
    return [to_xy(*point) for point in current_feature["geometry"]["coordinates"]]


def set_line(current_feature: dict[str, Any], points: list[XY]) -> None:
    current_feature["geometry"] = {
        "type": "LineString",
        "coordinates": [to_lonlat(point) for point in points],
    }
    current_feature["properties"]["length_m"] = round(line_length(points), 1)


def ring_xy(current_feature: dict[str, Any]) -> list[XY]:
    if current_feature["geometry"]["type"] != "Polygon":
        raise ValueError(f"Feature {current_feature['properties'].get('id')} is not a ring")
    points = [to_xy(*point) for point in current_feature["geometry"]["coordinates"][0]]
    if len(points) > 1 and distance(points[0], points[-1]) < 0.02:
        points.pop()
    return points


def set_ring(current_feature: dict[str, Any], points: list[XY]) -> None:
    coordinates = [to_lonlat(point) for point in points]
    current_feature["geometry"] = {
        "type": "Polygon",
        "coordinates": [coordinates + [coordinates[0]]],
    }
    current_feature["properties"]["acres_computed"] = round(ring_area(points) / 4046.8564224, 3)


def point_xy(current_feature: dict[str, Any]) -> XY:
    if current_feature["geometry"]["type"] != "Point":
        raise ValueError(f"Feature {current_feature['properties'].get('id')} is not a point")
    return to_xy(*current_feature["geometry"]["coordinates"])


def merge_computed_properties(
    job: dict[str, Any], computed: dict[str, Any], warnings: list[str]
) -> dict[str, Any]:
    supplied = copy.deepcopy(job["properties"])
    for key in COMPUTED_FIELDS:
        if key in supplied and key in computed and supplied[key] != computed[key]:
            warnings.append(
                f"{job['id']}: manifest {key}={supplied[key]!r} disagreed with computed {computed[key]!r}; computed value kept."
            )
    supplied.update(computed)
    supplied = {"id": job["id"], "name": job["name"], **supplied}
    return supplied


def endpoint_index_for_target(source: list[XY], endpoint: str, target: list[XY], ring: bool) -> int:
    if endpoint in {"start", "end"}:
        return 0 if endpoint == "start" else len(source) - 1
    if endpoint != "nearest":
        raise ValueError("Endpoint must be start, end, or nearest")
    distance_function = closest_point_on_ring if ring else closest_point_on_line
    return 0 if distance_function(source[0], target)[1] <= distance_function(source[-1], target)[1] else len(source) - 1


def process_job(
    job: dict[str, Any], source_root: Path, intake_date: str
) -> tuple[WorkingFeature, JobReport]:
    report = JobReport(job["id"], job["name"], job["type"], list(job["inputs"]))
    options = job.get("options", {})
    parsed_files = {}
    tracks_by_name = {}
    bridge_by_name: dict[str, list[float]] = {}
    for filename in job["inputs"]:
        path = source_root / filename
        if not path.is_file():
            raise ValueError(f"Job {job['id']} is missing input file {filename}")
        parsed = read_gpx(path, float(options.get("max_speed_mph", 8.0)))
        parsed_files[filename] = parsed
        report.file_lines.append(
            f"- `{filename}`: {len(parsed.raw_segment_points)} source segment(s); "
            f"raw points {parsed.raw_segment_points}; raw lengths "
            f"{[round(value, 1) for value in parsed.raw_segment_lengths]} m; "
            f"speed cap {float(options.get('max_speed_mph', 8.0)):g} mph; "
            f"speed-gate drops {parsed.dropped_speed_points}."
        )
        if job["type"] == "point":
            tracks_by_name[filename] = [point for segment in parsed.segments for point in segment]
            bridge_by_name[filename] = []
        else:
            combined, bridges = bridge_segments(
                parsed.segments,
                float(options.get("segment_bridge_cap", 15.0)),
            )
            tracks_by_name[filename] = combined
            bridge_by_name[filename] = bridges
            if job["type"] == "path":
                report.file_lines.append(
                    f"  - raw path self-intersections: {self_intersection_count([point.xy for point in combined])}."
                )
            if bridges:
                report.file_lines.append(
                    f"  - trkseg bridge distance(s): {[round(value, 1) for value in bridges]} m."
                )

    trim_spec = options.get("trim_to")
    trim_removed = None
    if trim_spec:
        trim_input = trim_spec["input"]
        reference_input = trim_spec["reference_input"]
        if trim_input not in tracks_by_name or reference_input not in tracks_by_name:
            raise ValueError(f"Job {job['id']} trim_to names an input outside the job")
        reference_track = tracks_by_name[reference_input]
        reference_endpoint = trim_spec.get("reference_endpoint", "end")
        target_point = reference_track[0 if reference_endpoint == "start" else -1].xy
        trimmed, removed = trim_track_endpoint_to_point(
            tracks_by_name[trim_input],
            target_point,
            trim_spec.get("endpoint", "end"),
        )
        tracks_by_name[trim_input] = trimmed
        trim_removed = removed
        report.output_lines.append(
            f"- Trimmed `{trim_input}` by {removed:.1f} m to the `{reference_input}` {reference_endpoint} extent."
        )

    warnings: list[str] = []
    if job["type"] == "point":
        track_points = [point for points in tracks_by_name.values() for point in points]
        raw_xy = [point.xy for point in track_points]
        cell_size = float(options.get("cell_size", 2.0))
        center = spatially_weighted_center(raw_xy, cell_size)
        spread = occupied_cell_spread(raw_xy, center, cell_size)
        computed = {
            "source_files": list(job["inputs"]),
            "recorded_on": job.get("recorded_on", intake_date),
            "processing": f"Position-weighted center; each occupied {cell_size:g} m cell counted once.",
        }
        properties = merge_computed_properties(job, computed, warnings)
        output = feature("Point", to_lonlat(center), properties)
        report.output_lines.extend(
            [
                "- Output vertices: 1.",
                f"- Occupied-cell 68% spread radius: {spread:.1f} m.",
                "- Self-intersections: not applicable.",
            ]
        )

    elif job["type"] == "zone":
        track_points = [point for points in tracks_by_name.values() for point in points]
        raw_xy = [point.xy for point in track_points]
        before_crossings = self_intersection_count(raw_xy, closed=True)
        raw_area = ring_area(raw_xy)
        ring = simplify_closed(raw_xy, float(options.get("area_threshold", 5.0)))
        area = ring_area(ring)
        acres = area / 4046.8564224
        computed = {
            "source_files": list(job["inputs"]),
            "recorded_on": job.get("recorded_on", intake_date),
            "processing": "Walked perimeter; start/finish crossings untangled, low-area jitter removed, ring closed counter-clockwise.",
            "acres_computed": round(acres, 3),
        }
        properties = merge_computed_properties(job, computed, warnings)
        coordinates = [to_lonlat(point) for point in ring]
        output = feature("Polygon", [coordinates + [coordinates[0]]], properties)
        report.output_lines.extend(
            [
                f"- Output vertices: {len(ring) + 1} including closure.",
                f"- Area: {acres:.3f} acres; perimeter: {ring_perimeter(ring):.1f} m.",
                f"- Closure: confirmed; crossings untangled: {before_crossings}; area discarded: {max(0.0, raw_area - area):.1f} m².",
                f"- Self-intersections after processing: {self_intersection_count(ring, closed=True)}.",
            ]
        )

    else:
        passes = []
        leg_gains = []
        detected_leg_counts: dict[str, int] = {}
        split_setting = options.get("split_passes", "auto")
        for filename in job["inputs"]:
            track = tracks_by_name[filename]
            if split_setting is False:
                split = None
                file_legs = [track]
                detected = False
                candidate_lengths = [track_length(track)]
            else:
                split = split_out_and_back(
                    track,
                    float(options.get("min_leg_length", 15.0)),
                    float(options.get("reversal_threshold", 8.0)),
                    float(options.get("pass_match_cap", 12.0)),
                    force=split_setting is True,
                )
                file_legs = split.legs
                detected = split.detected
                candidate_lengths = split.candidate_lengths
                if split.warning:
                    report.warnings.append(f"{filename}: {split.warning}")
            lengths = [track_length(leg) for leg in file_legs]
            detected_leg_counts[filename] = len(file_legs)
            report.file_lines.append(
                f"  - legs detected: {len(file_legs)} ({[round(value, 1) for value in lengths]} m); "
                f"auto-split {'accepted' if detected else 'not applied'}."
            )
            if detected and min(lengths) > 0 and max(lengths) / min(lengths) > 1.15:
                report.warnings.append(
                    f"{filename}: detected leg lengths differ by more than 15% ({[round(value, 1) for value in lengths]} m)."
                )
            passes.extend([[point.xy for point in leg] for leg in file_legs])
            leg_gains.extend(value for value in (elevation_gain(leg) for leg in file_legs) if value is not None)

        spacing = float(options.get("spacing", 3.0))
        result = arc_length_centerline(
            passes,
            spacing,
            int(options.get("smooth_passes", 1)),
            float(options.get("simplify_tolerance", spacing * 0.28)),
            float(options.get("pass_match_cap", 12.0)),
        )
        output_line = result.points
        length_m = line_length(output_line)
        length_ft = round(length_m * 3.28084)
        gain_m = statistics.median(leg_gains) if leg_gains else None
        gain_ft = round(gain_m * 3.28084) if gain_m is not None else None
        closed = distance(output_line[0], output_line[-1]) <= float(
            options.get("loop_close_threshold", 10.0)
        )
        processing = (
            "Single-pass order-preserving smoothing and RDP simplification."
            if len(passes) == 1
            else f"Arc-length median centerline from {len(passes)} equally weighted passes; directions normalized; {spacing:g} m stations."
        )
        computed = {
            "source_files": list(job["inputs"]),
            "recorded_on": job.get("recorded_on", intake_date),
            "processing": processing,
            "length_m": round(length_m, 1),
            "length_ft": length_ft,
        }
        if gain_ft is not None:
            computed["elevation_gain_ft"] = gain_ft
        properties = merge_computed_properties(job, computed, warnings)
        output = feature("LineString", [to_lonlat(point) for point in output_line], properties)
        median_spread = statistics.median(result.station_spreads) if result.station_spreads else 0.0
        max_spread = max(result.station_spreads, default=0.0)
        report.output_lines.extend(
            [
                f"- Output vertices: {len(output_line)}.",
                f"- Length: {length_m:.1f} m / {length_m * 3.28084:.0f} ft (`length_ft`: {length_ft}).",
                f"- Elevation gain: {gain_m:.1f} m / {gain_ft} ft." if gain_m is not None else "- Elevation gain: unavailable.",
                f"- Station spread MAD: median {median_spread:.1f} m; maximum {max_spread:.1f} m.",
                f"- Shape: {'closed loop' if closed else 'open path'}; endpoint gap {distance(output_line[0], output_line[-1]):.1f} m.",
                f"- Self-intersections: {self_intersection_count(output_line)}.",
                f"- Direction-normalized passes reversed: {sum(result.reversed_passes)} of {len(result.reversed_passes)}.",
            ]
        )
        intersection_count = self_intersection_count(output_line)
        if intersection_count:
            report.warnings.append(
                f"{job['id']}: processed path contains {intersection_count} self-intersection(s); compare with the raw track before promotion."
            )
        expectations = job.get("expect", {})
        if "closed" in expectations and bool(expectations["closed"]) != closed:
            report.warnings.append(
                f"{job['id']}: expected closed={bool(expectations['closed'])}, computed closed={closed}."
            )
        if expectations.get("length_range_m"):
            low, high = expectations["length_range_m"]
            if not float(low) <= length_m <= float(high):
                report.warnings.append(
                    f"{job['id']}: output length {length_m:.1f} m is outside expected range {low}-{high} m."
                )
        for filename, expected_count in expectations.get("legs", {}).items():
            actual_count = detected_leg_counts.get(filename)
            if actual_count != expected_count:
                report.warnings.append(
                    f"{job['id']}: {filename} expected {expected_count} leg(s), detected {actual_count}."
                )
        if "reversed_passes" in expectations:
            actual_reversed = sum(result.reversed_passes)
            if actual_reversed != int(expectations["reversed_passes"]):
                report.warnings.append(
                    f"{job['id']}: expected {expectations['reversed_passes']} reversed pass(es), computed {actual_reversed}; raw endpoint order disagrees with the stated direction fact."
                )
        if expectations.get("trim_removed_range_m") and trim_removed is not None:
            low, high = expectations["trim_removed_range_m"]
            if not float(low) <= trim_removed <= float(high):
                report.warnings.append(
                    f"{job['id']}: trim removed {trim_removed:.1f} m, outside expected range {low}-{high} m."
                )

    report.warnings.extend(warnings)
    return WorkingFeature(job["id"], safe_target(job["target"]), output, from_job=True, modified=True), report


def append_processing(current: WorkingFeature, message: str) -> None:
    previous = current.feature["properties"].get("processing", "")
    join_match = re.search(r"join `([^`]+)`", message, re.IGNORECASE)
    if message in previous or (
        join_match and re.search(rf"join `{re.escape(join_match.group(1))}`", previous, re.IGNORECASE)
    ):
        return
    current.feature["properties"]["processing"] = (previous.rstrip() + " " + message).strip()


def emit_intersection(
    definition: dict[str, Any],
    coordinate: XY,
    features: list[str],
    movement_note: str,
    intake_date: str,
) -> WorkingFeature:
    properties = {
        "id": definition["id"],
        "name": definition["name"],
        "type": definition.get("type", "confirmed intersection"),
        "features": features,
        "status": definition.get("status", "provisional; derived from declared join"),
        "recorded_on": intake_date,
        "note": f"{definition.get('note', '').strip()} {movement_note}".strip(),
    }
    return WorkingFeature(
        definition["id"],
        INTERSECTIONS_TARGET,
        feature("Point", to_lonlat(coordinate), properties),
        from_job=True,
        modified=True,
    )


def process_node_join(
    join: dict[str, Any],
    catalog: dict[str, WorkingFeature],
    intake_date: str,
    warnings: list[str],
) -> tuple[list[str], WorkingFeature | None]:
    members = join.get("members", [])
    if len(members) < 3:
        raise ValueError("A node join needs at least three members")
    endpoint_records = []
    for member in members:
        feature_id = member["feature"]
        if feature_id not in catalog:
            raise ValueError(f"Node join references unknown feature {feature_id}")
        line = line_xy(catalog[feature_id].feature)
        index = 0 if member["endpoint"] == "start" else len(line) - 1
        endpoint_records.append((member, line[index]))
    contributing_points = [
        point for member, point in endpoint_records if member.get("contributes", True)
    ]
    if len(contributing_points) < 3:
        raise ValueError("A node join needs at least three coordinate-contributing members")
    node = mean_point(contributing_points)
    cap = float(join.get("extension_cap", 8.0))
    movements = []
    for member, original in endpoint_records:
        movement = distance(original, node)
        member_cap = float(member.get("movement_cap", cap))
        if movement > member_cap:
            raise ValueError(
                f"Node {join.get('id', 'unnamed')} needs a {movement:.1f} m extension, above the {member_cap:.1f} m cap"
            )
        working = catalog[member["feature"]]
        line = line_xy(working.feature)
        index = 0 if member["endpoint"] == "start" else len(line) - 1
        if member.get("mode") == "relocate":
            line[index] = node
        else:
            move_endpoint_to_node(
                line,
                index,
                node,
                float(member.get("approach_length", join.get("approach_length", 3.0))),
            )
        set_line(working.feature, line)
        working.modified = True
        append_processing(
            working,
            f"Its {member['endpoint']} endpoint was extended {movement:.1f} m to the shared {join.get('name', 'node')} centroid.",
        )
        movements.append(f"{member['feature']} {member['endpoint']} {movement:.1f} m")
    expected = join.get("expected_lonlat")
    if expected:
        disagreement = distance(node, to_xy(*expected))
        if disagreement > float(join.get("expected_tolerance", 1.0)):
            warnings.append(
                f"Node {join.get('id')}: computed centroid differs from the stated check coordinate by {disagreement:.1f} m."
            )
    note = f"Node centroid {to_lonlat(node)}; endpoint movements: {', '.join(movements)}."
    emitted = join.get("emit_intersection")
    intersection = (
        emit_intersection(
            emitted,
            node,
            sorted({member["feature"] for member in members}),
            note,
            intake_date,
        )
        if emitted
        else None
    )
    return [f"{join.get('name', join.get('id', 'node'))}: {note}"], intersection


def apply_ring_inset(ring: list[XY], vertex_index: int, amount: float) -> None:
    center = mean_point(ring)
    for offset in (-1, 0, 1):
        index = (vertex_index + offset) % len(ring)
        ring[index] = move_toward(ring[index], center, amount)


def process_join(
    join: dict[str, Any],
    catalog: dict[str, WorkingFeature],
    intake_date: str,
    warnings: list[str],
) -> tuple[str, WorkingFeature | None]:
    source_id = join["feature"]
    target_id = join["target_feature"]
    if source_id not in catalog:
        raise ValueError(f"Join references unknown feature {source_id}")
    if target_id not in catalog:
        raise ValueError(f"Join references unknown target feature {target_id}")
    source = catalog[source_id]
    target = catalog[target_id]
    source_line = line_xy(source.feature)
    target_kind = join.get("target_kind", "line")
    target_geometry = (
        line_xy(target.feature)
        if target_kind == "line"
        else ring_xy(target.feature)
        if target_kind == "ring"
        else None
    )
    action = join["action"]
    fallback = False

    if action == "clearance":
        if target_kind != "ring" or target_geometry is None:
            raise ValueError("Clearance joins require a ring target")
        adjusted, movement, final_clearance = enforce_ring_clearance_from_line(
            target_geometry,
            source_line,
            float(join["minimum_clearance_m"]),
        )
        set_ring(target.feature, adjusted)
        target.modified = True
        append_processing(
            target,
            f"Join `{join.get('id', source_id + '-' + target_id)}` moved only conflicting zone vertices by at most {movement:.1f} m.",
        )
        return (
            f"{join.get('name', join.get('id'))}: Zone edge moved by at most {movement:.1f} m; "
            f"final line-to-zone clearance {final_clearance:.1f} m.",
            None,
        )

    if action == "offset":
        if target.feature["geometry"]["type"] != "Point":
            raise ValueError("Offset joins require a point target")
        target_point = point_xy(target.feature)
        endpoint_index = 0 if distance(source_line[0], target_point) <= distance(source_line[-1], target_point) else len(source_line) - 1
        neighbor = source_line[1 if endpoint_index == 0 else len(source_line) - 2]
        coordinate = move_toward(target_point, neighbor, float(join["distance_m"]))
        movement = distance(source_line[endpoint_index], coordinate)
        source_line[endpoint_index] = coordinate
        set_line(source.feature, source_line)
    elif target_geometry is None:
        raise ValueError(f"Join {join.get('id')} has unsupported target kind {target_kind}")
    else:
        endpoint_index = endpoint_index_for_target(
            source_line,
            join.get("endpoint", "nearest"),
            target_geometry,
            target_kind == "ring",
        )
        original = source_line[endpoint_index]
        if action == "snap":
            if target_kind == "line":
                coordinate, movement, target_segment = closest_point_on_line(original, target_geometry)
            else:
                coordinate, movement, target_segment = closest_point_on_ring(original, target_geometry)
            source_line[endpoint_index] = coordinate
            insert_vertex(target_geometry, coordinate, target_segment, closed=target_kind == "ring")
        elif action == "extend" and target_kind == "line":
            coordinate, movement, target_segment, fallback = extend_endpoint_to_line(
                source_line,
                endpoint_index,
                target_geometry,
                float(join.get("movement_cap", 15.0)),
            )
        elif action == "trim" and target_kind == "ring":
            coordinate, movement, target_segment = trim_line_to_ring(
                source_line, endpoint_index, target_geometry
            )
        else:
            raise ValueError(f"Unsupported join action/target combination: {action}/{target_kind}")

        if join.get("inset"):
            inserted_index = min(
                range(len(target_geometry)), key=lambda index: distance(target_geometry[index], coordinate)
            )
            apply_ring_inset(target_geometry, inserted_index, float(join["inset"]))
            coordinate = target_geometry[inserted_index]
            source_line[0 if endpoint_index == 0 else -1] = coordinate

        set_line(source.feature, source_line)
        if target_kind == "line":
            set_line(target.feature, target_geometry)
        else:
            set_ring(target.feature, target_geometry)

    source.modified = True
    # Point targets are reference anchors for offset joins; their geometry is
    # never edited and they must not be needlessly included in promotion.
    if target_kind in {"line", "ring"}:
        target.modified = True
    append_processing(
        source,
        f"Join `{join.get('id', source_id + '-' + target_id)}` adjusted its endpoint to the declared connection.",
    )
    if target_kind in {"line", "ring"}:
        append_processing(target, f"A matching vertex was inserted for join `{join.get('id', source_id + '-' + target_id)}`.")

    if fallback:
        warnings.append(
            f"Join {join.get('id')}: no forward bearing intersection was found; closest-point fallback was used."
        )
    if join.get("pin_id"):
        pin_id = join["pin_id"]
        if pin_id not in catalog:
            raise ValueError(f"Join references unknown pin {pin_id}")
        separation = distance(coordinate, point_xy(catalog[pin_id].feature))
        minimum = float(join.get("min_pin_distance_m", 3.0))
        if separation < minimum:
            raise ValueError(
                f"Join {join.get('id')} lands {separation:.1f} m from {pin_id}, below the {minimum:.1f} m minimum"
            )
        pin_note = f" Resulting separation from {pin_id}: {separation:.1f} m."
    else:
        pin_note = ""

    movement_note = (
        f"Declared {action} join moved/extended the {endpoint_name(0 if endpoint_index == 0 else len(source_line) - 1, source_line)} side "
        f"by {movement:.1f} m; source and target now share {to_lonlat(coordinate)}.{pin_note}"
    )
    emitted = join.get("emit_intersection")
    intersection = (
        emit_intersection(emitted, coordinate, [source_id, target_id], movement_note, intake_date)
        if emitted
        else None
    )
    if emitted and emitted["id"] in catalog:
        existing = catalog[emitted["id"]]
        if (
            existing.feature["geometry"]["type"] == "Point"
            and distance(point_xy(existing.feature), coordinate) <= 0.05
        ):
            intersection = copy.deepcopy(existing)
            intersection.from_job = True
            intersection.modified = True
    return f"{join.get('name', join.get('id'))}: {movement_note}", intersection


def add_derived_points(
    definitions: Iterable[dict[str, Any]],
    catalog: dict[str, WorkingFeature],
    intake_date: str,
) -> list[WorkingFeature]:
    result = []
    for definition in definitions:
        source_id = definition["feature"]
        if source_id not in catalog:
            raise ValueError(f"Derived point references unknown feature {source_id}")
        source_line = line_xy(catalog[source_id].feature)
        coordinate = source_line[0 if definition.get("endpoint", "start") == "start" else -1]
        offset = definition.get("offset_m", {})
        coordinate = (
            coordinate[0] + float(offset.get("east", 0.0)),
            coordinate[1] + float(offset.get("north", 0.0)),
        )
        properties = copy.deepcopy(definition["properties"])
        properties = {
            "id": definition["id"],
            "name": definition["name"],
            **properties,
            "recorded_on": properties.get("recorded_on", intake_date),
        }
        result.append(
            WorkingFeature(
                definition["id"],
                safe_target(definition.get("target", INTERSECTIONS_TARGET)),
                feature("Point", to_lonlat(coordinate), properties),
                from_job=True,
                modified=True,
            )
        )
    return result


def geometry_components(current_feature: dict[str, Any]) -> tuple[list[XY], list[list[XY]]]:
    geometry = current_feature["geometry"]
    geometry_type = geometry["type"]
    if geometry_type == "Point":
        point = to_xy(*geometry["coordinates"])
        return [point], []
    if geometry_type == "LineString":
        line = [to_xy(*point) for point in geometry["coordinates"]]
        return line, [line]
    if geometry_type == "Polygon":
        ring = [to_xy(*point) for point in geometry["coordinates"][0]]
        return ring, [ring]
    return [], []


def feature_distance(left: dict[str, Any], right: dict[str, Any]) -> float:
    left_points, left_lines = geometry_components(left)
    right_points, right_lines = geometry_components(right)
    candidates = []
    for point in left_points:
        for line in right_lines:
            candidates.append(closest_point_on_line(point, line)[1] if len(line) > 1 else distance(point, line[0]))
    for point in right_points:
        for line in left_lines:
            candidates.append(closest_point_on_line(point, line)[1] if len(line) > 1 else distance(point, line[0]))
    if not left_lines and not right_lines:
        candidates.extend(distance(a, b) for a in left_points for b in right_points)
    return min(candidates, default=math.inf)


def qa_proximity(
    working: WorkingFeature,
    live_catalog: dict[str, WorkingFeature],
) -> tuple[str, list[str]]:
    def is_declared_connection(other: WorkingFeature) -> bool:
        return working.id in other.feature.get("properties", {}).get("features", [])

    distances = [
        (feature_distance(working.feature, other.feature), feature_id)
        for feature_id, other in live_catalog.items()
        if feature_id != working.id and not is_declared_connection(other)
    ]
    nearest_distance, nearest_id = min(distances, default=(math.inf, "none"))
    warnings = []
    pin_distances = []
    for feature_id, other in live_catalog.items():
        if (
            other.feature["geometry"]["type"] != "Point"
            or feature_id == working.id
            or is_declared_connection(other)
        ):
            continue
        pin_distances.append((feature_distance(working.feature, other.feature), feature_id))
    if pin_distances:
        pin_distance, pin_id = min(pin_distances)
        if pin_distance < 3.0:
            warnings.append(f"{working.id}: geometry is {pin_distance:.1f} m from pin {pin_id} (under 3 m).")
    return f"Nearest existing mapped feature: `{nearest_id}` at {nearest_distance:.1f} m.", warnings


def build_route_candidates(
    manifest: dict[str, Any], catalog: dict[str, WorkingFeature], warnings: list[str]
) -> list[dict[str, Any]]:
    routes = []
    for definition in manifest.get("routes", []):
        segment_ids = definition["segments"]
        unknown = [segment_id for segment_id in segment_ids if segment_id not in catalog]
        if unknown:
            raise ValueError(f"Route {definition['id']} references unknown segments: {', '.join(unknown)}")
        length_ft = round(
            sum(float(catalog[segment_id].feature["properties"].get("length_m", 0)) for segment_id in segment_ids)
            * 3.28084
        )
        gain_values = [
            catalog[segment_id].feature["properties"].get("elevation_gain_ft")
            for segment_id in segment_ids
        ]
        gain_ft = round(sum(value for value in gain_values if isinstance(value, (int, float))))
        route = copy.deepcopy(definition)
        route["length_ft"] = length_ft
        route["elevation_gain_ft"] = gain_ft
        routes.append(route)
    omitted = manifest.get("route_omissions", [])
    if omitted:
        warnings.append(f"Intentionally omitted from routes: {', '.join(omitted)}.")
    return routes


def candidate_collection(
    target: str,
    features: list[dict[str, Any]],
    live_collections: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    title = live_collections.get(target, {}).get("properties", {}).get(
        "title", PurePosixPath(target).stem.replace("-", " ").title()
    )
    return {
        "type": "FeatureCollection",
        "properties": {"title": title},
        "features": features,
    }


def build_qa(
    manifest: dict[str, Any],
    reports: list[JobReport],
    join_lines: list[str],
    route_candidates: list[dict[str, Any]],
    catalog: dict[str, WorkingFeature],
    live_catalog: dict[str, WorkingFeature],
    warnings: list[str],
) -> str:
    lines = [
        f"# GPX intake QA — {manifest['intake_date']}",
        "",
        f"Manifest: `{manifest.get('_manifest_name', 'unknown')}`",
        "",
    ]
    for report in reports:
        lines.extend([f"## {report.name} (`{report.id}`)", "", f"Type: `{report.type}`", "", "### Inputs", ""])
        lines.extend(report.file_lines)
        lines.extend(["", "### Output", ""])
        lines.extend(report.output_lines)
        proximity, proximity_warnings = qa_proximity(catalog[report.id], live_catalog)
        lines.extend([f"- {proximity}", ""])
        report.warnings.extend(proximity_warnings)
        warnings.extend(report.warnings)

    lines.extend(["## Declared joins", ""])
    lines.extend(f"- {line}" for line in join_lines)
    if not join_lines:
        lines.append("- None.")
    lines.extend(["", "## Routes", ""])
    if route_candidates:
        for route in route_candidates:
            lines.append(
                f"- `{route['id']}`: {route['name']}; segments {route['segments']}; "
                f"`length_ft` {route['length_ft']}; `elevation_gain_ft` {route.get('elevation_gain_ft', 0)}."
            )
    else:
        lines.append("- No route candidates in this intake.")
    lines.extend(["", "## Consolidated warnings", ""])
    deduplicated = list(dict.fromkeys(warnings))
    lines.extend(f"- {warning}" for warning in deduplicated)
    if not deduplicated:
        lines.append("- None.")
    return "\n".join(lines) + "\n"


def process_manifest(manifest_path: Path) -> PipelineResult:
    manifest = load_manifest(manifest_path)
    manifest["_manifest_name"] = manifest_path.name
    source_root = (ROOT / manifest.get("source_dir", ".")).resolve()
    if ROOT.resolve() not in source_root.parents and source_root != ROOT.resolve():
        raise ValueError("source_dir must remain inside the project working folder")
    live_catalog, live_collections = load_live_catalog()
    catalog = {feature_id: copy.deepcopy(value) for feature_id, value in live_catalog.items()}
    reports = []
    warnings: list[str] = list(manifest.get("warnings", []))
    candidate_ids: set[str] = set()

    for job in manifest["jobs"]:
        working, report = process_job(job, source_root, manifest["intake_date"])
        catalog[working.id] = working
        candidate_ids.add(working.id)
        reports.append(report)

    all_known_ids = set(catalog)
    for join in manifest.get("joins", []):
        referenced = []
        if join.get("action") == "node":
            referenced.extend(member.get("feature") for member in join.get("members", []))
        else:
            referenced.extend([join.get("feature"), join.get("target_feature")])
        unknown = [feature_id for feature_id in referenced if feature_id not in all_known_ids]
        if unknown:
            raise ValueError(f"Join {join.get('id', 'unnamed')} references unknown id(s): {', '.join(unknown)}")

    join_lines = []
    emitted_features = []
    for join in manifest.get("joins", []):
        if join.get("action") == "node":
            lines, emitted = process_node_join(join, catalog, manifest["intake_date"], warnings)
            join_lines.extend(lines)
        else:
            line, emitted = process_join(join, catalog, manifest["intake_date"], warnings)
            join_lines.append(line)
        if emitted:
            catalog[emitted.id] = emitted
            candidate_ids.add(emitted.id)
            emitted_features.append(emitted)
        for feature_id, working in catalog.items():
            if working.modified:
                candidate_ids.add(feature_id)

    for derived in add_derived_points(
        manifest.get("derived_points", []), catalog, manifest["intake_date"]
    ):
        catalog[derived.id] = derived
        candidate_ids.add(derived.id)

    existing_pins = [
        (feature_id, point_xy(working.feature))
        for feature_id, working in live_catalog.items()
        if working.feature["geometry"]["type"] == "Point"
    ]
    for feature_id in sorted(candidate_ids):
        working = catalog[feature_id]
        if working.target != INTERSECTIONS_TARGET or working.feature["geometry"]["type"] != "Point":
            continue
        coordinate = point_xy(working.feature)
        nearby = [
            (distance(coordinate, pin), pin_id)
            for pin_id, pin in existing_pins
            if pin_id != feature_id
        ]
        if nearby:
            pin_distance, pin_id = min(nearby)
            if pin_distance < 3.0:
                warnings.append(
                    f"Intersection {feature_id} is {pin_distance:.1f} m from existing pin {pin_id}; resolve the under-3 m separation before promotion."
                )

    route_candidates = build_route_candidates(manifest, catalog, warnings)
    candidate_features: dict[str, list[dict[str, Any]]] = {}
    for feature_id in sorted(candidate_ids):
        working = catalog[feature_id]
        candidate_features.setdefault(working.target, []).append(working.feature)

    qa_text = build_qa(
        manifest,
        reports,
        join_lines,
        route_candidates,
        catalog,
        live_catalog,
        warnings,
    )
    candidate_contents: dict[Path, str] = {}
    for target, features in sorted(candidate_features.items()):
        path = CANDIDATES / Path(*PurePosixPath(target).parts)
        candidate_contents[path] = json_text(candidate_collection(target, features, live_collections))
    if route_candidates:
        route_path = CANDIDATES / "trails" / "routes.json"
        live_routes_path = DATA / "trails" / "routes.json"
        live_routes = json.loads(live_routes_path.read_text(encoding="utf-8")) if live_routes_path.exists() else {}
        candidate_contents[route_path] = json_text(
            {"_comment": live_routes.get("_comment", []), "routes": route_candidates}
        )
    qa_path = CANDIDATES / f"QA-{manifest['intake_date']}.md"
    candidate_contents[qa_path] = qa_text
    return PipelineResult(
        manifest,
        catalog,
        candidate_features,
        route_candidates,
        qa_text,
        list(dict.fromkeys(warnings)),
        candidate_contents,
    )


def write_candidates(result: PipelineResult) -> None:
    for path, content in result.candidate_contents.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")


def feature_array_spans(raw: str) -> tuple[list[tuple[int, int, dict[str, Any]]], int, int]:
    match = re.search(r'"features"\s*:\s*\[', raw)
    if not match:
        raise ValueError("Live GeoJSON has no features array")
    array_start = match.end() - 1
    decoder = json.JSONDecoder()
    position = array_start + 1
    spans = []
    while True:
        while position < len(raw) and raw[position].isspace():
            position += 1
        if raw[position] == "]":
            return spans, array_start, position
        start = position
        value, end = decoder.raw_decode(raw, position)
        spans.append((start, end, value))
        position = end
        while position < len(raw) and raw[position].isspace():
            position += 1
        if raw[position] == ",":
            position += 1
            continue
        if raw[position] == "]":
            return spans, array_start, position
        raise ValueError("Could not parse live features array")


def indent_json_at(raw: str, start: int, value: dict[str, Any]) -> str:
    line_start = raw.rfind("\n", 0, start) + 1
    indentation = raw[line_start:start]
    dumped = json.dumps(value, indent=2, ensure_ascii=False)
    return dumped.replace("\n", "\n" + indentation)


def merge_geojson_preserving_features(
    live_raw: str, candidates: list[dict[str, Any]]
) -> str:
    spans, array_start, array_end = feature_array_spans(live_raw)
    by_id = {
        value.get("properties", {}).get("id"): (start, end)
        for start, end, value in spans
        if value.get("properties", {}).get("id")
    }
    edits: list[tuple[int, int, str]] = []
    additions = []
    for candidate in candidates:
        feature_id = candidate["properties"]["id"]
        if feature_id in by_id:
            start, end = by_id[feature_id]
            edits.append((start, end, indent_json_at(live_raw, start, candidate)))
        else:
            additions.append(candidate)
    if additions:
        insert_at = array_end
        while insert_at > array_start + 1 and live_raw[insert_at - 1].isspace():
            insert_at -= 1
        prefix = "," if spans else ""
        addition_text = prefix + "\n" + ",\n".join(
            "    " + json.dumps(candidate, indent=2, ensure_ascii=False).replace("\n", "\n    ")
            for candidate in additions
        )
        edits.append((insert_at, insert_at, addition_text))
    merged = live_raw
    for start, end, replacement in sorted(edits, reverse=True):
        merged = merged[:start] + replacement + merged[end:]
    return merged


def merge_routes(live: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, Any]:
    result = copy.deepcopy(live)
    routes = list(result.get("routes", []))
    indexes = {route.get("id"): index for index, route in enumerate(routes)}
    for candidate in candidates:
        if candidate["id"] in indexes:
            routes[indexes[candidate["id"]]] = candidate
        else:
            routes.append(candidate)
    result["routes"] = routes
    return result


def promotion_summary(
    target: str,
    candidates: list[dict[str, Any]],
    live_collection: dict[str, Any] | None,
) -> list[str]:
    existing = {
        feature.get("properties", {}).get("id"): feature
        for feature in (live_collection or {}).get("features", [])
    }
    lines = [f"{target}:"]
    for candidate in candidates:
        feature_id = candidate["properties"]["id"]
        previous = existing.get(feature_id)
        if not previous:
            lines.append(f"  + add {feature_id}: {geometry_vertex_count(candidate['geometry'])} vertices")
            continue
        old_key, old_measure = geometry_measure(previous["geometry"])
        new_key, new_measure = geometry_measure(candidate["geometry"])
        measure = (
            f"; {old_key} {old_measure:.1f} -> {new_measure:.1f}"
            if old_key == new_key and old_key != "none"
            else ""
        )
        displacement = max_vertex_displacement(previous["geometry"], candidate["geometry"])
        lines.append(
            f"  ~ replace {feature_id}: {geometry_vertex_count(previous['geometry'])} -> "
            f"{geometry_vertex_count(candidate['geometry'])} vertices{measure}; max nearest-vertex displacement {displacement:.1f} m"
        )
    return lines


def prepare_promotion(result: PipelineResult, backup: bool) -> tuple[dict[Path, str], list[str]]:
    writes: dict[Path, str] = {}
    summary: list[str] = []
    for target, candidates in sorted(result.candidate_features.items()):
        live_path = DATA / Path(*PurePosixPath(target).parts)
        if live_path.exists():
            live_raw = live_path.read_text(encoding="utf-8")
            live_collection = json.loads(live_raw)
            writes[live_path] = merge_geojson_preserving_features(live_raw, candidates)
        else:
            live_collection = None
            writes[live_path] = json_text(candidate_collection(target, candidates, {}))
        summary.extend(promotion_summary(target, candidates, live_collection))
        if backup and live_path.exists():
            backup_path = CANDIDATES / "backups" / result.manifest["intake_date"] / Path(*PurePosixPath(target).parts)
            writes[backup_path] = live_path.read_text(encoding="utf-8")
    if result.candidate_routes:
        live_path = DATA / "trails" / "routes.json"
        live_routes = json.loads(live_path.read_text(encoding="utf-8")) if live_path.exists() else {"routes": []}
        writes[live_path] = json_text(merge_routes(live_routes, result.candidate_routes))
        summary.append(
            f"trails/routes.json: merge route id(s) {', '.join(route['id'] for route in result.candidate_routes)}"
        )
        if backup and live_path.exists():
            writes[CANDIDATES / "backups" / result.manifest["intake_date"] / "trails" / "routes.json"] = live_path.read_text(encoding="utf-8")
    return writes, summary


def promote(result: PipelineResult, assume_yes: bool, backup: bool) -> None:
    writes, summary = prepare_promotion(result, backup)
    print("\nPromotion diff summary:")
    print("\n".join(summary))
    if not assume_yes:
        response = input("\nPromote these candidate changes into live data? [y/N] ").strip().lower()
        if response not in {"y", "yes"}:
            print("Promotion cancelled; candidate files remain staged.")
            return
    for path, content in writes.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
    print(f"Promoted {len(writes)} file write(s).")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Path to an intake manifest JSON")
    parser.add_argument("--promote", action="store_true", help="Merge staged candidates into live data after confirmation")
    parser.add_argument("--yes", action="store_true", help="Treat this command invocation as explicit promotion confirmation")
    parser.add_argument("--backup", action="store_true", help="Write pre-promotion target copies under data/_candidates/backups")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        result = process_manifest(args.manifest.resolve())
        write_candidates(result)
        print(result.qa_text, end="")
        if args.promote:
            promote(result, args.yes, args.backup)
        elif args.yes or args.backup:
            raise ValueError("--yes and --backup only apply with --promote")
        return 0
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
