"use strict";

const PROPERTY_BOUNDS_PADDING = [28, 28];
const DEFAULT_MAX_ZOOM = 21;
const RAPID_DOUBLE_TAP_MS = 250;
const OFF_PROPERTY_MIN_DISTANCE_METERS = 4.5;
const OFF_PROPERTY_ENTER_FIXES = 2;
const OFF_PROPERTY_ENTER_DELAY_MS = 4000;
const OFF_PROPERTY_LEAVE_FIXES = 2;
const OFF_PROPERTY_ALERT_MS = 3500;
const OFF_PROPERTY_NEAR_ENTER_FIXES = 2;
const OFF_PROPERTY_NEAR_LEAVE_FIXES = 2;
const OFF_PROPERTY_UNION_PROBE_METERS = 1;
const OFF_PROPERTY_VIBRATION_MS = 35;
const ARRIVAL_DISTANCE_METERS = 7.62;
const MAGNETIC_DECLINATION_DEG = -13.5;
const GUIDANCE_HEADING_TIMEOUT_MS = 3000;
const GUIDANCE_UNAVAILABLE_HOLD_MS = 4000;
const GUIDANCE_IOS_HINT_DELAY_MS = 1800;
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
const requestedFeatureId = new URLSearchParams(window.location.search)
  .get("feature")
  ?.trim();
let preferencesReady = false;
let initialViewReady = false;
let pendingFeaturePopupTimer = null;
let suppressFeaturePopupsUntil = 0;
const routesBySegmentId = new Map();
const routesById = new Map();
const focusableFeaturesById = new Map();
let hasRouteDefinitions = false;
let requestedFeatureFocused = false;

const offPropertyTracker = {
  geometry: null,
  isConfirmedOff: false,
  isNear: false,
  enteringFixCount: 0,
  enteringStartedAt: 0,
  leavingFixCount: 0,
  nearEnteringFixCount: 0,
  nearLeavingFixCount: 0,
  hasAnnouncedOffProperty: false,
};

const guidanceTracker = {
  targets: new Map(),
  target: null,
  isActive: false,
  isWaitingForLocation: false,
  orientationPermission: "unknown",
  lastPermissionResult: "not-requested",
  hideGuideButton: false,
  orientationEvents: [],
  isIosPermissionPath: false,
  orientationEventFired: false,
  sawWebkitCompassHeading: false,
  sawFiniteAlpha: false,
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
  unavailableHintTimer: null,
  unavailableEndTimer: null,
  hasShownIosOrientationHint: false,
};

const map = L.map("map", {
  zoomControl: true,
  maxZoom: DEFAULT_MAX_ZOOM,
  doubleClickZoom: true,
  preferCanvas: true,
});

// Give Leaflet a valid drawing viewport before asynchronous GeoJSON arrives.
map.setView([43.3596, -73.8348], 17);

const MAP_PANES = Object.freeze({
  outsideShading: "outside-shading-pane",
  zones: "zones-pane",
  corridor: "corridor-pane",
  boundary: "boundary-pane",
  roads: "roads-pane",
  trails: "trails-pane",
  naturalLandmarks: "natural-landmarks-pane",
  corners: "corners-pane",
  intersections: "intersections-pane",
  buildings: "buildings-pane",
});

[
  [MAP_PANES.outsideShading, 401],
  [MAP_PANES.zones, 402],
  [MAP_PANES.corridor, 403],
  [MAP_PANES.boundary, 404],
  [MAP_PANES.roads, 405],
  [MAP_PANES.trails, 406],
  [MAP_PANES.naturalLandmarks, 610],
  [MAP_PANES.corners, 615],
  [MAP_PANES.intersections, 620],
  [MAP_PANES.buildings, 630],
].forEach(([name, zIndex]) => {
  map.createPane(name);
  map.getPane(name).style.zIndex = zIndex;
});

const outsideMaskRenderer = L.svg({
  pane: MAP_PANES.outsideShading,
  padding: 0.5,
});
const corridorRenderer = L.canvas({ pane: MAP_PANES.corridor });
const boundaryRenderer = L.canvas({ pane: MAP_PANES.boundary });
const roadsRenderer = L.canvas({ pane: MAP_PANES.roads });
const trailsRenderer = L.canvas({ pane: MAP_PANES.trails });
const zonesRenderer = L.canvas({ pane: MAP_PANES.zones });
const intersectionsRenderer = L.canvas({ pane: MAP_PANES.intersections });

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

const outsideMaskLayer = L.geoJSON(null, {
  pane: MAP_PANES.outsideShading,
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
  pane: MAP_PANES.corridor,
  renderer: corridorRenderer,
  style: {
    color: "#d5d9dc",
    weight: 3,
    opacity: 0.95,
    dashArray: "6 6",
    fillColor: "#e2e5e7",
    fillOpacity: 0.28,
  },
  onEachFeature(feature, layer) {
    registerFocusableFeature(feature, layer, corridorLayer);
    const message = "National Grid powerline cut — not our land, but access is allowed.";
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      layer.bindTooltip(message, { sticky: true, direction: "top" });
    }
    layer.bindPopup(() =>
      buildMapFeaturePopup(feature, "Not our land, but access is allowed.", {
        caveat: "Shaded extent is approximate; corridor edges are not surveyed here.",
      }),
    );
  },
}).addTo(map);

const roadHalo = L.geoJSON(null, {
  pane: MAP_PANES.roads,
  renderer: roadsRenderer,
  interactive: false,
  style: {
    color: "#473522",
    // Retained as a ready-to-tune layer if aerial imagery later needs a thin halo.
    weight: 0,
    opacity: 0,
    lineCap: "round",
    lineJoin: "round",
  },
});

const roadsLayer = L.geoJSON(null, {
  pane: MAP_PANES.roads,
  renderer: roadsRenderer,
  style: {
    color: "#d89a4a",
    weight: 3,
    opacity: 0.98,
    lineCap: "round",
    lineJoin: "round",
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, `${feature.properties.status}. ${feature.properties.note}`, {
      focusOverlay: roadsGroup,
    });
  },
});
const roadsGroup = L.layerGroup([roadHalo, roadsLayer]);
addOverlayIfEnabled(roadsGroup, "roads", true);

const trailsLayer = L.geoJSON(null, {
  pane: MAP_PANES.trails,
  renderer: trailsRenderer,
  style: trailStyle,
  onEachFeature(feature, layer) {
    const popupOptions = buildTrailPopupOptions(feature);
    popupOptions.focusOverlay = trailsLayer;
    bindMapFeature(layer, feature, popupOptions.detail, popupOptions);
  },
});
addOverlayIfEnabled(trailsLayer, "trails", true);

const zonesLayer = L.geoJSON(null, {
  pane: MAP_PANES.zones,
  renderer: zonesRenderer,
  style: {
    color: "#f0c85f",
    weight: 2,
    opacity: 0.95,
    dashArray: "2 7",
    fillColor: "#f5dda0",
    fillOpacity: 0.14,
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, feature.properties.note, { focusOverlay: zonesLayer });
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
    return L.marker(latlng, { icon: buildingIcon, pane: MAP_PANES.buildings });
  },
  onEachFeature(feature, layer) {
    registerGuidanceTarget(feature);
    bindMapFeature(
      layer,
      feature,
      feature.properties.note ||
        `${feature.properties.type}; provisional center from walked extent.`,
      { landmark: true, focusOverlay: landmarksLayer },
    );
  },
});
addOverlayIfEnabled(landmarksLayer, "landmarks", true);

const intersectionsLayer = L.geoJSON(null, {
  pane: MAP_PANES.intersections,
  renderer: intersectionsRenderer,
  pointToLayer(feature, latlng) {
    return L.circleMarker(latlng, {
      pane: MAP_PANES.intersections,
      renderer: intersectionsRenderer,
      radius: 5,
      color: "#ffffff",
      weight: 2,
      fillColor: "#8e4c9e",
      fillOpacity: 1,
    });
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, feature.properties.note, {
      focusOverlay: intersectionsLayer,
    });
  },
});
addOverlayIfEnabled(intersectionsLayer, "intersections", false);

const boundaryHalo = L.geoJSON(null, {
  pane: MAP_PANES.boundary,
  renderer: boundaryRenderer,
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
  pane: MAP_PANES.boundary,
  renderer: boundaryRenderer,
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
  pane: MAP_PANES.boundary,
  renderer: boundaryRenderer,
  style: { color: "#000000", weight: 12, opacity: 0.001 },
  onEachFeature(feature, layer) {
    registerFocusableFeature(feature, layer, mainBoundaryInteractionLayer);
    const description = feature.properties.popup_description || feature.properties.note;
    layer.bindPopup(() => buildMapFeaturePopup(feature, description));
  },
}).addTo(map);

const sliverInteractionLayer = L.geoJSON(null, {
  pane: MAP_PANES.boundary,
  renderer: boundaryRenderer,
  filter(feature) {
    return feature.properties.name === "Sliver";
  },
  style: { stroke: false, fillColor: "#000000", fillOpacity: 0.001 },
  onEachFeature(feature, layer) {
    registerFocusableFeature(feature, layer, sliverInteractionLayer);
    const description = feature.properties.popup_description || feature.properties.note;
    layer.bindPopup(() => buildMapFeaturePopup(feature, description));
  },
}).addTo(map);

const cornersLayer = L.geoJSON(null, {
  pointToLayer(feature, latlng) {
    return L.marker(latlng, {
      pane: MAP_PANES.corners,
      icon: L.divIcon({
        className: "corner-marker",
        iconSize: [9, 9],
        iconAnchor: [4.5, 4.5],
      }),
    }).bindTooltip(feature.properties.label);
  },
  onEachFeature(feature, layer) {
    registerFocusableFeature(feature, layer, cornersLayer);
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
    offPropertyTracker.geometry = buildOffPropertyGeometry(
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
    initialViewReady = true;
    tryFocusRequestedFeature();
  })
  .catch((error) => {
    console.error(error);
    showLocationStatus("Map data could not be loaded.");
    map.setView([43.3596, -73.8348], 17);
    preferencesReady = true;
    initialViewReady = true;
    tryFocusRequestedFeature();
  });

loadGeoJson("data/roads/dirt-roads.geojson")
  .then((data) => {
    roadHalo.addData(data);
    roadsLayer.addData(data);
    tryFocusRequestedFeature();
  })
  .catch((error) => console.error(error));

Promise.all([
  loadGeoJson("data/trails/walking-trails.geojson"),
  loadOptionalRoutes(),
])
  .then(([trailData, routes]) => {
    configureTrailRoutes(trailData, routes);
    trailsLayer.addData(trailData);
    tryFocusRequestedFeature();
  })
  .catch((error) => console.error(error));

Promise.all([
  loadGeoJson("data/landmarks/buildings.geojson"),
  loadOptionalGeoJson("data/landmarks/landmarks.geojson"),
])
  .then(([buildings, otherLandmarks]) => {
    landmarksLayer.addData(buildings);
    landmarksLayer.addData(otherLandmarks);
    tryFocusRequestedFeature();
  })
  .catch((error) => console.error(error));

loadGeoJson("data/zones/zones.geojson")
  .then((data) => {
    zonesLayer.addData(data);
    tryFocusRequestedFeature();
  })
  .catch((error) => console.error(error));

loadGeoJson("data/intersections/intersections.geojson")
  .then((data) => {
    intersectionsLayer.addData(data);
    tryFocusRequestedFeature();
  })
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
    : offPropertyTracker.isNear
      ? "location-dot location-dot--near"
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

function buildOffPropertyGeometry(...featureCollections) {
  const projectedRings = extractOuterPolygonRings(...featureCollections).map((ring) =>
    ring.map(projectToPropertyMeters),
  );
  const allSegments = projectedRings.flatMap((ring) => buildRingSegments(ring));
  const outerBoundarySegments = allSegments.filter(
    (segment) => !isInteriorUnionSegment(segment, projectedRings),
  );
  return { projectedRings, outerBoundarySegments };
}

function buildRingSegments(ring) {
  const segments = [];
  for (let index = 1; index < ring.length; index += 1) {
    segments.push({ start: ring[index - 1], end: ring[index] });
  }
  if (
    ring.length > 2 &&
    (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
  ) {
    segments.push({ start: ring[ring.length - 1], end: ring[0] });
  }
  return segments;
}

function isInteriorUnionSegment({ start, end }, rings) {
  const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) return true;

  const offsetX = (-deltaY / length) * OFF_PROPERTY_UNION_PROBE_METERS;
  const offsetY = (deltaX / length) * OFF_PROPERTY_UNION_PROBE_METERS;
  return (
    isPointInsideAnyRing([midpoint[0] + offsetX, midpoint[1] + offsetY], rings) &&
    isPointInsideAnyRing([midpoint[0] - offsetX, midpoint[1] - offsetY], rings)
  );
}

function classifyPropertyLocation(latlng, accuracy) {
  const geometry = offPropertyTracker.geometry;
  if (!geometry || geometry.outerBoundarySegments.length === 0) return "UNKNOWN";

  const point = projectToPropertyMeters([latlng.lng, latlng.lat]);
  const isInside = isPointInsideAnyRing(point, geometry.projectedRings);
  const nearestBoundaryDistance = Math.min(
    ...geometry.outerBoundarySegments.map(({ start, end }) =>
      distanceToSegment(point, start, end),
    ),
  );
  const signedDistance = isInside ? nearestBoundaryDistance : -nearestBoundaryDistance;
  const effectiveMargin = Math.max(OFF_PROPERTY_MIN_DISTANCE_METERS, accuracy);
  if (signedDistance > effectiveMargin) return "INSIDE";
  if (signedDistance < -effectiveMargin) return "OFF";
  return "NEAR";
}

function updateOffPropertyState(classification) {
  const now = performance.now();

  if (classification === "UNKNOWN") return false;

  if (classification === "OFF") {
    offPropertyTracker.leavingFixCount = 0;
    if (offPropertyTracker.enteringFixCount === 0) {
      offPropertyTracker.enteringStartedAt = now;
    }
    offPropertyTracker.enteringFixCount += 1;

    // Keep the visitor-facing state ordered even if a GPS fix jumps directly
    // from clearly inside to clearly outside between updates.
    const becameNearBridge =
      !offPropertyTracker.isNear &&
      offPropertyTracker.enteringFixCount >= OFF_PROPERTY_NEAR_ENTER_FIXES;
    if (becameNearBridge) {
      offPropertyTracker.isNear = true;
      offPropertyTracker.nearLeavingFixCount = 0;
    }

    if (offPropertyTracker.isConfirmedOff || becameNearBridge) return false;
    if (
      offPropertyTracker.isNear &&
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

  if (classification === "NEAR") {
    offPropertyTracker.nearLeavingFixCount = 0;
    offPropertyTracker.nearEnteringFixCount += 1;
    if (offPropertyTracker.isConfirmedOff) {
      offPropertyTracker.leavingFixCount += 1;
      if (offPropertyTracker.leavingFixCount >= OFF_PROPERTY_LEAVE_FIXES) {
        offPropertyTracker.isConfirmedOff = false;
        offPropertyTracker.isNear = true;
        offPropertyTracker.leavingFixCount = 0;
      }
      return false;
    }
    if (offPropertyTracker.nearEnteringFixCount >= OFF_PROPERTY_NEAR_ENTER_FIXES) {
      offPropertyTracker.isNear = true;
    }
    return false;
  }

  offPropertyTracker.nearEnteringFixCount = 0;
  offPropertyTracker.nearLeavingFixCount += 1;
  if (offPropertyTracker.isConfirmedOff) {
    offPropertyTracker.leavingFixCount += 1;
    if (offPropertyTracker.leavingFixCount >= OFF_PROPERTY_LEAVE_FIXES) {
      offPropertyTracker.isConfirmedOff = false;
      offPropertyTracker.isNear = true;
      offPropertyTracker.nearLeavingFixCount = 0;
      offPropertyTracker.leavingFixCount = 0;
    }
    return false;
  }
  if (offPropertyTracker.nearLeavingFixCount >= OFF_PROPERTY_NEAR_LEAVE_FIXES) {
    offPropertyTracker.isNear = false;
    offPropertyTracker.nearLeavingFixCount = 0;
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

  // iOS browsers do not implement the Vibration API, so this only fires on
  // supported devices such as Android Chrome.
  if (typeof navigator.vibrate === "function") {
    navigator.vibrate(OFF_PROPERTY_VIBRATION_MS);
  }
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

function isPointInsideAnyRing(point, rings) {
  return rings.some((ring) => isPointInsideRing(point, ring));
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

async function loadOptionalRoutes() {
  try {
    const response = await fetch("data/trails/routes.json");
    if (!response.ok) throw new Error(`Could not load routes: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.routes) ? data.routes : [];
  } catch (error) {
    console.info("Route definitions are unavailable; trail segment labels remain in use.", error);
    return [];
  }
}

async function loadOptionalGeoJson(url) {
  try {
    return await loadGeoJson(url);
  } catch (error) {
    console.info(`Optional map data are unavailable at ${url}.`, error);
    return { type: "FeatureCollection", features: [] };
  }
}

function configureTrailRoutes(trailData, routes) {
  routesBySegmentId.clear();
  routesById.clear();
  hasRouteDefinitions = routes.length > 0;
  const knownSegmentIds = new Set(
    trailData.features.map((feature) => feature.properties?.id).filter(Boolean),
  );

  routes.forEach((route) => {
    if (!route?.id || !route.name || !Array.isArray(route.segments)) {
      console.warn("Skipping an incomplete route definition.", route);
      return;
    }
    routesById.set(route.id, route);
    route.segments.forEach((segmentId) => {
      if (!knownSegmentIds.has(segmentId)) {
        console.warn(
          `Route \"${route.id}\" references unknown trail segment \"${segmentId}\"; skipping it.`,
        );
        return;
      }
      const segmentRoutes = routesBySegmentId.get(segmentId) || [];
      segmentRoutes.push(route);
      routesBySegmentId.set(segmentId, segmentRoutes);
    });
  });
}

function registerFocusableFeature(feature, layer, focusOverlay = null) {
  const featureId = feature?.properties?.id;
  if (!featureId) return;
  focusableFeaturesById.set(featureId, { feature, layer, focusOverlay });
}

function layerFocusBounds(layer) {
  if (typeof layer.getBounds === "function") {
    const bounds = layer.getBounds();
    if (bounds?.isValid()) return bounds;
  }
  if (typeof layer.getLatLng === "function") {
    return L.latLngBounds([layer.getLatLng()]);
  }
  return null;
}

function fitFocusBounds(bounds) {
  if (!bounds?.isValid()) return false;
  if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
    map.setView(bounds.getCenter(), 19, { animate: false });
  } else {
    map.fitBounds(bounds, {
      paddingTopLeft: PROPERTY_BOUNDS_PADDING,
      paddingBottomRight: PROPERTY_BOUNDS_PADDING,
      maxZoom: 19,
      animate: false,
    });
  }
  return true;
}

function tryFocusRequestedFeature() {
  if (!requestedFeatureId || requestedFeatureFocused || !initialViewReady) return;

  const route = routesById.get(requestedFeatureId);
  if (route) {
    const members = route.segments
      .map((segmentId) => focusableFeaturesById.get(segmentId))
      .filter(Boolean);
    if (members.length !== route.segments.length) return;
    if (!map.hasLayer(trailsLayer)) map.addLayer(trailsLayer);
    const bounds = L.latLngBounds([]);
    members.forEach(({ layer }) => {
      const memberBounds = layerFocusBounds(layer);
      if (memberBounds) bounds.extend(memberBounds);
    });
    if (!fitFocusBounds(bounds)) return;
    requestedFeatureFocused = true;
    const details = [route.shape, route.difficulty].filter(Boolean).join(" \u00b7 ");
    L.popup()
      .setLatLng(bounds.getCenter())
      .setContent(
        `<div class="map-popup-content"><strong>${escapeHtml(route.name)}</strong>` +
          (details ? `<span class="map-popup-secondary">${escapeHtml(details)}</span>` : "") +
          `</div>`,
      )
      .openOn(map);
    return;
  }

  const match = focusableFeaturesById.get(requestedFeatureId);
  if (!match) return;
  if (match.focusOverlay && !map.hasLayer(match.focusOverlay)) map.addLayer(match.focusOverlay);
  const bounds = layerFocusBounds(match.layer);
  if (!fitFocusBounds(bounds)) return;
  requestedFeatureFocused = true;
  L.popup()
    .setLatLng(bounds.getCenter())
    .setContent(
      `<div class="map-popup-content"><strong>${escapeHtml(match.feature.properties.name)}</strong></div>`,
    )
    .openOn(map);
}

function routesForTrail(feature) {
  return routesBySegmentId.get(feature.properties?.id) || [];
}

function trailStyle(feature) {
  const isConnector = hasRouteDefinitions && routesForTrail(feature).length === 0;
  return {
    color: "#63b8e8",
    weight: 3,
    // Keep unassigned segments present, but subtly secondary to named routes.
    opacity: isConnector ? 0.78 : 1,
    dashArray: "7 6",
    lineCap: "round",
    lineJoin: "round",
  };
}

function buildTrailPopupOptions(feature) {
  const segmentName = feature.properties.name;
  const routes = routesForTrail(feature);
  const detail = "Provisional walking-trail centerline from repeated phone-GPS passes.";
  if (routes.length === 0) return { detail };

  return {
    title: routes.map((route) => route.name).join(" \u00b7 "),
    secondary: `Segment: ${segmentName}`,
    detail,
  };
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
  const name = escapeHtml(options.title || feature.properties.name);
  const safeDetail = escapeHtml(detail || "Approximate mapped feature.");
  let popupHtml = '<div class="map-popup-content">';
  popupHtml += `<strong>${name}</strong>`;
  if (options.secondary) {
    popupHtml += `<span class="map-popup-secondary">${escapeHtml(options.secondary)}</span>`;
  }
  popupHtml += `<span class="map-popup-detail">${safeDetail}</span>`;
  if (options.caveat) {
    popupHtml += `<small class="map-popup-caveat">${escapeHtml(options.caveat)}</small>`;
  }
  if (!options.landmark) return `${popupHtml}</div>`;

  const target = guidanceTracker.targets.get(feature.properties.id);
  if (!target) return `${popupHtml}</div>`;

  if (latestPosition) {
    const distanceMeters = distanceBetweenLatLngs(latestPosition.latlng, target.latlng);
    const bearing = calculateTrueBearing(latestPosition.latlng, target.latlng);
    popupHtml +=
      `<span class="landmark-distance">${escapeHtml(formatLandmarkDistance(distanceMeters, bearing))}</span>`;
  }
  if (canOfferCompassGuidance()) {
    popupHtml +=
      `<button class="guide-me-button" type="button" data-landmark-id="${escapeHtml(target.id)}">` +
      `${guidanceButtonLabel(target.id)}</button>`;
  }
  return `${popupHtml}</div>`;
}

function bindMapFeature(layer, feature, detail, options = {}) {
  registerFocusableFeature(feature, layer, options.focusOverlay);
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
  const distanceText = formatApproximateDistance(distanceMeters);
  if (distanceText === "you're here") return distanceText;
  return `${distanceText} \u00b7 ${bearingToCompassPoint(bearing)}`;
}

function formatApproximateDistance(distanceMeters) {
  const distanceFeet = distanceMeters * 3.28084;
  if (distanceFeet < 15) return "you're here";
  const increment = distanceFeet < 300 ? 10 : 25;
  const roundedFeet = Math.round(distanceFeet / increment) * increment;
  return `about ${roundedFeet} ft`;
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

function guidanceButtonLabel(targetId) {
  if (!guidanceTracker.isActive || !guidanceTracker.target) return "Guide me";
  return guidanceTracker.target.id === targetId
    ? "Stop guiding"
    : "Guide here instead";
}

function handleGuideButtonClick(event) {
  const button = event.target.closest?.(".guide-me-button");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  if (
    guidanceTracker.isActive &&
    guidanceTracker.target?.id === button.dataset.landmarkId
  ) {
    stopGuidance();
    return;
  }
  startGuidance(button.dataset.landmarkId);
}

async function startGuidance(targetId) {
  const target = guidanceTracker.targets.get(targetId);
  if (!target) return;

  if (guidanceTracker.isActive) {
    guidanceTracker.target = target;
    if (latestPosition) {
      updateGuidanceFromPosition(latestPosition.latlng);
    } else {
      pauseGuidanceForLocation();
    }
    map.closePopup();
    return;
  }

  clearGuidanceTimers();
  guidanceTracker.target = target;
  if (
    latestPosition &&
    distanceBetweenLatLngs(latestPosition.latlng, target.latlng) <= ARRIVAL_DISTANCE_METERS
  ) {
    showGuidanceArrival();
    map.closePopup();
    return;
  }

  const permissionRequest = window.DeviceOrientationEvent?.requestPermission;
  guidanceTracker.lastPermissionResult =
    typeof permissionRequest === "function" ? "pending" : "not-required";
  if (
    typeof permissionRequest === "function" &&
    guidanceTracker.orientationPermission !== "granted"
  ) {
    try {
      const permission = await permissionRequest.call(window.DeviceOrientationEvent);
      guidanceTracker.lastPermissionResult = permission;
      if (permission !== "granted") {
        declineCompassGuidance();
        return;
      }
      guidanceTracker.orientationPermission = "granted";
    } catch {
      guidanceTracker.lastPermissionResult = "error";
      declineCompassGuidance();
      return;
    }
  } else if (guidanceTracker.orientationPermission === "granted") {
    guidanceTracker.lastPermissionResult = "previously-granted";
  }

  guidanceTracker.isActive = true;
  guidanceTracker.isWaitingForLocation = !latestPosition;
  guidanceTracker.isIosPermissionPath = typeof permissionRequest === "function";
  guidanceTracker.orientationEventFired = false;
  guidanceTracker.sawWebkitCompassHeading = false;
  guidanceTracker.sawFiniteAlpha = false;
  guidanceTracker.androidAbsoluteSeen = false;
  guidanceTracker.smoothedSin = null;
  guidanceTracker.smoothedCos = null;
  guidanceTracker.lastHeadingAt = 0;
  guidanceTracker.lastVisualUpdateAt = 0;
  updateGuidancePill();
  renderGuidanceTint(110, { centered: true });
  attachOrientationListeners(guidanceTracker.isIosPermissionPath);
  logGuidanceDiagnostic("start");
  if (latestPosition) {
    updateGuidanceFromPosition(latestPosition.latlng);
  } else {
    requestInitialLocation();
  }
  guidanceTracker.headingTimeout = window.setTimeout(
    handleGuidanceHeadingTimeout,
    GUIDANCE_HEADING_TIMEOUT_MS,
  );
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
  guidanceTracker.orientationEventFired = true;
  if (Number.isFinite(event.webkitCompassHeading)) {
    guidanceTracker.sawWebkitCompassHeading = true;
  }
  if (Number.isFinite(event.alpha)) guidanceTracker.sawFiniteAlpha = true;

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
  // Android absolute alpha is magnetic near Lake Luzerne. Field-verify this
  // correction while standing along a known bearing such as Mountain Drive.
  if (isAndroidHeading) {
    const screenRotation = Number(screen.orientation?.angle) || 0;
    heading += MAGNETIC_DECLINATION_DEG + screenRotation;
  }
  heading = normalizeAngle(heading);

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
  updateGuidancePill();
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
  renderGuidanceTint(110, { centered: true });
  updateGuidancePill();
}

function renderGuidanceTint(error, { centered = false } = {}) {
  const ramp = readGuidanceRamp();
  const magnitude = Math.min(Math.abs(error), 110);
  const style = interpolateGuidanceRamp(magnitude, ramp);
  const offset = centered ? 0 : Math.max(-1, Math.min(1, error / 90)) * 46;
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

function updateGuidancePill() {
  if (!guidanceTracker.target) return;
  if (!latestPosition || guidanceTracker.isWaitingForLocation) {
    setGuidancePill(`Guiding to ${guidanceTracker.target.name} \u00b7 waiting for location`);
    return;
  }
  const distance = distanceBetweenLatLngs(latestPosition.latlng, guidanceTracker.target.latlng);
  setGuidancePill(
    `Guiding to ${guidanceTracker.target.name} \u00b7 ${formatApproximateDistance(distance)}`,
  );
}

function handleGuidanceHeadingTimeout() {
  if (!guidanceTracker.isActive || guidanceTracker.smoothedSin !== null) return;
  logGuidanceDiagnostic("timeout");
  detachOrientationListeners();
  guidanceTracker.headingTimeout = null;
  setGuidancePill("Compass unavailable");
  if (guidanceTracker.isIosPermissionPath && !guidanceTracker.hasShownIosOrientationHint) {
    guidanceTracker.hasShownIosOrientationHint = true;
    guidanceTracker.unavailableHintTimer = window.setTimeout(() => {
      setGuidancePill("Check Settings \u2192 Safari \u2192 Motion & Orientation Access");
    }, GUIDANCE_IOS_HINT_DELAY_MS);
  }
  guidanceTracker.unavailableEndTimer = window.setTimeout(
    stopGuidance,
    GUIDANCE_UNAVAILABLE_HOLD_MS,
  );
}

function logGuidanceDiagnostic(phase) {
  console.info(
    `[457 guidance] ${phase} events=${guidanceTracker.orientationEvents.join(",") || "none"} ` +
      `permission=${guidanceTracker.lastPermissionResult} ` +
      `event=${guidanceTracker.orientationEventFired} ` +
      `webkit=${guidanceTracker.sawWebkitCompassHeading} alpha=${guidanceTracker.sawFiniteAlpha}`,
  );
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
  [
    "headingTimeout",
    "tintStartTimer",
    "tintHideTimer",
    "pillHideTimer",
    "unavailableHintTimer",
    "unavailableEndTimer",
  ].forEach(
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
