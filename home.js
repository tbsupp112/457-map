"use strict";

let openRouteDetails = null;

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

fetch("data/trails/routes.json")
  .then((response) => {
    if (!response.ok) throw new Error(`Could not load routes: ${response.status}`);
    return response.json();
  })
  .then((data) => {
    const routes = Array.isArray(data.routes) ? data.routes : [];
    if (routes.length === 0) return;
    const section = document.getElementById("home-routes");
    const list = document.getElementById("home-route-list");
    routes.forEach((route) => {
      if (route?.id && route.name) list.append(createRouteEntry(route));
    });
    section.hidden = list.childElementCount === 0;
  })
  .catch((error) => console.info("Walking routes are unavailable.", error));

document.addEventListener("click", (event) => {
  if (openRouteDetails && !openRouteDetails.entry.contains(event.target)) closeRouteDetails();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeRouteDetails({ restoreFocus: true });
});
