// format: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {};
  const keys = new Set([]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown format state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown format state: ' + key); featureState[key] = value; return value; }
const markets = { sh: "沪市主板", sz: "深市主板", gem: "创业板", star: "科创板", bj: "北交所", SH: "沪市主板", SZ: "深市主板", GEM: "创业板", STAR: "科创板", BJ: "北交所" };
const icons = { search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>', calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M8 3v4m8-4v4m-8 7 2 2 4-4"/></svg>', arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>' };
function escapeHTML(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }

function textValue(value) { return value === undefined || value === null || value === "" ? "—" : String(value); }

function numberValue(value, digits = 0) { if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return "—"; return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }

function marketValue(value) { return markets[value] || features.format.textValue(value); }

function dateLabel(value) { return value ? String(value).replaceAll("-", ".") : "—"; }

function debounce(fn, delay = 250) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }

function emptyHTML(title, description, icon = "search") { return `<div class="empty-state">${icons[icon]}<h4>${features.format.escapeHTML(title)}</h4><p>${features.format.escapeHTML(description)}</p></div>`; }

function loadingHTML() { return '<div class="loading-state" aria-label="正在加载"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>'; }

  const bindings = {

};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, escapeHTML, textValue, numberValue, marketValue, dateLabel, debounce, emptyHTML, loadingHTML, markets, icons };
}
