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
  constructor() {
    this.children = [];
    this.textContent = "";
    this.classList = { add() {}, toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  text() { return [this.textContent, ...this.children.map((child) => child.text())].join(" "); }
}

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
    createElement: () => new Element(),
    addEventListener: (name, fn) => listeners.set(fn, name),
    removeEventListener: (name, fn) => listeners.delete(fn),
  };
  const observation = {
    timestamp: new Date(START - HOUR / 2).toISOString(),
    temperature: { value: 10, unitCode: "wmoUnit:degC" },
    windSpeed: { value: 16.09344, unitCode: "wmoUnit:km_h-1" },
    windDirection: { value: 315, unitCode: "wmoUnit:degree_(angle)" },
    precipitationLastHour: { value: null, unitCode: "wmoUnit:mm" },
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
  assert.match(first.text(), /10 mph from NW/);
  assert.match(first.text(), /Previous-hour precipitation: Unavailable/);
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
  console.log("Weather runtime checks passed: units/nulls, timestamp selection, stale boundaries, shared cache, failures, visibility, aging.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
