// api: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {};
  const keys = new Set([]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown api state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown api state: ' + key); featureState[key] = value; return value; }

async function request(path, channel, options = {}) {
  features.api.channels[channel]?.abort();
  const controller = new AbortController();
  features.api.channels[channel] = controller;
  const timeout = setTimeout(() => controller.abort("timeout"), 30000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal, headers: { Accept: "application/json", ...options.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || data?.message || `服务器返回 ${response.status}`);
    if (!data) throw new Error("服务器未返回有效的数据。");
    return data;
  } catch (error) {
    if (controller.signal.reason === "timeout") throw new Error("查询时间超过 30 秒，请稍后重新加载。");
    if (error.name === "AbortError") return null;
    throw error;
  } finally { clearTimeout(timeout); }
}

  const bindings = {

};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, request, channels: {} };
}
