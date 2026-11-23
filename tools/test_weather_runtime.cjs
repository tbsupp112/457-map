"use strict";

// Execute provider logic with controlled time/network/storage; no external requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "weather.js"), "utf8");
const HOUR = 3600000;
const TEN_MINUTES = 600000;
const START = Date.parse("2026-10-27T18:00:00Z");
const CUTOFF = Date.parse("2026-12-14T05:00:00Z");

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.textContent = "";
    this.attributes = {};
    this.classList = { add() {}, toggle() {} };
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  text() { return [this.textContent, ...this.children.map((child) => child.text())].join(" "); }
  all(predicate) { return [this, ...this.children.flatMap((child) => child.all(predicate))].filter(predicate); }
}

const classIs = (name) => (element) => (element.className || element.attributes.class || "").split(" ").includes(name);

function harness(saved = {}, options = {}) {
  let now = options.start ?? START;
  let serial = 0;
  let mode = "ok";
  let heldObservationRelease = null;
  const timers = new Map();
  const listeners = new Map();
  const storage = new Map([["457-property-weather-v1", JSON.stringify(saved)]]);
  const calls = [];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const document = {
    hidden: false,
    createElement: (tag) => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag),
    addEventListener: (name, fn) => listeners.set(fn, name),
    removeEventListener: (name, fn) => listeners.delete(fn),
  };
  const observation = {
    timestamp: new Date(START - HOUR / 2).toISOString(),
    temperature: { value: 10, unitCode: "wmoUnit:degC" },
    windSpeed: { value: 16.09344, unitCode: "wmoUnit:km_h-1" },
    windDirection: { value: 315, unitCode: "wmoUnit:degree_(angle)" },
    precipitationLastHour: { value: null, unitCode: "wmoUnit:mm" },
    textDescription: "Fair",
    icon: "https://api.weather.gov/icons/land/day/skc",
  };
  const periods = [{
    startTime: new Date(START + 2 * HOUR).toISOString(),
    endTime: new Date(START + 3 * HOUR).toISOString(),
    temperature: 50, temperatureUnit: "F", windSpeed: "0 mph", windDirection: "NW",
    probabilityOfPrecipitation: { value: 0, unitCode: "wmoUnit:percent" },
  }];
  const window = {
    localStorage: {
      getItem: (key) => { if (options.storageDenied) throw new Error("storage denied"); return storage.get(key); },
      setItem: (key, value) => { if (options.storageDenied) throw new Error("storage denied"); storage.set(key, value); },
    },
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  function fetchResponse(url) {
    if (mode === "fail") throw new Error("offline");
    if (mode === "retry-after-seconds" && url.includes("observations/latest")) {
      return { ok: false, status: 503, headers: { get: (name) => name.toLowerCase() === "retry-after" ? "1200" : "" } };
    }
    if (mode === "retry-after-date" && url.includes("observations/latest")) {
      return { ok: false, status: 429, headers: { get: (name) => name.toLowerCase() === "retry-after" ? new Date(now + 1200000).toUTCString() : "" } };
    }
    let data;
    if (mode === "malformed") data = null;
    else if (url.includes("/points/")) data = { properties: { forecastHourly: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", timeZone: "America/New_York" } };
    else if (url.includes("observations/latest")) data = { properties: observation };
    else data = { properties: { periods } };
    return { ok: true, headers: { get: () => "public, max-age=86400" }, json: async () => data };
  }
  async function fetch(url) {
    calls.push(url);
    if (mode === "hold-observation" && url.includes("observations/latest")) {
      return new Promise((resolve) => { heldObservationRelease = () => resolve(fetchResponse(url)); });
    }
    return fetchResponse(url);
  }
  vm.runInNewContext(source, { window, document, fetch, AbortController, Intl, URL, Date: Clock, console });
  return {
    api: window.PropertyWeather, document, calls, storage, timers, observation, periods,
    time: (value) => { now = value; },
    mode: (value) => { mode = value; },
    releaseHeldObservation: () => {
      const release = heldObservationRelease;
      heldObservationRelease = null;
      mode = "ok";
      release?.();
    },
    tick: async () => {
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      due.forEach(([id, timer]) => { timers.delete(id); timer.fn(); });
      await new Promise(setImmediate);
    },
    visibility: () => { listeners.forEach((name, fn) => fn()); },
  };
}

async function main() {
  const h = harness();
  const api = h.api;
  assert.equal(api.temperatureF({ value: 0, unitCode: "wmoUnit:degC" }), 32);
  assert.equal(api.temperatureF({ value: null, unitCode: "wmoUnit:degC" }), null);
  assert.equal(api.temperatureF({ value: 10, unitCode: "unknown" }), null);
  assert.equal(api.speedMph({ value: 16.09344, unitCode: "wmoUnit:km_h-1" }), 10);
  assert.equal(api.formatPrecipitation({ value: null, unitCode: "wmoUnit:mm" }), "Unavailable");
  assert.equal(api.formatPrecipitation({ value: 0, unitCode: "wmoUnit:mm" }), "0.00 in");
  assert.equal(api.formatPrecipitation({ value: 25.4, unitCode: "wmoUnit:mm" }), "1.00 in");
  assert.equal(api.formatWind(0, "NW"), "Calm");
  assert.equal(api.formatWind(10, "NW", 15), "10 mph from NW · gusts 15 mph");
  assert.equal(api.observationDirection({ value: 315, unitCode: "unknown" }), "");
  assert.equal(api.observationDirection({ value: 315, unitCode: "wmoUnit:degree_(angle)" }), "NW");
  assert.equal(api.forecastWind({ windSpeed: "0 mph", windDirection: "N" }), "Calm");
  for (const [from, travel] of [[0, 180], [90, 270], [180, 0], [270, 90], [202.5, 22.5]]) {
    assert.equal(api.windTravelBearing(from), travel, `Air travel bearing for wind from ${from} degrees`);
  }
  for (const invalid of [null, undefined, -1, 361, NaN]) assert.equal(api.windTravelBearing(invalid), null);
  assert.equal(api.observationDirection({ value: -1, unitCode: "wmoUnit:degree_(angle)" }), "");
  assert.equal(api.forecastWind({ windSpeed: "5 to 10 mph", windDirection: "SSW" }), "5–10 mph from SSW");
  assert.equal(api.forecastWindDetails({ windSpeed: "5 to 10 mph", windDirection: "SSW" }).bearing, 202.5);
  assert.equal(api.forecastWindDetails({ windSpeed: "10 mph", windDirection: "VRB" }).bearing, null);
  assert.equal(api.forecastWind({ windSpeed: "10 to 5 mph", windDirection: "N" }), "Unavailable");
  const conditionCases = [
    [{ icon: "https://api.weather.gov/icons/land/day/skc", textDescription: "Fair" }, "clear-day"],
    [{ icon: "https://api.weather.gov/icons/land/night/skc", textDescription: "Fair" }, "clear-night"],
    [{ textDescription: "Partly Cloudy" }, "partly-cloudy"],
    [{ textDescription: "Overcast" }, "cloudy"],
    [{ textDescription: "Light Rain" }, "rain"],
    [{ textDescription: "Freezing Rain" }, "snow-ice"],
    [{ textDescription: "Snow" }, "snow-ice"],
    [{ presentWeather: [{ weather: "thunderstorm" }] }, "thunderstorm"],
    [{ textDescription: "Fog/Mist" }, "fog"],
    [{ textDescription: "Unknown conditions" }, null],
    [{ temperature: { value: 90 }, probabilityOfPrecipitation: { value: 0 } }, null],
    [{ textDescription: "Fair" }, null], // Clear without day/night evidence has no solar default.
  ];
  conditionCases.forEach(([fields, expected]) => assert.equal(api.conditionPresentation(fields).kind, expected));
  assert.equal(api.conditionPresentation({ shortForecast: "Clear", isDaytime: false }, true).kind, "clear-night");
  const timestamp = new Date(START).toISOString();
  assert.equal(api.observationState({ timestamp }, START + 2 * HOUR), "current");
  assert.equal(api.observationState({ timestamp }, START + 2 * HOUR + 1), "stale");
  assert.equal(api.observationState({ timestamp }, START + 6 * HOUR), "stale");
  assert.equal(api.observationState({ timestamp }, START + 6 * HOUR + 1), "unavailable");
  assert.equal(api.observationState({ timestamp: "bad" }, START), "unavailable");
  assert.equal(api.selectForecast(h.periods, START), h.periods[0]);
  assert.equal(api.selectForecast(h.periods, START + HOUR), null); // +2h is at exclusive end.
  assert.equal(api.selectForecast([null], START), null);
  assert.match(api.localTime(timestamp, "broken/timezone"), /EDT/);

  const first = new Element();
  const second = new Element();
  const a = api.createView(first);
  const b = api.createView(second);
  assert.equal(h.calls.length, 0, "Closed views do not fetch");
  a.setVisible(true);
  b.setVisible(true);
  await h.tick();
  assert.equal(h.calls.length, 3, "Concurrent views share point/forecast/observation requests");
  assert.match(first.text(), /50°F/);
  assert.match(first.all(classIs("weather-wind"))[0].attributes["aria-label"], /10 mph from NW/);
  assert.equal(first.all(classIs("weather-wind-arrow"))[0].attributes["data-travel-bearing"], "135");
  assert.equal(first.all(classIs("weather-condition-icon"))[0].attributes["data-condition"], "clear-day");
  assert.equal(first.all(classIs("weather-observed-precipitation")).length, 0);
  assert.equal(first.children.at(-1).className, "weather-station");
  assert.doesNotMatch(first.text(), /Nearby observation|Nearby airport conditions|Source:/);
  assert.match(first.text(), /Rain chance: 0%/);
  a.setVisible(true);
  await h.tick();
  assert.equal(h.calls.length, 3, "Opening again within the hour uses cache");
  a.setVisible(false);
  b.setVisible(false);
  assert.equal(h.timers.size, 0);
  h.time(START + 3 * HOUR);
  await h.tick();
  assert.equal(h.calls.length, 3, "Closed views do not poll");
  h.mode("fail");
  a.setVisible(true);
  await h.tick();
  assert.equal(h.calls.length, 5, "Retry reuses unexpired point metadata");
  assert.match(first.text(), /stale/);
  assert.match(first.text(), /50°F/);
  assert.match(first.text(), /Refresh unavailable/);
  assert.match(first.text(), /Forecast in about 2 hours unavailable/);
  const retained = JSON.parse(h.storage.get("457-property-weather-v1"));
  assert.equal(retained.observation.timestamp, h.observation.timestamp, "Failure keeps original observation time");
  h.time(START + 4 * HOUR);
  h.mode("malformed");
  await h.tick();
  assert.match(first.text(), /Refresh unavailable/);
  assert.equal(JSON.parse(h.storage.get("457-property-weather-v1")).observation.timestamp, h.observation.timestamp);
  h.document.hidden = true;
  h.visibility();
  assert.equal(h.timers.size, 0, "Hidden page cancels timers");
  a.destroy();
  b.destroy();

  const resumed = harness({
    attemptedAt: START,
    metadata: { timeZone: "America/New_York", hourlyUrl: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", expiresAt: START + HOUR },
    observation: { ...h.observation },
  });
  const resumedRoot = new Element();
  const resumedView = resumed.api.createView(resumedRoot);
  resumedView.setVisible(true);
  await resumed.tick();
  assert.equal(resumed.calls.length, 0, "opening before the due time uses the retained reading");
  assert.match(resumedRoot.text(), /50°F/);
  resumed.document.hidden = true;
  resumed.visibility();
  resumed.time(START + TEN_MINUTES + 1);
  await resumed.tick();
  assert.equal(resumed.calls.length, 0, "a hidden document makes no due weather request");
  resumed.document.hidden = false;
  resumed.visibility();
  await resumed.tick();
  assert.equal(resumed.calls.length, 2, "returning to a visible tab refreshes once when due");
  assert.match(resumedRoot.text(), /50°F/, "the retained reading remains visible after refresh");
  resumed.visibility();
  await resumed.tick();
  assert.equal(resumed.calls.length, 2, "repeated visibility signals do not duplicate a completed refresh");
  resumedView.destroy();

  const unchanged = harness({
    attemptedAt: START - TEN_MINUTES,
    metadata: { timeZone: "America/New_York", hourlyUrl: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", expiresAt: START + HOUR },
    observation: { ...h.observation },
  });
  const unchangedRoot = new Element();
  const unchangedView = unchanged.api.createView(unchangedRoot);
  unchangedView.setVisible(true);
  await unchanged.tick();
  const refreshedObservation = JSON.parse(unchanged.storage.get("457-property-weather-v1")).observation;
  assert.equal(refreshedObservation.timestamp, h.observation.timestamp, "an unchanged latest observation keeps the provider timestamp");
  assert.match(unchangedRoot.text(), new RegExp(unchanged.api.localTime(h.observation.timestamp, "America/New_York")));
  unchangedView.destroy();

  // The newer cadence applies to old hourly timestamps as soon as ten minutes is due.
  const beforeCutoff = harness({
    attemptedAt: CUTOFF - TEN_MINUTES - 1,
    metadata: { timeZone: "America/New_York", hourlyUrl: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", expiresAt: CUTOFF + HOUR },
  }, { start: CUTOFF - 1 });
  const beforeRoot = new Element();
  const beforeView = beforeCutoff.api.createView(beforeRoot);
  beforeView.setVisible(true);
  await beforeCutoff.tick();
  assert.equal(beforeCutoff.calls.length, 2, "old saved hourly attempt becomes due under the temporary ten-minute interval");
  assert.ok(beforeCutoff.calls.every((url) => !/[?&](t|time|cache|v)=/.test(url)), "weather requests do not add cache-busting parameters");
  beforeView.destroy();

  const atCutoff = harness({
    attemptedAt: CUTOFF - TEN_MINUTES - 1,
    metadata: { timeZone: "America/New_York", hourlyUrl: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", expiresAt: CUTOFF + HOUR },
  }, { start: CUTOFF });
  const cutoffRoot = new Element();
  const cutoffView = atCutoff.api.createView(cutoffRoot);
  cutoffView.setVisible(true);
  await atCutoff.tick();
  assert.equal(atCutoff.calls.length, 0, "at the cutoff the hourly cadence applies");
  cutoffView.destroy();

  const cutoffClock = harness({
    attemptedAt: CUTOFF - 5 * 60000,
    metadata: { timeZone: "America/New_York", hourlyUrl: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", expiresAt: CUTOFF + HOUR },
  }, { start: CUTOFF - 5 * 60000 });
  const cutoffClockRoot = new Element();
  const cutoffClockView = cutoffClock.api.createView(cutoffClockRoot);
  cutoffClockView.setVisible(true);
  await cutoffClock.tick();
  assert.equal(cutoffClock.calls.length, 0);
  cutoffClock.time(CUTOFF);
  await cutoffClock.tick();
  assert.equal(cutoffClock.calls.length, 0, "cutoff timer switches cadence without an extra early request");
  const nextHourly = CUTOFF + HOUR - 5 * 60000;
  assert.ok([...cutoffClock.timers.values()].some((timer) => timer.at === nextHourly), "open view schedules the next hourly attempt after cutoff");
  cutoffClock.time(nextHourly);
  await cutoffClock.tick();
  assert.equal(cutoffClock.calls.length, 2, "hourly refresh resumes automatically without reload");
  cutoffClockView.destroy();

  const failureBackoff = harness({
    attemptedAt: START - TEN_MINUTES,
    metadata: { timeZone: "America/New_York", hourlyUrl: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", expiresAt: START + HOUR },
    observation: { ...h.observation },
  });
  const failureRoot = new Element();
  const failureView = failureBackoff.api.createView(failureRoot);
  failureBackoff.mode("fail");
  failureView.setVisible(true);
  await failureBackoff.tick();
  assert.equal(failureBackoff.calls.length, 2);
  assert.match(failureRoot.text(), /50°F/);
  assert.match(failureRoot.text(), /Refresh unavailable/);
  failureBackoff.time(START + TEN_MINUTES - 1);
  await failureBackoff.tick();
  assert.equal(failureBackoff.calls.length, 2, "ordinary network failure waits for the full ten-minute interval");
  failureBackoff.time(START + TEN_MINUTES);
  await failureBackoff.tick();
  assert.equal(failureBackoff.calls.length, 4, "ordinary network failure retries when its normal deadline arrives");
  failureView.destroy();

  for (const modeName of ["retry-after-seconds", "retry-after-date"]) {
    const retry = harness({
      attemptedAt: START - TEN_MINUTES,
      metadata: { timeZone: "America/New_York", hourlyUrl: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", expiresAt: START + HOUR },
      observation: { ...h.observation },
    });
    const retryRoot = new Element();
    const retryView = retry.api.createView(retryRoot);
    retry.mode(modeName);
    retryView.setVisible(true);
    await retry.tick();
    const retainedTime = JSON.parse(retry.storage.get("457-property-weather-v1")).observation.timestamp;
    assert.equal(retainedTime, h.observation.timestamp, "HTTP failure retains the original observation");
    retry.time(START + TEN_MINUTES);
    await retry.tick();
    assert.equal(retry.calls.length, 2, `${modeName} is not retried at the normal ten-minute deadline`);
    retry.mode("ok");
    retry.time(START + 20 * 60000);
    await retry.tick();
    assert.equal(retry.calls.length, 4, `${modeName} retries when Retry-After is due`);
    retryView.destroy();
  }

  const deniedStorage = harness({}, { storageDenied: true });
  const deniedRoot = new Element();
  const deniedView = deniedStorage.api.createView(deniedRoot);
  deniedView.setVisible(true);
  await deniedStorage.tick();
  assert.match(deniedRoot.text(), /50°F/, "weather remains visible when storage access is denied");
  assert.equal(deniedStorage.calls.length, 3);
  deniedView.destroy();

  const aging = harness({
    attemptedAt: START,
    metadata: { timeZone: "America/New_York" },
    observation: { timestamp: new Date(START - 2 * HOUR + 1000).toISOString() },
  });
  const agingRoot = new Element();
  const agingView = aging.api.createView(agingRoot);
  agingView.setVisible(true);
  await aging.tick();
  aging.time(START + 1001);
  await aging.tick();
  assert.match(agingRoot.text(), /stale/);
  assert.equal(aging.calls.length, 0, "Age transition renders without an early network refresh");
  agingView.destroy();

  const forecastClock = harness({
    attemptedAt: CUTOFF + HOUR / 3 - TEN_MINUTES,
    periods: [
      { startTime: new Date(CUTOFF + HOUR / 3 + HOUR).toISOString(), endTime: new Date(CUTOFF + HOUR / 3 + 2.5 * HOUR).toISOString(), temperature: 50, temperatureUnit: "F" },
      { startTime: new Date(CUTOFF + HOUR / 3 + 2.5 * HOUR).toISOString(), endTime: new Date(CUTOFF + HOUR / 3 + 3.5 * HOUR).toISOString(), temperature: 60, temperatureUnit: "F" },
    ],
  }, { start: CUTOFF + HOUR / 3 });
  const forecastRoot = new Element();
  const forecastView = forecastClock.api.createView(forecastRoot);
  forecastView.setVisible(true);
  await forecastClock.tick();
  assert.match(forecastRoot.text(), /50°F/);
  forecastClock.time(CUTOFF + HOUR / 3 + 31 * 60000);
  await forecastClock.tick();
  assert.match(forecastRoot.text(), /60°F/);
  assert.doesNotMatch(forecastRoot.text(), /50°F/);
  assert.equal(forecastClock.calls.length, 0, "Forecast target crossing rerenders before hourly refresh without fetching");
  forecastView.destroy();

  async function renderedFixture(observation, periods = []) {
    const fixture = harness({ attemptedAt: START, observation, periods });
    const root = new Element();
    const view = fixture.api.createView(root);
    view.setVisible(true);
    await fixture.tick();
    view.destroy();
    assert.equal(fixture.calls.length, 0);
    return root;
  }
  const observed = { ...h.observation, timestamp: new Date(START).toISOString() };
  for (const [from, travel] of [[0, 180], [90, 270], [180, 0], [270, 90], [202.5, 22.5]]) {
    const root = await renderedFixture({ ...observed, windDirection: { value: from, unitCode: "wmoUnit:degree_(angle)" }, windGust: { value: 15, unitCode: "wmoUnit:mi_h-1" } });
    assert.equal(root.all(classIs("weather-wind-arrow"))[0].attributes["data-travel-bearing"], String(travel));
    assert.match(root.all(classIs("weather-wind-gust"))[0].text(), /gusts 15 mph/);
  }
  for (const [value, expected] of [[null, null], [0, null], [-1, null], [NaN, null], [25.4, "1.00 in"], [0.01, "<0.01 in"]]) {
    const root = await renderedFixture({ ...observed, precipitationLastHour: { value, unitCode: "wmoUnit:mm" } });
    const rows = root.all(classIs("weather-observed-precipitation"));
    assert.equal(rows.length, expected ? 1 : 0);
    if (expected) assert.match(rows[0].text(), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const zeroWind = await renderedFixture({ ...observed, windSpeed: { value: 0, unitCode: "wmoUnit:mi_h-1" } });
  assert.equal(zeroWind.all(classIs("weather-wind-arrow")).length, 0);
  assert.match(zeroWind.text(), /Calm/);
  for (const direction of [null, { value: null, unitCode: "wmoUnit:degree_(angle)" }, { value: 315, unitCode: "unknown" }]) {
    const root = await renderedFixture({ ...observed, windDirection: direction });
    assert.equal(root.all(classIs("weather-wind-arrow")).length, 0);
    assert.match(root.text(), /direction unavailable/);
  }
  const variableForecast = await renderedFixture(observed, [{ ...h.periods[0], windSpeed: "10 mph", windDirection: "VRB" }]);
  assert.equal(variableForecast.all(classIs("weather-forecast"))[0].all(classIs("weather-wind-arrow")).length, 0);
  assert.match(variableForecast.all(classIs("weather-forecast"))[0].text(), /direction unavailable/);
  const ranged = await renderedFixture(observed, [{ ...h.periods[0], windSpeed: "5 to 10 mph", windDirection: "SSW" }]);
  const forecastWind = ranged.all(classIs("weather-forecast"))[0].all(classIs("weather-wind"))[0];
  assert.match(forecastWind.attributes["aria-label"], /5–10 mph from SSW/);
  assert.equal(forecastWind.all(classIs("weather-wind-arrow"))[0].attributes["data-travel-bearing"], "22.5");
  assert.match(forecastWind.all(classIs("weather-wind-speed"))[0].text(), /5–10\s+mph/);
  const unsafe = await renderedFixture({ ...observed, textDescription: "<img src=x onerror=alert(1)>", icon: null });
  assert.equal(unsafe.all(classIs("weather-condition-icon")).length, 0);
  assert.match(unsafe.all(classIs("weather-condition-text"))[0].text(), /<img src=x onerror=alert\(1\)>/);
  const separateConditions = await renderedFixture({ ...observed, textDescription: "Unknown", icon: null }, [{ ...h.periods[0], shortForecast: "Sunny", isDaytime: true }]);
  assert.equal(separateConditions.all(classIs("weather-current"))[0].all(classIs("weather-condition-icon")).length, 0, "Forecast never supplies the observed condition icon");
  assert.equal(separateConditions.all(classIs("weather-forecast"))[0].all(classIs("weather-condition-icon"))[0].attributes["data-condition"], "clear-day");
  const expired = await renderedFixture({ ...observed, timestamp: new Date(START - 7 * HOUR).toISOString() });
  assert.match(expired.text(), /Current conditions unavailable/);
  assert.equal(expired.all(classIs("weather-condition-icon")).length, 0);
  assert.equal(expired.all(classIs("weather-wind-arrow")).length, 0);

  function windSubscriptionFixture(observation, now = START, attemptedAt = now) {
    const fixture = harness({
      attemptedAt,
      metadata: { timeZone: "America/New_York", hourlyUrl: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", expiresAt: now + HOUR },
      observation,
    }, { start: now });
    const snapshots = [];
    const subscription = fixture.api.createWindSubscription((snapshot) => snapshots.push(snapshot));
    return { fixture, snapshots, subscription };
  }

  const windObservation = {
    ...observed,
    windSpeed: { value: 8.04672, unitCode: "wmoUnit:km_h-1" },
    windDirection: { value: 202.5, unitCode: "wmoUnit:degree_(angle)" },
  };
  const windOnly = windSubscriptionFixture(windObservation);
  assert.equal(windOnly.fixture.calls.length, 0, "Creating a hidden wind subscription does not fetch");
  assert.equal(windOnly.fixture.timers.size, 0, "A hidden wind subscription does not schedule refreshes");
  windOnly.subscription.setVisible(true);
  assert.equal(windOnly.fixture.calls.length, 0, "Current cached weather is shared without an extra request");
  let windSnapshot = windOnly.snapshots.at(-1);
  assert.equal(windSnapshot.state, "current");
  assert.equal(windSnapshot.speedMph, 5, "Snapshot reuses shared speed unit conversion");
  assert.equal(windSnapshot.directionFrom, "SSW");
  assert.equal(windSnapshot.travelBearing, 22.5);
  assert.equal(windSnapshot.station, "Glens Falls airport (KGFL)");
  assert.equal(windSnapshot.observedAt, windObservation.timestamp, "Snapshot preserves the observation timestamp");
  assert.equal(windSnapshot.observationTime, windOnly.fixture.api.localTime(windObservation.timestamp, "America/New_York"));
  assert.equal(windOnly.fixture.timers.size, 1, "Visible weather consumers share one refresh/aging timer");
  const visibleCount = windOnly.snapshots.length;
  windOnly.subscription.setVisible(false);
  assert.equal(windOnly.fixture.timers.size, 0, "Minimized wind releases weather demand");
  assert.equal(windOnly.snapshots.length, visibleCount, "Hidden wind receives no further snapshot updates");
  windOnly.subscription.setVisible(true);
  assert.equal(windOnly.snapshots.length, visibleCount + 1, "Reopening resumes the requested wind subscription");
  windOnly.subscription.destroy();
  assert.equal(windOnly.fixture.timers.size, 0);

  for (const [from, direction, travel] of [
    [0, "N", 180], [90, "E", 270], [180, "S", 0], [270, "W", 90], [360, "N", 180],
  ]) {
    const cardinal = windSubscriptionFixture({
      ...windObservation,
      windDirection: { value: from, unitCode: "wmoUnit:degree_(angle)" },
    });
    cardinal.subscription.setVisible(true);
    windSnapshot = cardinal.snapshots.at(-1);
    assert.equal(windSnapshot.directionFrom, direction);
    assert.equal(windSnapshot.travelBearing, travel, `Snapshot reverses wind-from bearing ${from} to travel bearing`);
    cardinal.subscription.destroy();
  }

  const calmSnapshot = windSubscriptionFixture({
    ...windObservation, windSpeed: { value: 0, unitCode: "wmoUnit:mi_h-1" },
  });
  calmSnapshot.subscription.setVisible(true);
  assert.equal(calmSnapshot.snapshots.at(-1).speedMph, 0);
  assert.equal(calmSnapshot.snapshots.at(-1).travelBearing, null, "Calm conditions have no directional arrow");
  calmSnapshot.subscription.destroy();

  const variableSnapshot = windSubscriptionFixture({ ...windObservation, windDirection: null });
  variableSnapshot.subscription.setVisible(true);
  assert.equal(variableSnapshot.snapshots.at(-1).directionFrom, "", "Missing or variable direction never defaults north");
  assert.equal(variableSnapshot.snapshots.at(-1).travelBearing, null);
  variableSnapshot.subscription.destroy();

  const staleSnapshot = windSubscriptionFixture({
    ...windObservation, timestamp: new Date(START - 2 * HOUR - 1).toISOString(),
  });
  staleSnapshot.subscription.setVisible(true);
  assert.equal(staleSnapshot.snapshots.at(-1).state, "stale");
  assert.equal(staleSnapshot.snapshots.at(-1).speedMph, null, "Stale readings cannot supply an active arrow");
  assert.equal(staleSnapshot.snapshots.at(-1).travelBearing, null);
  staleSnapshot.subscription.destroy();

  const unavailableSnapshot = windSubscriptionFixture({
    ...windObservation, timestamp: new Date(START - 6 * HOUR - 1).toISOString(),
  });
  unavailableSnapshot.subscription.setVisible(true);
  assert.equal(unavailableSnapshot.snapshots.at(-1).state, "unavailable");
  assert.equal(unavailableSnapshot.snapshots.at(-1).travelBearing, null);
  unavailableSnapshot.subscription.destroy();

  const agingWind = windSubscriptionFixture({
    ...windObservation, timestamp: new Date(START - 2 * HOUR + 1000).toISOString(),
  });
  agingWind.subscription.setVisible(true);
  assert.equal(agingWind.snapshots.at(-1).state, "current");
  agingWind.fixture.time(START + 1001);
  await agingWind.fixture.tick();
  assert.equal(agingWind.snapshots.at(-1).state, "stale", "Wind-only consumer updates freshness without a fetch");
  assert.equal(agingWind.fixture.calls.length, 0);
  agingWind.subscription.destroy();

  const hiddenWind = windSubscriptionFixture({
    ...windObservation, timestamp: new Date(START - 2 * HOUR + 1000).toISOString(),
  });
  hiddenWind.subscription.setVisible(true);
  const visibleSnapshots = hiddenWind.snapshots.length;
  hiddenWind.fixture.document.hidden = true;
  hiddenWind.fixture.visibility();
  assert.equal(hiddenWind.fixture.timers.size, 0, "Hiding the document suspends the shared wind scheduler");
  hiddenWind.fixture.time(START + 1002);
  await hiddenWind.fixture.tick();
  assert.equal(hiddenWind.snapshots.length, visibleSnapshots, "A hidden wind consumer does not receive clock updates");
  assert.equal(hiddenWind.fixture.calls.length, 0, "A hidden wind consumer does not poll");
  hiddenWind.fixture.document.hidden = false;
  hiddenWind.fixture.visibility();
  assert.equal(hiddenWind.snapshots.at(-1).state, "stale", "Returning to the document refreshes the wind freshness snapshot");
  assert.equal(hiddenWind.fixture.calls.length, 0, "Resume uses the existing still-current fetch window");
  hiddenWind.subscription.destroy();

  const unavailableAging = windSubscriptionFixture({
    ...windObservation, timestamp: new Date(START - 6 * HOUR + 1000).toISOString(),
  });
  unavailableAging.subscription.setVisible(true);
  assert.equal(unavailableAging.snapshots.at(-1).state, "stale");
  unavailableAging.fixture.time(START + 1001);
  await unavailableAging.fixture.tick();
  assert.equal(unavailableAging.snapshots.at(-1).state, "unavailable", "Wind-only consumer also ages stale observations out");
  assert.equal(unavailableAging.fixture.calls.length, 0);
  unavailableAging.subscription.destroy();

  const retainedWind = windSubscriptionFixture(windObservation, START, START - TEN_MINUTES);
  const retainedSnapshots = retainedWind.snapshots;
  retainedWind.fixture.mode("fail");
  retainedWind.subscription.setVisible(true);
  await retainedWind.fixture.tick();
  windSnapshot = retainedSnapshots.at(-1);
  assert.equal(windSnapshot.state, "current");
  assert.equal(windSnapshot.travelBearing, 22.5, "A failed refresh may retain a still-current arrow");
  assert.equal(windSnapshot.observedAt, windObservation.timestamp, "Failed refresh keeps the original observation time");
  assert.equal(windSnapshot.refreshFailed, true, "The retained arrow carries refresh-failure status");
  retainedWind.subscription.destroy();

  const coexist = harness();
  const weatherRoot = new Element();
  const weatherView = coexist.api.createView(weatherRoot);
  const sharedSnapshots = [];
  const compassWind = coexist.api.createWindSubscription((snapshot) => sharedSnapshots.push(snapshot));
  weatherView.setVisible(true);
  compassWind.setVisible(true);
  await coexist.tick();
  assert.equal(coexist.calls.length, 3, "Weather panel and wind-only compass share the same three requests");
  assert.equal(coexist.timers.size, 1, "Coexisting weather views share one lifecycle timer");
  assert.equal(sharedSnapshots.at(-1).travelBearing, 135);
  compassWind.destroy();
  weatherView.destroy();
  assert.equal(coexist.timers.size, 0);

  const pendingWind = harness();
  const pendingSnapshots = [];
  const pendingSubscription = pendingWind.api.createWindSubscription((snapshot) => pendingSnapshots.push(snapshot));
  pendingWind.mode("hold-observation");
  pendingSubscription.setVisible(true);
  await pendingWind.tick();
  assert.ok(pendingWind.calls.some((url) => url.includes("observations/latest")));
  const pendingCount = pendingSnapshots.length;
  pendingSubscription.destroy();
  pendingWind.releaseHeldObservation();
  await pendingWind.tick();
  assert.equal(pendingSnapshots.length, pendingCount, "A late response after wind is turned off cannot update or reopen it");
  assert.equal(pendingWind.timers.size, 0);

  console.log("Weather runtime checks passed: shared fetch/scheduler, wind subscription lifecycle, unit/direction/freshness states, failure retention, visibility, and aging.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
