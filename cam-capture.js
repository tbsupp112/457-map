"use strict";

(() => {
  const CAM_RECORDS_KEY = "457-property-cam-deployments-v1";
  const AUTHORED_CAMERA_IDS = Object.freeze(["cam-1", "cam-2", "cam-3", "cam-4"]);
  const STORED_ARROW_LENGTH_METERS = 25;

  let config = null;
  let elements = null;
  let stage = "idle";
  let sitesById = new Map();
  let draft = emptyDraft();

  function emptyDraft() {
    return {
      siteId: "",
      cameraId: "",
      bearingDeg: null,
      targetLatLng: null,
    };
  }

  function readCamDeployments() {
    try {
      const stored = JSON.parse(window.localStorage.getItem(CAM_RECORDS_KEY));
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  async function appendCamDeployment(record) {
    const all = readCamDeployments();
    all.push(record);
    window.localStorage.setItem(CAM_RECORDS_KEY, JSON.stringify(all));
    return { stored: "local", count: all.length };
  }

  function initialize(options) {
    if (config || !options?.map || !options?.sitesLayer) return;
    config = options;
    createInterface();
    bindInterfaceEvents();
    config.map.on("click", handleMapClick);
    config.map.on("layeradd layerremove", handleMapLayerChange);
    syncLayerVisibility();
    refreshStoredState();
  }

  function createInterface() {
    const launcher = document.createElement("div");
    launcher.className = "cam-capture-launcher";
    launcher.hidden = true;
    launcher.innerHTML =
      '<button class="cam-record-button" type="button">Record deployment</button>' +
      '<button class="cam-export-shortcut" type="button">Export records (0)</button>';

    const panel = document.createElement("section");
    panel.className = "cam-capture-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "cam-capture-title");
    panel.innerHTML = `
      <div class="cam-capture-heading">
        <div>
          <p class="cam-capture-eyebrow">Owner · local test records</p>
          <h2 id="cam-capture-title">Trail cam deployment</h2>
        </div>
        <button class="cam-cancel-button" type="button">Cancel</button>
      </div>
      <p class="cam-capture-prompt" role="status" aria-live="polite"></p>
      <div class="cam-capture-grid">
        <p class="cam-capture-value"><span>Site</span><strong data-cam-site>None selected</strong></p>
        <p class="cam-capture-value"><span>Bearing</span><strong data-cam-bearing>Not set</strong></p>
      </div>
      <label class="cam-capture-field">
        <span>Camera ID</span>
        <select data-cam-camera disabled>
          <option value="">Choose a camera</option>
        </select>
      </label>
      <label class="cam-capture-field">
        <span>New camera ID (overrides list)</span>
        <input data-cam-new-camera type="text" inputmode="text" autocomplete="off" disabled maxlength="50">
      </label>
      <label class="cam-capture-field">
        <span>Note (optional)</span>
        <input data-cam-note type="text" autocomplete="off" maxlength="240">
      </label>
      <div class="cam-capture-actions">
        <button class="cam-confirm-button" type="button" disabled>Confirm deployment</button>
        <button class="cam-panel-export-button" type="button">Export records (0)</button>
      </div>
      <p class="cam-export-warning">Export after each session; iOS Safari may remove local records from sites that go unvisited.</p>
      <label class="cam-export-output">
        <span>Stored records JSON</span>
        <textarea data-cam-export readonly rows="7" spellcheck="false"></textarea>
      </label>
      <p class="cam-export-status" role="status" aria-live="polite"></p>
    `;

    document.body.append(launcher, panel);
    elements = {
      launcher,
      panel,
      recordButton: launcher.querySelector(".cam-record-button"),
      exportShortcut: launcher.querySelector(".cam-export-shortcut"),
      cancelButton: panel.querySelector(".cam-cancel-button"),
      prompt: panel.querySelector(".cam-capture-prompt"),
      site: panel.querySelector("[data-cam-site]"),
      bearing: panel.querySelector("[data-cam-bearing]"),
      camera: panel.querySelector("[data-cam-camera]"),
      newCamera: panel.querySelector("[data-cam-new-camera]"),
      note: panel.querySelector("[data-cam-note]"),
      confirmButton: panel.querySelector(".cam-confirm-button"),
      exportButton: panel.querySelector(".cam-panel-export-button"),
      exportText: panel.querySelector("[data-cam-export]"),
      exportStatus: panel.querySelector(".cam-export-status"),
    };

    AUTHORED_CAMERA_IDS.forEach((cameraId) => {
      const option = document.createElement("option");
      option.value = cameraId;
      option.textContent = cameraId;
      elements.camera.append(option);
    });
  }

  function bindInterfaceEvents() {
    elements.recordButton.addEventListener("click", startCapture);
    elements.exportShortcut.addEventListener("click", openExportPanel);
    elements.cancelButton.addEventListener("click", cancelCapture);
    elements.camera.addEventListener("change", updateCameraSelection);
    elements.newCamera.addEventListener("input", updateCameraSelection);
    elements.confirmButton.addEventListener("click", confirmDeployment);
    elements.exportButton.addEventListener("click", exportRecords);
    elements.exportText.addEventListener("focus", () => elements.exportText.select());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.panel.hidden) cancelCapture();
    });
  }

  function handleMapLayerChange(event) {
    if (event.layer !== config.sitesLayer) return;
    syncLayerVisibility();
    if (!config.map.hasLayer(config.sitesLayer)) cancelCapture();
  }

  function syncLayerVisibility() {
    elements.launcher.hidden = !config.map.hasLayer(config.sitesLayer);
  }

  function setSites(features) {
    sitesById = new Map(
      features
        .filter((feature) => feature?.properties?.id && feature?.geometry?.type === "Point")
        .map((feature) => [feature.properties.id, feature]),
    );
    renderStoredDeployments();
  }

  function startCapture() {
    clearDraft();
    stage = "select-site";
    elements.launcher.hidden = true;
    elements.panel.hidden = false;
    elements.exportStatus.textContent = "";
    refreshPanel();
  }

  function openExportPanel() {
    clearDraft();
    stage = "idle";
    elements.launcher.hidden = true;
    elements.panel.hidden = false;
    refreshPanel();
    exportRecords();
  }

  function cancelCapture() {
    if (!elements) return;
    clearDraft();
    stage = "idle";
    elements.panel.hidden = true;
    elements.exportStatus.textContent = "";
    syncLayerVisibility();
    config.clearSelection?.();
  }

  function clearDraft() {
    draft = emptyDraft();
    config?.draftArrowLayer?.clearLayers();
    if (!elements) return;
    elements.camera.value = "";
    elements.newCamera.value = "";
    elements.note.value = "";
  }

  function isCapturing() {
    return stage !== "idle";
  }

  function handleSiteActivation(feature) {
    if (!isCapturing()) return false;
    if (stage === "select-site" || stage === "select-camera") {
      selectSite(feature);
    }
    return true;
  }

  function selectSite(feature) {
    const siteId = feature?.properties?.id;
    if (!sitesById.has(siteId)) return;
    draft.siteId = siteId;
    draft.bearingDeg = null;
    draft.targetLatLng = null;
    config.draftArrowLayer.clearLayers();
    stage = currentCameraId() ? "select-bearing" : "select-camera";
    refreshPanel();
    elements.camera.focus({ preventScroll: true });
  }

  function currentCameraId() {
    const custom = elements?.newCamera.value.trim();
    return custom || elements?.camera.value || "";
  }

  function updateCameraSelection() {
    draft.cameraId = currentCameraId();
    if (!draft.siteId) {
      stage = "select-site";
    } else if (!draft.cameraId) {
      stage = "select-camera";
      draft.bearingDeg = null;
      draft.targetLatLng = null;
      config.draftArrowLayer.clearLayers();
    } else if (draft.bearingDeg === null) {
      stage = "select-bearing";
    } else {
      stage = "ready";
    }
    refreshPanel();
  }

  function handleMapClick(event) {
    if (stage !== "select-bearing" && stage !== "ready") return;
    const site = sitesById.get(draft.siteId);
    const cameraId = currentCameraId();
    if (!site || !cameraId) return;
    const [longitude, latitude] = site.geometry.coordinates;
    const siteLatLng = L.latLng(latitude, longitude);
    const bearing = config.calculateTrueBearing(siteLatLng, event.latlng);
    if (!Number.isFinite(bearing)) return;
    draft.cameraId = cameraId;
    draft.bearingDeg = Math.round(bearing) % 360;
    draft.targetLatLng = L.latLng(event.latlng);
    stage = "ready";
    config.draftArrowLayer.clearLayers();
    createArrow(siteLatLng, draft.targetLatLng, true).addTo(config.draftArrowLayer);
    refreshPanel();
  }

  function refreshPanel() {
    const site = sitesById.get(draft.siteId);
    elements.site.textContent = site?.properties?.name || "None selected";
    elements.bearing.textContent = Number.isInteger(draft.bearingDeg)
      ? `${draft.bearingDeg}° true`
      : "Not set";
    const hasSite = Boolean(site);
    elements.camera.disabled = !hasSite;
    elements.newCamera.disabled = !hasSite;
    elements.confirmButton.disabled = stage !== "ready";
    const prompts = {
      idle: "Stored records are shown below. Start a deployment from the map button.",
      "select-site": "Tap one trail cam site pin.",
      "select-camera": "Choose a camera ID or enter a new one.",
      "select-bearing": "Tap a second point anywhere on the map to set true bearing.",
      ready: "Check the arrow and bearing. Tap elsewhere to replace them, or confirm.",
    };
    elements.prompt.textContent = prompts[stage];
    refreshStoredState();
  }

  async function confirmDeployment() {
    const site = sitesById.get(draft.siteId);
    const cameraId = currentCameraId();
    if (!site || !cameraId || !Number.isInteger(draft.bearingDeg)) return;
    const now = new Date();
    const record = {
      id: nextDeploymentId(now),
      site_id: draft.siteId,
      camera_id: cameraId,
      bearing_deg: draft.bearingDeg,
      recorded_on: now.toISOString(),
      note: elements.note.value.trim(),
    };
    elements.confirmButton.disabled = true;
    try {
      await appendCamDeployment(record);
      const siteLatLng = featureLatLng(site);
      addStoredArrow(record, draft.targetLatLng || destinationLatLng(
        siteLatLng,
        record.bearing_deg,
        STORED_ARROW_LENGTH_METERS,
      ));
      refreshStoredState();
      cancelCapture();
    } catch {
      elements.exportStatus.textContent =
        "This browser could not store the record. Nothing was saved; export any earlier records now.";
      elements.confirmButton.disabled = false;
    }
  }

  function nextDeploymentId(now) {
    const day = now.toISOString().slice(0, 10);
    const prefix = `dep-${day}-`;
    const sequence = readCamDeployments().reduce((highest, record) => {
      if (typeof record?.id !== "string" || !record.id.startsWith(prefix)) return highest;
      const value = Number.parseInt(record.id.slice(prefix.length), 10);
      return Number.isFinite(value) ? Math.max(highest, value) : highest;
    }, 0) + 1;
    return `${prefix}${String(sequence).padStart(3, "0")}`;
  }

  function refreshStoredState() {
    if (!elements) return;
    const records = readCamDeployments();
    const label = `Export records (${records.length})`;
    elements.exportShortcut.textContent = label;
    elements.exportButton.textContent = label;
    elements.exportText.value = JSON.stringify(records, null, 2);
  }

  async function exportRecords() {
    refreshStoredState();
    elements.exportText.focus({ preventScroll: true });
    elements.exportText.select();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(elements.exportText.value);
      elements.exportStatus.textContent =
        "Copied. The selectable JSON remains below for manual copying.";
    } catch {
      elements.exportStatus.textContent =
        "Clipboard access was blocked. Select and copy the JSON below manually.";
    }
  }

  function formatSiteDetail(feature) {
    const siteId = feature?.properties?.id;
    const note = feature?.properties?.note || "Placeholder trail cam site.";
    const records = readCamDeployments()
      .filter((record) => record?.site_id === siteId)
      .sort((first, second) => String(second.recorded_on).localeCompare(String(first.recorded_on)));
    if (records.length === 0) return `${note}\nNo deployments stored for this site.`;
    const lines = records.map((record) => {
      const date = String(record.recorded_on || "unknown time").replace("T", " ").replace(/\.\d{3}Z$/, "Z");
      return `${date} · ${record.camera_id} · ${record.bearing_deg}° true`;
    });
    return `${note}\nDeployments, newest first:\n${lines.join("\n")}`;
  }

  function renderStoredDeployments() {
    if (!config) return;
    config.deploymentArrowsLayer.clearLayers();
    readCamDeployments().forEach((record) => {
      const site = sitesById.get(record?.site_id);
      const bearing = Number(record?.bearing_deg);
      if (!site || !Number.isFinite(bearing) || bearing < 0 || bearing >= 360) return;
      const start = featureLatLng(site);
      addStoredArrow(
        record,
        destinationLatLng(start, bearing, STORED_ARROW_LENGTH_METERS),
      );
    });
  }

  function addStoredArrow(record, target) {
    const site = sitesById.get(record.site_id);
    if (!site) return;
    const arrow = createArrow(featureLatLng(site), target, false);
    arrow.options.deploymentId = record.id;
    arrow.addTo(config.deploymentArrowsLayer);
  }

  function featureLatLng(feature) {
    const [longitude, latitude] = feature.geometry.coordinates;
    return L.latLng(latitude, longitude);
  }

  function createArrow(start, end, draftArrow) {
    const bearing = config.calculateTrueBearing(start, end);
    const distance = Math.max(1, distanceMeters(start, end));
    const headLength = Math.min(10, Math.max(3, distance * 0.18));
    const left = destinationLatLng(end, bearing + 150, headLength);
    const right = destinationLatLng(end, bearing - 150, headLength);
    const style = {
      pane: config.pane,
      renderer: config.renderer,
      interactive: false,
      color: draftArrow ? "#ffffff" : "#ffd45f",
      opacity: 0.96,
      weight: draftArrow ? 4 : 3,
      lineCap: "round",
      lineJoin: "round",
      dashArray: draftArrow ? "7 6" : null,
    };
    return L.layerGroup([
      L.polyline([start, end], style),
      L.polyline([left, end, right], style),
    ]);
  }

  function distanceMeters(first, second) {
    const radians = Math.PI / 180;
    const firstLat = first.lat * radians;
    const secondLat = second.lat * radians;
    const deltaLat = (second.lat - first.lat) * radians;
    const deltaLon = (second.lng - first.lng) * radians;
    const haversine =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(firstLat) * Math.cos(secondLat) * Math.sin(deltaLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  function destinationLatLng(start, bearing, distance) {
    const radius = 6371000;
    const radians = Math.PI / 180;
    const angularDistance = distance / radius;
    const startLat = start.lat * radians;
    const startLon = start.lng * radians;
    const direction = bearing * radians;
    const latitude = Math.asin(
      Math.sin(startLat) * Math.cos(angularDistance) +
      Math.cos(startLat) * Math.sin(angularDistance) * Math.cos(direction),
    );
    const longitude = startLon + Math.atan2(
      Math.sin(direction) * Math.sin(angularDistance) * Math.cos(startLat),
      Math.cos(angularDistance) - Math.sin(startLat) * Math.sin(latitude),
    );
    return L.latLng(latitude / radians, longitude / radians);
  }

  window.CamCapture = Object.freeze({
    initialize,
    setSites,
    isCapturing,
    handleSiteActivation,
    formatSiteDetail,
    readCamDeployments,
    appendCamDeployment,
  });
})();
