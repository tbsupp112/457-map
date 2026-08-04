"use strict";

const PROPERTY_BOUNDS_PADDING = [28, 28];
const DEFAULT_MAX_ZOOM = 21;
const MAP_PREFERENCES_KEY = "457-property-map-preferences-v1";
const savedMapPreferences = readMapPreferences();
let preferencesReady = false;

const map = L.map("map", {
  zoomControl: true,
  maxZoom: DEFAULT_MAX_ZOOM,
  doubleClickZoom: true,
  preferCanvas: true,
});

// Give Leaflet a valid drawing viewport before asynchronous GeoJSON arrives.
map.setView([43.3596, -73.8348], 17);

const nysAerial = L.tileLayer(
  "https://orthos.its.ny.gov/arcgis/rest/services/wms/2022/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: DEFAULT_MAX_ZOOM,
    maxNativeZoom: 19,
    attribution: "Imagery © NYS ITS Geospatial Services (2022)",
  },
);

const topoMap = L.tileLayer(
  "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
  {
    maxZoom: DEFAULT_MAX_ZOOM,
    maxNativeZoom: 17,
    subdomains: "abc",
    attribution:
      "Map data © OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)",
  },
);

(savedMapPreferences.baseMap === "topo" ? topoMap : nysAerial).addTo(map);

const outsideMaskRenderer = L.svg({ padding: 0.5 });
const outsideMaskLayer = L.geoJSON(null, {
  renderer: outsideMaskRenderer,
  interactive: false,
  style: {
    stroke: false,
    fillColor: "url(#outside-hatch)",
    fillOpacity: 1,
    fillRule: "evenodd",
  },
}).addTo(map);

const corridorLayer = L.geoJSON(null, {
  style: {
    color: "#d5d9dc",
    weight: 3,
    opacity: 0.95,
    dashArray: "6 6",
    fillColor: "#e2e5e7",
    fillOpacity: 0.28,
  },
  onEachFeature(feature, layer) {
    const message = "National Grid powerline cut — not our land, but access is allowed.";
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      layer.bindTooltip(message, { sticky: true, direction: "top" });
    }
    layer.bindPopup(
      `<strong>${escapeHtml(feature.properties.name)}</strong><br>` +
        "Not our land, but access is allowed.<br>" +
        "<small>Shaded extent is approximate; corridor edges are not surveyed here.</small>",
    );
  },
}).addTo(map);

const roadHalo = L.geoJSON(null, {
  interactive: false,
  style: {
    color: "#473522",
    weight: 8,
    opacity: 0.78,
    lineCap: "round",
    lineJoin: "round",
  },
});

const roadsLayer = L.geoJSON(null, {
  style: {
    color: "#d89a4a",
    weight: 5,
    opacity: 0.98,
    lineCap: "round",
    lineJoin: "round",
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, `${feature.properties.status}. ${feature.properties.note}`);
  },
});
const roadsGroup = L.layerGroup([roadHalo, roadsLayer]);
addOverlayIfEnabled(roadsGroup, "roads", true);

const trailsLayer = L.geoJSON(null, {
  style: {
    color: "#63b8e8",
    weight: 3,
    opacity: 1,
    dashArray: "7 6",
    lineCap: "round",
    lineJoin: "round",
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, "Provisional walking-trail centerline from repeated phone-GPS passes.");
  },
});
addOverlayIfEnabled(trailsLayer, "trails", true);

const zonesLayer = L.geoJSON(null, {
  style: {
    color: "#f0c85f",
    weight: 3,
    opacity: 0.95,
    dashArray: "2 7",
    fillColor: "#f5dda0",
    fillOpacity: 0.14,
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, feature.properties.note);
  },
});
addOverlayIfEnabled(zonesLayer, "zones", true);

const buildingIcon = L.icon({
  iconUrl: "assets/icons/building-pin.webp",
  iconSize: [20, 27],
  iconAnchor: [10, 27],
  popupAnchor: [0, -24],
  tooltipAnchor: [0, -22],
});

const landmarksLayer = L.geoJSON(null, {
  pointToLayer(feature, latlng) {
    return L.marker(latlng, { icon: buildingIcon });
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, `${feature.properties.type}; provisional center from walked extent.`);
  },
});
addOverlayIfEnabled(landmarksLayer, "landmarks", true);

const intersectionsLayer = L.geoJSON(null, {
  pointToLayer(feature, latlng) {
    return L.circleMarker(latlng, {
      radius: 5,
      color: "#ffffff",
      weight: 2,
      fillColor: "#8e4c9e",
      fillOpacity: 1,
    });
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, feature.properties.note);
  },
});
addOverlayIfEnabled(intersectionsLayer, "intersections", false);

const boundaryHalo = L.geoJSON(null, {
  interactive: false,
  style: {
    color: "#102f29",
    weight: 8,
    opacity: 0.88,
    fillOpacity: 0,
    lineJoin: "round",
  },
}).addTo(map);

const boundaryLayer = L.geoJSON(null, {
  interactive: false,
  style: {
    color: "#5ee6bd",
    weight: 4,
    opacity: 1,
    fillColor: "#5ee6bd",
    fillOpacity: 0.03,
    lineJoin: "round",
  },
  onEachFeature(feature, layer) {
    const acres = Number(feature.properties.acres_computed).toFixed(2);
    layer.bindTooltip(`${feature.properties.name}<br>${acres} acres`, {
      permanent: true,
      direction: "center",
      className: "parcel-label",
    });
  },
}).addTo(map);

const parcelInteractionLayer = L.geoJSON(null, {
  style(feature) {
    return feature.properties.name === "Main Parcel"
      ? { color: "#000000", weight: 16, opacity: 0.001, fill: false }
      : { stroke: false, fillColor: "#000000", fillOpacity: 0.001 };
  },
  onEachFeature(feature, layer) {
    const description = feature.properties.popup_description || feature.properties.note;
    layer.bindPopup(
      `<strong>${escapeHtml(feature.properties.name)}</strong><br>` +
        `${escapeHtml(description)}`,
    );
  },
}).addTo(map);

const cornersLayer = L.geoJSON(null, {
  pointToLayer(feature, latlng) {
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "corner-marker",
        iconSize: [9, 9],
        iconAnchor: [4.5, 4.5],
      }),
    }).bindTooltip(feature.properties.label);
  },
});
addOverlayIfEnabled(cornersLayer, "corners", false);

L.control
  .layers(
    {
      "NYS aerial (2022)": nysAerial,
      "Topo map": topoMap,
    },
    {
      "Corner markers": cornersLayer,
      "Dirt roads": roadsGroup,
      "Walking trails": trailsLayer,
      "Landmarks": landmarksLayer,
      "Zones": zonesLayer,
      "Intersections": intersectionsLayer,
    },
    { collapsed: true, position: "topright" },
  )
  .addTo(map);

map.on("baselayerchange overlayadd overlayremove moveend", saveMapPreferences);
document.querySelector(".home-link").addEventListener("click", saveMapPreferences);
window.addEventListener("pagehide", saveMapPreferences);
installMobileDoubleTapZoom();

const locationStatus = document.getElementById("location-status");
const locateButton = document.getElementById("locate-button");
const locationPanel = document.querySelector(".location-panel");
const infoButton = document.getElementById("info-button");
const infoOverlay = document.getElementById("info-overlay");
const infoClose = document.getElementById("info-close");
const locationLayer = L.layerGroup().addTo(map);
let watchId = null;
let latestPosition = null;
let hasCenteredOnUser = false;
let locationStatusTimer = null;

Promise.all([
  loadGeoJson("data/property/boundaries.geojson"),
  loadGeoJson("data/property/corners.geojson"),
  loadGeoJson("data/property/powerline-corridor.geojson"),
])
  .then(([boundaryData, cornerData, corridorData]) => {
    boundaryHalo.addData(boundaryData);
    boundaryLayer.addData(boundaryData);
    parcelInteractionLayer.addData(boundaryData);
    cornersLayer.addData(cornerData);
    corridorLayer.addData(corridorData);
    outsideMaskLayer.addData(buildOutsideMask(boundaryData, corridorData));
    installOutsideHatchPattern();
    outsideMaskLayer.bringToBack();
    corridorLayer.bringToFront();
    boundaryHalo.bringToFront();
    boundaryLayer.bringToFront();
    parcelInteractionLayer.bringToFront();
    if (hasSavedMapView(savedMapPreferences)) {
      map.setView(savedMapPreferences.center, savedMapPreferences.zoom);
    } else {
      map.fitBounds(boundaryLayer.getBounds(), {
        paddingTopLeft: PROPERTY_BOUNDS_PADDING,
        paddingBottomRight: PROPERTY_BOUNDS_PADDING,
        maxZoom: 18,
      });
    }
    preferencesReady = true;
    saveMapPreferences();
  })
  .catch((error) => {
    console.error(error);
    showLocationStatus("Map data could not be loaded.");
    map.setView([43.3596, -73.8348], 17);
    preferencesReady = true;
  });

loadGeoJson("data/roads/dirt-roads.geojson")
  .then((data) => {
    roadHalo.addData(data);
    roadsLayer.addData(data);
  })
  .catch((error) => console.error(error));

loadGeoJson("data/trails/walking-trails.geojson")
  .then((data) => trailsLayer.addData(data))
  .catch((error) => console.error(error));

loadGeoJson("data/landmarks/buildings.geojson")
  .then((data) => landmarksLayer.addData(data))
  .catch((error) => console.error(error));

loadGeoJson("data/zones/zones.geojson")
  .then((data) => zonesLayer.addData(data))
  .catch((error) => console.error(error));

loadGeoJson("data/intersections/intersections.geojson")
  .then((data) => intersectionsLayer.addData(data))
  .catch((error) => console.error(error));

infoButton.addEventListener("click", openInfo);
infoClose.addEventListener("click", closeInfo);
infoOverlay.addEventListener("click", (event) => {
  if (event.target === infoOverlay) closeInfo();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !infoOverlay.hidden) closeInfo();
});

locateButton.addEventListener("click", () => {
  if (latestPosition) {
    map.setView(latestPosition.latlng, Math.max(map.getZoom(), 18));
    return;
  }
  requestInitialLocation();
});

function requestInitialLocation() {
  if (!navigator.geolocation) {
    showLocationStatus("Location is not supported on this device.");
    locateButton.disabled = true;
    return;
  }

  showLocationStatus("Requesting your location…");
  locateButton.setAttribute("aria-label", "Locating");
  locateButton.title = "Locating";
  locateButton.disabled = true;

  // Start with a quick, possibly cached fix. This is more reliable than
  // demanding high-accuracy GPS before the browser has returned any location.
  navigator.geolocation.getCurrentPosition(
    (position) => {
      updateLocation(position);
      startLocationWatch();
    },
    handleLocationError,
    {
      enableHighAccuracy: false,
      maximumAge: 60000,
      timeout: 20000,
    },
  );
}

function startLocationWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);

  watchId = navigator.geolocation.watchPosition(
    updateLocation,
    handleWatchError,
    {
      enableHighAccuracy: true,
      maximumAge: 10000,
      timeout: 45000,
    },
  );
}

function updateLocation(position) {
  const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
  const accuracy = Math.max(position.coords.accuracy, 1);
  latestPosition = { latlng, accuracy };

  locationLayer.clearLayers();
  L.circle(latlng, {
    radius: accuracy,
    color: "#ffffff",
    weight: 2,
    opacity: 0.9,
    fillColor: "#2f8cff",
    fillOpacity: 0.2,
    interactive: false,
  }).addTo(locationLayer);
  L.marker(latlng, {
    interactive: false,
    icon: L.divIcon({
      className: "location-dot",
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
  }).addTo(locationLayer);

  hideLocationStatus();
  locateButton.setAttribute("aria-label", "Center map on my location");
  locateButton.title = "Center on my location";
  locateButton.disabled = false;

  const propertyBounds = boundaryLayer.getBounds();
  if (
    !hasCenteredOnUser &&
    propertyBounds.isValid() &&
    propertyBounds.pad(0.35).contains(latlng)
  ) {
    map.setView(latlng, Math.max(map.getZoom(), 18));
    hasCenteredOnUser = true;
  }
}

function handleLocationError(error) {
  const messages = {
    1: "Location blocked. Allow access in browser settings.",
    2: "Your location is currently unavailable.",
    3: "Location request timed out. Try again.",
  };
  showLocationStatus(messages[error.code] || "Could not determine your location.");
  locateButton.setAttribute("aria-label", "Try location again");
  locateButton.title = "Try location again";
  locateButton.disabled = false;
}

function handleWatchError(error) {
  // Keep showing the most recent valid position if a later GPS update times out.
  if (latestPosition && error.code !== 1) return;
  handleLocationError(error);
}

async function loadGeoJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
  return response.json();
}

function buildOutsideMask(boundaryData, corridorData) {
  const bounds = L.geoJSON(boundaryData).getBounds().pad(2);
  const outerRing = [
    [bounds.getWest(), bounds.getSouth()],
    [bounds.getEast(), bounds.getSouth()],
    [bounds.getEast(), bounds.getNorth()],
    [bounds.getWest(), bounds.getNorth()],
    [bounds.getWest(), bounds.getSouth()],
  ];
  const parcelHoles = boundaryData.features.map(
    (feature) => feature.geometry.coordinates[0],
  );
  const corridorHoles = corridorData.features.map(
    (feature) => feature.geometry.coordinates[0],
  );

  return {
    type: "Feature",
    properties: { purpose: "Dim unowned surroundings" },
    geometry: {
      type: "Polygon",
      coordinates: [outerRing, ...parcelHoles, ...corridorHoles],
    },
  };
}

function installOutsideHatchPattern() {
  const svg = outsideMaskRenderer._container;
  if (!svg || svg.querySelector("#outside-hatch")) return;

  const svgNamespace = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(svgNamespace, "defs");
  const pattern = document.createElementNS(svgNamespace, "pattern");
  pattern.setAttribute("id", "outside-hatch");
  pattern.setAttribute("width", "18");
  pattern.setAttribute("height", "18");
  pattern.setAttribute("patternUnits", "userSpaceOnUse");

  const background = document.createElementNS(svgNamespace, "rect");
  background.setAttribute("width", "18");
  background.setAttribute("height", "18");
  background.setAttribute("fill", "#fff4dc");
  background.setAttribute("fill-opacity", "0.34");

  const hatch = document.createElementNS(svgNamespace, "path");
  hatch.setAttribute("d", "M-4 4 L4 -4 M0 18 L18 0 M14 22 L22 14");
  hatch.setAttribute("fill", "none");
  hatch.setAttribute("stroke", "#934c13");
  hatch.setAttribute("stroke-opacity", "0.76");
  hatch.setAttribute("stroke-width", "1.65");
  hatch.setAttribute("stroke-dasharray", "5 4");

  pattern.append(background, hatch);
  defs.append(pattern);
  svg.prepend(defs);
}

function openInfo() {
  infoOverlay.hidden = false;
  infoButton.setAttribute("aria-expanded", "true");
  infoClose.focus();
}

function closeInfo() {
  infoOverlay.hidden = true;
  infoButton.setAttribute("aria-expanded", "false");
  infoButton.focus();
}

function showLocationStatus(message, hideAfter = 0) {
  locationStatus.textContent = message;
  locationPanel.dataset.showStatus = "true";
  window.clearTimeout(locationStatusTimer);
  if (hideAfter) {
    locationStatusTimer = window.setTimeout(() => {
      locationPanel.dataset.showStatus = "false";
    }, hideAfter);
  }
}

function hideLocationStatus() {
  window.clearTimeout(locationStatusTimer);
  locationPanel.dataset.showStatus = "false";
}

function bindMapFeature(layer, feature, detail) {
  const name = escapeHtml(feature.properties.name);
  const safeDetail = escapeHtml(detail || "Approximate mapped feature.");
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    layer.bindTooltip(name, { sticky: true, direction: "top" });
  }
  layer.bindPopup(`<strong>${name}</strong><br>${safeDetail}`);
}

function readMapPreferences() {
  try {
    const value = JSON.parse(window.localStorage.getItem(MAP_PREFERENCES_KEY));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function hasSavedMapView(preferences) {
  return (
    Array.isArray(preferences.center) &&
    preferences.center.length === 2 &&
    preferences.center.every(Number.isFinite) &&
    Number.isFinite(preferences.zoom) &&
    preferences.zoom >= 0 &&
    preferences.zoom <= DEFAULT_MAX_ZOOM
  );
}

function addOverlayIfEnabled(layer, key, enabledByDefault) {
  const savedValue = savedMapPreferences.overlays?.[key];
  if (typeof savedValue === "boolean" ? savedValue : enabledByDefault) {
    layer.addTo(map);
  }
}

function saveMapPreferences() {
  if (!preferencesReady) return;

  const center = map.getCenter();
  const preferences = {
    baseMap: map.hasLayer(topoMap) ? "topo" : "aerial",
    overlays: {
      corners: map.hasLayer(cornersLayer),
      roads: map.hasLayer(roadsGroup),
      trails: map.hasLayer(trailsLayer),
      landmarks: map.hasLayer(landmarksLayer),
      zones: map.hasLayer(zonesLayer),
      intersections: map.hasLayer(intersectionsLayer),
    },
    center: [Number(center.lat.toFixed(7)), Number(center.lng.toFixed(7))],
    zoom: map.getZoom(),
  };

  try {
    window.localStorage.setItem(MAP_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // The map remains usable when storage is blocked or unavailable.
  }
}

function installMobileDoubleTapZoom() {
  const container = map.getContainer();
  let previousTap = null;

  container.addEventListener(
    "touchend",
    (event) => {
      if (
        event.changedTouches.length !== 1 ||
        event.target.closest(".leaflet-control, .leaflet-popup")
      ) {
        previousTap = null;
        return;
      }

      const touch = event.changedTouches[0];
      const tap = { time: performance.now(), x: touch.clientX, y: touch.clientY };
      const isDoubleTap =
        previousTap &&
        tap.time - previousTap.time <= 325 &&
        Math.hypot(tap.x - previousTap.x, tap.y - previousTap.y) <= 30;

      if (!isDoubleTap) {
        previousTap = tap;
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      previousTap = null;
      const bounds = container.getBoundingClientRect();
      const point = L.point(tap.x - bounds.left, tap.y - bounds.top);
      map.setZoomAround(point, Math.min(map.getZoom() + 1, map.getMaxZoom()));
    },
    { passive: false },
  );
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value ?? "";
  return element.innerHTML;
}
