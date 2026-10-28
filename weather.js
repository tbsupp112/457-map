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
    const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return directions[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
  }

  function observationDirection(quantity) {
    return quantity?.unitCode === "wmoUnit:degree_(angle)" ? compassDirection(numberValue(quantity)) : "";
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

  function forecastWind(period) {
    const direction = /^(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)$/.test(period.windDirection)
      ? period.windDirection : "";
    if (typeof period.windSpeed === "object") return formatWind(speedMph(period.windSpeed), direction);
    const match = /^(\d+(?:\.\d+)?)(?: to (\d+(?:\.\d+)?))? (mph|km\/h|kt)$/.exec(period.windSpeed || "");
    if (!match) return "Unavailable";
    const unitCode = { mph: "wmoUnit:mi_h-1", "km/h": "wmoUnit:km_h-1", kt: "wmoUnit:kn" }[match[3]];
    const low = speedMph({ value: Number(match[1]), unitCode });
    if (!match[2]) return formatWind(low, direction);
    const high = speedMph({ value: Number(match[2]), unitCode });
    if (high === 0) return "Calm";
    return `${Math.round(low)}–${Math.round(high)} mph${direction ? ` from ${direction}` : " · direction unavailable"}`;
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
    const status = state === "stale" ? "Older observation · stale" : available ? "Nearby observation" : "Current conditions unavailable";
    appendText(current, "p", `weather-status${state === "stale" ? " weather-status--stale" : ""}`, status);
    appendText(current, "p", "weather-temperature", formatTemperature(available ? temperatureF(observation.temperature) : null));
    const wind = available ? formatWind(
      speedMph(observation.windSpeed),
      observationDirection(observation.windDirection),
      speedMph(observation.windGust),
    ) : "Unavailable";
    appendText(current, "p", "weather-reading", `Wind: ${wind}`);
    appendText(current, "p", "weather-reading", `Previous-hour precipitation: ${available ? formatPrecipitation(observation.precipitationLastHour) : "Unavailable"}`);
    appendText(current, "p", "weather-station", `${STATION_NAME} · ${observation?.timestamp ? localTime(observation.timestamp, timeZone) : "Observation time unavailable"}`);
    const forecast = appendText(container, "div", "weather-forecast", "");
    const period = selectForecast(cache.periods, now);
    appendText(forecast, "p", "weather-forecast-title", period ? `Forecast · ${localTime(period.startTime, timeZone)}` : "Forecast in about 2 hours unavailable");
    if (period) {
      appendText(forecast, "p", "weather-reading", `${formatTemperature(forecastTemperature(period))} · wind ${forecastWind(period)}`);
      appendText(forecast, "p", "weather-reading", `Rain chance: ${rainChance(period)}`);
    }
    if (inFlight && !observation) appendText(container, "p", "weather-message", "Loading nearby weather…");
    if (cache.refreshFailed) appendText(container, "p", "weather-message", "Refresh unavailable. Any retained reading keeps its original time.");
    appendText(container, "p", "weather-disclaimer", "Nearby airport conditions; wind may differ on the property.");
    const attribution = appendText(container, "p", "weather-attribution", "Source: ");
    const link = appendText(attribution, "a", "", "National Weather Service");
    link.href = "https://www.weather.gov/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
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
    observationDirection,
    selectForecast,
    observationState,
    localTime,
  });
})();
