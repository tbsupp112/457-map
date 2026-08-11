"use strict";

(function exposeRouteDetails() {
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  // Route summaries switch at 0.10 mile. Live landmark and guidance text use
  // a separate 0.15-mile threshold in app.js so the two policies stay explicit.
  const ROUTE_MILES_THRESHOLD_FEET = 0.10 * 5280;

  function formatDistance(
    lengthFeet,
    {
      approximate = false,
      hereThresholdFeet = null,
      milesThresholdFeet = ROUTE_MILES_THRESHOLD_FEET,
    } = {},
  ) {
    if (!Number.isFinite(Number(lengthFeet))) return "";
    const feet = Number(lengthFeet);
    if (Number.isFinite(hereThresholdFeet) && feet < hereThresholdFeet) {
      return "you're here";
    }
    const miles = feet / 5280;
    const prefix = approximate ? "about " : "";
    if (feet >= milesThresholdFeet) return `${prefix}${miles.toFixed(2)} mi`;
    const increment = approximate ? (feet < 300 ? 10 : 25) : 1;
    const displayedFeet = Math.round(feet / increment) * increment;
    return `${prefix}${displayedFeet.toLocaleString()} ft`;
  }

  function distanceLabel(route) {
    const distance = formatDistance(route.length_ft);
    if (!distance) return "";
    return route.shape === "out-and-back" ? `${distance} round trip` : distance;
  }

  function deriveRouteMetrics(route, segmentFeaturesById) {
    const segments = route.segments.map((id) => segmentFeaturesById.get(id));
    if (segments.some((segment) => !segment)) return { ...route };
    const directions = route.segment_directions || route.segments.map(() => "forward");
    const segmentLengths = segments.map(segmentLengthFeet);
    if (segmentLengths.some((length) => !Number.isFinite(length) || length <= 0)) {
      return { ...route };
    }

    const outAndBack = route.shape === "out-and-back";
    const outboundLength = segmentLengths.reduce((total, length) => total + length, 0);
    const prepared = {
      ...route,
      length_ft: Math.round(outboundLength * (outAndBack ? 2 : 1)),
    };
    const profile = buildRouteElevationProfile(segments, directions, segmentLengths, outAndBack);
    if (profile) prepared.elevation_profile_ft = profile;
    const elevationTotals = buildRouteElevationTotals(segments, directions, outAndBack);
    if (elevationTotals) {
      prepared.elevation_gain_ft = elevationTotals.gain;
      prepared.elevation_loss_ft = elevationTotals.loss;
    }
    return prepared;
  }

  function segmentLengthFeet(feature) {
    const recordedMeters = Number(feature.properties?.length_m);
    if (Number.isFinite(recordedMeters) && recordedMeters > 0) {
      return recordedMeters * 3.28084;
    }
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return NaN;
    return coordinates.slice(1).reduce(
      (total, coordinate, index) =>
        total + coordinateDistanceFeet(coordinates[index], coordinate),
      0,
    );
  }

  function coordinateDistanceFeet([firstLon, firstLat], [secondLon, secondLat]) {
    const radians = Math.PI / 180;
    const latitude1 = firstLat * radians;
    const latitude2 = secondLat * radians;
    const deltaLatitude = (secondLat - firstLat) * radians;
    const deltaLongitude = (secondLon - firstLon) * radians;
    const haversine =
      Math.sin(deltaLatitude / 2) ** 2 +
      Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
    return (
      6371000 *
      2 *
      Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)) *
      3.28084
    );
  }

  function buildRouteElevationProfile(segments, directions, lengths, outAndBack) {
    const outbound = [];
    let offset = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const rawProfile = segments[index].properties?.elevation_profile_ft;
      if (
        !Array.isArray(rawProfile) ||
        rawProfile.length < 2 ||
        rawProfile.some((elevation) => !Number.isFinite(Number(elevation)))
      ) {
        return null;
      }
      const elevations = directions[index] === "reverse"
        ? [...rawProfile].reverse()
        : rawProfile;
      const step = lengths[index] / (elevations.length - 1);
      elevations.forEach((elevation, pointIndex) => {
        if (outbound.length > 0 && pointIndex === 0) return;
        outbound.push([
          Number((offset + pointIndex * step).toFixed(1)),
          Number(Number(elevation).toFixed(1)),
        ]);
      });
      offset += lengths[index];
    }
    if (!outAndBack) return outbound;
    const returning = outbound
      .slice(0, -1)
      .reverse()
      .map(([distance, elevation]) => [
        Number((offset + (offset - distance)).toFixed(1)),
        elevation,
      ]);
    return [...outbound, ...returning];
  }

  function buildRouteElevationTotals(segments, directions, outAndBack) {
    let outboundGain = 0;
    let outboundLoss = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const gain = Number(segments[index].properties?.elevation_gain_ft);
      const loss = Number(segments[index].properties?.elevation_loss_ft);
      if (!Number.isFinite(gain) || !Number.isFinite(loss)) return null;
      if (directions[index] === "reverse") {
        outboundGain += loss;
        outboundLoss += gain;
      } else {
        outboundGain += gain;
        outboundLoss += loss;
      }
    }
    return {
      gain: Math.round(outboundGain + (outAndBack ? outboundLoss : 0)),
      loss: Math.round(outboundLoss + (outAndBack ? outboundGain : 0)),
    };
  }

  function createSvgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NAMESPACE, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  }

  function createElevationGraphic(route) {
    const points = Array.isArray(route.elevation_profile_ft)
      ? route.elevation_profile_ft.filter(
          (point) =>
            Array.isArray(point) &&
            point.length === 2 &&
            Number.isFinite(Number(point[0])) &&
            Number.isFinite(Number(point[1])),
        )
      : [];
    if (points.length < 2) {
      const unavailable = document.createElement("p");
      unavailable.className = "route-elevation-unavailable";
      unavailable.textContent = "Elevation profile is not available for this route yet.";
      return unavailable;
    }

    const width = 320;
    const height = 128;
    const left = 12;
    const right = 308;
    const top = 14;
    const bottom = 102;
    const maximumDistance = Math.max(...points.map((point) => Number(point[0])), 1);
    const elevations = points.map((point) => Number(point[1]));
    const minimumElevation = Math.min(...elevations);
    const maximumElevation = Math.max(...elevations);
    const elevationSpan = Math.max(maximumElevation - minimumElevation, 1);
    const plotted = points.map(([distance, elevation]) => {
      const x = left + (Number(distance) / maximumDistance) * (right - left);
      const y = bottom - ((Number(elevation) - minimumElevation) / elevationSpan) * (bottom - top);
      return [x, y];
    });
    const linePath = plotted
      .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(" ");
    const areaPath = `${linePath} L${right} ${bottom} L${left} ${bottom} Z`;
    const svg = createSvgElement("svg", {
      class: "route-elevation-chart",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `Elevation profile from ${Math.round(minimumElevation)} to ${Math.round(maximumElevation)} feet`,
    });
    svg.append(
      createSvgElement("line", {
        class: "route-elevation-baseline",
        x1: left,
        y1: bottom,
        x2: right,
        y2: bottom,
      }),
      createSvgElement("path", { class: "route-elevation-area", d: areaPath }),
      createSvgElement("path", { class: "route-elevation-line", d: linePath }),
    );
    const highLabel = createSvgElement("text", {
      class: "route-elevation-label",
      x: left,
      y: 11,
    });
    highLabel.textContent = `${Math.round(maximumElevation)} ft`;
    const routeLengthLabel = createSvgElement("text", {
      class: "route-elevation-label route-elevation-label--end",
      x: right,
      y: 121,
      "text-anchor": "end",
    });
    routeLengthLabel.textContent = distanceLabel(route);
    svg.append(highLabel, routeLengthLabel);
    return svg;
  }

  function createPanel(route, { includeMapLink = false, id = "", className = "" } = {}) {
    const details = document.createElement("aside");
    details.className = ["route-details-popout", className].filter(Boolean).join(" ");
    if (id) details.id = id;
    details.hidden = true;
    details.setAttribute("aria-label", `${route.name} details`);

    const heading = document.createElement("h3");
    heading.textContent = `${route.name} elevation`;
    const closeButton = document.createElement("button");
    closeButton.className = "route-details-close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close route details");
    closeButton.textContent = "\u00d7";

    const stats = document.createElement("div");
    stats.className = "route-elevation-stats";
    const gainValue = Number(route.elevation_gain_ft);
    const lossValue = Number(route.elevation_loss_ft);
    if (Number.isFinite(gainValue)) {
      const gain = document.createElement("span");
      gain.innerHTML = `<small>Total gain</small><strong>+${Math.round(gainValue).toLocaleString()} ft</strong>`;
      stats.append(gain);
    }
    if (Number.isFinite(lossValue)) {
      const loss = document.createElement("span");
      loss.innerHTML = `<small>Total loss</small><strong>\u2212${Math.round(lossValue).toLocaleString()} ft</strong>`;
      stats.append(loss);
    }

    const note = document.createElement("p");
    note.className = "route-elevation-note";
    note.textContent = "Approximate profile from phone GPS; the distance and totals cover the complete round trip.";
    details.append(heading, closeButton, createElevationGraphic(route));
    if (stats.childElementCount > 0) details.append(stats, note);

    if (includeMapLink) {
      const mapLink = document.createElement("a");
      mapLink.className = "route-map-link";
      mapLink.href = `map.html?feature=${encodeURIComponent(route.id)}`;
      mapLink.textContent = "View route on map";
      details.append(mapLink);
    }

    return { details, closeButton };
  }

  window.RouteDetails = Object.freeze({
    createPanel,
    deriveRouteMetrics,
    distanceLabel,
    formatDistance,
  });
})();
