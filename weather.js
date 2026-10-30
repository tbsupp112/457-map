"use strict";

(function exposePropertyWeather() {
  const HOUR_MS = 60 * 60 * 1000;
  const STORAGE_KEY = "457-property-weather-v1";
  const POINT_URL = "https://api.weather.gov/points/43.3596,-73.8348";
  // Compared with other reporting stations during the October 2026 intake.
  // This airport is a nearby regional observation, not an onsite wind sensor.
  const STATION_ID = "KGFL";
  const STATION_NAME = "Glens Falls airport (KGFL)";
  const OBSERVATION_URL = `https://api.weather.gov/stations/${STATION_ID}/observations/latest`;
  const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const views = new Set();
  let cache = readCache();
  let inFlight = null;

  function readCache() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        if (!saved.observation || typeof saved.observation !== "object") delete saved.observation;
        if (!Array.isArray(saved.periods)) delete saved.periods;
        if (saved.metadata) {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: saved.metadata.timeZone }).format();
          } catch {
            delete saved.metadata;
          }
        }
        return saved;
      }
    } catch {
      // Weather remains available when storage is denied or full.
    }
    return {};
  }

  function saveCache() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // Keep this page's in-memory cache when storage is unavailable.
    }
  }

  function nextAttemptAt(now = Date.now()) {
    const attemptedAt = cache.attemptedAt;
    return Number.isFinite(attemptedAt) && attemptedAt <= now + 60000
      ? attemptedAt + HOUR_MS
      : 0;
  }

  async function readJson(url) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/geo+json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Weather request failed (${response.status}).`);
      const data = await response.json();
      const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get("Cache-Control") || "")?.[1]);
      return { data, maxAge: Number.isFinite(maxAge) ? maxAge : 86400 };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function trustedNwsUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://api.weather.gov" ? url.href : null;
    } catch {
      return null;
    }
  }

  async function metadata() {
    if (cache.metadata?.expiresAt > Date.now() && trustedNwsUrl(cache.metadata.hourlyUrl)) return cache.metadata;
    try {
      const { data, maxAge } = await readJson(POINT_URL);
      const hourlyUrl = trustedNwsUrl(data?.properties?.forecastHourly);
      const timeZone = data?.properties?.timeZone;
      if (!hourlyUrl || typeof timeZone !== "string") throw new Error("Weather point metadata is incomplete.");
      // Check the returned time zone before saving or using it for display.
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
      cache.metadata = { hourlyUrl, timeZone, expiresAt: Date.now() + maxAge * 1000 };
      return cache.metadata;
    } catch (error) {
      if (trustedNwsUrl(cache.metadata?.hourlyUrl)) return cache.metadata;
      throw error;
    }
  }

  function notifyViews() {
    views.forEach((view) => view.update());
  }

  async function load() {
    if (inFlight) return inFlight;
    if (Date.now() < nextAttemptAt()) return cache;
    cache.attemptedAt = Date.now();
    inFlight = (async () => {
      const results = await Promise.allSettled([
        readJson(OBSERVATION_URL).then((response) => {
          const observation = response.data?.properties;
          if (!observation || !Number.isFinite(Date.parse(observation.timestamp))) {
            throw new Error("Weather observation is incomplete.");
          }
          return observation;
        }),
        metadata().then((point) => readJson(point.hourlyUrl)).then((response) => {
          const periods = response.data?.properties?.periods;
          if (!Array.isArray(periods) || !periods.some((period) =>
            Number.isFinite(Date.parse(period?.startTime)) && Number.isFinite(Date.parse(period?.endTime)),
          )) throw new Error("Weather forecast is incomplete.");
          return periods;
        }),
      ]);
      const [observation, forecast] = results;
      if (observation.status === "fulfilled") {
        cache.observation = observation.value;
        cache.observationFetchedAt = Date.now();
      }
      if (forecast.status === "fulfilled") {
        cache.periods = forecast.value;
        cache.forecastFetchedAt = Date.now();
      }
      cache.refreshFailed = results.some((result) => result.status === "rejected");
      saveCache();
      return cache;
    })().finally(() => {
      inFlight = null;
      notifyViews();
    });
    notifyViews();
    return inFlight;
  }

  function numberValue(quantity) {
    return Number.isFinite(quantity?.value) ? quantity.value : null;
  }

  function temperatureF(quantity) {
    const value = numberValue(quantity);
    if (value === null) return null;
    if (quantity.unitCode === "wmoUnit:degC") return value * 9 / 5 + 32;
    return quantity.unitCode === "wmoUnit:degF" ? value : null;
  }

  function speedMph(quantity) {
    const value = numberValue(quantity);
    if (value === null || value < 0) return null;
    const factors = {
      "wmoUnit:km_h-1": 1 / 1.609344,
      "wmoUnit:m_s-1": 2.2369362921,
      "wmoUnit:mi_h-1": 1,
      "wmoUnit:kn": 1.150779448,
    };
    return quantity.unitCode in factors ? value * factors[quantity.unitCode] : null;
  }

  function precipitationInches(quantity) {
    const value = numberValue(quantity);
    if (value === null || value < 0) return null;
    const factors = { "wmoUnit:mm": 1 / 25.4, "wmoUnit:m": 1 / 0.0254, "wmoUnit:in": 1 };
    return quantity.unitCode in factors ? value * factors[quantity.unitCode] : null;
  }

  function compassDirection(degrees) {
    if (!Number.isFinite(degrees)) return "";
    return COMPASS_POINTS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
  }

  function observationBearing(quantity) {
    const value = numberValue(quantity);
    return quantity?.unitCode === "wmoUnit:degree_(angle)" && value !== null && value >= 0 && value <= 360 ? value : null;
  }

  function observationDirection(quantity) {
    return compassDirection(observationBearing(quantity));
  }

  function windTravelBearing(fromBearing) {
    return Number.isFinite(fromBearing) && fromBearing >= 0 && fromBearing <= 360 ? (fromBearing + 180) % 360 : null;
  }

  function formatTemperature(value) {
    return Number.isFinite(value) ? `${Math.round(value)}°F` : "Unavailable";
  }

  function formatWind(speed, direction = "", gust = null) {
    let text = !Number.isFinite(speed) ? "Unavailable"
      : speed === 0 ? "Calm"
        : `${Math.max(1, Math.round(speed))} mph${direction ? ` from ${direction}` : " · direction unavailable"}`;
    if (Number.isFinite(gust) && gust > 0) text += ` · gusts ${Math.max(1, Math.round(gust))} mph`;
    return text;
  }

  function formatPrecipitation(quantity) {
    const inches = precipitationInches(quantity);
    if (inches === null) return "Unavailable";
    return inches > 0 && inches < 0.005 ? "<0.01 in" : `${inches.toFixed(2)} in`;
  }

  function selectForecast(periods, now = Date.now()) {
    const target = now + 2 * HOUR_MS;
    return Array.isArray(periods) ? periods.find((period) => {
      const start = Date.parse(period?.startTime);
      const end = Date.parse(period?.endTime);
      return Number.isFinite(start) && Number.isFinite(end) && start <= target && target < end;
    }) || null : null;
  }

  function observationState(observation, now = Date.now()) {
    const timestamp = Date.parse(observation?.timestamp);
    const age = now - timestamp;
    if (!Number.isFinite(timestamp) || age < -10 * 60000 || age > 6 * HOUR_MS) return "unavailable";
    return age > 2 * HOUR_MS ? "stale" : "current";
  }

  function localTime(timestamp, timeZone = "America/New_York") {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return "Time unavailable";
    const options = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
    try {
      return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(date);
    } catch {
      return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "America/New_York" }).format(date);
    }
  }

  function forecastTemperature(period) {
    if (!Number.isFinite(period?.temperature)) return null;
    if (period.temperatureUnit === "F") return period.temperature;
    return period.temperatureUnit === "C" ? period.temperature * 9 / 5 + 32 : null;
  }

  function forecastWindDetails(period) {
    const directionIndex = COMPASS_POINTS.indexOf(period?.windDirection);
    const bearing = directionIndex >= 0 ? directionIndex * 22.5 : null;
    if (typeof period?.windSpeed === "object") {
      return { low: speedMph(period.windSpeed), high: null, bearing, gust: null };
    }
    const match = /^(\d+(?:\.\d+)?)(?: to (\d+(?:\.\d+)?))? (mph|km\/h|kt)$/.exec(period?.windSpeed || "");
    if (!match) return { low: null, high: null, bearing: null, gust: null };
    const unitCode = { mph: "wmoUnit:mi_h-1", "km/h": "wmoUnit:km_h-1", kt: "wmoUnit:kn" }[match[3]];
    const low = speedMph({ value: Number(match[1]), unitCode });
    const high = match[2] ? speedMph({ value: Number(match[2]), unitCode }) : null;
    if (high !== null && high < low) return { low: null, high: null, bearing: null, gust: null };
    return { low, high, bearing, gust: null };
  }

  function windText({ low, high, bearing, gust }) {
    const direction = compassDirection(bearing);
    if (high === null) return formatWind(low, direction, gust);
    if (high === 0) return "Calm";
    return `${Math.round(low)}–${Math.round(high)} mph${direction ? ` from ${direction}` : " · direction unavailable"}`;
  }

  function forecastWind(period) {
    return windText(forecastWindDetails(period));
  }

  function conditionPresentation(fields, forecast = false) {
    const description = typeof (forecast ? fields?.shortForecast : fields?.textDescription) === "string"
      ? (forecast ? fields.shortForecast : fields.textDescription).trim() : "";
    let phase = null;
    let codes = [];
    try {
      const url = new URL(fields?.icon);
      const match = url.origin === "https://api.weather.gov" && /^\/icons\/land\/(day|night)\/(.+)$/.exec(url.pathname);
      if (match) {
        phase = match[1];
        codes = match[2].split("/").map((part) => part.split(",")[0]);
      }
    } catch {
      // Missing or unrecognized icon URLs carry no day/night assumption.
    }
    if (forecast && typeof fields?.isDaytime === "boolean") phase = fields.isDaytime ? "day" : "night";
    const present = !forecast && Array.isArray(fields?.presentWeather)
      ? fields.presentWeather.map((item) => `${typeof item?.weather === "string" ? item.weather : ""} ${typeof item?.modifier === "string" ? item.modifier : ""}`).join(" ")
      : "";
    const evidence = `${description} ${present}`.toLowerCase();
    let kind = null;
    if (/thunder/.test(evidence) || codes.some((code) => /^tsra/.test(code))) kind = "thunderstorm";
    else if (/snow|sleet|ice|freezing|hail|wintry/.test(evidence) || codes.some((code) => /snow|sleet|fzra/.test(code))) kind = "snow-ice";
    else if (/\brain|showers|drizzle/.test(evidence) || codes.some((code) => /^rain/.test(code))) kind = "rain";
    else if (/fog|mist/.test(evidence) || codes.includes("fog")) kind = "fog";
    else if (/partly cloudy|mostly clear|few clouds|scattered clouds/.test(evidence) || codes.some((code) => code === "few" || code === "sct")) kind = "partly-cloudy";
    else if (/cloudy|overcast|broken clouds/.test(evidence) || codes.some((code) => code === "bkn" || code === "ovc")) kind = "cloudy";
    else if (/\bclear\b|\bfair\b|\bsunny\b/.test(evidence) || codes.includes("skc")) kind = phase === "day" ? "clear-day" : phase === "night" ? "clear-night" : null;
    const labels = { "clear-day": "Clear", "clear-night": "Clear night", "partly-cloudy": "Partly cloudy", cloudy: "Cloudy", rain: "Rain", "snow-ice": "Snow or ice", thunderstorm: "Thunderstorm", fog: "Fog" };
    return { kind, label: description || labels[kind] || "", phase };
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS(SVG_NAMESPACE, name);
    Object.entries(attributes || {}).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  }

  function conditionIcon(condition) {
    if (!condition.kind) return null;
    const svg = svgElement("svg", {
      class: "weather-condition-icon", viewBox: "0 0 40 40", role: "img",
      "aria-label": condition.label, "data-condition": condition.kind,
    });
    const path = (d) => svg.append(svgElement("path", { d }));
    const sun = () => {
      svg.append(svgElement("circle", { cx: 20, cy: 20, r: 7 }));
      path("M20 3v5M20 32v5M3 20h5M32 20h5M8 8l4 4M28 28l4 4M8 32l4-4M28 12l4-4");
    };
    const moon = () => path("M26 5A14 14 0 1 0 34 28 15 15 0 0 1 26 5Z");
    const cloud = () => path("M10 26a6 6 0 1 1 1-12 9 9 0 0 1 17-1 6.5 6.5 0 0 1 1 13H10Z");
    if (condition.kind === "clear-day") sun();
    else if (condition.kind === "clear-night") moon();
    else {
      if (condition.kind === "partly-cloudy" && condition.phase === "day") {
        svg.append(svgElement("circle", { cx: 10, cy: 10, r: 5 }));
        path("M10 1v2M1 10h2M3 3l2 2M17 3l-2 2");
      } else if (condition.kind === "partly-cloudy" && condition.phase === "night") {
        path("M13 2A8 8 0 1 0 19 14 9 9 0 0 1 13 2Z");
      }
      cloud();
      if (condition.kind === "rain") path("M12 31l-2 5M22 31l-2 5M32 31l-2 5");
      if (condition.kind === "snow-ice") path("M12 31v7M9 33l6 3M9 36l6-3M29 31v7M26 33l6 3M26 36l6-3");
      if (condition.kind === "thunderstorm") path("M22 27l-6 7h6l-3 5 10-9h-7l3-3");
      if (condition.kind === "fog") path("M5 31h30M9 36h23");
    }
    return svg;
  }

  function appendTemperature(parent, temperature, condition) {
    const group = appendText(parent, "div", "weather-temperature-group", "");
    const line = appendText(group, "div", "weather-temperature-line", "");
    const icon = conditionIcon(condition);
    if (icon) line.append(icon);
    appendText(line, "p", "weather-temperature", formatTemperature(temperature));
    if (!icon && condition.label) appendText(group, "p", "weather-condition-text", condition.label);
  }

  function appendWind(parent, details) {
    const { low, high, bearing, gust } = details;
    const wind = appendText(parent, "div", "weather-wind", "");
    wind.setAttribute("role", "img");
    wind.setAttribute("aria-label", `Wind: ${windText(details)}`);
    const symbol = appendText(wind, "div", "weather-wind-symbol", "");
    const speed = high === null ? low : high;
    const travel = Number.isFinite(speed) && speed > 0 ? windTravelBearing(bearing) : null;
    if (travel !== null) {
      const svg = svgElement("svg", {
        class: "weather-wind-arrow", viewBox: "0 0 32 36", "aria-hidden": "true", "data-travel-bearing": travel,
      });
      const group = svgElement("g", { transform: `rotate(${travel} 16 18)` });
      group.append(svgElement("path", { d: "M16 31V5M7 14l9-9 9 9" }));
      svg.append(group);
      symbol.append(svg);
    } else {
      symbol.textContent = speed === 0 ? "Calm" : "—";
    }
    const speedLabel = Number.isFinite(low) ? high === null ? String(low === 0 ? 0 : Math.max(1, Math.round(low))) : `${Math.round(low)}–${Math.round(high)}` : "Unavailable";
    const reading = appendText(wind, "p", "weather-wind-speed", speedLabel);
    if (Number.isFinite(low)) appendText(reading, "span", "weather-wind-unit", " mph");
    const from = Number.isFinite(speed) && speed > 0 ? compassDirection(bearing) : "";
    if (from) appendText(wind, "p", "weather-wind-direction", `from ${from}`);
    else if (Number.isFinite(speed) && speed > 0) appendText(wind, "p", "weather-wind-direction", "direction unavailable");
    if (Number.isFinite(gust) && gust > 0) appendText(wind, "p", "weather-wind-gust", `gusts ${Math.max(1, Math.round(gust))} mph`);
  }

  function rainChance(period) {
    const chance = numberValue(period?.probabilityOfPrecipitation);
    return chance !== null && chance >= 0 && chance <= 100 && period.probabilityOfPrecipitation.unitCode === "wmoUnit:percent"
      ? `${Math.round(chance)}%` : "Unavailable";
  }

  function appendText(parent, tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function render(container, now = Date.now()) {
    container.replaceChildren();
    const observation = cache.observation;
    const state = observationState(observation, now);
    const timeZone = cache.metadata?.timeZone || "America/New_York";
    const available = state !== "unavailable";
    const current = appendText(container, "div", "weather-current", "");
    const status = state === "stale" ? "Older observation · stale" : available ? "" : inFlight && !observation ? "Loading weather…" : "Current conditions unavailable";
    if (status) appendText(current, "p", `weather-status${state === "stale" ? " weather-status--stale" : ""}`, status);
    const metrics = appendText(current, "div", "weather-metrics", "");
    appendTemperature(metrics, available ? temperatureF(observation.temperature) : null, conditionPresentation(available ? observation : null));
    appendWind(metrics, {
      low: available ? speedMph(observation.windSpeed) : null, high: null,
      bearing: available ? observationBearing(observation.windDirection) : null,
      gust: available ? speedMph(observation.windGust) : null,
    });
    const precipitation = available ? precipitationInches(observation.precipitationLastHour) : null;
    if (precipitation !== null && precipitation > 0) {
      appendText(current, "p", "weather-reading weather-observed-precipitation", `Previous-hour precipitation: ${formatPrecipitation(observation.precipitationLastHour)}`);
    }
    const forecast = appendText(container, "div", "weather-forecast", "");
    const period = selectForecast(cache.periods, now);
    appendText(forecast, "p", "weather-forecast-title", period ? `Forecast · ${localTime(period.startTime, timeZone)}` : "Forecast in about 2 hours unavailable");
    if (period) {
      const forecastMetrics = appendText(forecast, "div", "weather-metrics", "");
      appendTemperature(forecastMetrics, forecastTemperature(period), conditionPresentation(period, true));
      appendWind(forecastMetrics, forecastWindDetails(period));
      appendText(forecast, "p", "weather-reading", `Rain chance: ${rainChance(period)}`);
    }
    if (cache.refreshFailed) appendText(container, "p", "weather-message", "Refresh unavailable. Any retained reading keeps its original time.");
    const station = appendText(container, "p", "weather-station", "");
    const link = appendText(station, "a", "", STATION_NAME);
    link.href = OBSERVATION_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    appendText(station, "span", "", ` · ${observation?.timestamp ? localTime(observation.timestamp, timeZone) : "Observation time unavailable"}`);
  }

  function createView(container, { compact = false } = {}) {
    container.classList.add("property-weather");
    container.classList.toggle("property-weather--compact", Boolean(compact));
    let visible = false;
    let timer = null;
    let destroyed = false;
    const active = () => visible && !document.hidden && !destroyed;
    const view = {
      update() {
        window.clearTimeout(timer);
        timer = null;
        if (!active()) return;
        render(container);
        if (!inFlight) {
          const now = Date.now();
          const observedAt = Date.parse(cache.observation?.timestamp);
          const forecastBoundary = Date.parse(selectForecast(cache.periods, now)?.endTime) - 2 * HOUR_MS;
          // Status ages on time even when the next permitted network refresh is later.
          const deadlines = [nextAttemptAt(now), observedAt + 2 * HOUR_MS + 1, observedAt + 6 * HOUR_MS + 1, forecastBoundary]
            .filter((deadline) => Number.isFinite(deadline) && deadline > now);
          const deadline = deadlines.length ? Math.min(...deadlines) : now;
          timer = window.setTimeout(refresh, Math.max(1, deadline - now));
        }
      },
      setVisible(value) {
        visible = Boolean(value);
        if (active()) refresh();
        else {
          window.clearTimeout(timer);
          timer = null;
        }
      },
      destroy() {
        destroyed = true;
        window.clearTimeout(timer);
        views.delete(view);
        document.removeEventListener("visibilitychange", visibilityChanged);
      },
    };
    async function refresh() {
      if (!active()) return;
      await load();
      view.update();
    }
    function visibilityChanged() {
      if (active()) refresh();
      else view.update();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    views.add(view);
    return view;
  }

  window.PropertyWeather = Object.freeze({
    createView,
    temperatureF,
    speedMph,
    precipitationInches,
    formatTemperature,
    formatWind,
    formatPrecipitation,
    forecastWind,
    forecastWindDetails,
    windTravelBearing,
    conditionPresentation,
    observationDirection,
    selectForecast,
    observationState,
    localTime,
  });
})();
