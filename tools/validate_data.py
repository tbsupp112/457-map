"""Validate published map data and repository-wide safety rules."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

sys.dont_write_bytecode = True


ROOT = Path(__file__).resolve().parents[1]
FEET_PER_METER = 3.28084
FORBIDDEN_TERM_DIGESTS = frozenset({
    "cbc96d4e05bc1de245367be020fa0b8ca01c38c3f08769fdb89028cc9d387757",
})
MAX_POINT_PHOTO_BYTES = 400 * 1024
MAX_RUN_TOGETHER_TOKEN_LENGTH = 128


@dataclass
class ValidationReport:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def scan_forbidden_terminology(
    root: Path,
    report: ValidationReport,
    banned_digests: frozenset[str] = FORBIDDEN_TERM_DIGESTS,
) -> None:
    for path in root.rglob("*"):
        if not path.is_file() or ".git" in path.parts:
            continue
        try:
            text = path.read_bytes().decode("utf-8", errors="ignore").lower()
        except OSError as error:
            report.warn(f"Could not scan {path.relative_to(root)}: {error}")
            continue
        tokens = re.findall(r"[a-z0-9]+", text)
        found = False
        for token in tokens:
            if hashlib.sha256(token.encode("utf-8")).hexdigest() in banned_digests:
                found = True
                break
            if len(token) <= MAX_RUN_TOGETHER_TOKEN_LENGTH:
                for split in range(1, len(token)):
                    candidate = f"{token[:split]} {token[split:]}"
                    if hashlib.sha256(candidate.encode("utf-8")).hexdigest() in banned_digests:
                        found = True
                        break
            if found:
                break
        if not found:
            for first, second in zip(tokens, tokens[1:]):
                if any(
                    hashlib.sha256(candidate.encode("utf-8")).hexdigest() in banned_digests
                    for candidate in (f"{first} {second}", f"{first}{second}")
                ):
                    found = True
                    break
        if found:
            report.error(
                f"Forbidden landmark terminology appears in {path.relative_to(root)}"
            )


def read_json(path: Path, report: ValidationReport, *, required: bool = True) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        if required:
            report.error(f"Missing required file: {path}")
        return None
    except (OSError, json.JSONDecodeError) as error:
        report.error(f"Could not read JSON {path}: {error}")
        return None


def validate_manifest_source_references(
    root: Path, source_keys: set[str], report: ValidationReport
) -> None:
    reference_patterns = {
        "app.js": re.compile(r"\bsources\s*:\s*\[([^\]]*)\]", re.DOTALL),
        "home.js": re.compile(
            r"\bconst\s+requiredKeys\s*=\s*\[([^\]]*)\]", re.DOTALL
        ),
    }
    string_literal = re.compile(r'["\']([^"\']+)["\']')
    references_by_file: dict[str, set[str]] = {}

    for filename, pattern in reference_patterns.items():
        path = root / filename
        try:
            source = path.read_text(encoding="utf-8")
        except OSError as error:
            report.error(f"Could not read manifest source references from {filename}: {error}")
            continue
        arrays = pattern.findall(source)
        if not arrays:
            report.error(f"Could not find static manifest source references in {filename}")
            continue
        references = {
            match.group(1)
            for array_source in arrays
            for match in string_literal.finditer(array_source)
        }
        references_by_file[filename] = references
        for key in sorted(references - source_keys):
            report.error(f"{filename} references missing manifest source key {key!r}")

    referenced_keys = set().union(*references_by_file.values()) if references_by_file else set()
    for key in sorted(source_keys - referenced_keys):
        report.error(
            f"Manifest source key {key!r} is not referenced by app.js or home.js"
        )


def property_is_present(properties: dict[str, Any], key: str) -> bool:
    value = properties.get(key)
    return value is not None and value != ""


def iter_coordinate_pairs(value: Any) -> Iterable[tuple[float, float]]:
    if (
        isinstance(value, list)
        and len(value) >= 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    ):
        yield float(value[0]), float(value[1])
        return
    if isinstance(value, list):
        for child in value:
            yield from iter_coordinate_pairs(child)


def orientation(a: list[float], b: list[float], c: list[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_cross(a: list[float], b: list[float], c: list[float], d: list[float]) -> bool:
    first = orientation(a, b, c)
    second = orientation(a, b, d)
    third = orientation(c, d, a)
    fourth = orientation(c, d, b)
    return (first > 0 > second or second > 0 > first) and (
        third > 0 > fourth or fourth > 0 > third
    )


def ring_self_intersects(ring: list[list[float]]) -> bool:
    segment_count = len(ring) - 1
    for first in range(segment_count):
        for second in range(first + 1, segment_count):
            if second == first + 1 or (first == 0 and second == segment_count - 1):
                continue
            if segments_cross(
                ring[first], ring[first + 1], ring[second], ring[second + 1]
            ):
                return True
    return False


def distance_meters(first: tuple[float, float], second: tuple[float, float]) -> float:
    first_lon, first_lat = first
    second_lon, second_lat = second
    radians = math.pi / 180
    mean_latitude = (first_lat + second_lat) / 2 * radians
    x = (second_lon - first_lon) * radians * math.cos(mean_latitude)
    y = (second_lat - first_lat) * radians
    return 6_371_000 * math.hypot(x, y)


def segment_length_feet(feature: dict[str, Any]) -> float | None:
    properties = feature.get("properties", {})
    recorded_meters = properties.get("length_m")
    if isinstance(recorded_meters, (int, float)) and recorded_meters > 0:
        return float(recorded_meters) * FEET_PER_METER
    coordinates = feature.get("geometry", {}).get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return None
    return sum(
        distance_meters(tuple(first[:2]), tuple(second[:2])) * FEET_PER_METER
        for first, second in zip(coordinates, coordinates[1:])
    )


def derive_route_metrics(
    route: dict[str, Any], segments_by_id: dict[str, dict[str, Any]]
) -> dict[str, Any] | None:
    segment_ids = route.get("segments", [])
    if any(segment_id not in segments_by_id for segment_id in segment_ids):
        return None
    segments = [segments_by_id[segment_id] for segment_id in segment_ids]
    directions = route.get("segment_directions") or ["forward"] * len(segments)
    lengths = [segment_length_feet(segment) for segment in segments]
    if any(length is None or length <= 0 for length in lengths):
        return None
    numeric_lengths = [float(length) for length in lengths if length is not None]
    out_and_back = route.get("shape") == "out-and-back"
    outbound_length = sum(numeric_lengths)
    derived: dict[str, Any] = {
        "length_ft": round(outbound_length * (2 if out_and_back else 1))
    }

    outbound_gain = 0.0
    outbound_loss = 0.0
    totals_available = True
    for segment, direction in zip(segments, directions):
        properties = segment.get("properties", {})
        gain = properties.get("elevation_gain_ft")
        loss = properties.get("elevation_loss_ft")
        if not isinstance(gain, (int, float)) or not isinstance(loss, (int, float)):
            totals_available = False
            break
        if direction == "reverse":
            outbound_gain += loss
            outbound_loss += gain
        else:
            outbound_gain += gain
            outbound_loss += loss
    if totals_available:
        derived["elevation_gain_ft"] = round(
            outbound_gain + (outbound_loss if out_and_back else 0)
        )
        derived["elevation_loss_ft"] = round(
            outbound_loss + (outbound_gain if out_and_back else 0)
        )

    outbound: list[list[float]] = []
    offset = 0.0
    for segment, direction, length in zip(segments, directions, numeric_lengths):
        raw_profile = segment.get("properties", {}).get("elevation_profile_ft")
        if (
            not isinstance(raw_profile, list)
            or len(raw_profile) < 2
            or any(not isinstance(value, (int, float)) for value in raw_profile)
        ):
            return derived
        elevations = list(reversed(raw_profile)) if direction == "reverse" else raw_profile
        step = length / (len(elevations) - 1)
        for point_index, elevation in enumerate(elevations):
            if outbound and point_index == 0:
                continue
            outbound.append([round(offset + point_index * step, 1), round(elevation, 1)])
        offset += length
    if out_and_back:
        returning = [
            [round(offset + (offset - distance), 1), elevation]
            for distance, elevation in reversed(outbound[:-1])
        ]
        outbound.extend(returning)
    derived["elevation_profile_ft"] = outbound
    return derived


def profiles_match(first: Any, second: Any) -> bool:
    if not isinstance(first, list) or not isinstance(second, list) or len(first) != len(second):
        return False
    return all(
        isinstance(a, list)
        and isinstance(b, list)
        and len(a) == 2
        and len(b) == 2
        and abs(float(a[0]) - float(b[0])) <= 0.11
        and abs(float(a[1]) - float(b[1])) <= 0.11
        for a, b in zip(first, second)
    )


def validate_repository(root: Path = ROOT) -> ValidationReport:
    root = root.resolve()
    report = ValidationReport()
    forbidden_publish_paths = [
        root / "Raw gaia gpx 8.5.26",
        root / "Unprocessed GPS Files",
        root / "data" / "_candidates",
        root / "compass-test.html",
        *[
            path for path in root.rglob("PROJECT_HANDOFF*.md")
            if ".git" not in path.parts
        ],
    ]
    for path in forbidden_publish_paths:
        if path.exists():
            report.error(
                f"Local-only item remains in the publish folder: {path.relative_to(root)}"
            )
    for path in root.rglob("__pycache__"):
        if path.is_dir():
            report.error(
                f"Python cache directory remains in the publish folder: {path.relative_to(root)}"
            )
    for path in root.rglob("*.gpx"):
        if path.is_file():
            report.error(f"Raw GPX remains in the publish folder: {path.relative_to(root)}")
    point_photo_root = root / "assets" / "points"
    if point_photo_root.is_dir():
        for path in point_photo_root.rglob("*"):
            if path.is_file() and path.stat().st_size > MAX_POINT_PHOTO_BYTES:
                report.error(
                    f"Point photo exceeds 400 KB: {path.relative_to(root)}"
                )

    manifest = read_json(root / "data" / "manifest.json", report)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("sources"), list):
        if not report.errors:
            report.error("data/manifest.json must contain a sources array")
        return report

    constraints = manifest.get("constraints", {})
    bounds = constraints.get("coordinate_bounds", {})
    minimum_longitude = bounds.get("minimum_longitude", -180)
    maximum_longitude = bounds.get("maximum_longitude", 180)
    minimum_latitude = bounds.get("minimum_latitude", -90)
    maximum_latitude = bounds.get("maximum_latitude", 90)
    minimum_pin_separation = constraints.get("minimum_pin_separation_m", 3)
    expected_roles = constraints.get("boundary_roles", ["main-parcel", "sliver"])

    source_keys: set[str] = set()
    data_by_key: dict[str, Any] = {}
    reference_ids: dict[str, str] = {}
    feature_ids: set[str] = set()
    segments_by_id: dict[str, dict[str, Any]] = {}
    pins: list[tuple[str, tuple[float, float]]] = []

    for source in manifest["sources"]:
        if not isinstance(source, dict) or not source.get("key") or not source.get("path"):
            report.error("Each manifest source needs a key and path")
            continue
        key = source["key"]
        if key in source_keys:
            report.error(f"Duplicate manifest source key: {key}")
            continue
        source_keys.add(key)
        relative_path = Path(source["path"])
        path = (root / relative_path).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            report.error(f"Manifest path escapes repository: {source['path']}")
            continue
        data = read_json(path, report, required=bool(source.get("required")))
        if data is None:
            continue
        data_by_key[key] = data
        required_properties = source.get("required_properties", [])
        optional_properties = source.get("optional_properties", [])
        authored_properties = source.get("authored_properties", [])
        generated_properties = source.get("generated_properties", [])
        declared = set(required_properties) | set(optional_properties)
        if not set(authored_properties).issubset(declared):
            report.error(f"Manifest source {key} has undeclared authored properties")
        if not set(generated_properties).issubset(declared):
            report.error(f"Manifest source {key} has undeclared generated properties")

        if source.get("format") == "route-collection":
            records = data.get("routes") if isinstance(data, dict) else None
            if not isinstance(records, list):
                report.error(f"{source['path']} must contain a routes array")
                continue
        elif source.get("format") == "geojson":
            if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
                report.error(f"{source['path']} must be a GeoJSON FeatureCollection")
                continue
            records = data["features"]
        else:
            report.error(f"Unsupported manifest format for {key}: {source.get('format')}")
            continue

        for index, record in enumerate(records):
            location = f"{source['path']} record {index + 1}"
            properties = record if source.get("format") == "route-collection" else record.get("properties")
            if not isinstance(properties, dict):
                report.error(f"{location} needs a properties object")
                continue
            for property_name in required_properties:
                if not property_is_present(properties, property_name):
                    report.error(f"{location} is missing required property {property_name!r}")
            if source.get("feature_type") in {"road", "trail"}:
                condition = properties.get("condition")
                if condition is None:
                    report.warn(f"{location} omits condition; display defaults to 'finished'")
                elif condition not in {"finished", "unfinished"}:
                    report.error(
                        f"{location} condition must be 'finished' or 'unfinished'"
                    )
            prominence = properties.get("prominence")
            if prominence is not None and prominence not in {"major", "minor"}:
                report.error(f"{location} prominence must be 'major' or 'minor'")
            if source.get("ids"):
                feature_id = properties.get("id")
                if not isinstance(feature_id, str) or not feature_id:
                    report.error(f"{location} needs a non-empty id")
                elif feature_id in reference_ids:
                    report.error(
                        f"Duplicate id {feature_id!r}: {reference_ids[feature_id]} and {location}"
                    )
                else:
                    reference_ids[feature_id] = location
                    if source.get("format") == "geojson":
                        feature_ids.add(feature_id)

            if source.get("format") != "geojson":
                continue
            geometry = record.get("geometry")
            if not isinstance(geometry, dict) or not geometry.get("type"):
                report.error(f"{location} has no geometry")
                continue
            geometry_type = geometry["type"]
            if geometry_type not in source.get("geometry_types", []):
                report.error(
                    f"{location} geometry is {geometry_type}, expected {source.get('geometry_types')}"
                )
            coordinates = geometry.get("coordinates")
            coordinate_pairs = list(iter_coordinate_pairs(coordinates))
            if not coordinate_pairs:
                report.error(f"{location} has no usable coordinates")
            for longitude, latitude in coordinate_pairs:
                if not (
                    minimum_longitude <= longitude <= maximum_longitude
                    and minimum_latitude <= latitude <= maximum_latitude
                ):
                    report.error(
                        f"{location} coordinate [{longitude}, {latitude}] is outside the property bounding box; check longitude/latitude order"
                    )
            if (
                source.get("feature_type") in {"road", "trail"}
                and geometry_type == "LineString"
                and len(coordinate_pairs) >= 2
            ):
                geometry_length_m = sum(
                    distance_meters(first, second)
                    for first, second in zip(coordinate_pairs, coordinate_pairs[1:])
                )
                length_m = properties.get("length_m")
                length_ft = properties.get("length_ft")
                if isinstance(length_m, (int, float)):
                    if abs(float(length_m) - geometry_length_m) > 0.5:
                        report.error(f"{location} length_m disagrees with its geometry")
                    if isinstance(length_ft, (int, float)) and abs(
                        float(length_ft) - float(length_m) * FEET_PER_METER
                    ) > 1:
                        report.error(
                            f"{location} length_ft disagrees with length_m × {FEET_PER_METER}"
                        )
            if geometry_type in {"Polygon", "MultiPolygon"}:
                polygons = [coordinates] if geometry_type == "Polygon" else coordinates
                for polygon_index, polygon in enumerate(polygons or []):
                    for ring_index, ring in enumerate(polygon or []):
                        if not isinstance(ring, list) or len(ring) < 4 or ring[0] != ring[-1]:
                            report.error(
                                f"{location} polygon {polygon_index + 1} ring {ring_index + 1} is not closed"
                            )
                        elif key == "zones" and ring_self_intersects(ring):
                            report.error(f"{location} has a self-intersecting zone ring")
            if geometry_type == "Point" and coordinate_pairs:
                pin_name = properties.get("id") or properties.get("label") or location
                if properties.get("status") != "placeholder":
                    pins.append((str(pin_name), coordinate_pairs[0]))
            if source.get("feature_type") in {"road", "trail"} and isinstance(properties.get("id"), str):
                segments_by_id[properties["id"]] = record

    validate_manifest_source_references(root, source_keys, report)

    cam_sites = data_by_key.get("camSites")
    if cam_sites is not None:
        position_status = cam_sites.get("properties", {}).get("position_status")
        if position_status != "placeholder":
            report.error(
                "data/cams/cam-sites.geojson position_status must remain 'placeholder' in the public repository"
            )

    boundaries = data_by_key.get("boundaries", {}).get("features", [])
    role_counts: dict[str, int] = {}
    for feature in boundaries:
        role = feature.get("properties", {}).get("role")
        if role:
            role_counts[role] = role_counts.get(role, 0) + 1
    for role in expected_roles:
        if role_counts.get(role) != 1:
            report.error(
                f"boundaries.geojson needs exactly one {role!r} role; found {role_counts.get(role, 0)}"
            )
    for role in sorted(set(role_counts) - set(expected_roles)):
        report.warn(f"boundaries.geojson contains unexpected parcel role {role!r}")

    routes = data_by_key.get("routes", {}).get("routes", [])
    for route in routes:
        route_id = route.get("id", "<unnamed route>")
        segments = route.get("segments")
        directions = route.get("segment_directions")
        if not isinstance(segments, list):
            continue
        for segment_id in segments:
            if segment_id not in segments_by_id:
                report.error(f"Route {route_id!r} references missing segment {segment_id!r}")
        if not isinstance(directions, list) or len(directions) != len(segments):
            report.error(f"Route {route_id!r} segment_directions must match segments length")
        elif any(direction not in {"forward", "reverse"} for direction in directions):
            report.error(f"Route {route_id!r} has a direction other than forward/reverse")
        derived = derive_route_metrics(route, segments_by_id)
        if derived:
            for property_name in (
                "length_ft",
                "elevation_gain_ft",
                "elevation_loss_ft",
                "elevation_profile_ft",
            ):
                if property_name not in route:
                    continue
                report.warn(
                    f"Route {route_id!r} caches redundant generated property {property_name!r}"
                )
                if property_name == "elevation_profile_ft":
                    matches = profiles_match(route[property_name], derived.get(property_name))
                else:
                    matches = derived.get(property_name) is not None and abs(
                        float(route[property_name]) - float(derived[property_name])
                    ) <= 1
                if not matches:
                    report.error(
                        f"Route {route_id!r} cached {property_name} disagrees with member segments"
                    )

    intersections = data_by_key.get("intersections", {}).get("features", [])
    for feature in intersections:
        intersection_id = feature.get("properties", {}).get("id", "<unnamed intersection>")
        for referenced_id in feature.get("properties", {}).get("features", []):
            if referenced_id not in feature_ids:
                report.error(
                    f"Intersection {intersection_id!r} references missing feature {referenced_id!r}"
                )

    for first_index, (first_name, first_point) in enumerate(pins):
        for second_name, second_point in pins[first_index + 1 :]:
            separation = distance_meters(first_point, second_point)
            if separation < minimum_pin_separation:
                report.error(
                    f"Pins {first_name!r} and {second_name!r} are only {separation:.1f} m apart; minimum is {minimum_pin_separation} m"
                )

    for segment_id, feature in segments_by_id.items():
        if not feature.get("properties", {}).get("elevation_profile_ft"):
            report.warn(f"Segment {segment_id!r} has no elevation profile yet")

    scan_forbidden_terminology(root, report)
    return report


def print_report(report: ValidationReport) -> None:
    print("Map data validation: PASS" if report.ok else "Map data validation: FAIL")
    if report.errors:
        print(f"Errors ({len(report.errors)}):")
        for error in report.errors:
            print(f"  ERROR: {error}")
    if report.warnings:
        print(f"Warnings ({len(report.warnings)}):")
        for warning in report.warnings:
            print(f"  WARNING: {warning}")
    if not report.errors and not report.warnings:
        print("No errors or warnings.")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="Repository root to validate (defaults to this working copy)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = validate_repository(args.root)
    print_report(report)
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
