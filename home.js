"use strict";

const DATA_CACHE_VERSION = "20260918-4";
let openRouteDetails = null;

function versionedDataUrl(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}v=${DATA_CACHE_VERSION}`;
}

function closeRouteDetails({ restoreFocus = false } = {}) {
  if (!openRouteDetails) return;
  const { button, details } = openRouteDetails;
  details.hidden = true;
  button.setAttribute("aria-expanded", "false");
  openRouteDetails = null;
  if (restoreFocus) button.focus();
}

function createRouteEntry(route) {
  const entry = document.createElement("article");
  entry.className = "home-route-entry";

  const button = document.createElement("button");
  button.className = "route-card";
  button.type = "button";
  const detailsId = `route-details-${route.id}`;
  button.setAttribute("aria-controls", detailsId);
  button.setAttribute("aria-expanded", "false");

  const title = document.createElement("strong");
  const facts = document.createElement("span");
  const description = document.createElement("span");
  title.className = "route-card-title";
  facts.className = "route-card-facts";
  description.className = "route-card-description";
  title.textContent = route.name;
  facts.textContent = [
    window.RouteDetails.distanceLabel(route),
    route.difficulty || "",
    route.shape || "",
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
  description.textContent = route.description || "Open this route for more details.";
  button.append(title, facts, description);

  const { details, closeButton } = window.RouteDetails.createPanel(route, {
    id: detailsId,
    includeMapLink: true,
  });
  closeButton.addEventListener("click", () => closeRouteDetails({ restoreFocus: true }));
  button.addEventListener("click", () => {
    const shouldOpen = details.hidden;
    closeRouteDetails();
    if (!shouldOpen) return;
    details.hidden = false;
    button.setAttribute("aria-expanded", "true");
    openRouteDetails = { button, details, entry };
  });
  entry.append(button, details);
  return entry;
}

async function loadHomeRoutes() {
  if (typeof window.RouteDetails?.deriveRouteMetrics !== "function") {
    throw new Error("Shared route details are unavailable.");
  }
  const manifestResponse = await fetch(versionedDataUrl("data/manifest.json"));
  if (!manifestResponse.ok) {
    throw new Error(`Could not load the data manifest: ${manifestResponse.status}`);
  }
  const manifest = await manifestResponse.json();
  const sources = new Map(
    (manifest.sources || []).map((source) => [source.key, source.path]),
  );
  const requiredKeys = ["routes", "driveway", "trails"];
  if (requiredKeys.some((key) => !sources.has(key))) {
    throw new Error("The data manifest is missing a route source.");
  }
  const responses = await Promise.all(
    requiredKeys.map((key) => fetch(versionedDataUrl(sources.get(key)))),
  );
  responses.forEach((response, index) => {
    if (!response.ok) {
      throw new Error(`Could not load ${requiredKeys[index]}: ${response.status}`);
    }
  });
  const [routeData, drivewayData, trailData] = await Promise.all(
    responses.map((response) => response.json()),
  );
  const segmentFeaturesById = new Map(
    [
      ...(drivewayData.features || []),
      ...(trailData.features || []),
    ]
      .filter((feature) => feature.properties?.id)
      .map((feature) => [feature.properties.id, feature]),
  );
  return (routeData.routes || []).map((route) =>
    window.RouteDetails.deriveRouteMetrics(route, segmentFeaturesById),
  );
}

loadHomeRoutes()
  .then((routes) => {
    if (routes.length === 0) return;
    const section = document.getElementById("home-routes");
    const list = document.getElementById("home-route-list");
    routes.forEach((route) => {
      if (route?.id && route.name) list.append(createRouteEntry(route));
    });
    section.hidden = list.childElementCount === 0;
  })
  .catch((error) => console.error("Walking routes are unavailable.", error));

document.addEventListener("click", (event) => {
  if (openRouteDetails && !openRouteDetails.entry.contains(event.target)) closeRouteDetails();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeRouteDetails({ restoreFocus: true });
});
