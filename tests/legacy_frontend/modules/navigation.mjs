// navigation: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {tab: "date"};
  const keys = new Set(["tab"]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown navigation state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown navigation state: ' + key); featureState[key] = value; return value; }

function updateURL({replace = false} = {}) {
  const params = new URLSearchParams();
  const queryDate = featureState.tab === "intraday" ? features.intraday.read("intradayDate") : $("trade-date").value;
  if (queryDate) params.set("date", queryDate);
  if (featureState.tab === "intraday") {
    params.set("view", "intraday");
    if (features.intraday.read("intradayCode")) params.set("minute_code", features.intraday.read("intradayCode"));
    if (features.intraday.read("minuteCompareCodes")?.length) params.set("minute_compare", features.intraday.read("minuteCompareCodes").join(","));
    if ($("minute-timeline-exclude-gem").checked === false) params.set("timeline_gem", "1");
  }
  if (featureState.tab === "stock" && features.stock.read("selectedStock")) {
    params.set("code", features.stock.read("selectedStock").code);
  } else if (features.daily.read("boards")) params.set("boards", features.daily.read("boards"));
  if (featureState.tab === "blacklist") params.set("view", "blacklist");
  if (featureState.tab === "tags") { params.set("view", "tags"); if (features.tags.read("tagManagerName")) params.set("tag", features.tags.read("tagManagerName")); }
  if (["region", "pinyin", "code"].includes(features.daily.read("grouping"))) params.set("layout", features.daily.read("grouping"));
  if (features.daily.read("excludeST")) params.set("exclude_st", "1");
  if (features.daily.read("excludeGEM")) params.set("exclude_gem", "1");
  if (features.stock.read("relationExcludeST")) params.set("relation_exclude_st", "1");
  if (features.stock.read("relationExcludeGEM")) params.set("relation_exclude_gem", "1");
  if (features.stock.read("relationExcludeLatest")) params.set("relation_exclude_latest", "1");
  const url = `${location.pathname}${params.size ? `?${params}` : ""}`;
  if (url === `${location.pathname}${location.search}`) return;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

function setView(view, update = true) {
  if (featureState.tab !== view) {
    ["date", "stock", "blacklist", "intraday", "tags"].filter(channel => channel !== view).forEach(channel => features.api.channels[channel]?.abort());
    if (view !== "tags") { features.api.channels["tag-members"]?.abort(); features.api.channels["tag-manager-search"]?.abort(); }
    if (view !== "intraday") {
      features.api.channels["intraday-stock"]?.abort();
      if (typeof features.intraday.stopMinuteTimelineCollection === "function") features.intraday.stopMinuteTimelineCollection(false);
      Object.keys(features.api.channels).filter(channel => channel.startsWith("minute-compare-")).forEach(channel => features.api.channels[channel]?.abort());
    }
  }
  featureState.tab = view;
  document.documentElement.classList.toggle("stock-mode", view === "stock");
  $("stock-summary").hidden = view !== "stock";
  if (view !== "stock") { features.api.channels.comparison?.abort(); features.api.channels.relations?.abort(); }
  const blacklist = view === "blacklist";
  const tags = view === "tags";
  const minutes = view === "intraday";
  $("stock-sticky").hidden = blacklist || minutes || tags;
  $("date-view").hidden = view !== "date";
  $("stock-view").hidden = view !== "stock";
  $("blacklist-view").hidden = !blacklist;
  $("tag-management-view").hidden = !tags;
  $("intraday-view").hidden = !minutes;
  $("search-workspace").hidden = blacklist || minutes || tags;
  $("archive-range").hidden = blacklist || minutes || tags;
  $("page-title").textContent = tags ? "标签管理" : minutes ? "主板分时" : blacklist ? "黑名单" : "连板档案";
  $("page-description").textContent = tags ? "查看全部标签，管理所属股票，统一改名与合并。" : minutes ? "查看沪深主板分时、成交量与竞价，对比不同股票的走势。" : blacklist ? "管理你的黑名单股票，名单中的每一只都持续有效。" : "从交易日看市场高度，从个股看连板轨迹。";
  $("breadcrumb-page").textContent = tags ? "标签管理" : minutes ? "主板分时" : blacklist ? "黑名单" : "历史连板";
  ["nav-search", "nav-blacklist", "nav-intraday", "nav-tags"].forEach(id => {
    const active = id === "nav-tags" ? tags : id === "nav-intraday" ? minutes : id === "nav-blacklist" ? blacklist : !minutes && !blacklist && !tags;
    $(id).classList.toggle("active", active);
    if (active) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  });
  if (blacklist || minutes || tags) {
    features.api.channels.search?.abort();
    features.api.channels["stock-resolve"]?.abort();
    features.stock.hideSuggestions();
  } else {
    features.api.channels["blacklist-search"]?.abort();
    features.blacklist.hideBlacklistSuggestions();
  }
  $("stock-query-button").disabled = false;
  features.shell.clearError();
  if (update) features.navigation.updateURL();
}

async function restoreFromURL({remember = false} = {}) {
  features.api.channels.search?.abort();
  features.api.channels["stock-resolve"]?.abort();
  features.stock.write("stockGeneration", (features.stock.read("stockGeneration") || 0) + 1);
  features.stock.write("suggestions", []);
  features.stock.write("suggestionsQuery", "");
  features.stock.hideSuggestions();
  $("stock-search").setCustomValidity("");
  const params = new URLSearchParams(location.search);
  features.daily.write("grouping", ["region", "pinyin", "code"].includes(params.get("layout")) ? params.get("layout") : "industry");
  features.daily.write("excludeST", params.get("exclude_st") === "1");
  $("exclude-st").checked = features.daily.read("excludeST");
  features.daily.write("excludeGEM", params.get("exclude_gem") === "1");
  $("exclude-gem").checked = features.daily.read("excludeGEM");
  features.stock.write("relationExcludeST", params.get("relation_exclude_st") === "1");
  $("relation-exclude-st").checked = features.stock.read("relationExcludeST");
  features.stock.write("relationExcludeGEM", params.get("relation_exclude_gem") === "1");
  $("relation-exclude-gem").checked = features.stock.read("relationExcludeGEM");
  features.stock.write("relationExcludeLatest", params.get("relation_exclude_latest") === "1");
  $("relation-exclude-latest").checked = features.stock.read("relationExcludeLatest");
  $("trade-date").value = params.get("date") || features.shell.read("meta").query_dates?.at(-1) || features.shell.read("meta").latest_date || features.shell.read("meta").dates.at(-1) || "";
  const boards = Number(params.get("boards"));
  features.daily.write("boards", Number.isSafeInteger(boards) && boards > 0 ? String(boards) : "");
  const view = params.get("view") === "tags" ? "tags" : params.get("view") === "intraday" ? "intraday" : params.get("view") === "blacklist" ? "blacklist" : params.get("code") ? "stock" : "date";
  if (view === "tags") features.tags.write("tagManagerName", params.get("tag") || "");
  if (view === "intraday") {
    $("minute-timeline-exclude-gem").checked = params.get("timeline_gem") !== "1";
    features.intraday.write("intradayDate", params.get("date") || "");
    features.intraday.write("intradayCode", params.get("minute_code") || "");
    features.intraday.write("minuteCompareCodes", [...new Set((params.get("minute_compare") || "").split(",").filter(code => /^\d{6}$/.test(code)))]);
    $("minute-search").value = "";
    $("minute-compare-search").value = "";
  }
  features.stock.write("selectedStock", view === "stock" ? {code: params.get("code"), name: ""} : null);
  $("stock-search").value = features.stock.read("selectedStock")?.code || "";
  features.daily.renderBoardOptions();
  features.daily.updateDateNavigation();
  features.navigation.setView(view, false);
  // Initial loads and history traversal may normalize a URL, but never add a visit.
  features.navigation.updateURL({replace: true});
  if (view === "intraday") await features.intraday.loadIntraday();
  else if (view === "tags") await features.tags.loadTagManager();
  else if (view === "blacklist") await features.blacklist.loadBlacklist();
  else if (view === "stock") await features.stock.loadStock({remember});
  else await features.daily.loadDate();
}

  const bindings = {
binding013() {
$("nav-search").addEventListener("click", () => {
  if (!["date", "stock"].includes(featureState.tab)) { if (features.stock.read("selectedStock")) features.stock.loadStock({remember: false}); else features.daily.loadDate(); }
  $("search-workspace").scrollIntoView({ block: "center" }); $("stock-search").focus();
});
},
binding014() {
$("nav-blacklist").addEventListener("click", () => { features.blacklist.loadBlacklist(); $("main").scrollIntoView({block: "start"}); });
},
binding015() {
$("nav-tags").addEventListener("click", () => { features.tags.loadTagManager(); $("main").scrollIntoView({block: "start"}); });
},
binding018() {
$("nav-intraday").addEventListener("click", () => { features.intraday.loadIntraday(); $("main").scrollIntoView({block: "start"}); });
},
binding138() {
window.addEventListener("popstate", () => { if (features.shell.read("meta")) return features.navigation.restoreFromURL(); });
}
};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, updateURL, setView, restoreFromURL };
}
