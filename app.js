"use strict";

const PROPERTY_BOUNDS_PADDING = [28, 28];
const DEFAULT_MAX_ZOOM = 21;
const RAPID_DOUBLE_TAP_MS = 250;
const OFF_PROPERTY_MIN_DISTANCE_METERS = 3;
const OFF_PROPERTY_ENTER_FIXES = 3;
const OFF_PROPERTY_ENTER_DELAY_MS = 8000;
const OFF_PROPERTY_LEAVE_FIXES = 2;
const OFF_PROPERTY_ALERT_MS = 3500;
const ARRIVAL_DISTANCE_METERS = 7.62;
const MAGNETIC_DECLINATION_DEG = -13.5;
const GUIDANCE_HEADING_TIMEOUT_MS = 3000;
const GUIDANCE_SMOOTHING_TIME_MS = 250;
const GUIDANCE_VISUAL_INTERVAL_MS = 100;
const LAYER_CONTROL_COLLAPSE_DELAY_MS = 280;
const PROPERTY_REFERENCE_LAT = 43.3596;
const PROPERTY_REFERENCE_LON = -73.8350;
const METERS_PER_LATITUDE_DEGREE = 111132;
const METERS_PER_LONGITUDE_DEGREE =
  111320 * Math.cos((PROPERTY_REFERENCE_LAT * Math.PI) / 180);
const MAP_PREFERENCES_KEY = "457-property-map-preferences-v1";
const DEFAULT_OVERLAY_VISIBILITY = Object.freeze({
  corners: false,
  roads: true,
  trails: true,
  landmarks: true,
  zones: true,
  intersections: false,
});
const savedMapPreferences = readMapPreferences();
let preferencesReady = false;
let pendingFeaturePopupTimer = null;
let suppressFeaturePopupsUntil = 0;

const offPropertyTracker = {
  polygonRings: null,
  isConfirmedOff: false,
  enteringFixCount: 0,
  enteringStartedAt: 0,
  leavingFixCount: 0,
  hasAnnouncedOffProperty: false,
};

const guidanceTracker = {
  targets: new Map(),
  target: null,
  isActive: false,
  isWaitingForLocation: false,
  orientationPermission: "unknown",
  hideGuideButton: false,
  orientationEvents: [],
  androidAbsoluteSeen: false,
  smoothedSin: null,
  smoothedCos: null,
  lastHeadingAt: 0,
  lastVisualUpdateAt: 0,
  targetBearing: null,
  headingTimeout: null,
  tintStartTimer: null,
  tintHideTimer: null,
  pillHideTimer: null,
};

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
    registerGuidanceTarget(feature);
    bindMapFeature(
      layer,
      feature,
      `${feature.properties.type}; provisional center from walked extent.`,
      { landmark: true },
    );
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
}).addTo(map);

const mainBoundaryInteractionLayer = L.geoJSON(null, {
  style: { color: "#000000", weight: 12, opacity: 0.001 },
  onEachFeature(feature, layer) {
    const description = feature.properties.popup_description || feature.properties.note;
    layer.bindPopup(
      `<strong>${escapeHtml(feature.properties.name)}</strong><br>` +
        `${escapeHtml(description)}`,
    );
  },
}).addTo(map);

const sliverInteractionLayer = L.geoJSON(null, {
  filter(feature) {
    return feature.properties.name === "Sliver";
  },
  style: { stroke: false, fillColor: "#000000", fillOpacity: 0.001 },
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

const layerControl = L.control
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

installLayerResetButton(layerControl);
installLayerControlHoverDelay(layerControl);

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
const guidanceTint = document.getElementById("guidance-tint");
const guidancePill = document.getElementById("guidance-pill");
const guidanceDismiss = document.getElementById("guidance-dismiss");
const guidancePillText = document.getElementById("guidance-pill-text");
const locationLayer = L.layerGroup().addTo(map);
let watchId = null;
let latestPosition = null;
let hasCenteredOnUser = false;
let locationStatusTimer = null;
let locationAccuracyCircle = null;
let locationMarker = null;
let offPropertyTooltipTimer = null;

map.getContainer().addEventListener("click", handleGuideButtonClick, true);
guidanceDismiss.addEventListener("click", stopGuidance);

Promise.all([
  loadGeoJson("data/property/boundaries.geojson"),
  loadGeoJson("data/property/corners.geojson"),
  loadGeoJson("data/property/powerline-corridor.geojson"),
])
  .then(([boundaryData, cornerData, corridorData]) => {
    offPropertyTracker.polygonRings = extractOuterPolygonRings(
      boundaryData,
      corridorData,
    );
    boundaryHalo.addData(boundaryData);
    boundaryLayer.addData(boundaryData);
    mainBoundaryInteractionLayer.addData(buildMainBoundaryLine(boundaryData));
    sliverInteractionLayer.addData(boundaryData);
    cornersLayer.addData(cornerData);
    corridorLayer.addData(corridorData);
    outsideMaskLayer.addData(buildOutsideMask(boundaryData, corridorData));
    installOutsideHatchPattern();
    outsideMaskLayer.bringToBack();
    corridorLayer.bringToFront();
    boundaryHalo.bringToFront();
    boundaryLayer.bringToFront();
    mainBoundaryInteractionLayer.bringToFront();
    sliverInteractionLayer.bringToFront();
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

  const classification = classifyPropertyLocation(latlng, accuracy);
  const enteredConfirmedOff = updateOffPropertyState(classification);
  const dotClassName = offPropertyTracker.isConfirmedOff
    ? "location-dot location-dot--off"
    : "location-dot";

  if (!locationAccuracyCircle) {
    locationAccuracyCircle = L.circle(latlng, {
      radius: accuracy,
      color: "#ffffff",
      weight: 2,
      opacity: 0.9,
      fillColor: "#2f8cff",
      fillOpacity: 0.2,
      interactive: false,
    }).addTo(locationLayer);
  } else {
    locationAccuracyCircle.setLatLng(latlng).setRadius(accuracy);
  }

  const locationIcon = L.divIcon({
    className: dotClassName,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  if (!locationMarker) {
    locationMarker = L.marker(latlng, {
      interactive: false,
      icon: locationIcon,
    }).addTo(locationLayer);
  } else {
    locationMarker.setLatLng(latlng).setIcon(locationIcon);
  }

  if (enteredConfirmedOff && !offPropertyTracker.hasAnnouncedOffProperty) {
    announceOffProperty();
  }

  updateGuidanceFromPosition(latlng);

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

function extractOuterPolygonRings(...featureCollections) {
  const rings = [];
  featureCollections.forEach((collection) => {
    collection.features.forEach((feature) => {
      if (feature.geometry.type === "Polygon") {
        rings.push(feature.geometry.coordinates[0]);
      } else if (feature.geometry.type === "MultiPolygon") {
        feature.geometry.coordinates.forEach((polygon) => rings.push(polygon[0]));
      }
    });
  });
  return rings;
}

function classifyPropertyLocation(latlng, accuracy) {
  const rings = offPropertyTracker.polygonRings;
  if (!rings || rings.length === 0) return "UNKNOWN";

  const point = projectToPropertyMeters([latlng.lng, latlng.lat]);
  const projectedRings = rings.map((ring) => ring.map(projectToPropertyMeters));
  if (projectedRings.some((ring) => isPointInsideRing(point, ring))) {
    return "INSIDE";
  }

  const nearestBoundaryDistance = Math.min(
    ...projectedRings.map((ring) => distanceToRing(point, ring)),
  );
  return nearestBoundaryDistance > Math.max(OFF_PROPERTY_MIN_DISTANCE_METERS, accuracy)
    ? "OFF"
    : "UNKNOWN";
}

function updateOffPropertyState(classification) {
  const now = performance.now();

  if (classification === "OFF") {
    offPropertyTracker.leavingFixCount = 0;
    if (offPropertyTracker.isConfirmedOff) return false;

    if (offPropertyTracker.enteringFixCount === 0) {
      offPropertyTracker.enteringStartedAt = now;
    }
    offPropertyTracker.enteringFixCount += 1;
    if (
      offPropertyTracker.enteringFixCount >= OFF_PROPERTY_ENTER_FIXES &&
      now - offPropertyTracker.enteringStartedAt >= OFF_PROPERTY_ENTER_DELAY_MS
    ) {
      offPropertyTracker.isConfirmedOff = true;
      offPropertyTracker.enteringFixCount = 0;
      return true;
    }
    return false;
  }

  offPropertyTracker.enteringFixCount = 0;
  offPropertyTracker.enteringStartedAt = 0;
  if (!offPropertyTracker.isConfirmedOff) return false;

  offPropertyTracker.leavingFixCount += 1;
  if (offPropertyTracker.leavingFixCount >= OFF_PROPERTY_LEAVE_FIXES) {
    offPropertyTracker.isConfirmedOff = false;
    offPropertyTracker.leavingFixCount = 0;
  }
  return false;
}

function announceOffProperty() {
  offPropertyTracker.hasAnnouncedOffProperty = true;
  locationMarker
    .bindTooltip("You may be off 457 property", {
      permanent: true,
      direction: "top",
      offset: [0, -10],
      opacity: 1,
      className: "off-property-tooltip",
    })
    .openTooltip();

  window.clearTimeout(offPropertyTooltipTimer);
  offPropertyTooltipTimer = window.setTimeout(() => {
    locationMarker.closeTooltip().unbindTooltip();
    offPropertyTooltipTimer = null;
  }, OFF_PROPERTY_ALERT_MS);

  if (typeof navigator.vibrate === "function") navigator.vibrate(15);
}

function projectToPropertyMeters([longitude, latitude]) {
  return [
    (longitude - PROPERTY_REFERENCE_LON) * METERS_PER_LONGITUDE_DEGREE,
    (latitude - PROPERTY_REFERENCE_LAT) * METERS_PER_LATITUDE_DEGREE,
  ];
}

function isPointInsideRing([x, y], ring) {
  let isInside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crossesRay = yi > y !== yj > y;
    if (crossesRay && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      isInside = !isInside;
    }
  }
  return isInside;
}

function distanceToRing(point, ring) {
  let nearestDistance = Infinity;
  for (let i = 1; i < ring.length; i += 1) {
    nearestDistance = Math.min(
      nearestDistance,
      distanceToSegment(point, ring[i - 1], ring[i]),
    );
  }
  return nearestDistance;
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);

  const position = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(px - (ax + position * dx), py - (ay + position * dy));
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
  pauseGuidanceForLocation();
  // Keep showing the most recent valid position if a later GPS update times out.
  if (latestPosition && error.code !== 1) return;
  handleLocationError(error);
}

async function loadGeoJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
  return response.json();
}

function buildMainBoundaryLine(boundaryData) {
  const mainParcel = boundaryData.features.find(
    (feature) => feature.properties.name === "Main Parcel",
  );
  if (!mainParcel) return { type: "FeatureCollection", features: [] };

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: mainParcel.properties,
        geometry: {
          type: "LineString",
          coordinates: mainParcel.geometry.coordinates[0],
        },
      },
    ],
  };
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

function registerGuidanceTarget(feature) {
  if (feature.geometry.type !== "Point" || !feature.properties.id) return;
  const [longitude, latitude] = feature.geometry.coordinates;
  guidanceTracker.targets.set(feature.properties.id, {
    id: feature.properties.id,
    name: feature.properties.name,
    latlng: L.latLng(latitude, longitude),
  });
}

function buildMapFeaturePopup(feature, detail, options = {}) {
  const name = escapeHtml(feature.properties.name);
  const safeDetail = escapeHtml(detail || "Approximate mapped feature.");
  let popupHtml = `<strong>${name}</strong><br>${safeDetail}`;
  if (!options.landmark || !latestPosition) return popupHtml;

  const target = guidanceTracker.targets.get(feature.properties.id);
  if (!target) return popupHtml;

  const distanceMeters = distanceBetweenLatLngs(latestPosition.latlng, target.latlng);
  const bearing = calculateTrueBearing(latestPosition.latlng, target.latlng);
  popupHtml +=
    `<span class="landmark-distance">${escapeHtml(formatLandmarkDistance(distanceMeters, bearing))}</span>`;
  if (canOfferCompassGuidance()) {
    popupHtml +=
      `<button class="guide-me-button" type="button" data-landmark-id="${escapeHtml(target.id)}">` +
      "Guide me</button>";
  }
  return popupHtml;
}

function bindMapFeature(layer, feature, detail, options = {}) {
  const hasFinePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (hasFinePointer) {
    layer.bindTooltip(escapeHtml(feature.properties.name), {
      sticky: true,
      direction: "top",
    });
    layer.bindPopup(() => buildMapFeaturePopup(feature, detail, options));
    return;
  }

  layer.on("click", (event) => {
    window.clearTimeout(pendingFeaturePopupTimer);
    if (performance.now() < suppressFeaturePopupsUntil) return;

    pendingFeaturePopupTimer = window.setTimeout(() => {
      if (performance.now() < suppressFeaturePopupsUntil) return;
      L.popup()
        .setLatLng(event.latlng)
        .setContent(buildMapFeaturePopup(feature, detail, options))
        .openOn(map);
    }, RAPID_DOUBLE_TAP_MS + 20);
  });
}

function formatLandmarkDistance(distanceMeters, bearing) {
  const distanceFeet = distanceMeters * 3.28084;
  if (distanceFeet < 15) return "you're here";
  const increment = distanceFeet < 300 ? 10 : 25;
  const roundedFeet = Math.round(distanceFeet / increment) * increment;
  return `about ${roundedFeet} ft \u00b7 ${bearingToCompassPoint(bearing)}`;
}

function bearingToCompassPoint(bearing) {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(normalizeAngle(bearing) / 45) % directions.length];
}

function distanceBetweenLatLngs(from, to) {
  const radians = Math.PI / 180;
  const lat1 = from.lat * radians;
  const lat2 = to.lat * radians;
  const deltaLat = (to.lat - from.lat) * radians;
  const deltaLon = (to.lng - from.lng) * radians;
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function calculateTrueBearing(from, to) {
  const radians = Math.PI / 180;
  const lat1 = from.lat * radians;
  const lat2 = to.lat * radians;
  const deltaLon = (to.lng - from.lng) * radians;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return normalizeAngle((Math.atan2(y, x) * 180) / Math.PI);
}

function normalizeAngle(angle) {
  return ((angle % 360) + 360) % 360;
}

function normalizeBearingError(angle) {
  return ((angle + 540) % 360) - 180;
}

function canOfferCompassGuidance() {
  const hasCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const hasOrientationSupport =
    "DeviceOrientationEvent" in window ||
    "ondeviceorientation" in window ||
    "ondeviceorientationabsolute" in window;
  return hasCoarsePointer && hasOrientationSupport && !guidanceTracker.hideGuideButton;
}

function handleGuideButtonClick(event) {
  const button = event.target.closest?.(".guide-me-button");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  startGuidance(button.dataset.landmarkId);
}

async function startGuidance(targetId) {
  const target = guidanceTracker.targets.get(targetId);
  if (!target || !latestPosition) return;

  clearGuidanceTimers();
  guidanceTracker.target = target;
  if (guidanceTracker.isActive) {
    updateGuidanceFromPosition(latestPosition.latlng);
    map.closePopup();
    return;
  }

  if (distanceBetweenLatLngs(latestPosition.latlng, target.latlng) <= ARRIVAL_DISTANCE_METERS) {
    showGuidanceArrival();
    map.closePopup();
    return;
  }

  const permissionRequest = window.DeviceOrientationEvent?.requestPermission;
  if (
    typeof permissionRequest === "function" &&
    guidanceTracker.orientationPermission !== "granted"
  ) {
    try {
      const permission = await permissionRequest.call(window.DeviceOrientationEvent);
      if (permission !== "granted") {
        declineCompassGuidance();
        return;
      }
      guidanceTracker.orientationPermission = "granted";
    } catch {
      declineCompassGuidance();
      return;
    }
  }

  guidanceTracker.isActive = true;
  guidanceTracker.isWaitingForLocation = false;
  guidanceTracker.androidAbsoluteSeen = false;
  guidanceTracker.smoothedSin = null;
  guidanceTracker.smoothedCos = null;
  guidanceTracker.lastHeadingAt = 0;
  guidanceTracker.lastVisualUpdateAt = 0;
  setGuidancePill(`Guiding to ${target.name}`);
  attachOrientationListeners(typeof permissionRequest === "function");
  updateGuidanceFromPosition(latestPosition.latlng);
  guidanceTracker.headingTimeout = window.setTimeout(() => {
    guidanceTracker.hideGuideButton = true;
    stopGuidance();
  }, GUIDANCE_HEADING_TIMEOUT_MS);
  map.closePopup();
}

function declineCompassGuidance() {
  guidanceTracker.orientationPermission = "denied";
  guidanceTracker.hideGuideButton = true;
  const popup = map._popup;
  if (!popup) return;
  popup.setContent('<span class="compass-note">Compass access was declined</span>');
  window.setTimeout(() => {
    if (map._popup === popup) map.closePopup();
  }, 2500);
}

function attachOrientationListeners(isIosPermissionPath) {
  detachOrientationListeners();
  const eventNames = isIosPermissionPath
    ? ["deviceorientation"]
    : ["deviceorientationabsolute", "deviceorientation"];
  eventNames.forEach((eventName) => {
    window.addEventListener(eventName, handleOrientationEvent, true);
  });
  guidanceTracker.orientationEvents = eventNames;
}

function detachOrientationListeners() {
  guidanceTracker.orientationEvents.forEach((eventName) => {
    window.removeEventListener(eventName, handleOrientationEvent, true);
  });
  guidanceTracker.orientationEvents = [];
}

function handleOrientationEvent(event) {
  let heading = null;
  let isAndroidHeading = false;

  if (Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
  } else if (event.type === "deviceorientationabsolute" && Number.isFinite(event.alpha)) {
    guidanceTracker.androidAbsoluteSeen = true;
    heading = 360 - event.alpha;
    isAndroidHeading = true;
  } else if (
    event.type === "deviceorientation" &&
    event.absolute === true &&
    !guidanceTracker.androidAbsoluteSeen &&
    Number.isFinite(event.alpha)
  ) {
    heading = 360 - event.alpha;
    isAndroidHeading = true;
  }

  if (!Number.isFinite(heading)) return;
  const screenRotation = Number(screen.orientation?.angle ?? window.orientation) || 0;
  // Android absolute alpha is magnetic near Lake Luzerne. Field-verify this
  // correction while standing along a known bearing such as Mountain Drive.
  if (isAndroidHeading) heading += MAGNETIC_DECLINATION_DEG;
  heading = normalizeAngle(heading + screenRotation);

  window.clearTimeout(guidanceTracker.headingTimeout);
  guidanceTracker.headingTimeout = null;
  smoothGuidanceHeading(heading);
}

function smoothGuidanceHeading(heading) {
  const now = performance.now();
  const radians = (heading * Math.PI) / 180;
  if (guidanceTracker.smoothedSin === null) {
    guidanceTracker.smoothedSin = Math.sin(radians);
    guidanceTracker.smoothedCos = Math.cos(radians);
  } else {
    const elapsed = Math.max(0, now - guidanceTracker.lastHeadingAt);
    const weight = 1 - Math.exp(-elapsed / GUIDANCE_SMOOTHING_TIME_MS);
    guidanceTracker.smoothedSin +=
      weight * (Math.sin(radians) - guidanceTracker.smoothedSin);
    guidanceTracker.smoothedCos +=
      weight * (Math.cos(radians) - guidanceTracker.smoothedCos);
  }
  guidanceTracker.lastHeadingAt = now;

  if (
    guidanceTracker.targetBearing === null ||
    now - guidanceTracker.lastVisualUpdateAt < GUIDANCE_VISUAL_INTERVAL_MS
  ) {
    return;
  }
  guidanceTracker.lastVisualUpdateAt = now;
  const filteredHeading = normalizeAngle(
    (Math.atan2(guidanceTracker.smoothedSin, guidanceTracker.smoothedCos) * 180) /
      Math.PI,
  );
  renderGuidanceTint(normalizeBearingError(guidanceTracker.targetBearing - filteredHeading));
}

function updateGuidanceFromPosition(latlng) {
  if (!guidanceTracker.isActive || !guidanceTracker.target) return;
  const distance = distanceBetweenLatLngs(latlng, guidanceTracker.target.latlng);
  if (distance <= ARRIVAL_DISTANCE_METERS) {
    showGuidanceArrival();
    return;
  }

  guidanceTracker.isWaitingForLocation = false;
  guidanceTracker.targetBearing = calculateTrueBearing(latlng, guidanceTracker.target.latlng);
  setGuidancePill(`Guiding to ${guidanceTracker.target.name}`);
  if (guidanceTracker.smoothedSin !== null) {
    const filteredHeading = normalizeAngle(
      (Math.atan2(guidanceTracker.smoothedSin, guidanceTracker.smoothedCos) * 180) /
        Math.PI,
    );
    renderGuidanceTint(
      normalizeBearingError(guidanceTracker.targetBearing - filteredHeading),
    );
  }
}

function pauseGuidanceForLocation() {
  if (!guidanceTracker.isActive) return;
  guidanceTracker.isWaitingForLocation = true;
  guidanceTracker.targetBearing = null;
  guidanceTint.classList.remove("guidance-tint--active", "guidance-tint--locked");
  setGuidancePill("Waiting for location\u2026");
}

function renderGuidanceTint(error) {
  const ramp = readGuidanceRamp();
  const magnitude = Math.min(Math.abs(error), 110);
  const style = interpolateGuidanceRamp(magnitude, ramp);
  const offset = Math.max(-1, Math.min(1, error / 90)) * 46;
  guidanceTint.style.setProperty("--guidance-offset", `${offset}vw`);
  guidanceTint.style.setProperty("--guidance-saturation", `${style.saturation}%`);
  guidanceTint.style.setProperty("--guidance-lightness", `${style.lightness}%`);
  guidanceTint.style.setProperty("--guidance-opacity", style.opacity);
  guidanceTint.style.setProperty("--guidance-width", `${style.width}vw`);
  guidanceTint.style.setProperty("--guidance-blur", `${style.blur}px`);
  guidanceTint.classList.toggle("guidance-tint--locked", magnitude <= 8);

  if (!guidanceTint.classList.contains("guidance-tint--active")) {
    guidanceTint.classList.add("guidance-tint--starting");
    window.requestAnimationFrame(() => guidanceTint.classList.add("guidance-tint--active"));
    window.clearTimeout(guidanceTracker.tintStartTimer);
    guidanceTracker.tintStartTimer = window.setTimeout(() => {
      guidanceTint.classList.remove("guidance-tint--starting");
      guidanceTracker.tintStartTimer = null;
    }, 440);
  }
}

function readGuidanceRamp() {
  const styles = getComputedStyle(document.documentElement);
  const value = (name) => Number.parseFloat(styles.getPropertyValue(name));
  return [
    { error: 0, saturation: value("--guidance-saturation-0"), lightness: value("--guidance-lightness-0"), opacity: value("--guidance-opacity-0"), width: value("--guidance-width-0"), blur: value("--guidance-blur-0") },
    { error: 30, saturation: value("--guidance-saturation-30"), lightness: value("--guidance-lightness-30"), opacity: value("--guidance-opacity-30"), width: value("--guidance-width-30"), blur: value("--guidance-blur-30") },
    { error: 60, saturation: value("--guidance-saturation-60"), lightness: value("--guidance-lightness-60"), opacity: value("--guidance-opacity-60"), width: value("--guidance-width-60"), blur: value("--guidance-blur-60") },
    { error: 110, saturation: value("--guidance-saturation-110"), lightness: value("--guidance-lightness-110"), opacity: value("--guidance-opacity-110"), width: value("--guidance-width-110"), blur: value("--guidance-blur-110") },
  ];
}

function interpolateGuidanceRamp(error, ramp) {
  let lower = ramp[0];
  let upper = ramp[ramp.length - 1];
  for (let index = 1; index < ramp.length; index += 1) {
    if (error <= ramp[index].error) {
      lower = ramp[index - 1];
      upper = ramp[index];
      break;
    }
  }
  const amount = (error - lower.error) / Math.max(upper.error - lower.error, 1);
  const mix = (key) => lower[key] + amount * (upper[key] - lower[key]);
  return {
    saturation: mix("saturation"),
    lightness: mix("lightness"),
    opacity: mix("opacity"),
    width: mix("width"),
    blur: mix("blur"),
  };
}

function setGuidancePill(message) {
  guidancePillText.textContent = message;
  guidancePill.hidden = false;
}

function showGuidanceArrival() {
  detachOrientationListeners();
  window.clearTimeout(guidanceTracker.headingTimeout);
  guidanceTracker.headingTimeout = null;
  guidanceTracker.isActive = false;
  renderGuidanceTint(0);
  setGuidancePill("Arrived");
  window.clearTimeout(guidanceTracker.tintHideTimer);
  window.clearTimeout(guidanceTracker.pillHideTimer);
  guidanceTracker.tintHideTimer = window.setTimeout(() => {
    guidanceTint.classList.remove("guidance-tint--active", "guidance-tint--locked");
  }, 1000);
  guidanceTracker.pillHideTimer = window.setTimeout(() => {
    guidancePill.hidden = true;
    guidanceTracker.target = null;
  }, 2000);
}

function stopGuidance() {
  detachOrientationListeners();
  clearGuidanceTimers();
  guidanceTracker.isActive = false;
  guidanceTracker.isWaitingForLocation = false;
  guidanceTracker.targetBearing = null;
  guidanceTracker.smoothedSin = null;
  guidanceTracker.smoothedCos = null;
  guidanceTint.classList.remove(
    "guidance-tint--active",
    "guidance-tint--starting",
    "guidance-tint--locked",
  );
  guidanceTracker.pillHideTimer = window.setTimeout(() => {
    guidancePill.hidden = true;
    guidanceTracker.target = null;
  }, 260);
}

function clearGuidanceTimers() {
  ["headingTimeout", "tintStartTimer", "tintHideTimer", "pillHideTimer"].forEach(
    (key) => {
      window.clearTimeout(guidanceTracker[key]);
      guidanceTracker[key] = null;
    },
  );
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

function installLayerResetButton(control) {
  const list = control.getContainer().querySelector(".leaflet-control-layers-list");
  const resetSection = document.createElement("div");
  resetSection.className = "layer-reset-section";
  const resetButton = document.createElement("button");
  resetButton.className = "layer-reset-button";
  resetButton.type = "button";
  resetButton.textContent = "Reset to default";
  resetButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetMapToDefaults();
  });
  resetSection.append(resetButton);
  list.append(resetSection);
  L.DomEvent.disableClickPropagation(resetSection);
}

function installLayerControlHoverDelay(control) {
  const container = control.getContainer();
  let collapseTimer = null;

  // Leaflet normally collapses immediately on mouseleave. Retain its normal
  // expand behavior while forgiving a brief slip outside the panel.
  L.DomEvent.off(container, "mouseleave", control.collapse, control);
  container.addEventListener("mouseenter", () => {
    window.clearTimeout(collapseTimer);
    collapseTimer = null;
  });
  container.addEventListener("mouseleave", () => {
    window.clearTimeout(collapseTimer);
    collapseTimer = window.setTimeout(() => {
      if (!container.matches(":hover")) control.collapse();
      collapseTimer = null;
    }, LAYER_CONTROL_COLLAPSE_DELAY_MS);
  });
}

function resetMapToDefaults() {
  map.closePopup();
  if (map.hasLayer(topoMap)) map.removeLayer(topoMap);
  if (!map.hasLayer(nysAerial)) map.addLayer(nysAerial);

  const overlays = {
    corners: cornersLayer,
    roads: roadsGroup,
    trails: trailsLayer,
    landmarks: landmarksLayer,
    zones: zonesLayer,
    intersections: intersectionsLayer,
  };
  Object.entries(overlays).forEach(([key, layer]) => {
    const shouldShow = DEFAULT_OVERLAY_VISIBILITY[key];
    if (shouldShow && !map.hasLayer(layer)) map.addLayer(layer);
    if (!shouldShow && map.hasLayer(layer)) map.removeLayer(layer);
  });

  if (boundaryLayer.getBounds().isValid()) {
    map.fitBounds(boundaryLayer.getBounds(), {
      paddingTopLeft: PROPERTY_BOUNDS_PADDING,
      paddingBottomRight: PROPERTY_BOUNDS_PADDING,
      maxZoom: 18,
    });
  }
  saveMapPreferences();
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
        tap.time - previousTap.time <= RAPID_DOUBLE_TAP_MS &&
        Math.hypot(tap.x - previousTap.x, tap.y - previousTap.y) <= 24;

      if (!isDoubleTap) {
        previousTap = tap;
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      previousTap = null;
      window.clearTimeout(pendingFeaturePopupTimer);
      pendingFeaturePopupTimer = null;
      suppressFeaturePopupsUntil = performance.now() + RAPID_DOUBLE_TAP_MS;
      map.closePopup();
      const bounds = container.getBoundingClientRect();
      const point = L.point(tap.x - bounds.left, tap.y - bounds.top);
      map.setZoomAround(point, Math.min(map.getZoom() + 1, map.getMaxZoom()));
    },
    { passive: false, capture: true },
  );
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value ?? "";
  return element.innerHTML;
}
