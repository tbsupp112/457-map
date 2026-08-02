"use strict";

const PROPERTY_BOUNDS_PADDING = [28, 28];
const DEFAULT_MAX_ZOOM = 19;

const map = L.map("map", {
  zoomControl: true,
  maxZoom: DEFAULT_MAX_ZOOM,
  preferCanvas: true,
});

// Give Leaflet a valid drawing viewport before asynchronous GeoJSON arrives.
map.setView([43.3596, -73.8348], 17);

const nysAerial = L.tileLayer(
  "https://orthos.its.ny.gov/arcgis/rest/services/wms/2022/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: "Imagery © NYS ITS Geospatial Services (2022)",
  },
).addTo(map);

const usgsTopo = L.tileLayer(
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 16,
    maxNativeZoom: 16,
    attribution: "Map © U.S. Geological Survey",
  },
);

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
  style: {
    color: "#5ee6bd",
    weight: 4,
    opacity: 1,
    fillColor: "#5ee6bd",
    fillOpacity: 0.2,
    lineJoin: "round",
  },
  onEachFeature(feature, layer) {
    const acres = Number(feature.properties.acres_computed).toFixed(2);
    layer.bindTooltip(`${feature.properties.name}<br>${acres} acres`, {
      permanent: true,
      direction: "center",
      className: "parcel-label",
    });
    layer.bindPopup(
      `<strong>${escapeHtml(feature.properties.name)}</strong><br>` +
        `${acres} computed acres<br>` +
        `<small>${escapeHtml(feature.properties.note)}</small><hr>` +
        `<small>Approximate boundary — not a survey.</small>`,
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

L.control
  .layers(
    {
      "NYS aerial (2022)": nysAerial,
      "USGS topo": usgsTopo,
    },
    {
      "Corner markers": cornersLayer,
    },
    { collapsed: true, position: "topright" },
  )
  .addTo(map);

const corridorSouth = L.latLng(43.36114129, -73.83520117);
const corridorNorth = L.latLng(43.36108584, -73.83562233);

L.polyline([corridorSouth, corridorNorth], {
  color: "#382c08",
  weight: 7,
  opacity: 0.88,
  dashArray: "4 7",
  interactive: false,
}).addTo(map);

const corridorMarker = L.marker(
  L.latLng(
    (corridorSouth.lat + corridorNorth.lat) / 2,
    (corridorSouth.lng + corridorNorth.lng) / 2,
  ),
  {
    interactive: false,
    icon: L.divIcon({
      className: "corridor-icon",
      html: "Utility corridor<br>Not our land",
      iconSize: [84, 26],
      iconAnchor: [42, 13],
    }),
  },
).addTo(map);

function updateCorridorLabel() {
  const element = corridorMarker.getElement();
  if (!element) return;
  const point = map.latLngToContainerPoint(corridorMarker.getLatLng());
  const size = map.getSize();
  const comfortablyVisible =
    map.getZoom() >= 18 &&
    point.x > 80 &&
    point.x < size.x - 70 &&
    point.y > 70 &&
    point.y < size.y - 55;
  element.hidden = !comfortablyVisible;
}

map.on("moveend zoomend resize", updateCorridorLabel);
corridorMarker.on("add", () => window.requestAnimationFrame(updateCorridorLabel));

const locationStatus = document.getElementById("location-status");
const locateButton = document.getElementById("locate-button");
const locationLayer = L.layerGroup().addTo(map);
let watchId = null;
let latestPosition = null;
let hasCenteredOnUser = false;

Promise.all([
  loadGeoJson("data/boundary.geojson"),
  loadGeoJson("data/corners.geojson"),
])
  .then(([boundaryData, cornerData]) => {
    boundaryHalo.addData(boundaryData);
    boundaryLayer.addData(boundaryData);
    cornersLayer.addData(cornerData);
    map.fitBounds(boundaryLayer.getBounds(), {
      paddingTopLeft: PROPERTY_BOUNDS_PADDING,
      paddingBottomRight: PROPERTY_BOUNDS_PADDING,
      maxZoom: 18,
    });
  })
  .catch((error) => {
    console.error(error);
    locationStatus.textContent = "Map data could not be loaded.";
    map.setView([43.3596, -73.8348], 17);
  });

// Location should still work if a data file or layer service has a problem.
startLocationWatch();

locateButton.addEventListener("click", () => {
  if (latestPosition) {
    map.setView(latestPosition.latlng, Math.max(map.getZoom(), 18));
    return;
  }
  startLocationWatch(true);
});

function startLocationWatch(forceRestart = false) {
  if (!navigator.geolocation) {
    locationStatus.textContent = "Location is not supported on this device.";
    locateButton.disabled = true;
    return;
  }

  if (watchId !== null && !forceRestart) return;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);

  locationStatus.textContent = "Requesting your location…";
  locateButton.textContent = "Find me";

  watchId = navigator.geolocation.watchPosition(
    updateLocation,
    handleLocationError,
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
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

  const accuracyFeet = Math.round(accuracy * 3.28084);
  locationStatus.textContent = `Location accuracy: about ±${accuracyFeet} ft`;
  locateButton.textContent = "Center on me";

  if (!hasCenteredOnUser && boundaryLayer.getBounds().pad(0.35).contains(latlng)) {
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
  locationStatus.textContent = messages[error.code] || "Could not determine your location.";
  locateButton.textContent = "Try again";
}

async function loadGeoJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
  return response.json();
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value ?? "";
  return element.innerHTML;
}
