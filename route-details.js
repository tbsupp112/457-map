"use strict";

(function exposeRouteDetails() {
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

  function formatDistance(lengthFeet) {
    if (!Number.isFinite(Number(lengthFeet))) return "";
    const feet = Number(lengthFeet);
    const miles = feet / 5280;
    return miles < 0.15
      ? `${Math.round(feet).toLocaleString()} ft`
      : `${miles.toFixed(2)} mi`;
  }

  function distanceLabel(route) {
    const distance = formatDistance(route.length_ft);
    if (!distance) return "";
    return route.shape === "out-and-back" ? `${distance} round trip` : distance;
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
    const gain = document.createElement("span");
    const loss = document.createElement("span");
    gain.innerHTML = `<small>Total gain</small><strong>+${Math.round(Number(route.elevation_gain_ft) || 0).toLocaleString()} ft</strong>`;
    loss.innerHTML = `<small>Total loss</small><strong>\u2212${Math.round(Number(route.elevation_loss_ft) || 0).toLocaleString()} ft</strong>`;
    stats.append(gain, loss);

    const note = document.createElement("p");
    note.className = "route-elevation-note";
    note.textContent = "Approximate profile from phone GPS; the distance and totals cover the complete round trip.";
    details.append(heading, closeButton, createElevationGraphic(route), stats, note);

    if (includeMapLink) {
      const mapLink = document.createElement("a");
      mapLink.className = "route-map-link";
      mapLink.href = `map.html?feature=${encodeURIComponent(route.id)}`;
      mapLink.textContent = "View route on map";
      details.append(mapLink);
    }

    return { details, closeButton };
  }

  window.RouteDetails = Object.freeze({ createPanel, distanceLabel, formatDistance });
})();
