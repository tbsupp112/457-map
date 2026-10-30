"use strict";

// Execute provider logic with controlled time/network/storage; no external requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "weather.js"), "utf8");
const HOUR = 3600000;
const START = Date.parse("2026-10-27T18:00:00Z");

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

function harness(saved = {}) {
  let now = START;
  let serial = 0;
  let mode = "ok";
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
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  async function fetch(url) {
    calls.push(url);
    if (mode === "fail") throw new Error("offline");
    let data;
    if (mode === "malformed") data = null;
    else if (url.includes("/points/")) data = { properties: { forecastHourly: "https://api.weather.gov/gridpoints/ALY/64,95/forecast/hourly", timeZone: "America/New_York" } };
    else if (url.includes("observations/latest")) data = { properties: observation };
    else data = { properties: { periods } };
    return { ok: true, headers: { get: () => "public, max-age=86400" }, json: async () => data };
  }
  vm.runInNewContext(source, { window, document, fetch, AbortController, Intl, URL, Date: Clock, console });
  return {
    api: window.PropertyWeather, document, calls, storage, timers, observation, periods,
    time: (value) => { now = value; },
    mode: (value) => { mode = value; },
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
    attemptedAt: START + HOUR / 3,
    periods: [
      { startTime: new Date(START + 2 * HOUR).toISOString(), endTime: new Date(START + 3 * HOUR).toISOString(), temperature: 50, temperatureUnit: "F" },
      { startTime: new Date(START + 3 * HOUR).toISOString(), endTime: new Date(START + 4 * HOUR).toISOString(), temperature: 60, temperatureUnit: "F" },
    ],
  });
  forecastClock.time(START + HOUR / 3);
  const forecastRoot = new Element();
  const forecastView = forecastClock.api.createView(forecastRoot);
  forecastView.setVisible(true);
  await forecastClock.tick();
  assert.match(forecastRoot.text(), /50°F/);
  forecastClock.time(START + HOUR);
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
  console.log("Weather runtime checks passed: units/nulls, timestamp selection, stale boundaries, shared cache, failures, visibility, aging.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
