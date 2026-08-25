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
const GUIDANCE_MAX_ERROR_DEG = 180;
const GUIDANCE_LOCKED_ERROR_DEG = 8;
const GUIDANCE_TURN_AROUND_ERROR_DEG = 150;
const LAYER_CONTROL_COLLAPSE_DELAY_MS = 280;
const ROAD_HIT_TOLERANCE_PX = 5;
const ROAD_INTERACTION_WEIGHT_PX = 15;
const TRAIL_HIT_TOLERANCE_PX = 6;
const PROPERTY_REFERENCE_LAT = 43.3596;
const PROPERTY_REFERENCE_LON = -73.8350;
const METERS_PER_LATITUDE_DEGREE = 111132;
const METERS_PER_LONGITUDE_DEGREE =
  111320 * Math.cos((PROPERTY_REFERENCE_LAT * Math.PI) / 180);
const ROUTE_MILES_THRESHOLD_FEET = 0.10 * 5280;
const LIVE_DISTANCE_MILES_THRESHOLD_FEET = 0.15 * 5280;
const MAP_PREFERENCES_KEY = "457-property-map-preferences-v1";
const MAP_PREFERENCES_VERSION = 2;
const MAP_AUDIENCES = Object.freeze(["visitor", "owner"]);
let mapPreferenceStore = migrateMapPreferences(readMapPreferences());
const requestedAudience = new URLSearchParams(window.location.search).get("view");
let activeAudience = MAP_AUDIENCES.includes(requestedAudience)
  ? requestedAudience
  : MAP_AUDIENCES.includes(mapPreferenceStore.activeAudience)
    ? mapPreferenceStore.activeAudience
    : "visitor";
let savedMapPreferences = getAudiencePreferences(mapPreferenceStore, activeAudience);
const requestedFeatureId = new URLSearchParams(window.location.search)
  .get("feature")
  ?.trim();
let preferencesReady = false;
let initialViewReady = false;
let pendingFeaturePopupTimer = null;
let suppressFeaturePopupsUntil = 0;
let suppressPreferencePersistence = false;
let programmaticFocusViewActive = false;
let programmaticFocusReleaseTimer = null;
let releaseProgrammaticFocus = null;
const routesBySegmentId = new Map();
const routesById = new Map();
const focusableFeaturesById = new Map();
const baseFeatureStyles = new WeakMap();
let hasRouteDefinitions = false;
let requestedFeatureFocused = false;
let selectedFeatureLayers = [];
let hoveredFeatureLayers = [];
let hoveredFeatureEventLayers = new Set();
let featureHoverClearTimer = null;
let openMapRouteDetails = null;
let hidingPopupForRouteDetails = false;
const roadVisualLayersById = new Map();

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
  headingError: null,
  headingTimeout: null,
  tintStartTimer: null,
  tintHideTimer: null,
  pillHideTimer: null,
  unavailableHintTimer: null,
  unavailableEndTimer: null,
  popupCloseTimer: null,
  highlightLayer: null,
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

// Audiences only tailor presentation. They are not a security boundary: every
// repository file remains publicly downloadable, and either view can be chosen
// through the URL. Keep genuinely private data out of this repository.
const ALL_AUDIENCES = Object.freeze(["visitor", "owner"]);
const LAYER_DEFINITIONS = [
  {
    key: "outsideShading",
    label: null,
    group: "structure",
    order: 10,
    sources: ["boundaries", "corridor"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "derived",
      panes: [{ key: "outsideShading", name: "outside-shading-pane", order: 10 }],
      style: { stroke: false, fillColor: "url(#outside-hatch)", fillOpacity: 1, fillRule: "evenodd" },
    },
    getLayer: () => outsideMaskLayer,
    applyData: applyOutsideMaskData,
  },
  {
    key: "zones",
    label: "Zones",
    group: "40-zones",
    order: 20,
    sources: ["zones"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "geojson",
      panes: [{ key: "zones", name: "zones-pane", order: 20 }],
      style: { color: "#f0c85f", weight: 2, opacity: 0.95, dashArray: "2 7", fillColor: "#f5dda0", fillOpacity: 0.14 },
    },
    getLayer: () => zonesLayer,
    applyData: applyZonesData,
  },
  {
    key: "corridor",
    label: null,
    group: "structure",
    order: 30,
    sources: ["corridor"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "geojson",
      panes: [{ key: "corridor", name: "corridor-pane", order: 30 }],
      style: { color: "#d5d9dc", weight: 3, opacity: 0.95, dashArray: "6 6", fillColor: "#e2e5e7", fillOpacity: 0.28 },
    },
    getLayer: () => corridorLayer,
    applyData: applyCorridorData,
  },
  {
    key: "boundary",
    label: null,
    group: "structure",
    order: 40,
    sources: ["boundaries", "corridor"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "composite",
      panes: [{ key: "boundary", name: "boundary-pane", order: 40 }],
      haloStyle: { color: "#102f29", weight: 8, opacity: 0.88, fillOpacity: 0, lineJoin: "round" },
      style: { color: "#5ee6bd", weight: 4, opacity: 1, fillColor: "#5ee6bd", fillOpacity: 0.03, lineJoin: "round" },
      mainInteractionStyle: { color: "#000000", weight: 12, opacity: 0.001 },
      sliverInteractionStyle: { stroke: false, fillColor: "#000000", fillOpacity: 0.001 },
    },
    getLayer: () => boundaryGroup,
    applyData: applyBoundaryData,
  },
  {
    key: "roads",
    label: "Dirt roads",
    group: "20-routes",
    order: 50,
    sources: ["mountainDrive", "driveway", "trails", "routes"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "composite",
      panes: [
        { key: "roads", name: "roads-pane", order: 50 },
        // The interaction paths must sit above the full-map trail canvas or
        // that canvas intercepts road pointer events. They remain below every
        // landmark and pin pane, and their nearly transparent stroke changes
        // no visible layer ordering.
        { key: "roadInteractions", name: "road-interactions-pane", order: 67 },
      ],
      haloStyle: { color: "#473522", weight: 0, opacity: 0, lineCap: "round", lineJoin: "round" },
      style: { color: "#d89a4a", weight: 3, opacity: 0.98, lineCap: "round", lineJoin: "round" },
      interactionStyle: { color: "#ffffff", weight: ROAD_INTERACTION_WEIGHT_PX, opacity: 0.001, lineCap: "round", lineJoin: "round" },
    },
    getLayer: () => roadsGroup,
    applyData: applyRoadsData,
  },
  {
    key: "trails",
    label: "Walking trails",
    group: "20-routes",
    order: 60,
    sources: ["mountainDrive", "driveway", "trails", "routes"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: { kind: "geojson", panes: [{ key: "trails", name: "trails-pane", order: 60 }], style: trailStyle },
    getLayer: () => trailsLayer,
    applyData: applyTrailsData,
  },
  {
    key: "routeDefinitions",
    label: null,
    group: "data",
    order: 65,
    sources: ["mountainDrive", "driveway", "trails", "routes"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: { kind: "data", panes: [] },
    getLayer: () => null,
    applyData: applyRouteDefinitionData,
  },
  {
    key: "liveLocation",
    label: null,
    group: "runtime",
    order: 66,
    sources: [],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "runtime",
      panes: [{ key: "liveLocation", name: "live-location-pane", order: 66 }],
    },
    getLayer: () => null,
    applyData() {},
  },
  {
    key: "landmarks",
    label: "Landmarks",
    group: "30-landmarks",
    order: 70,
    sources: ["buildings", "landmarks"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "merged-geojson",
      panes: [
        { key: "naturalLandmarks", name: "natural-landmarks-pane", order: 70 },
        { key: "buildings", name: "buildings-pane", order: 100 },
      ],
      markerPane: "buildings",
    },
    getLayer: () => landmarksLayer,
    applyData: applyLandmarkData,
  },
  {
    key: "corners",
    label: "Corner markers",
    group: "10-corners",
    order: 80,
    sources: ["corners"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: false, owner: false },
    render: { kind: "geojson", panes: [{ key: "corners", name: "corners-pane", order: 80 }], markerPane: "corners" },
    getLayer: () => cornersLayer,
    applyData: applyCornersData,
  },
  {
    key: "intersections",
    label: "Intersections",
    group: "50-intersections",
    order: 90,
    sources: ["intersections"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: false, owner: false },
    render: {
      kind: "geojson",
      panes: [{ key: "intersections", name: "intersections-pane", order: 90 }],
      markerStyle: { radius: 5, color: "#ffffff", weight: 2, fillColor: "#8e4c9e", fillOpacity: 1 },
    },
    getLayer: () => intersectionsLayer,
    applyData: applyIntersectionsData,
  },
];

const paneDefinitions = LAYER_DEFINITIONS
  .flatMap((definition) => definition.render.panes)
  .sort((first, second) => first.order - second.order);
const MAP_PANES = Object.freeze(
  Object.fromEntries(paneDefinitions.map((pane) => [pane.key, pane.name])),
);
// Leaflet reserves overlayPane 400, shadowPane 500, markerPane 600,
// tooltipPane 650, and popupPane 700. Anything that must interleave with the
// registry needs an explicit registered pane rather than one of those defaults.
paneDefinitions.forEach((pane, index) => {
  map.createPane(pane.name);
  map.getPane(pane.name).style.zIndex = 401 + index;
});

const OUTSIDE_RENDER_CONFIG = getLayerDefinition("outsideShading").render;
const ZONE_RENDER_CONFIG = getLayerDefinition("zones").render;
const CORRIDOR_RENDER_CONFIG = getLayerDefinition("corridor").render;
const BOUNDARY_RENDER_CONFIG = getLayerDefinition("boundary").render;
const ROAD_RENDER_CONFIG = getLayerDefinition("roads").render;
const TRAIL_RENDER_CONFIG = getLayerDefinition("trails").render;
const LANDMARK_RENDER_CONFIG = getLayerDefinition("landmarks").render;
const CORNER_RENDER_CONFIG = getLayerDefinition("corners").render;
const INTERSECTION_RENDER_CONFIG = getLayerDefinition("intersections").render;

const outsideMaskRenderer = L.svg({
  pane: MAP_PANES.outsideShading,
  padding: 0.5,
});
const corridorRenderer = L.canvas({ pane: MAP_PANES.corridor });
const boundaryRenderer = L.canvas({ pane: MAP_PANES.boundary });
const roadsRenderer = L.canvas({
  pane: MAP_PANES.roads,
  tolerance: ROAD_HIT_TOLERANCE_PX,
});
const roadInteractionsRenderer = L.svg({
  pane: MAP_PANES.roadInteractions,
  padding: 0.5,
});
const trailsRenderer = L.canvas({
  pane: MAP_PANES.trails,
  tolerance: TRAIL_HIT_TOLERANCE_PX,
});
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
  style: OUTSIDE_RENDER_CONFIG.style,
});

const corridorLayer = L.geoJSON(null, {
  pane: MAP_PANES.corridor,
  renderer: corridorRenderer,
  style: CORRIDOR_RENDER_CONFIG.style,
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
});

// Intentionally retained as a zero-width tuning layer so a road halo can be
// restored without changing the road data or interaction layer.
const roadHalo = L.geoJSON(null, {
  pane: MAP_PANES.roads,
  renderer: roadsRenderer,
  interactive: false,
  style: ROAD_RENDER_CONFIG.haloStyle,
});

const roadsLayer = L.geoJSON(null, {
  pane: MAP_PANES.roads,
  renderer: roadsRenderer,
  interactive: false,
  style: ROAD_RENDER_CONFIG.style,
  onEachFeature(feature, layer) {
    if (feature.properties?.id) roadVisualLayersById.set(feature.properties.id, layer);
  },
});
const roadInteractionLayer = L.geoJSON(null, {
  pane: MAP_PANES.roadInteractions,
  renderer: roadInteractionsRenderer,
  style: ROAD_RENDER_CONFIG.interactionStyle,
  onEachFeature(feature, layer) {
    const popupOptions = buildRoadPopupOptions(feature);
    bindMapFeature(layer, feature, popupOptions.detail, {
      ...popupOptions,
      focusOverlay: roadsGroup,
      visualLayer: roadVisualLayersById.get(feature.properties?.id),
    });
  },
});
const roadsGroup = L.layerGroup([roadHalo, roadsLayer, roadInteractionLayer]);

const trailsLayer = L.geoJSON(null, {
  pane: MAP_PANES.trails,
  renderer: trailsRenderer,
  style: TRAIL_RENDER_CONFIG.style,
  onEachFeature(feature, layer) {
    const popupOptions = buildTrailPopupOptions(feature);
    popupOptions.focusOverlay = trailsLayer;
    bindMapFeature(layer, feature, popupOptions.detail, popupOptions);
  },
});

const zonesLayer = L.geoJSON(null, {
  pane: MAP_PANES.zones,
  renderer: zonesRenderer,
  style: ZONE_RENDER_CONFIG.style,
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, feature.properties.note, { focusOverlay: zonesLayer });
  },
});

const buildingIcon = L.icon({
  iconUrl: "assets/icons/building-pin.webp",
  className: "landmark-marker",
  iconSize: [22, 30],
  iconAnchor: [11, 30],
  popupAnchor: [0, -27],
  tooltipAnchor: [0, -25],
});

const guidanceTargetIcon = L.divIcon({
  className: "guidance-target-highlight",
  html: '<span aria-hidden="true"></span>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

const landmarksLayer = L.geoJSON(null, {
  pointToLayer(feature, latlng) {
    return L.marker(latlng, {
      icon: buildingIcon,
      pane: MAP_PANES[LANDMARK_RENDER_CONFIG.markerPane],
    });
  },
  onEachFeature(feature, layer) {
    registerGuidanceTarget(feature, layer);
    bindMapFeature(
      layer,
      feature,
      feature.properties.note ||
        `${feature.properties.type}; provisional center from walked extent.`,
      { landmark: true, focusOverlay: landmarksLayer },
    );
  },
});

const intersectionsLayer = L.geoJSON(null, {
  pane: MAP_PANES.intersections,
  renderer: intersectionsRenderer,
  pointToLayer(feature, latlng) {
    return L.circleMarker(latlng, {
      pane: MAP_PANES.intersections,
      renderer: intersectionsRenderer,
      ...INTERSECTION_RENDER_CONFIG.markerStyle,
    });
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, feature.properties.note, {
      focusOverlay: intersectionsLayer,
    });
  },
});

const boundaryHalo = L.geoJSON(null, {
  pane: MAP_PANES.boundary,
  renderer: boundaryRenderer,
  interactive: false,
  style: BOUNDARY_RENDER_CONFIG.haloStyle,
});

const boundaryLayer = L.geoJSON(null, {
  pane: MAP_PANES.boundary,
  renderer: boundaryRenderer,
  interactive: false,
  style: BOUNDARY_RENDER_CONFIG.style,
});

const mainBoundaryInteractionLayer = L.geoJSON(null, {
  pane: MAP_PANES.boundary,
  renderer: boundaryRenderer,
  style: BOUNDARY_RENDER_CONFIG.mainInteractionStyle,
  onEachFeature(feature, layer) {
    registerFocusableFeature(feature, layer, mainBoundaryInteractionLayer);
    const description = feature.properties.popup_description || feature.properties.note;
    layer.bindPopup(() => buildMapFeaturePopup(feature, description));
  },
});

const sliverInteractionLayer = L.geoJSON(null, {
  pane: MAP_PANES.boundary,
  renderer: boundaryRenderer,
  filter(feature) {
    return feature.properties.role === "sliver";
  },
  style: BOUNDARY_RENDER_CONFIG.sliverInteractionStyle,
  onEachFeature(feature, layer) {
    registerFocusableFeature(feature, layer, sliverInteractionLayer);
    const description = feature.properties.popup_description || feature.properties.note;
    layer.bindPopup(() => buildMapFeaturePopup(feature, description));
  },
});

const boundaryGroup = L.layerGroup([
  boundaryHalo,
  boundaryLayer,
  mainBoundaryInteractionLayer,
  sliverInteractionLayer,
]);

const cornersLayer = L.geoJSON(null, {
  pointToLayer(feature, latlng) {
    return L.marker(latlng, {
      pane: MAP_PANES[CORNER_RENDER_CONFIG.markerPane],
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

initializeRegistryLayers();

const controlOverlayEntries = Object.fromEntries(
  getAudienceLayerDefinitions({ panelOnly: true }).map((definition) => [
    definition.label,
    definition.getLayer(),
  ]),
);

const layerControl = L.control
  .layers(
    {
      "NYS aerial (2022)": nysAerial,
      "Topo map": topoMap,
    },
    controlOverlayEntries,
    { collapsed: true, position: "topright" },
  )
  .addTo(map);

installLayerResetButton(layerControl);
const clearLayerControlHoverDelay = installLayerControlHoverDelay(layerControl);

map.on("baselayerchange overlayadd overlayremove moveend", handleMapPreferenceEvent);
map.on("movestart zoomstart", handleMapViewChangeStart);
document.querySelector(".home-link").addEventListener("click", saveMapPreferences);
window.addEventListener("pagehide", handlePageHide);
window.addEventListener("pageshow", handlePageShow);
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

map.getContainer().addEventListener("click", handleMapPopupActionClick, true);
map.getContainer().addEventListener("mouseleave", clearFeatureHoverHighlight);
window.addEventListener("blur", clearFeatureHoverHighlight);
guidanceDismiss.addEventListener("click", stopGuidance);
map.on("popupclose", () => {
  if (hidingPopupForRouteDetails) return;
  clearSelectedFeatureHighlight();
  closeMapRouteDetails({ restorePopup: false, restoreFocus: false });
});

loadLayerRegistry();

infoButton.addEventListener("click", openInfo);
infoClose.addEventListener("click", closeInfo);
infoOverlay.addEventListener("click", (event) => {
  if (event.target === infoOverlay) closeInfo();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!infoOverlay.hidden) closeInfo();
  closeMapRouteDetails({ restorePopup: false });
});

locateButton.addEventListener("click", () => {
  programmaticFocusViewActive = false;
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
    // The accuracy area intentionally stays in Leaflet's overlayPane (400),
    // below every registered property, road, trail, and marker pane.
    locationAccuracyCircle = L.circle(latlng, {
      pane: "overlayPane",
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
      pane: MAP_PANES.liveLocation,
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

let hasShownRequiredDataNotice = false;

async function loadLayerRegistry() {
  let manifest;
  try {
    const response = await fetch("data/manifest.json");
    if (!response.ok) throw new Error(`network response ${response.status}`);
    manifest = await response.json();
    validateDataManifest(manifest);
  } catch (error) {
    console.error("Required data manifest data/manifest.json could not be loaded.", error);
    showRequiredDataNotice();
    finishInitialViewWithoutBoundary();
    return;
  }

  const manifestSources = new Map(
    manifest.sources.map((source) => [source.key, source]),
  );
  const sourcePromises = new Map();
  const loadSourceByKey = (key) => {
    if (!sourcePromises.has(key)) {
      const source = manifestSources.get(key);
      sourcePromises.set(key, loadManifestSource(source));
    }
    return sourcePromises.get(key);
  };

  const tasks = LAYER_DEFINITIONS.map(async (definition) => {
    const sourceEntries = await Promise.all(
      definition.sources.map(async (key) => [key, await loadSourceByKey(key)]),
    );
    const dataBySource = Object.fromEntries(sourceEntries);
    try {
      definition.applyData(dataBySource);
    } catch (error) {
      console.error(`Could not render registered layer ${definition.key}.`, error);
      if (definition.sources.some((key) => manifestSources.get(key)?.required)) {
        showRequiredDataNotice();
      }
    }
    tryFocusRequestedFeature();
  });

  await Promise.all(tasks);
  if (!initialViewReady) finishInitialViewWithoutBoundary();
}

function validateDataManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.sources)) {
    throw new Error("manifest must contain a sources array");
  }
  const sourceKeys = new Set();
  manifest.sources.forEach((source) => {
    if (!source?.key || !source.path || !source.format) {
      throw new Error("every manifest source needs key, path, and format");
    }
    if (sourceKeys.has(source.key)) throw new Error(`duplicate manifest source ${source.key}`);
    sourceKeys.add(source.key);
  });
  LAYER_DEFINITIONS.forEach((definition) => {
    definition.sources.forEach((key) => {
      if (!sourceKeys.has(key)) {
        throw new Error(`layer ${definition.key} references unknown source ${key}`);
      }
    });
  });
}

async function loadManifestSource(source) {
  try {
    const response = await fetch(source.path);
    if (!response.ok) {
      if (!source.required && response.status === 404) return null;
      throw new Error(`network response ${response.status}`);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`malformed JSON: ${error.message}`);
    }
    validateManifestSourceData(source, data);
    return data;
  } catch (error) {
    const classification = String(error.message).startsWith("malformed")
      ? "Malformed"
      : "Unavailable";
    const message = `${classification} ${source.required ? "required" : "optional"} map source ${source.path}.`;
    if (source.required) console.error(message, error);
    else console.warn(message, error);
    if (source.required) showRequiredDataNotice();
    return null;
  }
}

function validateManifestSourceData(source, data) {
  if (source.format === "route-collection") {
    if (!data || !Array.isArray(data.routes)) {
      throw new Error("malformed route collection: routes must be an array");
    }
    return;
  }
  if (source.format !== "geojson") {
    throw new Error(`malformed manifest format: unsupported format ${source.format}`);
  }
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error("malformed GeoJSON: expected a FeatureCollection with features");
  }
  data.features.forEach((feature, index) => {
    if (!feature?.geometry?.type) {
      throw new Error(`malformed GeoJSON: feature ${index} has no geometry`);
    }
    if (
      Array.isArray(source.geometry_types) &&
      source.geometry_types.length > 0 &&
      !source.geometry_types.includes(feature.geometry.type)
    ) {
      throw new Error(
        `malformed GeoJSON: feature ${index} has ${feature.geometry.type}, expected ${source.geometry_types.join(" or ")}`,
      );
    }
  });
}

function showRequiredDataNotice() {
  if (hasShownRequiredDataNotice) return;
  hasShownRequiredDataNotice = true;
  showLocationStatus("Some map details could not be loaded.", 6000);
}

function applyOutsideMaskData({ boundaries, corridor }) {
  if (!boundaries || !corridor) return;
  outsideMaskLayer.addData(buildOutsideMask(boundaries, corridor));
  installOutsideHatchPattern();
}

function applyZonesData({ zones }) {
  if (zones) zonesLayer.addData(zones);
}

function applyCorridorData({ corridor }) {
  if (corridor) corridorLayer.addData(corridor);
}

function applyBoundaryData({ boundaries, corridor }) {
  if (!boundaries) {
    finishInitialViewWithoutBoundary();
    return;
  }
  warnForMissingParcelRoles(boundaries);
  if (corridor) {
    offPropertyTracker.geometry = buildOffPropertyGeometry(boundaries, corridor);
  }
  boundaryHalo.addData(boundaries);
  boundaryLayer.addData(boundaries);
  mainBoundaryInteractionLayer.addData(buildMainBoundaryLine(boundaries));
  sliverInteractionLayer.addData(boundaries);
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
}

function finishInitialViewWithoutBoundary() {
  if (initialViewReady) return;
  map.setView([43.3596, -73.8348], 17);
  preferencesReady = true;
  initialViewReady = true;
  saveMapPreferences();
  tryFocusRequestedFeature();
}

function combineFeatureCollections(title, ...collections) {
  return {
    type: "FeatureCollection",
    properties: { title },
    features: collections
      .filter(Boolean)
      .flatMap((collection) => collection.features || []),
  };
}

function applyRoadsData({ mountainDrive, driveway, trails, routes }) {
  const roads = combineFeatureCollections("Dirt roads", mountainDrive, driveway);
  configureMapRoutes(
    [roads, trails].filter(Boolean),
    Array.isArray(routes?.routes) ? routes.routes : [],
  );
  if (roads.features.length === 0) return;
  roadHalo.addData(roads);
  roadsLayer.addData(roads);
  roadInteractionLayer.addData(roads);
}

function applyTrailsData({ mountainDrive, driveway, trails, routes }) {
  const roads = combineFeatureCollections("Dirt roads", mountainDrive, driveway);
  configureMapRoutes(
    [roads, trails].filter(Boolean),
    Array.isArray(routes?.routes) ? routes.routes : [],
  );
  if (trails) trailsLayer.addData(trails);
}

function applyRouteDefinitionData({ mountainDrive, driveway, trails, routes }) {
  const roads = combineFeatureCollections("Dirt roads", mountainDrive, driveway);
  configureMapRoutes(
    [roads, trails].filter(Boolean),
    Array.isArray(routes?.routes) ? routes.routes : [],
  );
}

function applyLandmarkData({ buildings, landmarks }) {
  if (buildings) landmarksLayer.addData(buildings);
  if (landmarks) landmarksLayer.addData(landmarks);
}

function applyCornersData({ corners }) {
  if (corners) cornersLayer.addData(corners);
}

function applyIntersectionsData({ intersections }) {
  if (intersections) intersectionsLayer.addData(intersections);
}

function configureMapRoutes(featureCollections, routes) {
  routesBySegmentId.clear();
  routesById.clear();
  hasRouteDefinitions = routes.length > 0;
  const segmentFeaturesById = new Map(
    featureCollections
      .flatMap((collection) => collection.features || [])
      .filter((feature) => feature.properties?.id)
      .map((feature) => [feature.properties.id, feature]),
  );

  routes.forEach((route) => {
    if (!route?.id || !route.name || !Array.isArray(route.segments)) {
      console.warn("Skipping an incomplete route definition.", route);
      return;
    }
    const preparedRoute = typeof window.RouteDetails?.deriveRouteMetrics === "function"
      ? window.RouteDetails.deriveRouteMetrics(route, segmentFeaturesById)
      : { ...route };
    routesById.set(preparedRoute.id, preparedRoute);
    preparedRoute.segments.forEach((segmentId) => {
      if (!segmentFeaturesById.has(segmentId)) {
        console.warn(
          `Route \"${route.id}\" references unknown map segment \"${segmentId}\"; skipping it.`,
        );
        return;
      }
      const segmentRoutes = routesBySegmentId.get(segmentId) || [];
      segmentRoutes.push(preparedRoute);
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
      paddingTopLeft: [48, 58],
      paddingBottomRight: [58, 58],
      maxZoom: 18,
      animate: false,
    });
  }
  return true;
}

function focusRequestedBounds(bounds, overlays = []) {
  if (!bounds?.isValid()) return false;
  programmaticFocusViewActive = true;
  suppressPreferencePersistence = true;
  let released = false;
  const release = (keepFocusedView = true) => {
    if (released) return;
    released = true;
    suppressPreferencePersistence = false;
    if (!keepFocusedView) programmaticFocusViewActive = false;
    map.off("moveend", releaseAfterMove);
    window.clearTimeout(programmaticFocusReleaseTimer);
    programmaticFocusReleaseTimer = null;
    if (releaseProgrammaticFocus === release) releaseProgrammaticFocus = null;
  };
  const releaseAfterMove = () => release(true);
  releaseProgrammaticFocus = release;
  map.once("moveend", releaseAfterMove);
  try {
    overlays.forEach((overlay) => {
      if (overlay && !map.hasLayer(overlay)) map.addLayer(overlay);
    });
    const focused = fitFocusBounds(bounds);
    if (!focused) {
      release(false);
      return false;
    }
    if (!released) {
      programmaticFocusReleaseTimer = window.setTimeout(releaseAfterMove, 0);
    }
    return true;
  } catch (error) {
    release(false);
    throw error;
  }
}

function tryFocusRequestedFeature() {
  if (!requestedFeatureId || requestedFeatureFocused || !initialViewReady) return;

  const route = routesById.get(requestedFeatureId);
  if (route) {
    const members = route.segments
      .map((segmentId) => focusableFeaturesById.get(segmentId))
      .filter(Boolean);
    if (members.length !== route.segments.length) return;
    const bounds = L.latLngBounds([]);
    members.forEach(({ layer }) => {
      const memberBounds = layerFocusBounds(layer);
      if (memberBounds) bounds.extend(memberBounds);
    });
    if (!focusRequestedBounds(bounds, members.map(({ focusOverlay }) => focusOverlay))) return;
    requestedFeatureFocused = true;
    setSelectedFeatureLayers(members.map(({ layer }) => layer));
    L.popup({ autoPan: false })
      .setLatLng(bounds.getCenter())
      .setContent(
        buildMapFeaturePopup(
          { properties: { name: route.name } },
          route.description || "Mapped visitor route.",
          {
            secondary: route.shape,
            routes: [route],
          },
        ),
      )
      .openOn(map);
    return;
  }

  const match = focusableFeaturesById.get(requestedFeatureId);
  if (!match) return;
  const bounds = layerFocusBounds(match.layer);
  if (!focusRequestedBounds(bounds, [match.focusOverlay])) return;
  requestedFeatureFocused = true;
  setSelectedFeatureLayers([match.layer]);
  L.popup({ autoPan: false })
    .setLatLng(bounds.getCenter())
    .setContent(
      `<div class="map-popup-content"><strong>${escapeHtml(match.feature.properties.name)}</strong></div>`,
    )
    .openOn(map);
}

function routesForFeature(feature) {
  return routesBySegmentId.get(feature.properties?.id) || [];
}

function trailStyle(feature) {
  const isConnector = hasRouteDefinitions && routesForFeature(feature).length === 0;
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
  const routes = routesForFeature(feature);
  const detail = "Provisional walking-trail centerline from repeated phone-GPS passes.";
  if (routes.length === 0) return { detail };

  return {
    title: routes.map((route) => route.name).join(" \u00b7 "),
    secondary: `Segment: ${segmentName}`,
    detail,
    routes,
  };
}

function buildRoadPopupOptions(feature) {
  const routes = routesForFeature(feature);
  const properties = feature.properties || {};
  const detail = [properties.status, properties.note]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().replace(/[.\s]+$/, ""))
    .join(". ");
  const safeDetail = detail ? `${detail}.` : "Approximate dirt-road centerline.";
  if (routes.length === 0) return { detail: safeDetail };
  return {
    title: routes.map((route) => route.name).join(" \u00b7 "),
    secondary: `Road: ${properties.name || "Mapped road"}`,
    detail: safeDetail,
    routes,
  };
}

function buildMainBoundaryLine(boundaryData) {
  const mainParcel = boundaryData.features.find(
    (feature) => feature.properties.role === "main-parcel",
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

function warnForMissingParcelRoles(boundaryData) {
  const roles = new Set(
    (boundaryData.features || []).map((feature) => feature.properties?.role).filter(Boolean),
  );
  ["main-parcel", "sliver"].forEach((role) => {
    if (!roles.has(role)) {
      console.warn(`Expected parcel role "${role}" was not found in boundaries.geojson.`);
    }
  });
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

function registerGuidanceTarget(feature, layer) {
  if (feature.geometry.type !== "Point" || !feature.properties.id) return;
  const [longitude, latitude] = feature.geometry.coordinates;
  guidanceTracker.targets.set(feature.properties.id, {
    id: feature.properties.id,
    name: feature.properties.name,
    latlng: L.latLng(latitude, longitude),
    layer,
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
  if (Array.isArray(options.routes) && options.routes.length > 0) {
    popupHtml += buildRouteSummaryHtml(options.routes);
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

function buildRouteSummaryHtml(routes) {
  const summaries = routes.map((route) => {
    const difficulty = routeDifficultyPresentation(route.difficulty);
    const difficultyHtml = difficulty
      ? `<span class="route-difficulty route-difficulty--${difficulty.className}" ` +
        `aria-label="${escapeHtml(difficulty.label)} difficulty">` +
        `<span class="route-difficulty-symbol" aria-hidden="true"></span>` +
        `<span>${escapeHtml(difficulty.label)}</span></span>`
      : "";
    const lengthHtml = Number.isFinite(Number(route.length_ft))
      ? `<span class="route-length">${escapeHtml(formatRouteDistanceLabel(route))}</span>`
      : "";
    const detailsHtml =
      `<button class="route-details-trigger" type="button" ` +
      `data-route-id="${escapeHtml(route.id)}">Route details</button>`;
    return `<span class="route-summary-row">${difficultyHtml}${detailsHtml}${lengthHtml}</span>`;
  });
  return `<span class="route-summary">${summaries.join("")}</span>`;
}

function formatRouteDistanceLabel(route) {
  if (typeof window.RouteDetails?.distanceLabel === "function") {
    return window.RouteDetails.distanceLabel(route);
  }
  const feet = Number(route?.length_ft);
  if (!Number.isFinite(feet)) return "";
  const distance = feet >= ROUTE_MILES_THRESHOLD_FEET
    ? `${(feet / 5280).toFixed(2)} mi`
    : `${Math.round(feet).toLocaleString()} ft`;
  return route.shape === "out-and-back" ? `${distance} round trip` : distance;
}

function formatLiveDistance(lengthFeet, hereThresholdFeet = null) {
  if (typeof window.RouteDetails?.formatDistance === "function") {
    return window.RouteDetails.formatDistance(lengthFeet, {
      approximate: true,
      hereThresholdFeet,
      milesThresholdFeet: LIVE_DISTANCE_MILES_THRESHOLD_FEET,
    });
  }
  const feet = Number(lengthFeet);
  if (!Number.isFinite(feet)) return "";
  if (Number.isFinite(hereThresholdFeet) && feet < hereThresholdFeet) {
    return "you're here";
  }
  if (feet >= LIVE_DISTANCE_MILES_THRESHOLD_FEET) {
    return `about ${(feet / 5280).toFixed(2)} mi`;
  }
  const increment = feet < 300 ? 10 : 25;
  return `about ${(Math.round(feet / increment) * increment).toLocaleString()} ft`;
}

function routeDifficultyPresentation(value) {
  const difficulty = String(value || "").toLowerCase();
  return {
    easy: { className: "easy", label: "Easy" },
    moderate: { className: "moderate", label: "Moderate" },
    rugged: { className: "rugged", label: "Rugged" },
  }[difficulty] || null;
}

function bindMapFeature(layer, feature, detail, options = {}) {
  registerFocusableFeature(feature, options.visualLayer || layer, options.focusOverlay);
  rememberBaseFeatureStyle(options.visualLayer || layer);
  const hasFinePointer = window.matchMedia(
    "(any-hover: hover) and (any-pointer: fine)",
  ).matches;
  if (hasFinePointer) {
    layer.bindTooltip(escapeHtml(options.title || feature.properties.name), {
      sticky: true,
      direction: "top",
    });
    installFeatureHoverFeedback(
      () => featureSelectionLayers(layer, options),
      layer,
    );
  }

  layer.on("click", (event) => {
    if (!hasFinePointer) layer.closeTooltip();
    window.clearTimeout(pendingFeaturePopupTimer);
    pendingFeaturePopupTimer = null;
    if (featurePopupsAreSuppressed()) return;

    const openPopup = () => {
      pendingFeaturePopupTimer = null;
      if (featurePopupsAreSuppressed()) return;
      closeMapRouteDetails({ restorePopup: false, restoreFocus: false });
      map.closePopup();
      setSelectedFeatureLayers(featureSelectionLayers(layer, options));
      L.popup()
        .setLatLng(event.latlng)
        .setContent(buildMapFeaturePopup(feature, detail, options))
        .openOn(map);
    };
    if (hasFinePointer) {
      openPopup();
    } else {
      pendingFeaturePopupTimer = window.setTimeout(
        openPopup,
        RAPID_DOUBLE_TAP_MS + 20,
      );
    }
  });
}

function rememberBaseFeatureStyle(layer) {
  if (!layer || typeof layer.setStyle !== "function" || baseFeatureStyles.has(layer)) {
    return;
  }
  const style = {};
  ["color", "weight", "opacity", "fillOpacity"].forEach((key) => {
    if (layer.options[key] !== undefined) style[key] = layer.options[key];
  });
  baseFeatureStyles.set(layer, style);
}

function installFeatureHoverFeedback(resolveLayers, eventLayer) {
  if (!eventLayer || typeof eventLayer.on !== "function") return;
  eventLayer.on("mouseover", () => {
    window.clearTimeout(featureHoverClearTimer);
    featureHoverClearTimer = null;
    hoveredFeatureEventLayers.add(eventLayer);
    setHoveredFeatureLayers(resolveLayers());
  });
  eventLayer.on("mouseout", () => {
    hoveredFeatureEventLayers.delete(eventLayer);
    window.clearTimeout(featureHoverClearTimer);
    featureHoverClearTimer = window.setTimeout(() => {
      featureHoverClearTimer = null;
      if (hoveredFeatureEventLayers.size === 0) clearFeatureHoverHighlight();
    }, 0);
  });
}

function featureSelectionLayers(layer, options = {}) {
  const route = Array.isArray(options.routes) ? options.routes[0] : null;
  if (route?.segments?.length) {
    const routeLayers = route.segments
      .map((segmentId) => focusableFeaturesById.get(segmentId)?.layer)
      .filter(Boolean);
    if (routeLayers.length) return routeLayers;
  }
  return [options.visualLayer || layer].filter(Boolean);
}

function clearSelectedFeatureHighlight() {
  const previousLayers = selectedFeatureLayers;
  selectedFeatureLayers = [];
  previousLayers.forEach(applyFeatureHighlightState);
}

function setSelectedFeatureLayers(layers) {
  const previousLayers = selectedFeatureLayers;
  clearSelectedFeatureHighlight();
  selectedFeatureLayers = [...new Set(layers)].filter(
    (layer) => layer && typeof layer.setStyle === "function",
  );
  [...new Set([...previousLayers, ...selectedFeatureLayers])]
    .forEach(applyFeatureHighlightState);
}

function setHoveredFeatureLayers(layers) {
  const previousLayers = hoveredFeatureLayers;
  hoveredFeatureLayers = [...new Set(layers)].filter(
    (layer) => layer && typeof layer.setStyle === "function",
  );
  [...new Set([...previousLayers, ...hoveredFeatureLayers])]
    .forEach(applyFeatureHighlightState);
}

function clearFeatureHoverHighlight() {
  window.clearTimeout(featureHoverClearTimer);
  featureHoverClearTimer = null;
  hoveredFeatureEventLayers = new Set();
  const previousLayers = hoveredFeatureLayers;
  hoveredFeatureLayers = [];
  previousLayers.forEach(applyFeatureHighlightState);
}

function applyFeatureHighlightState(layer) {
  rememberBaseFeatureStyle(layer);
  const baseStyle = baseFeatureStyles.get(layer) || {};
  const isSelected = selectedFeatureLayers.includes(layer);
  const isHovered = hoveredFeatureLayers.includes(layer);
  const emphasis = isSelected ? 3 : isHovered ? 1 : 0;
  const style = { ...baseStyle };
  if (emphasis > 0) {
    style.weight = (Number(baseStyle.weight) || 0) + emphasis;
    style.opacity = 1;
    if (baseStyle.fillOpacity !== undefined) {
      style.fillOpacity = Math.min(
        1,
        Number(baseStyle.fillOpacity) + (isSelected ? 0.1 : 0.04),
      );
    }
  }
  layer.setStyle(style);
}

function featurePopupsAreSuppressed() {
  const now = performance.now();
  const remaining = suppressFeaturePopupsUntil - now;
  if (
    !Number.isFinite(suppressFeaturePopupsUntil) ||
    remaining > RAPID_DOUBLE_TAP_MS + 50
  ) {
    console.warn("Feature popup suppression exceeded its bounded double-tap window; resetting it.");
    suppressFeaturePopupsUntil = 0;
    return false;
  }
  if (remaining <= 0) {
    suppressFeaturePopupsUntil = 0;
    return false;
  }
  return true;
}

function formatLandmarkDistance(distanceMeters, bearing) {
  const distanceText = formatLiveDistance(distanceMeters * 3.28084, 15);
  if (distanceText === "you're here") return distanceText;
  return `${distanceText} \u00b7 ${bearingToCompassPoint(bearing)}`;
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

function handleMapPopupActionClick(event) {
  if (event.target.closest?.(".guide-me-button")) {
    handleGuideButtonClick(event);
    return;
  }
  if (event.target.closest?.(".route-details-trigger")) {
    handleRouteDetailsClick(event);
  }
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

function handleRouteDetailsClick(event) {
  const button = event.target.closest?.(".route-details-trigger");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const route = routesById.get(button.dataset.routeId);
  if (!route || !window.RouteDetails) return;

  closeMapRouteDetails({ restorePopup: false, restoreFocus: false });
  const sourcePopup = typeof map.getPopup === "function" ? map.getPopup() : map._popup;
  const { details, closeButton } = window.RouteDetails.createPanel(route, {
    className: "route-details-popout--map",
  });
  closeButton.addEventListener("click", () => {
    closeMapRouteDetails({ restorePopup: true });
  });
  document.body.append(details);
  details.hidden = false;
  button.setAttribute("aria-expanded", "true");
  openMapRouteDetails = { button, details, routeId: route.id, sourcePopup };
  if (sourcePopup) {
    hidingPopupForRouteDetails = true;
    try {
      map.closePopup(sourcePopup);
    } finally {
      hidingPopupForRouteDetails = false;
    }
  }
  closeButton.focus();
}

function closeMapRouteDetails({ restorePopup = false, restoreFocus = true } = {}) {
  if (!openMapRouteDetails) return;
  const currentDetails = openMapRouteDetails;
  openMapRouteDetails = null;
  currentDetails.button.setAttribute("aria-expanded", "false");
  currentDetails.details.remove();

  if (restorePopup && currentDetails.sourcePopup) {
    currentDetails.sourcePopup.openOn(map);
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        const restoredButton = [...map.getContainer().querySelectorAll(".route-details-trigger")]
          .find((candidate) => candidate.dataset.routeId === currentDetails.routeId);
        restoredButton?.focus();
      });
    }
    return;
  }

  clearSelectedFeatureHighlight();
  if (restoreFocus && currentDetails.button.isConnected) currentDetails.button.focus();
}

async function startGuidance(targetId) {
  const target = guidanceTracker.targets.get(targetId);
  if (!target) return;

  showGuidanceTargetHighlight(target);
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
  guidanceTracker.headingError = null;
  updateGuidancePill();
  renderGuidanceTint(GUIDANCE_MAX_ERROR_DEG, { centered: true });
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
  clearGuidanceTargetHighlight();
  const popup = map._popup;
  if (!popup) return;
  popup.setContent('<span class="compass-note">Compass access was declined</span>');
  guidanceTracker.popupCloseTimer = window.setTimeout(() => {
    if (map._popup === popup) map.closePopup();
    guidanceTracker.popupCloseTimer = null;
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
  renderGuidanceTint(GUIDANCE_MAX_ERROR_DEG, { centered: true });
  updateGuidancePill();
}

function renderGuidanceTint(error, { centered = false } = {}) {
  const ramp = readGuidanceRamp();
  const signedError = normalizeBearingError(error);
  const magnitude = Math.min(Math.abs(signedError), GUIDANCE_MAX_ERROR_DEG);
  const style = interpolateGuidanceRamp(magnitude, ramp);
  const offset = centered ? 0 : Math.max(-1, Math.min(1, signedError / 90)) * 46;
  guidanceTracker.headingError = centered ? null : signedError;
  guidanceTint.style.setProperty("--guidance-offset", `${offset}vw`);
  guidanceTint.style.setProperty("--guidance-saturation", `${style.saturation}%`);
  guidanceTint.style.setProperty("--guidance-lightness", `${style.lightness}%`);
  guidanceTint.style.setProperty("--guidance-opacity", style.opacity);
  guidanceTint.style.setProperty("--guidance-width", `${style.width}vw`);
  guidanceTint.style.setProperty("--guidance-blur", `${style.blur}px`);
  guidanceTint.classList.toggle(
    "guidance-tint--locked",
    !centered && magnitude <= GUIDANCE_LOCKED_ERROR_DEG,
  );

  if (!guidanceTint.classList.contains("guidance-tint--active")) {
    guidanceTint.classList.add("guidance-tint--starting");
    window.requestAnimationFrame(() => guidanceTint.classList.add("guidance-tint--active"));
    window.clearTimeout(guidanceTracker.tintStartTimer);
    guidanceTracker.tintStartTimer = window.setTimeout(() => {
      guidanceTint.classList.remove("guidance-tint--starting");
      guidanceTracker.tintStartTimer = null;
    }, 440);
  }
  if (guidanceTracker.isActive && !centered) updateGuidancePill();
}

function readGuidanceRamp() {
  const styles = getComputedStyle(document.documentElement);
  const value = (name) => Number.parseFloat(styles.getPropertyValue(name));
  return [
    { error: 0, saturation: value("--guidance-saturation-0"), lightness: value("--guidance-lightness-0"), opacity: value("--guidance-opacity-0"), width: value("--guidance-width-0"), blur: value("--guidance-blur-0") },
    { error: 30, saturation: value("--guidance-saturation-30"), lightness: value("--guidance-lightness-30"), opacity: value("--guidance-opacity-30"), width: value("--guidance-width-30"), blur: value("--guidance-blur-30") },
    { error: 60, saturation: value("--guidance-saturation-60"), lightness: value("--guidance-lightness-60"), opacity: value("--guidance-opacity-60"), width: value("--guidance-width-60"), blur: value("--guidance-blur-60") },
    { error: 110, saturation: value("--guidance-saturation-110"), lightness: value("--guidance-lightness-110"), opacity: value("--guidance-opacity-110"), width: value("--guidance-width-110"), blur: value("--guidance-blur-110") },
    { error: 180, saturation: value("--guidance-saturation-180"), lightness: value("--guidance-lightness-180"), opacity: value("--guidance-opacity-180"), width: value("--guidance-width-180"), blur: value("--guidance-blur-180") },
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
  const turnInstruction = guidanceTurnInstruction(guidanceTracker.headingError);
  setGuidancePill(
    `Guiding to ${guidanceTracker.target.name} \u00b7 ${formatLiveDistance(distance * 3.28084, 15)}` +
      (turnInstruction ? ` \u00b7 ${turnInstruction}` : ""),
  );
}

function guidanceTurnInstruction(error) {
  if (!Number.isFinite(error)) return "";
  const signedError = normalizeBearingError(error);
  const magnitude = Math.abs(signedError);
  if (magnitude <= GUIDANCE_LOCKED_ERROR_DEG) return "on course";
  if (magnitude >= GUIDANCE_TURN_AROUND_ERROR_DEG) return "turn around";
  return signedError > 0 ? "turn right" : "turn left";
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
    clearGuidanceTargetHighlight();
    guidanceTracker.target = null;
  }, 2000);
}

function stopGuidance() {
  detachOrientationListeners();
  clearGuidanceTimers();
  guidanceTracker.isActive = false;
  guidanceTracker.isWaitingForLocation = false;
  guidanceTracker.targetBearing = null;
  guidanceTracker.headingError = null;
  guidanceTracker.smoothedSin = null;
  guidanceTracker.smoothedCos = null;
  guidanceTint.classList.remove(
    "guidance-tint--active",
    "guidance-tint--starting",
    "guidance-tint--locked",
  );
  clearGuidanceTargetHighlight();
  guidanceTracker.pillHideTimer = window.setTimeout(() => {
    guidancePill.hidden = true;
    guidanceTracker.target = null;
  }, 260);
}

function showGuidanceTargetHighlight(target) {
  clearGuidanceTargetHighlight();
  guidanceTracker.highlightLayer = L.marker(target.latlng, {
    icon: guidanceTargetIcon,
    pane: MAP_PANES.buildings,
    interactive: false,
    keyboard: false,
    zIndexOffset: -1000,
  }).addTo(map);
}

function clearGuidanceTargetHighlight() {
  if (!guidanceTracker.highlightLayer) return;
  guidanceTracker.highlightLayer.remove();
  guidanceTracker.highlightLayer = null;
}

function clearGuidanceTimers() {
  [
    "headingTimeout",
    "tintStartTimer",
    "tintHideTimer",
    "pillHideTimer",
    "unavailableHintTimer",
    "unavailableEndTimer",
    "popupCloseTimer",
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

function migrateMapPreferences(value) {
  if (
    value?.version === MAP_PREFERENCES_VERSION &&
    value.profiles &&
    typeof value.profiles === "object"
  ) {
    return value;
  }
  const legacy = value && typeof value === "object" ? value : {};
  return {
    version: MAP_PREFERENCES_VERSION,
    activeAudience: "visitor",
    profiles: { visitor: legacy },
  };
}

function getAudiencePreferences(store, audience) {
  const direct = store.profiles?.[audience];
  if (direct && typeof direct === "object") return direct;
  const visitor = store.profiles?.visitor;
  if (!visitor || typeof visitor !== "object") return {};
  return {
    ...visitor,
    overlays: visitor.overlays && typeof visitor.overlays === "object"
      ? { ...visitor.overlays }
      : {},
  };
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

function getLayerDefinition(key) {
  const definition = LAYER_DEFINITIONS.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`Unknown registered layer: ${key}`);
  return definition;
}

function getAudienceLayerDefinitions({ panelOnly = false } = {}) {
  return LAYER_DEFINITIONS
    .filter((definition) => definition.audiences.includes(activeAudience))
    .filter((definition) => !panelOnly || Boolean(definition.label && definition.getLayer()))
    .sort((first, second) =>
      first.group.localeCompare(second.group) || first.order - second.order,
    );
}

function initializeRegistryLayers() {
  getAudienceLayerDefinitions().forEach((definition) => {
    const layer = definition.getLayer();
    if (!layer) return;
    const savedValue = savedMapPreferences.overlays?.[definition.key];
    const shouldShow = definition.label
      ? (typeof savedValue === "boolean"
          ? savedValue
          : definition.defaultVisible[activeAudience])
      : definition.defaultVisible[activeAudience];
    if (shouldShow) layer.addTo(map);
  });
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
  const handleMouseEnter = () => {
    window.clearTimeout(collapseTimer);
    collapseTimer = null;
  };
  const handleMouseLeave = () => {
    window.clearTimeout(collapseTimer);
    collapseTimer = window.setTimeout(() => {
      if (!container.matches(":hover")) control.collapse();
      collapseTimer = null;
    }, LAYER_CONTROL_COLLAPSE_DELAY_MS);
  };
  container.addEventListener("mouseenter", handleMouseEnter);
  container.addEventListener("mouseleave", handleMouseLeave);
  return () => {
    window.clearTimeout(collapseTimer);
    collapseTimer = null;
  };
}

function resetMapToDefaults() {
  programmaticFocusViewActive = false;
  stopGuidance();
  map.closePopup();
  if (map.hasLayer(topoMap)) map.removeLayer(topoMap);
  if (!map.hasLayer(nysAerial)) map.addLayer(nysAerial);

  getAudienceLayerDefinitions({ panelOnly: true }).forEach((definition) => {
    const layer = definition.getLayer();
    const shouldShow = definition.defaultVisible[activeAudience];
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

  const preferences = {
    baseMap: map.hasLayer(topoMap) ? "topo" : "aerial",
    overlays: Object.fromEntries(
      getAudienceLayerDefinitions({ panelOnly: true }).map((definition) => [
        definition.key,
        map.hasLayer(definition.getLayer()),
      ]),
    ),
  };
  if (programmaticFocusViewActive && hasSavedMapView(savedMapPreferences)) {
    preferences.center = savedMapPreferences.center;
    preferences.zoom = savedMapPreferences.zoom;
  } else if (!programmaticFocusViewActive) {
    const center = map.getCenter();
    preferences.center = [Number(center.lat.toFixed(7)), Number(center.lng.toFixed(7))];
    preferences.zoom = map.getZoom();
  }

  try {
    mapPreferenceStore = {
      ...mapPreferenceStore,
      version: MAP_PREFERENCES_VERSION,
      activeAudience,
      profiles: {
        ...(mapPreferenceStore.profiles || {}),
        [activeAudience]: preferences,
      },
    };
    window.localStorage.setItem(MAP_PREFERENCES_KEY, JSON.stringify(mapPreferenceStore));
    savedMapPreferences = preferences;
  } catch {
    // The map remains usable when storage is blocked or unavailable.
  }
}

function handleMapPreferenceEvent() {
  if (suppressPreferencePersistence) return;
  saveMapPreferences();
}

function handleMapViewChangeStart() {
  if (!suppressPreferencePersistence) programmaticFocusViewActive = false;
}

function handlePageHide() {
  saveMapPreferences();
  if (watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  detachOrientationListeners();
  clearGuidanceTimers();
  clearGuidanceTargetHighlight();
  guidanceTracker.isActive = false;
  guidanceTracker.isWaitingForLocation = false;
  guidanceTracker.targetBearing = null;
  guidanceTracker.target = null;
  guidancePill.hidden = true;
  guidanceTint.classList.remove(
    "guidance-tint--active",
    "guidance-tint--starting",
    "guidance-tint--locked",
  );
  clearSelectedFeatureHighlight();
  closeMapRouteDetails();
  window.clearTimeout(locationStatusTimer);
  locationStatusTimer = null;
  window.clearTimeout(offPropertyTooltipTimer);
  offPropertyTooltipTimer = null;
  if (locationMarker) locationMarker.closeTooltip().unbindTooltip();
  window.clearTimeout(pendingFeaturePopupTimer);
  pendingFeaturePopupTimer = null;
  window.clearTimeout(programmaticFocusReleaseTimer);
  programmaticFocusReleaseTimer = null;
  if (releaseProgrammaticFocus) releaseProgrammaticFocus(false);
  suppressPreferencePersistence = false;
  clearLayerControlHoverDelay();
}

function handlePageShow(event) {
  if (event.persisted && latestPosition && watchId === null && navigator.geolocation) {
    startLocationWatch();
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
