// preferences: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {};
  const keys = new Set([]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown preferences state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown preferences state: ' + key); featureState[key] = value; return value; }
const RECENT_STOCKS_KEY = "limit-up-archive.recent-stocks.v1";
const RELATION_HEIGHT_KEY = "limit-up-archive.relation-height.v1";
function normalizeRelationHeight(value) {
  const height = Number(value);
  return String(value ?? "").trim() && Number.isFinite(height) ? Math.min(1600, Math.max(600, Math.round(height))) : 880;
}

function readRelationHeight() {
  try { return features.preferences.normalizeRelationHeight(localStorage.getItem(RELATION_HEIGHT_KEY)); }
  catch { return 880; }
}

function applyRelationHeight(value, remember = true) {
  const height = features.preferences.normalizeRelationHeight(value);
  $("relation-height").value = String(height);
  $("stock-relations").style.setProperty("--relation-height", `${height}px`);
  if (remember) { try { localStorage.setItem(RELATION_HEIGHT_KEY, String(height)); } catch {} }
}

function normalizeRecentStocks(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter(stock => {
    if (!stock || typeof stock.code !== "string" || !/^\d{6}$/.test(stock.code) || typeof stock.name !== "string" || !stock.name.trim() || stock.name.length > 80 || seen.has(stock.code)) return false;
    seen.add(stock.code);
    return true;
  }).slice(0, 10).map(stock => ({code: String(stock.code), name: stock.name.trim()}));
}

function readRecentStocks() {
  try { return features.preferences.normalizeRecentStocks(JSON.parse(localStorage.getItem(RECENT_STOCKS_KEY) || "[]")); }
  catch { return []; }
}

  const bindings = {

};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, normalizeRelationHeight, readRelationHeight, applyRelationHeight, normalizeRecentStocks, readRecentStocks, RECENT_STOCKS_KEY, RELATION_HEIGHT_KEY };
}
