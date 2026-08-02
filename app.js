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
      "Topo map": topoMap,
    },
    {
      "Corner markers": cornersLayer,
    },
    { collapsed: true, position: "topright" },
  )
  .addTo(map);

const corridorSouth = L.latLng(43.36114129, -73.83520117);
const corridorNorth = L.latLng(43.36108584, -73.83562233);

// The corridor's exact edges are not mapped here. This transparent hit area
// only makes the known gap between the two owned parcels interactive.
L.polyline([corridorSouth, corridorNorth], {
  color: "#000000",
  weight: 30,
  opacity: 0,
  interactive: true,
})
  .bindTooltip("National Grid powerline cut — not our land, but access is allowed.", {
    sticky: true,
    direction: "top",
  })
  .bindPopup(
    "<strong>National Grid powerline cut</strong><br>Not our land, but access is allowed.",
  )
  .addTo(map);

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

locateButton.addEventListener("click", () => {
  if (latestPosition) {
    map.setView(latestPosition.latlng, Math.max(map.getZoom(), 18));
    return;
  }
  requestInitialLocation();
});

function requestInitialLocation() {
  if (!navigator.geolocation) {
    locationStatus.textContent = "Location is not supported on this device.";
    locateButton.disabled = true;
    return;
  }

  locationStatus.textContent = "Requesting your location…";
  locateButton.textContent = "Locating…";
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

  const accuracyFeet = Math.round(accuracy * 3.28084);
  locationStatus.textContent = `Location accuracy: about ±${accuracyFeet} ft`;
  locateButton.textContent = "Center on me";
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
  locationStatus.textContent = messages[error.code] || "Could not determine your location.";
  locateButton.textContent = "Try again";
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

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value ?? "";
  return element.innerHTML;
}
