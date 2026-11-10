"use strict";

const PROPERTY_BOUNDS_PADDING = [28, 28];
const PROPERTY_CONTEXT_METERS = 60.96;
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
const PREFERRED_ABSOLUTE_HEADING_WINDOW_MS = 1200;
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
const DATA_CACHE_VERSION = "20261109-6";
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
const requestedMapFocus = new URLSearchParams(window.location.search)
  .get("focus")
  ?.trim();
const hasExplicitMapFocus = requestedMapFocus === "property" || Boolean(requestedFeatureId);
let preferencesReady = false;
let initialViewReady = false;
let pendingFeaturePopupTimer = null;
let pendingFeaturePopupPriority = Number.NEGATIVE_INFINITY;
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
let infoButton = null;
let mapLegendControl = null;
let mapLegendRestoreControl = null;
let legendDismissedForSession = false;
let mapWeatherControl = null;
let mapWeatherView = null;
let weatherPanelOpen = false;
let mapCompassControl = null;
let compassPanelOpen = false;
let mobileHeadingSessionActive = false;
let compassToggleDisplayedAngle = null;
let topographicStatusNode = null;
let contourSourceState = "pending";
const mapPanelOpenOrder = ["legend"];
const mobileMapPanels = window.matchMedia("(max-width: 720px)");
let layerControlDecorationFrame = null;
const roadVisualLayersById = new Map();
const trailVisualLayersById = new Map();
const zoneVisualLayersById = new Map();
const boundaryVisualLayersById = new Map();
const corridorVisualLayersByName = new Map();
const camSiteVisualLayersById = new Map();
let camSitesVisualLayer = null;
let camSitesInteractionLayer = null;
let camDeploymentArrowsLayer = null;
let camDraftArrowLayer = null;
let camSitesGroup = null;

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
  hideGuideButton: false,
  targetBearing: null,
  headingError: null,
  tintStartTimer: null,
  tintHideTimer: null,
  pillHideTimer: null,
  unavailableHintTimer: null,
  unavailableEndTimer: null,
  popupCloseTimer: null,
  highlightLayer: null,
  hasShownIosOrientationHint: false,
};

const headingPipeline = {
  permission: "unknown",
  lastPermissionResult: "not-requested",
  permissionPromise: null,
  orientationEvents: [],
  screenOrientationTarget: null,
  usesWindowOrientationChange: false,
  isIosPermissionPath: false,
  orientationEventFired: false,
  sawWebkitCompassHeading: false,
  sawFiniteAlpha: false,
  lastNativeAbsoluteAt: 0,
  lastAndroidSensorHeading: null,
  latestHeading: null,
  latestHeadingAt: 0,
  smoothedSin: null,
  smoothedCos: null,
  lastHeadingAt: 0,
  lastVisualUpdateAt: 0,
  freshnessTimeout: null,
  staleNotified: false,
  awaitingFreshEventAfterResume: false,
  pageSuspended: false,
};
let compassDisplayedAngle = null;
let guidanceStartGeneration = 0;
let guidanceStartPending = false;

const map = L.map("map", {
  zoomControl: true,
  maxZoom: DEFAULT_MAX_ZOOM,
  zoomDelta: 0.5,
  zoomSnap: 0.5,
  wheelPxPerZoomLevel: L.Map.prototype.options.wheelPxPerZoomLevel * 2,
  doubleClickZoom: true,
  preferCanvas: true,
});

// Give Leaflet a valid drawing viewport before asynchronous GeoJSON arrives.
map.setView([43.3596, -73.8348], 17);

// Audiences only tailor presentation. They are not a security boundary: every
// repository file remains publicly downloadable, and either view can be chosen
// through the URL. Keep genuinely private data out of this repository.
const ALL_AUDIENCES = Object.freeze(["visitor", "owner"]);
const terrainLayers = Object.fromEntries(
  ["terrainSlope", "terrainAspect", "soils", "contours"].map((key) => [key, L.layerGroup()]),
);
const terrainLegends = new Map();
const ASPECT_DIRECTIONS = Object.freeze([
  ["N", 0], ["NE", 45], ["E", 90], ["SE", 135],
  ["S", 180], ["SW", 225], ["W", 270], ["NW", 315],
].map(([label, bearing]) => Object.freeze({ label, bearing })));
const LAYER_DEFINITIONS = [
  ...[
    { key: "terrainSlope", label: "Slope", order: 11, sources: ["terrainSlope"] },
    { key: "terrainAspect", label: "Slope direction (aspect)", order: 12, sources: ["terrainAspect"] },
    { key: "soils", label: "Soil map units", order: 13, sources: ["soils"] },
    {
      key: "contours", label: null, order: 31, sources: ["contours"],
      baseOnly: true, optionalSources: ["contours"],
    },
  ].map(({ key, label, order, sources, baseOnly = false, optionalSources = [] }) => ({
    key, label, group: "80-terrain", order, sources,
    baseOnly, optionalSources,
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: false, owner: false },
    render: { kind: "geojson", panes: [
      { key, name: `${key}-pane`, order },
      ...(key === "soils" ? [{ key: "soilInteractions", name: "soil-interactions-pane", order: 66.5 }] : []),
      ...(key === "contours" ? [{ key: "contourLabels", name: "contour-labels-pane", order: 32 }] : []),
    ] },
    getLayer: () => terrainLayers[key],
    applyData: (data) => applyTerrainData(key, data[key]),
  })),
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
      hatch: {
        size: 18,
        backgroundColor: "#fff4dc",
        backgroundOpacity: 0.18,
        color: "#934c13",
        opacity: 0.45,
        weight: 1.65,
        dashArray: "5 4",
      },
    },
    getLayer: () => outsideMaskLayer,
    applyData: applyOutsideMaskData,
  },
  {
    key: "zones",
    label: "Zones",
    group: "90-experimental",
    order: 20,
    experimental: true,
    sources: ["zones"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: false, owner: false },
    render: {
      kind: "geojson",
      panes: [{ key: "zones", name: "zones-pane", order: 20 }],
      style: { color: "#f0c85f", weight: 2, opacity: 0.95, dashArray: "2 7", fillColor: "#f5dda0", fillOpacity: 0.14 },
      interactionStyle: { stroke: false, fillColor: "#000000", fillOpacity: 0.001 },
    },
    getLayer: () => zonesGroup,
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
      interactionStyle: { stroke: false, fillColor: "#000000", fillOpacity: 0.001 },
    },
    getLayer: () => corridorGroup,
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
      interactionStyle: { color: "#ffffff", weight: 12, opacity: 0.001, fill: false, lineJoin: "round" },
    },
    getLayer: () => boundaryGroup,
    applyData: applyBoundaryData,
  },
  {
    key: "roads",
    label: null,
    group: "20-routes",
    order: 50,
    sources: ["driveway", "trails", "routes"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "composite",
      panes: [{ key: "roads", name: "roads-pane", order: 50 }],
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
    sources: ["driveway", "trails", "routes"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "geojson",
      panes: [
        { key: "trails", name: "trails-pane", order: 60 },
        { key: "trailInteractions", name: "trail-interactions-pane", order: 67.5 },
      ],
      style: trailStyle,
      interactionStyle: trailInteractionStyle,
    },
    getLayer: () => trailsGroup,
    applyData: applyTrailsData,
  },
  {
    key: "routeDefinitions",
    label: null,
    group: "data",
    order: 65,
    sources: ["driveway", "trails", "routes"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: { kind: "data", panes: [] },
    getLayer: () => null,
    applyData: applyRouteDefinitionData,
  },
  {
    key: "camSites",
    label: "Trail cam sites",
    group: "90-experimental",
    order: 64,
    experimental: true,
    sources: ["camSites"],
    audiences: ["owner"],
    defaultVisible: { owner: false },
    render: {
      kind: "geojson",
      panes: [{ key: "camSites", name: "cam-sites-pane", order: 64 }],
      markerStyle: {
        radius: 7,
        color: "#14231d",
        weight: 2,
        fillColor: "#ffd45f",
        fillOpacity: 1,
      },
      interactionStyle: {
        radius: 18,
        stroke: false,
        fillColor: "#000000",
        fillOpacity: 0.001,
      },
    },
    getLayer: () => camSitesGroup,
    applyData: applyCamSitesData,
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
    key: "interactions",
    label: null,
    group: "runtime",
    order: 67,
    sources: [],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: true, owner: true },
    render: {
      kind: "runtime",
      // One SVG pane sits above every full-viewport visual canvas and below
      // the landmark and marker panes. Only its painted hit paths receive
      // pointer events, so empty map areas continue to fall through.
      panes: [{ key: "interactions", name: "interactions-pane", order: 67 }],
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
        { key: "buildings", name: "buildings-pane", order: 71 },
      ],
      markerPanes: { building: "buildings", landmark: "naturalLandmarks" },
      markerStyle: {
        iconUrl: "assets/icons/building-pin.webp",
        iconSize: [22, 30],
        iconAnchor: [11, 30],
        popupAnchor: [0, -27],
        tooltipAnchor: [0, -25],
      },
    },
    getLayer: () => landmarksLayer,
    applyData: applyLandmarkData,
  },
  {
    key: "minorLandmarks",
    label: "Minor landmarks",
    group: "30-landmarks",
    order: 71,
    sources: ["buildings", "landmarks"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: false, owner: false },
    render: {
      kind: "merged-geojson",
      panes: [],
      markerStyle: {
        size: 11,
        borderWidth: 2,
        fillColor: "#3b8f7c",
        borderColor: "#eef8f5",
      },
    },
    getLayer: () => minorLandmarksLayer,
    applyData: applyMinorLandmarkData,
  },
  {
    key: "corners",
    label: "Corner markers",
    group: "90-experimental",
    order: 80,
    experimental: true,
    sources: ["corners"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: false, owner: false },
    render: { kind: "geojson", panes: [{ key: "corners", name: "corners-pane", order: 68 }], markerPane: "corners" },
    getLayer: () => cornersLayer,
    applyData: applyCornersData,
  },
  {
    key: "intersections",
    label: "Intersections",
    group: "90-experimental",
    order: 90,
    experimental: true,
    sources: ["intersections"],
    audiences: ALL_AUDIENCES,
    defaultVisible: { visitor: false, owner: false },
    render: {
      kind: "geojson",
      panes: [{ key: "intersections", name: "intersections-pane", order: 69 }],
      markerPane: "intersections",
      markerStyle: { radius: 5, color: "#ffffff", weight: 2, fillColor: "#8e4c9e", fillOpacity: 1 },
    },
    getLayer: () => intersectionsLayer,
    applyData: applyIntersectionsData,
  },
];

const OPTIONAL_MANIFEST_SOURCE_KEYS = new Set(
  LAYER_DEFINITIONS.flatMap((definition) => definition.optionalSources || []),
);

const paneDefinitions = LAYER_DEFINITIONS
  .filter((definition) => definition.audiences.includes(activeAudience))
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
map.getPane(MAP_PANES.contourLabels).style.pointerEvents = "none";
const contourLabelGroup = L.layerGroup().addTo(map);
let contourLabelFeatures = [];

const OUTSIDE_RENDER_CONFIG = getLayerDefinition("outsideShading").render;
const ZONE_RENDER_CONFIG = getLayerDefinition("zones").render;
const CORRIDOR_RENDER_CONFIG = getLayerDefinition("corridor").render;
const BOUNDARY_RENDER_CONFIG = getLayerDefinition("boundary").render;
const ROAD_RENDER_CONFIG = getLayerDefinition("roads").render;
const TRAIL_RENDER_CONFIG = getLayerDefinition("trails").render;
const CAM_SITE_RENDER_CONFIG = activeAudience === "owner"
  ? getLayerDefinition("camSites").render
  : null;
const LANDMARK_RENDER_CONFIG = getLayerDefinition("landmarks").render;
const MINOR_LANDMARK_RENDER_CONFIG = getLayerDefinition("minorLandmarks").render;
const CORNER_RENDER_CONFIG = getLayerDefinition("corners").render;
const INTERSECTION_RENDER_CONFIG = getLayerDefinition("intersections").render;

document.documentElement.style.setProperty(
  "--minor-landmark-fill",
  MINOR_LANDMARK_RENDER_CONFIG.markerStyle.fillColor,
);
document.documentElement.style.setProperty(
  "--minor-landmark-border",
  MINOR_LANDMARK_RENDER_CONFIG.markerStyle.borderColor,
);
document.documentElement.style.setProperty(
  "--minor-landmark-border-width",
  `${MINOR_LANDMARK_RENDER_CONFIG.markerStyle.borderWidth}px`,
);

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
const interactionsRenderer = L.svg({
  pane: MAP_PANES.interactions,
  padding: 0.5,
});
const trailInteractionsRenderer = L.svg({
  pane: MAP_PANES.trailInteractions,
  padding: 0.5,
});
const intersectionsRenderer = L.svg({
  pane: MAP_PANES.intersections,
  padding: 0.5,
});
const trailsRenderer = L.canvas({
  pane: MAP_PANES.trails,
  tolerance: TRAIL_HIT_TOLERANCE_PX,
});
const zonesRenderer = L.canvas({ pane: MAP_PANES.zones });
const camSitesRenderer = activeAudience === "owner"
  ? L.canvas({ pane: MAP_PANES.camSites })
  : null;

const nysAerial = L.tileLayer(
  "https://orthos.its.ny.gov/arcgis/rest/services/wms/2022/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: DEFAULT_MAX_ZOOM,
    maxNativeZoom: 19,
    attribution: "Imagery © NYS ITS Geospatial Services (2022)",
  },
);

const topographicGround = L.gridLayer({
  maxZoom: DEFAULT_MAX_ZOOM,
  updateWhenIdle: true,
  interactive: false,
});
topographicGround.createTile = function createTopographicGroundTile() {
  const tile = document.createElement("div");
  tile.className = "topographic-ground-tile";
  tile.setAttribute("aria-hidden", "true");
  return tile;
};

(savedMapPreferences.baseMap === "topo" ? topographicGround : nysAerial).addTo(map);
syncTopographicContours();

const outsideMaskLayer = L.geoJSON(null, {
  pane: MAP_PANES.outsideShading,
  renderer: outsideMaskRenderer,
  interactive: false,
  style: OUTSIDE_RENDER_CONFIG.style,
});

const corridorLayer = L.geoJSON(null, {
  pane: MAP_PANES.corridor,
  renderer: corridorRenderer,
  interactive: false,
  style: CORRIDOR_RENDER_CONFIG.style,
  onEachFeature(feature, layer) {
    if (feature.properties?.name) {
      corridorVisualLayersByName.set(feature.properties.name, layer);
    }
  },
});
const corridorInteractionLayer = L.geoJSON(null, {
  pane: MAP_PANES.interactions,
  renderer: interactionsRenderer,
  style: CORRIDOR_RENDER_CONFIG.interactionStyle,
  onEachFeature(feature, layer) {
    const message = feature.properties?.name || "National Grid powerline cut";
    bindMapFeature(layer, feature, "", {
      tooltip: message,
      caveat: "Shaded extent is approximate; corridor edges are not surveyed here.",
      focusOverlay: corridorGroup,
      visualLayer: corridorVisualLayersByName.get(feature.properties?.name),
    });
  },
});
const corridorGroup = L.layerGroup([corridorLayer, corridorInteractionLayer]);

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
  pane: MAP_PANES.interactions,
  renderer: interactionsRenderer,
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
  interactive: false,
  style: TRAIL_RENDER_CONFIG.style,
  onEachFeature(feature, layer) {
    if (feature.properties?.id) trailVisualLayersById.set(feature.properties.id, layer);
  },
});
const trailInteractionLayer = L.geoJSON(null, {
  pane: MAP_PANES.trailInteractions,
  renderer: trailInteractionsRenderer,
  style: TRAIL_RENDER_CONFIG.interactionStyle,
  onEachFeature(feature, layer) {
    const popupOptions = buildTrailPopupOptions(feature);
    bindMapFeature(layer, feature, popupOptions.detail, {
      ...popupOptions,
      focusOverlay: trailsGroup,
      visualLayer: trailVisualLayersById.get(feature.properties?.id),
      interactionPriority: 100,
    });
  },
});
const trailsGroup = L.layerGroup([trailsLayer, trailInteractionLayer]);

const zonesLayer = L.geoJSON(null, {
  pane: MAP_PANES.zones,
  renderer: zonesRenderer,
  interactive: false,
  style: ZONE_RENDER_CONFIG.style,
  onEachFeature(feature, layer) {
    if (feature.properties?.id) zoneVisualLayersById.set(feature.properties.id, layer);
  },
});
const zonesInteractionLayer = L.geoJSON(null, {
  pane: MAP_PANES.interactions,
  renderer: interactionsRenderer,
  style: ZONE_RENDER_CONFIG.interactionStyle,
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, feature.properties.note, {
      focusOverlay: zonesGroup,
      standardPopupWidth: true,
      visualLayer: zoneVisualLayersById.get(feature.properties?.id),
    });
  },
});
const zonesGroup = L.layerGroup([zonesLayer, zonesInteractionLayer]);

const buildingIcon = L.icon({
  ...LANDMARK_RENDER_CONFIG.markerStyle,
  className: "landmark-marker",
});

const guidanceTargetIcon = L.divIcon({
  className: "guidance-target-highlight",
  html: '<span aria-hidden="true"></span>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

const minorLandmarkIcon = L.divIcon({
  className: "minor-landmark-marker",
  iconSize: [MINOR_LANDMARK_RENDER_CONFIG.markerStyle.size, MINOR_LANDMARK_RENDER_CONFIG.markerStyle.size],
  iconAnchor: [MINOR_LANDMARK_RENDER_CONFIG.markerStyle.size / 2, MINOR_LANDMARK_RENDER_CONFIG.markerStyle.size / 2],
  popupAnchor: [0, -7],
  tooltipAnchor: [0, -7],
});

function createLandmarksLayer({ prominence, icon }) {
  let layerGroup;
  layerGroup = L.geoJSON(null, {
    filter(feature) {
      const featureProminence = feature.properties?.prominence || "minor";
      return featureProminence === prominence;
    },
    pointToLayer(feature, latlng) {
      const markerPane = LANDMARK_RENDER_CONFIG.markerPanes[feature.properties?.type]
        || LANDMARK_RENDER_CONFIG.markerPanes.landmark;
      return L.marker(latlng, {
        icon,
        pane: MAP_PANES[markerPane],
      });
    },
    onEachFeature(feature, layer) {
      registerGuidanceTarget(feature, layer);
      bindMapFeature(
        layer,
        feature,
        feature.properties.note || "",
        {
          landmark: true,
          pointPhoto: true,
          standardPopupWidth: true,
          focusOverlay: layerGroup,
        },
      );
    },
  });
  return layerGroup;
}

const landmarksLayer = createLandmarksLayer({ prominence: "major", icon: buildingIcon });
const minorLandmarksLayer = createLandmarksLayer({ prominence: "minor", icon: minorLandmarkIcon });

const intersectionsLayer = L.geoJSON(null, {
  pane: MAP_PANES[INTERSECTION_RENDER_CONFIG.markerPane],
  renderer: intersectionsRenderer,
  pointToLayer(feature, latlng) {
    return L.circleMarker(latlng, {
      pane: MAP_PANES[INTERSECTION_RENDER_CONFIG.markerPane],
      renderer: intersectionsRenderer,
      ...INTERSECTION_RENDER_CONFIG.markerStyle,
    });
  },
  onEachFeature(feature, layer) {
    bindMapFeature(layer, feature, feature.properties.note, {
      focusOverlay: intersectionsLayer,
      pointPhoto: true,
      standardPopupWidth: true,
    });
  },
});

if (activeAudience === "owner") {
  camDeploymentArrowsLayer = L.layerGroup();
  camDraftArrowLayer = L.layerGroup();
  camSitesVisualLayer = L.geoJSON(null, {
    pane: MAP_PANES.camSites,
    renderer: camSitesRenderer,
    interactive: false,
    pointToLayer(feature, latlng) {
      return L.circleMarker(latlng, {
        pane: MAP_PANES.camSites,
        renderer: camSitesRenderer,
        interactive: false,
        ...CAM_SITE_RENDER_CONFIG.markerStyle,
      });
    },
    onEachFeature(feature, layer) {
      if (feature.properties?.id) {
        camSiteVisualLayersById.set(feature.properties.id, layer);
      }
    },
  });
  camSitesInteractionLayer = L.geoJSON(null, {
    pane: MAP_PANES.interactions,
    renderer: interactionsRenderer,
    pointToLayer(feature, latlng) {
      return L.circleMarker(latlng, {
        pane: MAP_PANES.interactions,
        renderer: interactionsRenderer,
        ...CAM_SITE_RENDER_CONFIG.interactionStyle,
      });
    },
    onEachFeature(feature, layer) {
      bindMapFeature(
        layer,
        feature,
        () => window.CamCapture?.formatSiteDetail(feature),
        {
          focusOverlay: camSitesGroup,
          visualLayer: camSiteVisualLayersById.get(feature.properties?.id),
          onActivate: (event) => window.CamCapture?.handleSiteActivation(feature, event),
        },
      );
    },
  });
  camSitesGroup = L.layerGroup([
    camDeploymentArrowsLayer,
    camDraftArrowLayer,
    camSitesVisualLayer,
    camSitesInteractionLayer,
  ]);
}

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
  onEachFeature(feature, layer) {
    if (feature.properties?.id) {
      boundaryVisualLayersById.set(feature.properties.id, layer);
    }
  },
});

const boundaryInteractionLayer = L.geoJSON(null, {
  pane: MAP_PANES.interactions,
  renderer: interactionsRenderer,
  style: BOUNDARY_RENDER_CONFIG.interactionStyle,
  onEachFeature(feature, layer) {
    const description = feature.properties.note || feature.properties.popup_description;
    bindMapFeature(layer, feature, description, {
      focusOverlay: boundaryGroup,
      visualLayer: boundaryVisualLayersById.get(feature.properties?.id),
    });
  },
});

const boundaryGroup = L.layerGroup([
  boundaryHalo,
  boundaryLayer,
  boundaryInteractionLayer,
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
      "Satellite map": nysAerial,
      "Topographic map": topographicGround,
    },
    controlOverlayEntries,
    { collapsed: true, position: "topright" },
  )
  .addTo(map);

decorateLayerControl(layerControl);
installTopographicStatusControl();
installMapLegend();
installMapWeatherControl();
installMapCompassControl();
const clearLayerControlHoverDelay = installLayerControlHoverDelay(layerControl);

if (activeAudience === "owner" && camSitesGroup && window.CamCapture) {
  window.CamCapture.initialize({
    map,
    sitesLayer: camSitesGroup,
    deploymentArrowsLayer: camDeploymentArrowsLayer,
    draftArrowLayer: camDraftArrowLayer,
    pane: MAP_PANES.camSites,
    renderer: camSitesRenderer,
    calculateTrueBearing,
    clearSelection: clearSelectedFeatureHighlight,
  });
}

map.on("baselayerchange overlayadd overlayremove moveend", handleMapPreferenceEvent);
map.on("baselayerchange", syncTopographicContours);
map.on("baselayerchange", refreshTrailPresentation);
map.on("baselayerchange overlayadd overlayremove", scheduleLayerControlDecoration);
map.on("overlayadd overlayremove", installMapLegend);
map.on("moveend zoomend", refreshContourLabels);
map.on("overlayadd overlayremove", (event) => {
  if (event.layer === terrainLayers.contours) refreshContourLabels();
});
layerControl.getContainer().addEventListener("click", (event) => {
  const input = event.target;
  if (!input.matches?.("input.leaflet-control-layers-selector") || !input.checked) return;
  const terrainKeys = ["terrainSlope", "terrainAspect"];
  const selectedKey = terrainKeys.find(
    (key) => getLayerDefinition(key).label === input.closest("label")?.textContent.trim(),
  );
  if (!selectedKey) return;
  const otherKey = terrainKeys.find((key) => key !== selectedKey);
  const otherLabel = [...layerControl.getContainer().querySelectorAll("label")]
    .find((label) => label.textContent.trim() === getLayerDefinition(otherKey).label);
  // Leaflet snapshots all checked overlays before applying a click. Clear the
  // other checkbox first so its snapshot cannot re-add the just-removed raster.
  const otherInput = otherLabel?.querySelector("input");
  if (otherInput) otherInput.checked = false;
}, true);
map.on("overlayadd", (event) => {
  // Keep the two color scales readable by showing one terrain raster at a time.
  if (event.layer === terrainLayers.terrainSlope) map.removeLayer(terrainLayers.terrainAspect);
  if (event.layer === terrainLayers.terrainAspect) map.removeLayer(terrainLayers.terrainSlope);
});
map.on("movestart zoomstart", handleMapViewChangeStart);
window.matchMedia("(max-width: 720px)").addEventListener("change", refreshTrailPresentation);
window.matchMedia("(pointer: coarse)").addEventListener("change", refreshTrailPresentation);
mobileMapPanels.addEventListener("change", () => {
  if (mobileMapPanels.matches) retainMostRecentMobilePanel();
  refreshContourLabels();
  handleCompassViewportChange();
});
document.querySelector(".home-link").addEventListener("click", saveMapPreferences);
window.addEventListener("pagehide", handlePageHide);
window.addEventListener("pageshow", handlePageShow);
document.addEventListener("visibilitychange", handleHeadingVisibilityChange);
installMobileDoubleTapZoom();

const locationStatus = document.getElementById("location-status");
const locateButton = document.getElementById("locate-button");
const locationPanel = document.querySelector(".location-panel");
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
map.on("popupopen", preparePointPopupPhoto);
map.on("popupclose", () => {
  if (hidingPopupForRouteDetails) return;
  if (guidanceStartPending && !guidanceTracker.isActive) cancelPendingGuidance();
  clearSelectedFeatureHighlight();
  closeMapRouteDetails({ restorePopup: false, restoreFocus: false });
});

loadLayerRegistry();
installGuidancePreviewControl();

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
  let invalidOptionalSources;
  try {
    const response = await fetch(versionedDataUrl("data/manifest.json"));
    if (!response.ok) throw new Error(`network response ${response.status}`);
    manifest = await response.json();
    invalidOptionalSources = validateDataManifest(manifest);
  } catch (error) {
    setContourSourceState("unavailable");
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
      sourcePromises.set(
        key,
        invalidOptionalSources.has(key) || !source
          ? Promise.resolve(null)
          : loadManifestSource(source),
      );
    }
    return sourcePromises.get(key);
  };

  const tasks = getAudienceLayerDefinitions().map(async (definition) => {
    const sourceEntries = await Promise.all(
      definition.sources.map(async (key) => [key, await loadSourceByKey(key)]),
    );
    const dataBySource = Object.fromEntries(sourceEntries);
    try {
      definition.applyData(dataBySource);
    } catch (error) {
      if (definition.key === "contours") setContourSourceState("unavailable");
      console.error(`Could not render registered layer ${definition.key}.`, error);
      if (definition.sources.some((key) => manifestSourceIsRequired(manifestSources.get(key)))) {
        showRequiredDataNotice();
      }
    }
  });

  await Promise.all(tasks);
  if (!initialViewReady) finishInitialViewWithoutBoundary();
  window.requestAnimationFrame(() => {
    map.invalidateSize({ pan: false });
    tryFocusRequestedFeature();
  });
}

function validateDataManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.sources)) {
    throw new Error("manifest must contain a sources array");
  }
  const sourceKeys = new Set();
  const invalidOptionalSources = new Set();
  manifest.sources.forEach((source) => {
    if (!source?.key || !source.path || !source.format) {
      if (OPTIONAL_MANIFEST_SOURCE_KEYS.has(source?.key)) {
        invalidOptionalSources.add(source.key);
        return;
      }
      throw new Error("every manifest source needs key, path, and format");
    }
    if (sourceKeys.has(source.key)) {
      if (OPTIONAL_MANIFEST_SOURCE_KEYS.has(source.key)) {
        invalidOptionalSources.add(source.key);
        return;
      }
      throw new Error(`duplicate manifest source ${source.key}`);
    }
    sourceKeys.add(source.key);
  });
  LAYER_DEFINITIONS.forEach((definition) => {
    definition.sources.forEach((key) => {
      if (!sourceKeys.has(key)) {
        if (definition.optionalSources?.includes(key)) {
          invalidOptionalSources.add(key);
          return;
        }
        throw new Error(`layer ${definition.key} references unknown source ${key}`);
      }
    });
  });
  return invalidOptionalSources;
}

function manifestSourceIsRequired(source) {
  return Boolean(source?.required && !OPTIONAL_MANIFEST_SOURCE_KEYS.has(source.key));
}

async function loadManifestSource(source) {
  try {
    const response = await fetch(versionedDataUrl(source.path));
    if (!response.ok) {
      if (!manifestSourceIsRequired(source) && response.status === 404) return null;
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
    const required = manifestSourceIsRequired(source);
    const message = `${classification} ${required ? "required" : "optional"} map source ${source.path}.`;
    if (required) console.error(message, error);
    else console.warn(message, error);
    if (required) showRequiredDataNotice();
    return null;
  }
}

function versionedDataUrl(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}v=${DATA_CACHE_VERSION}`;
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
  if (!zones) return;
  zonesLayer.addData(zones);
  zonesInteractionLayer.addData(zones);
}

function applyCorridorData({ corridor }) {
  if (!corridor) return;
  corridorLayer.addData(corridor);
  corridorInteractionLayer.addData(corridor);
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
  boundaryInteractionLayer.addData(buildBoundaryLines(boundaries));
  if (hasExplicitMapFocus) programmaticFocusViewActive = true;
  if (requestedMapFocus === "property") {
    focusRequestedBounds(propertyContextBounds(), [boundaryGroup], {
      paddingTopLeft: PROPERTY_BOUNDS_PADDING,
      paddingBottomRight: PROPERTY_BOUNDS_PADDING,
      maxZoom: 18,
      zoomSnap: 0.5,
    });
  } else if (!hasExplicitMapFocus && hasSavedMapView(savedMapPreferences)) {
    map.setView(savedMapPreferences.center, savedMapPreferences.zoom);
  } else if (!hasExplicitMapFocus) {
    map.fitBounds(propertyContextBounds(), {
      paddingTopLeft: PROPERTY_BOUNDS_PADDING,
      paddingBottomRight: PROPERTY_BOUNDS_PADDING,
      maxZoom: 18,
    });
  }
  preferencesReady = true;
  saveMapPreferences();
  initialViewReady = true;
}

function finishInitialViewWithoutBoundary() {
  if (initialViewReady) return;
  map.setView([43.3596, -73.8348], 17);
  preferencesReady = true;
  initialViewReady = true;
  saveMapPreferences();
}

function propertyContextBounds(bounds = boundaryLayer.getBounds()) {
  if (!bounds?.isValid()) return bounds;
  const latitudeMargin = PROPERTY_CONTEXT_METERS / 6371000 * 180 / Math.PI;
  const longitudeMargin = latitudeMargin / Math.cos(bounds.getCenter().lat * Math.PI / 180);
  return L.latLngBounds(
    [bounds.getSouth() - latitudeMargin, bounds.getWest() - longitudeMargin],
    [bounds.getNorth() + latitudeMargin, bounds.getEast() + longitudeMargin],
  );
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

function applyRoadsData({ driveway, trails, routes }) {
  const roads = combineFeatureCollections("Dirt roads", driveway);
  configureMapRoutes(
    [roads, trails].filter(Boolean),
    Array.isArray(routes?.routes) ? routes.routes : [],
  );
  if (roads.features.length === 0) return;
  roadHalo.addData(roads);
  roadsLayer.addData(roads);
  roadInteractionLayer.addData(roads);
}

function applyTrailsData({ driveway, trails, routes }) {
  const roads = combineFeatureCollections("Dirt roads", driveway);
  configureMapRoutes(
    [roads, trails].filter(Boolean),
    Array.isArray(routes?.routes) ? routes.routes : [],
  );
  if (trails) {
    trailsLayer.addData(trails);
    trailInteractionLayer.addData(trails);
  }
}

function applyRouteDefinitionData({ driveway, trails, routes }) {
  const roads = combineFeatureCollections("Dirt roads", driveway);
  configureMapRoutes(
    [roads, trails].filter(Boolean),
    Array.isArray(routes?.routes) ? routes.routes : [],
  );
}

function applyLandmarkData({ buildings, landmarks }) {
  if (buildings) landmarksLayer.addData(buildings);
  if (landmarks) landmarksLayer.addData(landmarks);
}

function applyMinorLandmarkData({ buildings, landmarks }) {
  if (buildings) minorLandmarksLayer.addData(buildings);
  if (landmarks) minorLandmarksLayer.addData(landmarks);
}

function applyCornersData({ corners }) {
  if (corners) cornersLayer.addData(corners);
}

function applyIntersectionsData({ intersections }) {
  if (intersections) intersectionsLayer.addData(intersections);
}

function applyCamSitesData({ camSites }) {
  if (!camSites || !camSitesVisualLayer || !camSitesInteractionLayer) return;
  camSitesVisualLayer.addData(camSites);
  camSitesInteractionLayer.addData(camSites);
  window.CamCapture?.setSites(camSites.features || []);
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

function fitFocusBounds(bounds, options = {}) {
  if (!bounds?.isValid()) return false;
  const previousZoomSnap = map.options.zoomSnap;
  if (Number.isFinite(options.zoomSnap)) map.options.zoomSnap = options.zoomSnap;
  try {
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      map.setView(bounds.getCenter(), 19, { animate: false });
    } else {
      map.fitBounds(bounds, {
        paddingTopLeft: options.paddingTopLeft || [48, 58],
        paddingBottomRight: options.paddingBottomRight || [58, 58],
        maxZoom: options.maxZoom ?? 18,
        animate: false,
      });
    }
  } finally {
    map.options.zoomSnap = previousZoomSnap;
  }
  return true;
}

function focusRequestedBounds(bounds, overlays = [], fitOptions = {}) {
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
    const focused = fitFocusBounds(bounds, fitOptions);
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
    const missingSegmentIds = route.segments.filter(
      (segmentId) => !focusableFeaturesById.has(segmentId),
    );
    if (missingSegmentIds.length > 0) {
      console.warn(
        `Could not focus route "${route.id}": missing rendered segment layer(s): ` +
          missingSegmentIds.join(", "),
      );
      return;
    }
    const members = route.segments
      .map((segmentId) => focusableFeaturesById.get(segmentId))
      .filter(Boolean);
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
  if (!match) {
    console.warn(`Could not focus requested map feature "${requestedFeatureId}".`);
    return;
  }
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
  const isUnfinished = feature.properties?.condition === "unfinished";
  const isPhone = window.matchMedia("(max-width: 720px)").matches;
  const aerialIsActive = map.hasLayer(nysAerial);
  return {
    color: isUnfinished && aerialIsActive ? "#bed6df" : isUnfinished ? "#6f8fa3" : "#63b8e8",
    weight: isUnfinished && isPhone ? 2.35 : 3,
    opacity: 1,
    dashArray: isUnfinished ? "3 11" : "7 6",
    lineCap: "round",
    lineJoin: "round",
  };
}

function trailInteractionStyle() {
  return {
    color: "#ffffff",
    weight: window.matchMedia("(pointer: coarse)").matches ? 26 : ROAD_INTERACTION_WEIGHT_PX,
    opacity: 0.001,
    lineCap: "round",
    lineJoin: "round",
  };
}

function buildTrailPopupOptions(feature) {
  const segmentName = feature.properties.name;
  const routes = routesForFeature(feature);
  const detail = feature.properties?.condition === "unfinished"
    ? "Not finished yet."
    : "";
  if (routes.length === 0) {
    return {
      detail,
      secondary: formatSegmentDistance(feature),
      standardPopupWidth: true,
    };
  }

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
  const detail = typeof properties.note === "string" ? properties.note.trim() : "";
  if (routes.length === 0) return { detail, standardPopupWidth: true };
  return {
    title: routes.map((route) => route.name).join(" \u00b7 "),
    secondary: `Road: ${properties.name || "Mapped road"}`,
    detail,
    routes,
  };
}

function buildBoundaryLines(boundaryData) {
  return {
    type: "FeatureCollection",
    features: (boundaryData.features || []).map((feature) => {
      const geometry = feature.geometry || {};
      const isMultiPolygon = geometry.type === "MultiPolygon";
      return {
        type: "Feature",
        properties: feature.properties,
        geometry: {
          type: isMultiPolygon ? "MultiLineString" : "LineString",
          coordinates: isMultiPolygon
            ? (geometry.coordinates || []).map((polygon) => polygon[0])
            : geometry.coordinates?.[0] || [],
        },
      };
    }),
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
  pattern.setAttribute("width", String(OUTSIDE_RENDER_CONFIG.hatch.size));
  pattern.setAttribute("height", String(OUTSIDE_RENDER_CONFIG.hatch.size));
  pattern.setAttribute("patternUnits", "userSpaceOnUse");

  const background = document.createElementNS(svgNamespace, "rect");
  background.setAttribute("width", String(OUTSIDE_RENDER_CONFIG.hatch.size));
  background.setAttribute("height", String(OUTSIDE_RENDER_CONFIG.hatch.size));
  background.setAttribute("fill", OUTSIDE_RENDER_CONFIG.hatch.backgroundColor);
  background.setAttribute("fill-opacity", String(OUTSIDE_RENDER_CONFIG.hatch.backgroundOpacity));

  const hatch = document.createElementNS(svgNamespace, "path");
  hatch.setAttribute("d", "M-4 4 L4 -4 M0 18 L18 0 M14 22 L22 14");
  hatch.setAttribute("fill", "none");
  hatch.setAttribute("stroke", OUTSIDE_RENDER_CONFIG.hatch.color);
  hatch.setAttribute("stroke-opacity", String(OUTSIDE_RENDER_CONFIG.hatch.opacity));
  hatch.setAttribute("stroke-width", String(OUTSIDE_RENDER_CONFIG.hatch.weight));
  hatch.setAttribute("stroke-dasharray", OUTSIDE_RENDER_CONFIG.hatch.dashArray);

  pattern.append(background, hatch);
  defs.append(pattern);
  svg.prepend(defs);
}

function createLegendSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 34 18");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("map-legend-swatch");
  return svg;
}

function createLegendLine(styles) {
  const svg = createLegendSvg();
  styles.forEach((style) => {
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", "2");
    line.setAttribute("x2", "32");
    line.setAttribute("y1", "9");
    line.setAttribute("y2", "9");
    line.setAttribute("stroke", style.color);
    line.setAttribute("stroke-width", String(style.weight));
    line.setAttribute("stroke-opacity", String(style.opacity ?? 1));
    if (style.dashArray) line.setAttribute("stroke-dasharray", style.dashArray);
    line.setAttribute("stroke-linecap", style.lineCap || "round");
    svg.append(line);
  });
  return svg;
}

function createLegendHatch() {
  const style = OUTSIDE_RENDER_CONFIG.hatch;
  const svg = createLegendSvg();
  const background = document.createElementNS(svg.namespaceURI, "rect");
  background.setAttribute("x", "1");
  background.setAttribute("y", "1");
  background.setAttribute("width", "32");
  background.setAttribute("height", "16");
  background.setAttribute("rx", "2");
  background.setAttribute("fill", style.backgroundColor);
  background.setAttribute("fill-opacity", String(style.backgroundOpacity));
  const hatch = document.createElementNS(svg.namespaceURI, "path");
  hatch.setAttribute("d", "M-3 17 L17 -3 M5 21 L25 1 M17 21 L37 1");
  hatch.setAttribute("fill", "none");
  hatch.setAttribute("stroke", style.color);
  hatch.setAttribute("stroke-opacity", String(style.opacity));
  hatch.setAttribute("stroke-width", String(style.weight));
  hatch.setAttribute("stroke-dasharray", style.dashArray);
  svg.append(background, hatch);
  return svg;
}

function createLegendLandmark({ minor = false } = {}) {
  const svg = createLegendSvg();
  if (minor) {
    const style = MINOR_LANDMARK_RENDER_CONFIG.markerStyle;
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", "17");
    circle.setAttribute("cy", "9");
    circle.setAttribute("r", String(style.size / 2));
    circle.setAttribute("fill", style.fillColor);
    circle.setAttribute("stroke", style.borderColor);
    circle.setAttribute("stroke-width", String(style.borderWidth));
    svg.append(circle);
    return svg;
  }
  const style = LANDMARK_RENDER_CONFIG.markerStyle;
  const image = document.createElementNS(svg.namespaceURI, "image");
  image.setAttribute("href", style.iconUrl);
  image.setAttribute("x", "10");
  image.setAttribute("y", "0");
  image.setAttribute("width", "14");
  image.setAttribute("height", "18");
  image.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.append(image);
  return svg;
}

function installTopographicStatusControl() {
  const control = L.control({ position: "topleft" });
  control.onAdd = () => {
    const node = L.DomUtil.create("div", "topographic-source-status");
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.textContent = "Contours unavailable. Check data/manifest.json or data/terrain/contours.geojson.";
    node.hidden = true;
    L.DomEvent.disableClickPropagation(node);
    topographicStatusNode = node;
    return node;
  };
  control.addTo(map);
  updateTopographicStatusNotice();
}

function setContourSourceState(state) {
  contourSourceState = state;
  updateTopographicStatusNotice();
}

function updateTopographicStatusNotice() {
  if (!topographicStatusNode) return;
  topographicStatusNode.hidden = !(
    contourSourceState === "unavailable" && map.hasLayer(topographicGround)
  );
}

function syncTopographicContours() {
  const shouldShowContours = map.hasLayer(topographicGround);
  const contoursAreVisible = map.hasLayer(terrainLayers.contours);
  if (shouldShowContours && !contoursAreVisible) map.addLayer(terrainLayers.contours);
  if (!shouldShowContours && contoursAreVisible) map.removeLayer(terrainLayers.contours);
  refreshContourLabels();
  updateTopographicStatusNotice();
}

function applyTerrainData(key, data) {
  const group = terrainLayers[key];
  group.clearLayers();
  if (key === "contours") {
    setContourSourceState("unavailable");
    contourLabelFeatures = (data?.features || []).filter((feature) => {
      const elevation = feature.properties?.elevation;
      return feature.properties?.elevation_unit === "m"
        && typeof elevation === "number" && Number.isFinite(elevation);
    });
    refreshContourLabels();
  }
  if (!data) return;
  if (key === "terrainSlope" || key === "terrainAspect") {
    const properties = data.features[0]?.properties;
    if (!properties?.image_path || !properties.bounds) return;
    L.imageOverlay(versionedDataUrl(properties.image_path), properties.bounds, {
      pane: MAP_PANES[key], opacity: 0.58, interactive: false,
    }).addTo(group);
    terrainLegends.set(key, Array.isArray(properties.legend) ? properties.legend : []);
  } else {
    L.geoJSON(data, {
      pane: MAP_PANES[key],
      style: key === "contours"
        ? (feature) => ({ color: "#765535", weight: Number(feature.properties.elevation) % 5 === 0 ? 1.3 : 0.55, opacity: 0.65, fill: false })
        : { color: "#8b4b85", weight: 1.5, fillColor: "#ba88b5", fillOpacity: 0.16 },
      interactive: false,
    }).addTo(group);
    if (key === "contours") setContourSourceState("available");
    if (key === "soils") L.geoJSON(data, {
      pane: MAP_PANES.soilInteractions,
      renderer: L.svg({ pane: MAP_PANES.soilInteractions }),
      style: { stroke: false, fillOpacity: 0.001 },
      onEachFeature(feature, layer) {
        if (key !== "soils") return;
        const properties = feature.properties || {};
        const content = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = properties.name || "Soil map unit";
        const detail = document.createElement("div");
        detail.textContent = `Survey: ${properties.survey_area || "unspecified"} · Map unit: ${properties.map_unit_key || properties.symbol || "unspecified"}`;
        content.append(title, detail);
        layer.bindPopup(content);
      },
    }).addTo(group);
  }
  installMapLegend();
}

function refreshContourLabels() {
  contourLabelGroup.clearLayers();
  const isPhone = mobileMapPanels.matches;
  if (!map.hasLayer(terrainLayers.contours) || map.getZoom() < (isPhone ? 18.5 : 17)) return;
  const showMinorLabels = map.getZoom() >= map.getMaxZoom() - map.options.zoomDelta;
  const size = map.getSize();
  const interior = { left: 44, right: size.x - 44, top: 28, bottom: size.y - 28 };
  const measurer = document.createElement("span");
  map.getContainer().append(measurer);
  const measuredLabels = new Map();
  const candidates = [];
  for (const feature of contourLabelFeatures) {
    const elevation = feature.properties.elevation;
    if (!Number.isInteger(elevation)) continue;
    const major = elevation % 5 === 0;
    if (!major && !showMinorLabels) continue;
    const text = `${elevation} m`;
    const className = `contour-elevation-label${major ? "" : " contour-elevation-label--minor"}`;
    if (!measuredLabels.has(text)) {
      measurer.className = `${className} contour-label-measure`;
      measurer.textContent = text;
      const bounds = measurer.getBoundingClientRect();
      measuredLabels.set(text, { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) });
    }
    const labelSize = measuredLabels.get(text);
    const minimumRunLength = Math.max(showMinorLabels ? 70 : isPhone ? 90 : 100, labelSize.width + 28);
    const lines = feature.geometry?.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry?.type === "MultiLineString" ? feature.geometry.coordinates : [];
    for (const coordinates of lines) {
      let run = [];
      const addRun = () => {
        const length = run.slice(1).reduce((total, point, index) => total + point.distanceTo(run[index]), 0);
        if (length >= minimumRunLength) candidates.push({ elevation, major, text, className, labelSize, run, length });
        run = [];
      };
      const points = coordinates.map(([longitude, latitude]) => map.latLngToContainerPoint([latitude, longitude]));
      for (let index = 1; index < points.length; index += 1) {
        const segment = clipContourSegment(points[index - 1], points[index], interior);
        if (!segment) {
          addRun();
          continue;
        }
        if (run.length && run[run.length - 1].distanceTo(segment[0]) > 0.5) addRun();
        if (!run.length) run.push(segment[0]);
        run.push(segment[1]);
      }
      addRun();
    }
  }
  measurer.remove();
  candidates.sort((first, second) => Number(second.major) - Number(first.major) || second.length - first.length);
  const usedElevations = new Set();
  const boxes = [];
  for (const candidate of candidates) {
    if (!showMinorLabels && usedElevations.has(candidate.elevation)) continue;
    for (const fraction of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const point = contourRunPoint(candidate.run, candidate.length * fraction);
      const halfWidth = candidate.labelSize.width / 2 + (isPhone ? 10 : 12);
      const halfHeight = candidate.labelSize.height / 2 + (isPhone ? 5 : 6);
      const box = { left: point.x - halfWidth, right: point.x + halfWidth, top: point.y - halfHeight, bottom: point.y + halfHeight };
      if (boxes.some((other) => box.left < other.right && box.right > other.left
        && box.top < other.bottom && box.bottom > other.top)) continue;
      L.marker(map.containerPointToLatLng(point), {
        pane: MAP_PANES.contourLabels,
        interactive: false,
        keyboard: false,
        contourMajor: candidate.major,
        icon: L.divIcon({
          className: candidate.className,
          html: `<span>${candidate.text}</span>`,
          iconSize: [candidate.labelSize.width, candidate.labelSize.height],
          iconAnchor: [candidate.labelSize.width / 2, candidate.labelSize.height / 2],
        }),
      }).addTo(contourLabelGroup);
      usedElevations.add(candidate.elevation);
      boxes.push(box);
      break;
    }
    // At close zoom the measured label boxes and their spacing govern density,
    // leaving useful room for minors after majors instead of imposing the old cap.
    if (!showMinorLabels && boxes.length >= (isPhone ? 8 : 12)) break;
  }
}

function clipContourSegment(start, end, bounds) {
  const delta = end.subtract(start);
  const directions = [-delta.x, delta.x, -delta.y, delta.y];
  const distances = [start.x - bounds.left, bounds.right - start.x, start.y - bounds.top, bounds.bottom - start.y];
  let first = 0;
  let last = 1;
  for (let edge = 0; edge < 4; edge += 1) {
    if (directions[edge] === 0) {
      if (distances[edge] < 0) return null;
      continue;
    }
    const ratio = distances[edge] / directions[edge];
    if (directions[edge] < 0) first = Math.max(first, ratio);
    else last = Math.min(last, ratio);
    if (first > last) return null;
  }
  return [start.add(delta.multiplyBy(first)), start.add(delta.multiplyBy(last))];
}

function contourRunPoint(run, distance) {
  for (let index = 1; index < run.length; index += 1) {
    const length = run[index].distanceTo(run[index - 1]);
    if (distance <= length && length > 0) {
      return run[index - 1].add(run[index].subtract(run[index - 1]).multiplyBy(distance / length));
    }
    distance -= length;
  }
  return run[run.length - 1];
}

function aspectCompassPoint(bearing, radius) {
  const radians = (bearing * Math.PI) / 180;
  return {
    x: 48 + Math.sin(radians) * radius,
    y: 48 - Math.cos(radians) * radius,
  };
}

function createAspectCompassSectors(entries) {
  const colorsByDirection = new Map(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.label === "string")
      .map(({ label, color }) => [label, color]),
  );
  const format = (value) => Number(value.toFixed(2));
  return ASPECT_DIRECTIONS.flatMap(({ label, bearing }) => {
    const color = colorsByDirection.get(label);
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return [];
    const startBearing = bearing - 22.5;
    const endBearing = bearing + 22.5;
    const outerStart = aspectCompassPoint(startBearing, 43);
    const outerEnd = aspectCompassPoint(endBearing, 43);
    const innerStart = aspectCompassPoint(startBearing, 15);
    const innerEnd = aspectCompassPoint(endBearing, 15);
    const labelPoint = aspectCompassPoint(bearing, 29);
    const path = [
      `M ${format(outerStart.x)} ${format(outerStart.y)}`,
      `A 43 43 0 0 1 ${format(outerEnd.x)} ${format(outerEnd.y)}`,
      `L ${format(innerEnd.x)} ${format(innerEnd.y)}`,
      `A 15 15 0 0 0 ${format(innerStart.x)} ${format(innerStart.y)}`,
      "Z",
    ].join(" ");
    return [{
      label,
      color,
      bearing,
      startBearing,
      endBearing,
      wrapsNorth: startBearing < 0 || endBearing > 360,
      labelPoint: { x: format(labelPoint.x), y: format(labelPoint.y) },
      path,
    }];
  });
}

function aspectDirectionTextColor(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return "#242923";
  const channels = [0, 2, 4].map((index) => {
    const value = Number.parseInt(match[1].slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.18 ? "#242923" : "#fffdf5";
}

function appendAspectCompassKey(container, sectors) {
  const key = L.DomUtil.create("div", "terrain-aspect-key", container);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 96 96");
  svg.setAttribute("aria-hidden", "true");
  sectors.forEach((sector) => {
    const wedge = document.createElementNS(svg.namespaceURI, "path");
    wedge.setAttribute("class", "terrain-aspect-sector");
    wedge.setAttribute("d", sector.path);
    wedge.setAttribute("fill", sector.color);
    wedge.setAttribute("stroke", "#f5f1e8");
    wedge.setAttribute("stroke-width", "1.2");
    wedge.setAttribute("data-direction", sector.label);
    wedge.setAttribute("data-color", sector.color);
    wedge.setAttribute("data-bearing", String(sector.bearing));
    wedge.setAttribute("data-start-bearing", String(sector.startBearing));
    wedge.setAttribute("data-end-bearing", String(sector.endBearing));
    wedge.setAttribute("data-wraps-north", String(sector.wrapsNorth));
    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("class", "terrain-aspect-direction");
    label.setAttribute("x", String(sector.labelPoint.x));
    label.setAttribute("y", String(sector.labelPoint.y));
    label.setAttribute("fill", aspectDirectionTextColor(sector.color));
    label.setAttribute("data-direction", sector.label);
    label.textContent = sector.label;
    svg.append(wedge, label);
  });
  const center = document.createElementNS(svg.namespaceURI, "circle");
  center.setAttribute("class", "terrain-aspect-center");
  center.setAttribute("cx", "48");
  center.setAttribute("cy", "48");
  center.setAttribute("r", "11");
  svg.append(center);
  key.append(svg);

  const accessiblePairs = document.createElement("ul");
  accessiblePairs.className = "terrain-aspect-key-text";
  accessiblePairs.setAttribute("aria-label", "Downslope direction color pairs");
  sectors.forEach(({ label, color }) => {
    const pair = document.createElement("li");
    pair.textContent = `${label}: ${color}`;
    accessiblePairs.append(pair);
  });
  key.append(accessiblePairs);
}

function appendTerrainLegend(container) {
  for (const [key, group] of Object.entries(terrainLayers)) {
    if (key === "contours" || !map.hasLayer(group)) continue;
    const section = L.DomUtil.create("div", "terrain-legend", container);
    const title = L.DomUtil.create("strong", "", section);
    title.textContent = getLayerDefinition(key).label;
    const entries = terrainLegends.get(key);
    if (key === "terrainAspect") {
      const sectors = createAspectCompassSectors(entries || []);
      if (sectors.length === ASPECT_DIRECTIONS.length) {
        const caption = L.DomUtil.create("span", "terrain-aspect-key-caption", section);
        caption.textContent = "Downslope direction";
        appendAspectCompassKey(section, sectors);
      } else {
        const note = L.DomUtil.create("span", "", section);
        note.textContent = "Aspect direction colors unavailable.";
      }
    } else if (entries?.length) {
      entries.forEach(({ label, color }) => {
        const row = L.DomUtil.create("span", "terrain-legend-item", section);
        const swatch = L.DomUtil.create("i", "", row);
        swatch.style.backgroundColor = color;
        row.append(document.createTextNode(label));
      });
    } else if (key === "soils") {
      const note = L.DomUtil.create("span", "", section);
      note.textContent = "Purple outlines · tap for map unit";
    }
  }
}

function legendRows() {
  const finishedTrailStyle = trailStyle({ properties: { condition: "finished" } });
  const unfinishedTrailStyle = trailStyle({ properties: { condition: "unfinished" } });
  return [
    ["Property boundary (approximate)", createLegendLine([BOUNDARY_RENDER_CONFIG.haloStyle, BOUNDARY_RENDER_CONFIG.style])],
    ["Walking trail", createLegendLine([finishedTrailStyle])],
    ["Unfinished trail", createLegendLine([unfinishedTrailStyle])],
    ["Dirt road", createLegendLine([ROAD_RENDER_CONFIG.style])],
    ["Not part of the property", createLegendHatch()],
    ["Landmark", createLegendLandmark(), true],
    ["Minor landmark", createLegendLandmark({ minor: true }), true],
  ];
}

function installMapLegend() {
  if (mapLegendControl) mapLegendControl.remove();
  if (mapLegendRestoreControl) {
    mapLegendRestoreControl.remove();
    mapLegendRestoreControl = null;
  }
  if (legendDismissedForSession) {
    installMapLegendRestoreControl();
    return;
  }
  const control = L.control({ position: "bottomleft" });
  control.onAdd = () => {
    const container = L.DomUtil.create("div", "map-legend");
    container.setAttribute("role", "region");
    container.setAttribute("aria-label", "Map legend");
    const dismiss = L.DomUtil.create("button", "map-legend-dismiss", container);
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss map legend");
    dismiss.textContent = "×";
    legendRows().forEach(([label, swatch, desktopOnly]) => {
      const row = L.DomUtil.create(
        "div",
        `map-legend-row${desktopOnly ? " map-legend-row--desktop" : ""}`,
        container,
      );
      row.append(swatch);
      const text = L.DomUtil.create("span", "map-legend-label", row);
      text.textContent = label;
    });
    appendTerrainLegend(container);
    dismiss.addEventListener("click", () => dismissMapLegend({ restoreFocus: true }));
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    return container;
  };
  control.addTo(map);
  mapLegendControl = control;
  placeMapPanelControls();
}

function dismissMapLegend({ restoreFocus = false } = {}) {
  removeMapPanelFromOrder("legend");
  legendDismissedForSession = true;
  if (mapLegendControl) {
    mapLegendControl.remove();
    mapLegendControl = null;
  }
  installMapLegendRestoreControl();
  if (restoreFocus) mapLegendRestoreControl?.getContainer()?.focus();
}

function installMapLegendRestoreControl() {
  if (mapLegendRestoreControl) mapLegendRestoreControl.remove();
  const control = L.control({ position: "bottomleft" });
  control.onAdd = () => {
    const button = L.DomUtil.create("button", "map-legend-restore");
    button.type = "button";
    button.setAttribute("aria-label", "Show map legend");
    button.title = "Show map legend";
    button.append(createLegendLine([trailStyle({ properties: { condition: "finished" } })]));
    button.addEventListener("click", showMapLegend);
    L.DomEvent.disableClickPropagation(button);
    return button;
  };
  control.addTo(map);
  mapLegendRestoreControl = control;
  placeMapPanelControls();
}

function showMapLegend() {
  legendDismissedForSession = false;
  installMapLegend();
  recordMapPanelOpen("legend");
  closeMobilePanelConflicts("legend");
  mapLegendControl?.getContainer().querySelector(".map-legend-dismiss")?.focus();
}

function isMapPanelOpen(panel) {
  if (panel === "legend") return Boolean(mapLegendControl && !legendDismissedForSession);
  if (panel === "weather") return weatherPanelOpen;
  if (panel === "compass") return compassPanelOpen;
  return false;
}

function recordMapPanelOpen(panel) {
  removeMapPanelFromOrder(panel);
  mapPanelOpenOrder.push(panel);
}

function removeMapPanelFromOrder(panel) {
  const index = mapPanelOpenOrder.indexOf(panel);
  if (index >= 0) mapPanelOpenOrder.splice(index, 1);
}

function closeMobilePanelConflicts(keep) {
  if (!mobileMapPanels.matches) return;
  if (keep !== "compass") setMapCompassOpen(false);
  if (keep !== "weather") setMapWeatherOpen(false);
  if (keep !== "legend" && !legendDismissedForSession) dismissMapLegend();
}

function retainMostRecentMobilePanel() {
  const keep = [...mapPanelOpenOrder].reverse().find(isMapPanelOpen);
  if (keep) closeMobilePanelConflicts(keep);
}

function installMapWeatherControl() {
  if (typeof window.PropertyWeather?.createView !== "function") return;
  const control = L.control({ position: "bottomleft" });
  control.onAdd = () => {
    const container = L.DomUtil.create("div", "map-weather-control");
    const toggle = L.DomUtil.create("button", "map-weather-toggle", container);
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Show weather");
    toggle.title = "Weather";
    toggle.setAttribute("aria-controls", "map-weather-panel");
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = '<svg viewBox="0 0 32 26" aria-hidden="true"><path class="weather-sun" d="M14 17a7 7 0 1 1 7-7M14 1v2M4 10H2M6 3l2 2M23 3l-2 2"></path><path class="weather-cloud" d="M11 23a5 5 0 0 1 0-10h1a7 7 0 0 1 13 1 4.5 4.5 0 0 1 0 9Z"></path></svg>';
    const panel = L.DomUtil.create("section", "map-weather-panel", container);
    panel.id = "map-weather-panel";
    panel.hidden = true;
    panel.setAttribute("aria-labelledby", "map-weather-title");
    const title = L.DomUtil.create("h2", "weather-accessible-title", panel);
    title.id = "map-weather-title";
    title.textContent = "Weather";
    const close = L.DomUtil.create("button", "map-weather-close", panel);
    close.type = "button";
    close.setAttribute("aria-label", "Close weather");
    close.textContent = "×";
    const content = L.DomUtil.create("div", "map-weather-content", panel);
    mapWeatherView = window.PropertyWeather.createView(content);
    toggle.addEventListener("click", () => {
      setMapWeatherOpen(true);
      close.focus();
    });
    close.addEventListener("click", () => {
      setMapWeatherOpen(false);
      toggle.focus();
    });
    container.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && weatherPanelOpen) {
        setMapWeatherOpen(false);
        toggle.focus();
      }
    });
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    return container;
  };
  control.addTo(map);
  mapWeatherControl = control;
  placeMapPanelControls();
}

function setMapWeatherOpen(open) {
  weatherPanelOpen = Boolean(open && mapWeatherControl);
  if (!mapWeatherControl) {
    removeMapPanelFromOrder("weather");
    return;
  }
  const container = mapWeatherControl.getContainer();
  container.querySelector(".map-weather-panel").hidden = !weatherPanelOpen;
  const toggle = container.querySelector(".map-weather-toggle");
  toggle.hidden = weatherPanelOpen;
  toggle.setAttribute("aria-expanded", String(weatherPanelOpen));
  mapWeatherView.setVisible(weatherPanelOpen);
  if (weatherPanelOpen) {
    recordMapPanelOpen("weather");
    closeMobilePanelConflicts("weather");
  } else {
    removeMapPanelFromOrder("weather");
  }
}

function placeMapPanelControls() {
  const legend = (mapLegendControl || mapLegendRestoreControl)?.getContainer();
  const weather = mapWeatherControl?.getContainer();
  const compass = mapCompassControl?.getContainer();
  if (legend?.isConnected && weather?.isConnected) legend.before(weather);
  if (weather?.isConnected && compass?.isConnected) weather.before(compass);
  else if (legend?.isConnected && compass?.isConnected) legend.before(compass);
}

function mapCompassRoseArtwork() {
  const ticks = Array.from({ length: 16 }, (_, index) => {
    const angle = index * 22.5;
    const radians = angle * Math.PI / 180;
    const outerRadius = 82;
    const tickLength = angle % 90 === 0 ? 14 : angle % 45 === 0 ? 10 : 7;
    const innerRadius = outerRadius - tickLength;
    const coordinate = (radius, sine) => Number((100 + radius * sine).toFixed(2));
    const x1 = coordinate(innerRadius, Math.sin(radians));
    const y1 = coordinate(innerRadius, -Math.cos(radians));
    const x2 = coordinate(outerRadius, Math.sin(radians));
    const y2 = coordinate(outerRadius, -Math.cos(radians));
    const kind = angle % 90 === 0 ? "cardinal" : angle % 45 === 0 ? "intercardinal" : "minor";
    return `<line class="compass-rose-tick compass-rose-tick--${kind}" data-angle="${angle}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join("");
  const arms = [0, 90, 180, 270].map((angle) =>
    `<path class="compass-rose-static-arm" data-bearing="${angle}" d="M100 34 109 92 100 86 91 92Z" transform="rotate(${angle} 100 100)"/>`,
  ).join("");

  return '<circle class="compass-rose-focus-ring" cx="100" cy="100" r="88"/><circle class="compass-rose-halo" cx="100" cy="100" r="83"/><circle class="compass-rose-ring" cx="100" cy="100" r="83"/>' +
    `<g class="compass-rose-ticks">${ticks}</g><g class="compass-rose-arms">${arms}</g>` +
    '<g class="compass-heading-needle" visibility="hidden"><path class="compass-heading-needle-tail" d="M100 120 103 99 100 104 97 99Z"/><path class="compass-heading-needle-forward" d="M100 43 108 100 100 92 92 100Z"/><path class="compass-heading-needle-highlight" d="M99.2 51c.45 9.5.65 18.1.75 27.8"/></g>' +
    '<circle class="compass-rose-center" cx="100" cy="100" r="4"/><text class="compass-cardinal" x="100" y="12">N</text><text class="compass-cardinal" x="190" y="105">E</text><text class="compass-cardinal" x="100" y="198">S</text><text class="compass-cardinal" x="10" y="105">W</text>';
}

function syncCompassDismissSurface(container = mapCompassControl?.getContainer()) {
  const rose = container?.querySelector(".map-compass-rose");
  if (!rose) return;
  const close = container.querySelector(".map-compass-close");
  if (mobileMapPanels.matches) {
    const focusNeedsMobileDismissTarget = document.activeElement === close || document.activeElement === document.body;
    rose.setAttribute("role", "button");
    rose.setAttribute("tabindex", "0");
    rose.setAttribute("aria-label", "Minimize compass");
    if (focusNeedsMobileDismissTarget && compassPanelOpen) {
      window.requestAnimationFrame(() => {
        if (compassPanelOpen && mobileMapPanels.matches && rose.isConnected) rose.focus();
      });
    }
    return;
  }
  const focusNeedsDesktopCloseTarget = document.activeElement === rose || document.activeElement === document.body;
  rose.setAttribute("role", "img");
  rose.setAttribute("aria-label", "North-up compass rose with device heading needle");
  rose.removeAttribute("tabindex");
  if (focusNeedsDesktopCloseTarget && compassPanelOpen) {
    window.requestAnimationFrame(() => {
      if (compassPanelOpen && !mobileMapPanels.matches && close?.isConnected) close.focus();
    });
  }
}

function installMapCompassControl() {
  const control = L.control({ position: "bottomleft" });
  control.onAdd = () => {
    const container = L.DomUtil.create("div", "map-compass-control");
    const toggle = L.DomUtil.create("button", "map-compass-toggle", container);
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Open compass");
    toggle.setAttribute("aria-controls", "map-compass-panel");
    toggle.setAttribute("aria-expanded", "false");
    toggle.title = "Compass";
    toggle.innerHTML = '<svg class="map-compass-toggle-rose" viewBox="0 0 40 32" aria-hidden="true"><g class="map-compass-toggle-heading" aria-hidden="true"><g class="map-compass-toggle-artwork" transform="translate(0 6)"><path class="map-compass-toggle-arrow" d="M20 1.8 26.5 17.1 21.15 15.4 20 18.2 18.85 15.4 13.5 17.1Z"/><path class="map-compass-toggle-highlight" d="M19.25 5.2c.25 2.35.44 4.54.48 6.76"/><circle class="map-compass-toggle-hub" cx="20" cy="17.2" r="1.45"/></g></g></svg>';

    const panel = L.DomUtil.create("section", "map-compass-panel", container);
    panel.id = "map-compass-panel";
    panel.hidden = true;
    panel.setAttribute("aria-labelledby", "map-compass-title");
    const title = L.DomUtil.create("h2", "weather-accessible-title", panel);
    title.id = "map-compass-title";
    title.textContent = "Compass";
    const close = L.DomUtil.create("button", "map-compass-close", panel);
    close.type = "button";
    close.setAttribute("aria-label", "Close compass");
    close.textContent = "×";
    const rose = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    rose.classList.add("map-compass-rose");
    rose.setAttribute("viewBox", "0 0 200 200");
    rose.setAttribute("role", "img");
    rose.setAttribute("aria-label", "North-up compass rose with device heading needle");
    rose.innerHTML = mapCompassRoseArtwork();
    panel.append(rose);
    const readout = L.DomUtil.create("p", "map-compass-readout", panel);
    readout.setAttribute("role", "status");
    readout.setAttribute("aria-live", "off");
    readout.textContent = "North fixed · waiting for device heading";

    let compassPointerGesture = null;
    const compassDismissTarget = (target) => target instanceof Element
      ? target.closest(".map-compass-rose, .map-compass-readout")
      : null;
    const pointerDown = (event) => {
      if (!mobileMapPanels.matches) return;
      const surface = compassDismissTarget(event.target);
      if (compassPointerGesture) {
        if (event.pointerId !== compassPointerGesture.pointerId) compassPointerGesture.multiPointer = true;
        return;
      }
      if (surface) {
        compassPointerGesture = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
          multiPointer: false,
          complete: false,
          endedOnSurface: false,
        };
      }
    };
    const pointerMove = (event) => {
      if (!compassPointerGesture || compassPointerGesture.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - compassPointerGesture.startX, event.clientY - compassPointerGesture.startY);
      if (distance > 8) compassPointerGesture.moved = true;
    };
    const pointerUp = (event) => {
      const gesture = compassPointerGesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.complete = true;
      gesture.endedOnSurface = Boolean(compassDismissTarget(event.target));
      window.setTimeout(() => {
        if (compassPointerGesture === gesture) compassPointerGesture = null;
      }, 0);
    };
    const pointerCancel = (event) => {
      if (!compassPointerGesture || compassPointerGesture.pointerId !== event.pointerId) return;
      compassPointerGesture = null;
    };
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);

    const minimizeFromCompassSurface = (event) => {
      if (!mobileMapPanels.matches) return;
      if (event.type === "click" && event.detail !== 0) {
        const gesture = compassPointerGesture;
        if (!gesture?.complete || gesture.moved || gesture.multiPointer || !gesture.endedOnSurface) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        compassPointerGesture = null;
      }
      setMapCompassOpen(false, { restoreFocus: true });
    };
    rose.addEventListener("click", minimizeFromCompassSurface);
    readout.addEventListener("click", minimizeFromCompassSurface);
    rose.addEventListener("keydown", (event) => {
      if (!mobileMapPanels.matches || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      setMapCompassOpen(false, { restoreFocus: true });
    });

    toggle.addEventListener("click", () => {
      setMapCompassOpen(!compassPanelOpen, {
        requestAccess: !compassPanelOpen,
        focusClose: !compassPanelOpen,
      });
    });
    close.addEventListener("click", () => setMapCompassOpen(false, { restoreFocus: true }));
    container.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && compassPanelOpen) {
        event.preventDefault();
        setMapCompassOpen(false, { restoreFocus: true });
      }
    });
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    syncCompassDismissSurface(container);
    return container;
  };
  control.addTo(map);
  mapCompassControl = control;
  placeMapPanelControls();
  updateMinimizedCompassHeading(null);
}

function setMapCompassOpen(open, {
  requestAccess = false,
  restoreFocus = false,
  focusClose = false,
} = {}) {
  compassPanelOpen = Boolean(open && mapCompassControl);
  if (!mapCompassControl) {
    removeMapPanelFromOrder("compass");
    return;
  }
  const container = mapCompassControl.getContainer();
  const panel = container.querySelector(".map-compass-panel");
  const toggle = container.querySelector(".map-compass-toggle");
  panel.hidden = !compassPanelOpen;
  toggle.hidden = compassPanelOpen;
  toggle.setAttribute("aria-expanded", String(compassPanelOpen));

  if (compassPanelOpen) {
    recordMapPanelOpen("compass");
    closeMobilePanelConflicts("compass");
    syncHeadingLifecycle();
    if (requestAccess) {
      setCompassUnavailableMessage("Requesting device heading permission…");
      requestHeadingAccess().then((allowed) => {
        if (allowed && headingPipeline.permission === "granted") {
          activateMobileHeadingSession();
        }
        updateMinimizedCompassHeading();
        if (!compassPanelOpen) return;
        if (!allowed) {
          setCompassUnavailableMessage(compassPermissionMessage());
          return;
        }
        renderFreshCompassHeadingOrWaiting();
      });
    } else {
      renderFreshCompassHeadingOrWaiting();
    }
    if (focusClose) {
      const focusTarget = mobileMapPanels.matches
        ? container.querySelector(".map-compass-rose")
        : container.querySelector(".map-compass-close");
      focusTarget?.focus();
    }
    return;
  }

  removeMapPanelFromOrder("compass");
  syncHeadingLifecycle();
  updateMinimizedCompassHeading();
  if (restoreFocus && toggle.isConnected) toggle.focus();
}

function activateMobileHeadingSession() {
  if (headingPipeline.permission !== "granted") return false;
  mobileHeadingSessionActive = true;
  syncHeadingLifecycle();
  updateMinimizedCompassHeading();
  return true;
}

function handleCompassViewportChange() {
  syncCompassDismissSurface();
  syncHeadingLifecycle();
  updateMinimizedCompassHeading();
  if (compassPanelOpen && headingPipeline.permission !== "pending") {
    renderFreshCompassHeadingOrWaiting();
  }
}

function minimizedCompassStatus(heading) {
  if (headingPipeline.permission === "denied") return "Motion access denied";
  if (headingPipeline.permission === "error") return "Motion access unavailable";
  if (headingPipeline.permission === "unsupported") return "Live heading unavailable";
  if (headingPipeline.permission === "pending") return "Motion access pending";
  if (headingPipeline.awaitingFreshEventAfterResume) return "Waiting for a fresh heading";
  if (mobileHeadingSessionActive && !mobileMapPanels.matches) return "Heading inactive at desktop size";
  if (mobileHeadingSessionActive && mobileMapPanels.matches && heading !== null) {
    return `Live heading ${Math.round(normalizeAngle(heading)) % 360}° ${compassCardinal(heading)}`;
  }
  if (
    mobileHeadingSessionActive &&
    mobileMapPanels.matches &&
    headingPipeline.staleNotified &&
    headingPipeline.latestHeadingAt > 0
  ) {
    return "Heading stale";
  }
  if (mobileHeadingSessionActive && mobileMapPanels.matches) return "No live heading";
  if (headingPipeline.staleNotified || headingPipeline.latestHeadingAt > 0) return "Heading stale";
  return "Heading not enabled";
}

function updateMinimizedCompassHeading(heading = getFreshHeading()) {
  if (!mapCompassControl) return;
  const toggle = mapCompassControl.getContainer().querySelector(".map-compass-toggle");
  const needle = toggle?.querySelector(".map-compass-toggle-heading");
  if (!toggle || !needle) return;

  const isLive = Boolean(
    mobileHeadingSessionActive &&
    mobileMapPanels.matches &&
    headingPipeline.permission === "granted" &&
    Number.isFinite(heading),
  );
  if (isLive) {
    const normalized = normalizeAngle(heading);
    const displayAngle = compassToggleDisplayedAngle === null
      ? normalized
      : compassToggleDisplayedAngle + normalizeBearingError(normalized - normalizeAngle(compassToggleDisplayedAngle));
    compassToggleDisplayedAngle = displayAngle;
    needle.style.transform = `rotate(${displayAngle}deg)`;
  } else {
    compassToggleDisplayedAngle = null;
    needle.style.transform = "rotate(0deg)";
  }

  const status = minimizedCompassStatus(isLive ? heading : null);
  toggle.dataset.headingState = isLive
    ? "live"
    : mobileHeadingSessionActive && !mobileMapPanels.matches
      ? "inactive"
      : "unavailable";
  toggle.setAttribute("aria-label", `Open compass — ${status}`);
  toggle.title = `Compass · ${status}`;
}

function setCompassUnavailableMessage(message) {
  if (!compassPanelOpen || !mapCompassControl) return;
  const container = mapCompassControl.getContainer();
  const needle = container.querySelector(".compass-heading-needle");
  const readout = container.querySelector(".map-compass-readout");
  needle.setAttribute("visibility", "hidden");
  compassDisplayedAngle = null;
  readout.dataset.live = "false";
  readout.textContent = message;
  updateMinimizedCompassHeading();
}

function renderFreshCompassHeadingOrWaiting() {
  const heading = getFreshHeading();
  if (heading !== null) {
    renderCompassHeading(heading);
    return;
  }
  setCompassUnavailableMessage(compassPermissionMessage());
}

function compassPermissionMessage() {
  if (headingPipeline.permission === "denied") return "North fixed · motion access denied";
  if (headingPipeline.permission === "error") return "North fixed · motion access unavailable";
  if (headingPipeline.permission === "unsupported") return "North fixed · live heading unavailable";
  if (headingPipeline.latestHeadingAt) return "North fixed · heading is stale";
  return "North fixed · waiting for device heading";
}

function renderCompassHeading(heading) {
  if (!compassPanelOpen || !mapCompassControl) return;
  const container = mapCompassControl.getContainer();
  const needle = container.querySelector(".compass-heading-needle");
  const readout = container.querySelector(".map-compass-readout");
  const normalized = normalizeAngle(heading);
  const displayAngle = compassDisplayedAngle === null
    ? normalized
    : compassDisplayedAngle + normalizeBearingError(normalized - normalizeAngle(compassDisplayedAngle));
  compassDisplayedAngle = displayAngle;
  needle.style.transform = `rotate(${displayAngle}deg)`;
  needle.setAttribute("visibility", "visible");
  readout.dataset.live = "true";
  const degrees = Math.round(normalized) % 360;
  readout.textContent = `${degrees}° · ${compassCardinal(normalized)}`;
  updateMinimizedCompassHeading(normalized);
}

function compassCardinal(heading) {
  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return directions[Math.round(normalizeAngle(heading) / 22.5) % directions.length];
}

function refreshTrailPresentation() {
  trailsLayer.setStyle(TRAIL_RENDER_CONFIG.style);
  trailInteractionLayer.setStyle(TRAIL_RENDER_CONFIG.interactionStyle);
  installMapLegend();
}

function openInfo() {
  infoOverlay.hidden = false;
  infoButton?.setAttribute("aria-expanded", "true");
  infoClose.focus();
}

function closeInfo() {
  infoOverlay.hidden = true;
  infoButton?.setAttribute("aria-expanded", "false");
  if (infoButton?.isConnected) infoButton.focus();
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
  const title = options.title || feature.properties.name;
  const name = escapeHtml(title);
  const safeDetail = detail ? escapeHtml(detail) : "";
  const popupClass = shouldUseStandardPopupWidth(title, detail, options)
    ? "map-popup-content map-popup-content--standard"
    : "map-popup-content";
  let popupHtml = `<div class="${popupClass}">`;
  popupHtml += buildPointPhotoHtml(feature, name, options);
  popupHtml += `<strong>${name}</strong>`;
  if (options.secondary) {
    popupHtml += `<span class="map-popup-secondary">${escapeHtml(options.secondary)}</span>`;
  }
  if (safeDetail) popupHtml += `<span class="map-popup-detail">${safeDetail}</span>`;
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

function shouldUseStandardPopupWidth(title, detail, options = {}) {
  if (!options.standardPopupWidth || options.routes?.length) return false;
  if (options.pointPhoto) return true;
  const titleLength = String(title || "").trim().length;
  const detailLength = String(detail || "").trim().length;
  return titleLength > 18 || detailLength > 60;
}

function buildPointPhotoHtml(feature, safeName, options) {
  const featureId = String(feature?.properties?.id || "").trim().toLowerCase();
  if (
    !options.pointPhoto ||
    feature?.geometry?.type !== "Point" ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(featureId)
  ) {
    return "";
  }
  const photoPath = `assets/points/${encodeURIComponent(featureId)}.jpg`;
  return (
    '<figure class="point-popup-photo">' +
    `<img src="${escapeHtml(photoPath)}" alt="${safeName}" loading="lazy">` +
    "</figure>"
  );
}

function handlePointPhotoLoad(photo, popup) {
  if (!pointPhotoBelongsToPopup(photo, popup)) return;
  const figure = photo.closest(".point-popup-photo");
  if (figure.classList.contains("is-loaded")) return;
  figure.classList.add("is-loaded");
}

function handlePointPhotoError(photo, popup) {
  if (!pointPhotoBelongsToPopup(photo, popup)) return;
  photo.closest(".point-popup-photo")?.remove();
}

function pointPhotoBelongsToPopup(photo, popup) {
  return Boolean(photo && popup?.getElement()?.contains(photo));
}

function preparePointPopupPhoto(event) {
  window.requestAnimationFrame(() => settlePointPopupPhoto(event.popup));
}

function settlePointPopupPhoto(popup) {
  const photo = popup?.getElement()?.querySelector(".point-popup-photo img");
  if (!photo) return;
  if (!photo.complete) {
    photo.addEventListener("load", () => handlePointPhotoLoad(photo, popup), { once: true });
    photo.addEventListener("error", () => handlePointPhotoError(photo, popup), { once: true });
    if (!photo.complete) return;
  }
  if (photo.naturalWidth > 0) {
    handlePointPhotoLoad(photo, popup);
  } else {
    handlePointPhotoError(photo, popup);
  }
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
    const distanceLabel = formatRouteDistanceLabel(route);
    const lengthHtml = distanceLabel
      ? `<span class="route-length">${escapeHtml(distanceLabel)}</span>`
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
  const rawFeet = route?.length_ft;
  if (!["number", "string"].includes(typeof rawFeet) || String(rawFeet).trim() === "") return "";
  const feet = Number(rawFeet);
  if (!Number.isFinite(feet) || feet < 0) return "";
  const distance = feet >= ROUTE_MILES_THRESHOLD_FEET
    ? `${(feet / 5280).toFixed(2)} mi`
    : `${Math.round(feet / 3).toLocaleString()} yd`;
  return route.shape === "out-and-back" ? `${distance} round trip` : distance;
}

function formatSegmentDistance(feature) {
  if (typeof window.RouteDetails?.segmentDistanceLabel === "function") {
    return window.RouteDetails.segmentDistanceLabel(feature);
  }
  return formatRouteDistanceLabel({ length_ft: feature.properties?.length_ft });
}

function formatLiveDistance(lengthFeet, hereThresholdFeet = null) {
  if (typeof window.RouteDetails?.formatDistance === "function") {
    return window.RouteDetails.formatDistance(lengthFeet, {
      approximate: true,
      hereThresholdFeet,
      milesThresholdFeet: LIVE_DISTANCE_MILES_THRESHOLD_FEET,
    });
  }
  if (!["number", "string"].includes(typeof lengthFeet) || String(lengthFeet).trim() === "") return "";
  const feet = Number(lengthFeet);
  if (!Number.isFinite(feet) || feet < 0) return "";
  if (Number.isFinite(hereThresholdFeet) && feet < hereThresholdFeet) {
    return "you're here";
  }
  if (feet >= LIVE_DISTANCE_MILES_THRESHOLD_FEET) {
    return `about ${(feet / 5280).toFixed(2)} mi`;
  }
  const yards = feet / 3;
  const increment = yards < 100 ? 5 : 10;
  return `about ${(Math.round(yards / increment) * increment).toLocaleString()} yd`;
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
    layer.bindTooltip(
      escapeHtml(options.tooltip || options.title || feature.properties.name),
      {
        sticky: true,
        direction: "top",
      },
    );
    installFeatureHoverFeedback(
      () => featureSelectionLayers(layer, options),
      layer,
    );
  }

  layer.on("click", (event) => {
    if (!hasFinePointer) layer.closeTooltip();
    if (featurePopupsAreSuppressed()) return;

    const activateFeature = () => {
      pendingFeaturePopupTimer = null;
      pendingFeaturePopupPriority = Number.NEGATIVE_INFINITY;
      if (featurePopupsAreSuppressed()) return;
      if (typeof options.onActivate === "function" && options.onActivate(event)) {
        setSelectedFeatureLayers(featureSelectionLayers(layer, options));
        return;
      }
      if (window.CamCapture?.isCapturing()) return;
      closeMapRouteDetails({ restorePopup: false, restoreFocus: false });
      map.closePopup();
      setSelectedFeatureLayers(featureSelectionLayers(layer, options));
      const resolvedDetail = typeof detail === "function" ? detail(feature) : detail;
      L.popup()
        .setLatLng(event.latlng)
        .setContent(buildMapFeaturePopup(feature, resolvedDetail, options))
        .openOn(map);
    };
    if (hasFinePointer) {
      window.clearTimeout(pendingFeaturePopupTimer);
      pendingFeaturePopupTimer = null;
      pendingFeaturePopupPriority = Number.NEGATIVE_INFINITY;
      activateFeature();
    } else {
      const priority = Number(options.interactionPriority) || 0;
      if (pendingFeaturePopupTimer && priority < pendingFeaturePopupPriority) return;
      window.clearTimeout(pendingFeaturePopupTimer);
      pendingFeaturePopupPriority = priority;
      pendingFeaturePopupTimer = window.setTimeout(
        activateFeature,
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
  if (guidanceStartPending && guidanceTracker.target?.id === targetId) return "Cancel guide request";
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
  if (guidanceStartPending && guidanceTracker.target?.id === button.dataset.landmarkId) {
    cancelPendingGuidance();
    return;
  }
  if (
    guidanceTracker.isActive &&
    guidanceTracker.target?.id === button.dataset.landmarkId
  ) {
    stopGuidance();
    return;
  }
  startGuidance(button.dataset.landmarkId);
}

function cancelPendingGuidance() {
  if (!guidanceStartPending) return;
  guidanceStartPending = false;
  guidanceStartGeneration += 1;
  guidanceTracker.target = null;
  clearGuidanceTargetHighlight();
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

  if (guidanceTracker.isActive) {
    showGuidanceTargetHighlight(target);
    guidanceTracker.target = target;
    if (latestPosition) {
      updateGuidanceFromPosition(latestPosition.latlng);
    } else {
      pauseGuidanceForLocation();
    }
    map.closePopup();
    return;
  }

  const requestGeneration = ++guidanceStartGeneration;
  clearGuidanceTimers();
  guidanceTracker.target = target;
  guidanceTracker.targetBearing = null;
  guidanceTracker.headingError = null;
  showGuidanceTargetHighlight(target);
  if (
    latestPosition &&
    distanceBetweenLatLngs(latestPosition.latlng, target.latlng) <= ARRIVAL_DISTANCE_METERS
  ) {
    showGuidanceArrival();
    map.closePopup();
    return;
  }

  guidanceStartPending = true;
  const accessAllowed = await requestHeadingAccess();
  if (requestGeneration !== guidanceStartGeneration || guidanceTracker.target !== target) return;
  guidanceStartPending = false;
  if (!accessAllowed) {
    updateMinimizedCompassHeading();
    declineCompassGuidance();
    return;
  }

  activateMobileHeadingSession();
  guidanceTracker.isActive = true;
  guidanceTracker.isWaitingForLocation = !latestPosition;
  guidanceTracker.headingError = null;
  updateGuidancePill();
  renderGuidanceTint(GUIDANCE_MAX_ERROR_DEG, { centered: true });
  syncHeadingLifecycle({ restartTimeout: true });
  logGuidanceDiagnostic("start");
  if (latestPosition) {
    updateGuidanceFromPosition(latestPosition.latlng);
  } else {
    requestInitialLocation();
  }
  map.closePopup();
}

function declineCompassGuidance() {
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

function requestHeadingAccess() {
  if (headingPipeline.permission === "granted" || headingPipeline.permission === "unsupported") {
    syncHeadingLifecycle();
    return Promise.resolve(true);
  }
  if (headingPipeline.permission === "denied" || headingPipeline.permission === "error") {
    return Promise.resolve(false);
  }
  if (headingPipeline.permission === "pending" && headingPipeline.permissionPromise) {
    return headingPipeline.permissionPromise;
  }

  const orientationApi = window.DeviceOrientationEvent;
  if (!orientationApi) {
    headingPipeline.permission = "unsupported";
    headingPipeline.lastPermissionResult = "unsupported";
    syncHeadingLifecycle();
    return Promise.resolve(true);
  }

  const permissionRequest = orientationApi.requestPermission;
  if (typeof permissionRequest !== "function") {
    headingPipeline.permission = "granted";
    headingPipeline.lastPermissionResult = "not-required";
    headingPipeline.isIosPermissionPath = false;
    syncHeadingLifecycle();
    return Promise.resolve(true);
  }

  headingPipeline.permission = "pending";
  headingPipeline.lastPermissionResult = "pending";
  headingPipeline.isIosPermissionPath = true;
  let request;
  try {
    // Called only by a deliberate compass or Guide me gesture.
    request = permissionRequest.call(orientationApi);
  } catch {
    headingPipeline.permission = "error";
    headingPipeline.lastPermissionResult = "error";
    return Promise.resolve(false);
  }

  const permissionPromise = Promise.resolve(request)
    .then((permission) => {
      headingPipeline.lastPermissionResult = permission;
      headingPipeline.permission = permission === "granted" ? "granted" : "denied";
      syncHeadingLifecycle();
      return headingPipeline.permission === "granted";
    })
    .catch(() => {
      headingPipeline.permission = "error";
      headingPipeline.lastPermissionResult = "error";
      syncHeadingLifecycle();
      return false;
    })
    .finally(() => {
      if (headingPipeline.permissionPromise === permissionPromise) {
        headingPipeline.permissionPromise = null;
      }
    });
  headingPipeline.permissionPromise = permissionPromise;
  return permissionPromise;
}

function hasActiveHeadingConsumer() {
  return (
    compassPanelOpen ||
    guidanceTracker.isActive ||
    (mobileHeadingSessionActive && mobileMapPanels.matches && headingPipeline.permission === "granted")
  );
}

function syncHeadingLifecycle({ restartTimeout = false } = {}) {
  const hasConsumer = hasActiveHeadingConsumer();
  const pageHidden = headingPipeline.pageSuspended || document.visibilityState === "hidden";
  if (!hasConsumer) {
    window.clearTimeout(headingPipeline.freshnessTimeout);
    headingPipeline.freshnessTimeout = null;
    headingPipeline.staleNotified = false;
    detachOrientationListeners();
    return;
  }
  if (pageHidden) {
    window.clearTimeout(headingPipeline.freshnessTimeout);
    headingPipeline.freshnessTimeout = null;
    detachOrientationListeners();
    return;
  }

  if (headingPipeline.permission === "granted") attachOrientationListeners();
  else detachOrientationListeners();

  if (restartTimeout) {
    window.clearTimeout(headingPipeline.freshnessTimeout);
    headingPipeline.freshnessTimeout = null;
    headingPipeline.staleNotified = false;
  }
  if (
    headingPipeline.permission === "pending" ||
    headingPipeline.permission === "unknown" ||
    headingPipeline.permission === "denied" ||
    headingPipeline.permission === "error" ||
    headingPipeline.freshnessTimeout ||
    headingPipeline.staleNotified
  ) return;

  const remainingFreshness = headingPipeline.latestHeadingAt
    ? GUIDANCE_HEADING_TIMEOUT_MS - (performance.now() - headingPipeline.latestHeadingAt)
    : GUIDANCE_HEADING_TIMEOUT_MS;
  headingPipeline.freshnessTimeout = window.setTimeout(
    handleHeadingFreshnessTimeout,
    Math.max(0, remainingFreshness),
  );
}

function attachOrientationListeners() {
  if (headingPipeline.orientationEvents.length) return;
  const eventNames = headingPipeline.isIosPermissionPath
    ? ["deviceorientation"]
    : ["deviceorientationabsolute", "deviceorientation"];
  eventNames.forEach((eventName) => {
    window.addEventListener(eventName, handleOrientationEvent, true);
  });
  headingPipeline.orientationEvents = eventNames;
  const screenOrientation = window.screen?.orientation;
  if (screenOrientation?.addEventListener) {
    screenOrientation.addEventListener("change", handleHeadingScreenChange);
    headingPipeline.screenOrientationTarget = screenOrientation;
  } else {
    window.addEventListener("orientationchange", handleHeadingScreenChange, true);
    headingPipeline.usesWindowOrientationChange = true;
  }
}

function detachOrientationListeners() {
  headingPipeline.orientationEvents.forEach((eventName) => {
    window.removeEventListener(eventName, handleOrientationEvent, true);
  });
  headingPipeline.orientationEvents = [];
  headingPipeline.screenOrientationTarget?.removeEventListener?.("change", handleHeadingScreenChange);
  headingPipeline.screenOrientationTarget = null;
  if (headingPipeline.usesWindowOrientationChange) {
    window.removeEventListener("orientationchange", handleHeadingScreenChange, true);
    headingPipeline.usesWindowOrientationChange = false;
  }
}

function handleOrientationEvent(event) {
  headingPipeline.orientationEventFired = true;
  if (Number.isFinite(event.webkitCompassHeading)) headingPipeline.sawWebkitCompassHeading = true;
  if (Number.isFinite(event.alpha)) headingPipeline.sawFiniteAlpha = true;

  let heading = null;
  let isAndroidHeading = false;

  if (Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
  } else if (event.type === "deviceorientationabsolute" && Number.isFinite(event.alpha)) {
    headingPipeline.lastNativeAbsoluteAt = performance.now();
    heading = 360 - event.alpha;
    isAndroidHeading = true;
  } else if (
    event.type === "deviceorientation" &&
    event.absolute === true &&
    Number.isFinite(event.alpha)
  ) {
    // Keep native absolute readings preferred for 1.2 s, then accept only an
    // absolute-flagged fallback while that preferred stream is quiet.
    const nativeAbsoluteIsRecent =
      headingPipeline.lastNativeAbsoluteAt > 0 &&
      performance.now() - headingPipeline.lastNativeAbsoluteAt <= PREFERRED_ABSOLUTE_HEADING_WINDOW_MS;
    if (nativeAbsoluteIsRecent) return;
    heading = 360 - event.alpha;
    isAndroidHeading = true;
  }

  if (!Number.isFinite(heading)) return;
  // Android absolute alpha is magnetic near Lake Luzerne. Field-verify this
  // correction while standing along a known bearing such as Mountain Drive.
  if (isAndroidHeading) {
    heading += MAGNETIC_DECLINATION_DEG;
    headingPipeline.lastAndroidSensorHeading = heading;
    heading += currentScreenRotation();
  } else {
    headingPipeline.lastAndroidSensorHeading = null;
  }
  smoothGuidanceHeading(normalizeAngle(heading));
}

function currentScreenRotation() {
  return Number(window.screen?.orientation?.angle ?? window.orientation) || 0;
}

function handleHeadingScreenChange() {
  if (!Number.isFinite(headingPipeline.lastAndroidSensorHeading) || getFreshHeading() === null) return;
  smoothGuidanceHeading(
    normalizeAngle(headingPipeline.lastAndroidSensorHeading + currentScreenRotation()),
  );
}

function getFreshHeading() {
  if (headingPipeline.awaitingFreshEventAfterResume) return null;
  if (!Number.isFinite(headingPipeline.latestHeadingAt) || headingPipeline.latestHeadingAt <= 0) return null;
  if (performance.now() - headingPipeline.latestHeadingAt > GUIDANCE_HEADING_TIMEOUT_MS) return null;
  return Number.isFinite(headingPipeline.latestHeading) ? headingPipeline.latestHeading : null;
}

function handleHeadingFreshnessTimeout() {
  headingPipeline.freshnessTimeout = null;
  if (!hasActiveHeadingConsumer() || headingPipeline.pageSuspended || document.visibilityState === "hidden") return;
  if (getFreshHeading() !== null) {
    syncHeadingLifecycle();
    return;
  }

  const hadHeading = headingPipeline.latestHeadingAt > 0;
  headingPipeline.latestHeading = null;
  headingPipeline.smoothedSin = null;
  headingPipeline.smoothedCos = null;
  headingPipeline.staleNotified = true;
  if (compassPanelOpen) {
    setCompassUnavailableMessage(hadHeading
      ? "North fixed · heading stale"
      : "North fixed · no live heading");
  }
  updateMinimizedCompassHeading(null);
  if (guidanceTracker.isActive) handleGuidanceHeadingTimeout();
}

function handleHeadingVisibilityChange() {
  if (document.visibilityState === "hidden") {
    headingPipeline.awaitingFreshEventAfterResume = true;
    window.clearTimeout(headingPipeline.freshnessTimeout);
    headingPipeline.freshnessTimeout = null;
    detachOrientationListeners();
    if (compassPanelOpen) {
      setCompassUnavailableMessage("North fixed · waiting for a fresh heading");
    }
    updateMinimizedCompassHeading(null);
    return;
  }
  if (headingPipeline.pageSuspended) return;

  if (headingPipeline.latestHeadingAt && getFreshHeading() === null && !headingPipeline.staleNotified) {
    headingPipeline.latestHeading = null;
    headingPipeline.smoothedSin = null;
    headingPipeline.smoothedCos = null;
    headingPipeline.staleNotified = true;
    if (compassPanelOpen) setCompassUnavailableMessage("North fixed · heading stale");
    if (guidanceTracker.isActive) handleGuidanceHeadingTimeout();
  }
  syncHeadingLifecycle();
  if (compassPanelOpen && headingPipeline.permission !== "pending") {
    renderFreshCompassHeadingOrWaiting();
  }
  updateMinimizedCompassHeading();
}

function smoothGuidanceHeading(heading) {
  const now = performance.now();
  const radians = (heading * Math.PI) / 180;
  if (
    headingPipeline.smoothedSin === null ||
    (headingPipeline.latestHeadingAt && now - headingPipeline.latestHeadingAt > GUIDANCE_HEADING_TIMEOUT_MS)
  ) {
    headingPipeline.smoothedSin = Math.sin(radians);
    headingPipeline.smoothedCos = Math.cos(radians);
  } else {
    const elapsed = Math.max(0, now - headingPipeline.lastHeadingAt);
    const weight = 1 - Math.exp(-elapsed / GUIDANCE_SMOOTHING_TIME_MS);
    headingPipeline.smoothedSin +=
      weight * (Math.sin(radians) - headingPipeline.smoothedSin);
    headingPipeline.smoothedCos +=
      weight * (Math.cos(radians) - headingPipeline.smoothedCos);
  }
  headingPipeline.lastHeadingAt = now;
  headingPipeline.latestHeadingAt = now;
  headingPipeline.staleNotified = false;
  headingPipeline.awaitingFreshEventAfterResume = false;
  const filteredHeading = normalizeAngle(
    (Math.atan2(headingPipeline.smoothedSin, headingPipeline.smoothedCos) * 180) / Math.PI,
  );
  headingPipeline.latestHeading = filteredHeading;
  window.clearTimeout(headingPipeline.freshnessTimeout);
  headingPipeline.freshnessTimeout = null;
  syncHeadingLifecycle();

  if (compassPanelOpen) renderCompassHeading(filteredHeading);
  updateMinimizedCompassHeading(filteredHeading);
  const recoveringGuidance = Boolean(
    guidanceTracker.unavailableEndTimer || guidanceTracker.unavailableHintTimer,
  );
  if (recoveringGuidance) {
    window.clearTimeout(guidanceTracker.unavailableEndTimer);
    window.clearTimeout(guidanceTracker.unavailableHintTimer);
    guidanceTracker.unavailableEndTimer = null;
    guidanceTracker.unavailableHintTimer = null;
    if (guidanceTracker.isActive) updateGuidancePill();
  }

  if (
    !guidanceTracker.isActive ||
    guidanceTracker.targetBearing === null ||
    now - headingPipeline.lastVisualUpdateAt < GUIDANCE_VISUAL_INTERVAL_MS
  ) {
    return;
  }
  headingPipeline.lastVisualUpdateAt = now;
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
  const filteredHeading = getFreshHeading();
  if (filteredHeading !== null) {
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
  const position = guidancePerimeterPosition(centered ? 0 : signedError);
  guidanceTracker.headingError = centered ? null : signedError;
  guidanceTint.style.setProperty("--guidance-x", `${position.x}%`);
  guidanceTint.style.setProperty("--guidance-y", `${position.y}%`);
  guidanceTint.style.setProperty("--guidance-saturation", `${style.saturation}%`);
  guidanceTint.style.setProperty("--guidance-lightness", `${style.lightness}%`);
  guidanceTint.style.setProperty("--guidance-opacity", style.opacity);
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

function guidancePerimeterPosition(error) {
  const radians = normalizeBearingError(error) * Math.PI / 180;
  const perimeterRadius = 52;
  return {
    x: Number((50 + perimeterRadius * Math.sin(radians)).toFixed(2)),
    y: Number((50 - perimeterRadius * Math.cos(radians)).toFixed(2)),
  };
}

function previewGuidanceHeadingError(error) {
  if (error === null || String(error).trim() === "") {
    throw new TypeError("Guidance preview error must be a number from -180 to 180.");
  }
  const parsedError = Number(error);
  if (!Number.isFinite(parsedError)) {
    throw new TypeError("Guidance preview error must be a number from -180 to 180.");
  }
  const normalizedError = Math.max(-180, Math.min(180, parsedError));
  renderGuidanceTint(normalizedError);
  return { error: normalizedError, ...guidancePerimeterPosition(normalizedError) };
}

function installGuidancePreviewControl() {
  window.previewGuidanceHeadingError = previewGuidanceHeadingError;
  const requestedPreview = new URLSearchParams(window.location.search).get("guidanceError");
  if (requestedPreview === null) return;
  window.requestAnimationFrame(() => {
    try {
      previewGuidanceHeadingError(requestedPreview);
    } catch (error) {
      console.warn(error.message);
    }
  });
}

function readGuidanceRamp() {
  const styles = getComputedStyle(document.documentElement);
  const value = (name) => Number.parseFloat(styles.getPropertyValue(name));
  return [
    { error: 0, saturation: value("--guidance-saturation-0"), lightness: value("--guidance-lightness-0"), opacity: value("--guidance-opacity-0"), blur: value("--guidance-blur-0") },
    { error: 30, saturation: value("--guidance-saturation-30"), lightness: value("--guidance-lightness-30"), opacity: value("--guidance-opacity-30"), blur: value("--guidance-blur-30") },
    { error: 60, saturation: value("--guidance-saturation-60"), lightness: value("--guidance-lightness-60"), opacity: value("--guidance-opacity-60"), blur: value("--guidance-blur-60") },
    { error: 110, saturation: value("--guidance-saturation-110"), lightness: value("--guidance-lightness-110"), opacity: value("--guidance-opacity-110"), blur: value("--guidance-blur-110") },
    { error: 180, saturation: value("--guidance-saturation-180"), lightness: value("--guidance-lightness-180"), opacity: value("--guidance-opacity-180"), blur: value("--guidance-blur-180") },
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
  if (!guidanceTracker.isActive || getFreshHeading() !== null) return;
  logGuidanceDiagnostic("timeout");
  guidanceTracker.headingError = null;
  renderGuidanceTint(GUIDANCE_MAX_ERROR_DEG, { centered: true });
  setGuidancePill("Compass unavailable");
  if (headingPipeline.isIosPermissionPath && !guidanceTracker.hasShownIosOrientationHint) {
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
    `[457 guidance] ${phase} events=${headingPipeline.orientationEvents.join(",") || "none"} ` +
      `permission=${headingPipeline.lastPermissionResult} ` +
      `event=${headingPipeline.orientationEventFired} ` +
      `webkit=${headingPipeline.sawWebkitCompassHeading} alpha=${headingPipeline.sawFiniteAlpha}`,
  );
}

function showGuidanceArrival() {
  window.clearTimeout(guidanceTracker.unavailableHintTimer);
  window.clearTimeout(guidanceTracker.unavailableEndTimer);
  guidanceTracker.unavailableHintTimer = null;
  guidanceTracker.unavailableEndTimer = null;
  guidanceTracker.isActive = false;
  guidanceTracker.isWaitingForLocation = false;
  guidanceTracker.targetBearing = null;
  guidanceTracker.headingError = null;
  syncHeadingLifecycle();
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
  guidanceStartPending = false;
  guidanceStartGeneration += 1;
  clearGuidanceTimers();
  guidanceTracker.isActive = false;
  guidanceTracker.isWaitingForLocation = false;
  guidanceTracker.targetBearing = null;
  guidanceTracker.headingError = null;
  syncHeadingLifecycle();
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
    if (definition.baseOnly) return;
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

function decorateLayerControl(control) {
  window.cancelAnimationFrame(layerControlDecorationFrame);
  layerControlDecorationFrame = null;
  const focusedControlElement = control.getContainer().contains(document.activeElement)
    ? document.activeElement
    : null;
  installLayerControlHeadings(control);
  infoButton = installLayerResetButton(control);
  if (focusedControlElement?.isConnected) focusedControlElement.focus();
}

function scheduleLayerControlDecoration() {
  window.cancelAnimationFrame(layerControlDecorationFrame);
  layerControlDecorationFrame = window.requestAnimationFrame(() => {
    layerControlDecorationFrame = null;
    decorateLayerControl(layerControl);
  });
}

function installLayerResetButton(control) {
  const list = control.getContainer().querySelector(".leaflet-control-layers-list");
  const resetSections = [...list.querySelectorAll(".layer-reset-section")];
  const resetSection = resetSections.shift() || document.createElement("div");
  resetSections.forEach((section) => section.remove());
  resetSection.className = "layer-reset-section";
  let resetButton = resetSection.querySelector(".layer-reset-button");
  if (!resetButton) {
    resetButton = document.createElement("button");
    resetButton.className = "layer-reset-button";
    resetButton.type = "button";
    resetButton.textContent = "Reset to default";
    resetButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetMapToDefaults();
      scheduleLayerControlDecoration();
    });
  }
  // Leaflet replaces its checkbox lists, while this custom footer survives.
  let aboutButton = infoButton || list.querySelector("#info-button");
  if (!aboutButton) {
    aboutButton = document.createElement("button");
    aboutButton.id = "info-button";
    aboutButton.className = "layer-about-button";
    aboutButton.type = "button";
    aboutButton.setAttribute("aria-label", "About this map");
    aboutButton.title = "About this map";
    aboutButton.setAttribute("aria-controls", "info-overlay");
    aboutButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10.5v6M12 7.5h.01"></path></svg>';
    aboutButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openInfo();
    });
  }
  aboutButton.setAttribute("aria-expanded", String(!document.getElementById("info-overlay").hidden));
  list.querySelectorAll("#info-button").forEach((button) => {
    if (button !== aboutButton) button.remove();
  });
  list.querySelectorAll(".layer-about-row").forEach((row) => row.remove());
  resetSection.append(resetButton, aboutButton);
  list.append(resetSection);
  L.DomEvent.disableClickPropagation(resetSection);
  return aboutButton;
}

function installLayerControlHeadings(control) {
  const list = control.getContainer().querySelector(".leaflet-control-layers-list");
  const baseLayers = list.querySelector(".leaflet-control-layers-base");
  const overlays = list.querySelector(".leaflet-control-layers-overlays");
  list.querySelectorAll(".layer-group-heading").forEach((heading) => heading.remove());
  const definitions = getAudienceLayerDefinitions({ panelOnly: true });
  const labels = new Map(
    [...overlays.querySelectorAll("label")].map((label) => [label.textContent.trim(), label]),
  );
  const appendGroup = (title, entries, container) => {
    const groupLabels = entries.map((entry) => labels.get(entry.label)).filter(Boolean);
    if (groupLabels.length === 0) return;
    const heading = document.createElement("div");
    heading.className = "layer-group-heading";
    heading.textContent = title;
    container.append(heading, ...groupLabels);
  };
  const mapTypeHeading = document.createElement("div");
  mapTypeHeading.className = "layer-group-heading";
  mapTypeHeading.textContent = "Map Type";
  baseLayers.prepend(mapTypeHeading);
  appendGroup("Points", definitions.filter((entry) => entry.group !== "80-terrain"), overlays);
  appendGroup("Layers", definitions.filter((entry) => entry.group === "80-terrain"), overlays);
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
  showMapLegend();
  map.closePopup();
  if (map.hasLayer(topographicGround)) map.removeLayer(topographicGround);
  if (!map.hasLayer(nysAerial)) map.addLayer(nysAerial);

  getAudienceLayerDefinitions({ panelOnly: true }).forEach((definition) => {
    const layer = definition.getLayer();
    const shouldShow = definition.defaultVisible[activeAudience];
    if (shouldShow && !map.hasLayer(layer)) map.addLayer(layer);
    if (!shouldShow && map.hasLayer(layer)) map.removeLayer(layer);
  });

  if (boundaryLayer.getBounds().isValid()) {
    map.fitBounds(propertyContextBounds(), {
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
    baseMap: map.hasLayer(topographicGround) ? "topo" : "aerial",
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
  headingPipeline.pageSuspended = true;
  headingPipeline.awaitingFreshEventAfterResume = true;
  window.clearTimeout(headingPipeline.freshnessTimeout);
  headingPipeline.freshnessTimeout = null;
  detachOrientationListeners();
  updateMinimizedCompassHeading(null);
  guidanceStartGeneration += 1;
  guidanceStartPending = false;
  if (watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
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
  pendingFeaturePopupPriority = Number.NEGATIVE_INFINITY;
  window.clearTimeout(programmaticFocusReleaseTimer);
  programmaticFocusReleaseTimer = null;
  if (releaseProgrammaticFocus) releaseProgrammaticFocus(false);
  suppressPreferencePersistence = false;
  clearLayerControlHoverDelay();
}

function handlePageShow(event) {
  headingPipeline.pageSuspended = false;
  if (event.persisted && latestPosition && watchId === null && navigator.geolocation) {
    startLocationWatch();
  }
  if (headingPipeline.latestHeadingAt && getFreshHeading() === null && !headingPipeline.staleNotified) {
    handleHeadingFreshnessTimeout();
  }
  syncHeadingLifecycle();
  if (compassPanelOpen) renderFreshCompassHeadingOrWaiting();
  updateMinimizedCompassHeading();
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
      pendingFeaturePopupPriority = Number.NEGATIVE_INFINITY;
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
