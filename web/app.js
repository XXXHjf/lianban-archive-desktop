"use strict";

const $ = (id) => document.getElementById(id);
const state = { meta: null, tab: "date", grouping: "industry", boards: "", excludeST: false, excludeGEM: false, relationExcludeST: false, relationExcludeGEM: false, relationExcludeLatest: false, dateData: null, stockData: null, selectedStock: null, suggestions: [], suggestionIndex: -1, retry: null, requests: {}, relationPeers: [], relationPeerCode: "", relationQuery: "", relationSort: "commonCount", relationSortDirection: "desc" };
const markets = { sh: "沪市主板", sz: "深市主板", gem: "创业板", star: "科创板", bj: "北交所", SH: "沪市主板", SZ: "深市主板", GEM: "创业板", STAR: "科创板", BJ: "北交所" };
const icons = { search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>', calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M8 3v4m8-4v4m-8 7 2 2 4-4"/></svg>', arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>' };

function escapeHTML(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function textValue(value) { return value === undefined || value === null || value === "" ? "—" : String(value); }
function numberValue(value, digits = 0) { if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return "—"; return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
const RECENT_STOCKS_KEY = "limit-up-archive.recent-stocks.v1";
const RELATION_HEIGHT_KEY = "limit-up-archive.relation-height.v1";
function normalizeRelationHeight(value) {
  const height = Number(value);
  return String(value ?? "").trim() && Number.isFinite(height) ? Math.min(1600, Math.max(600, Math.round(height))) : 880;
}
function readRelationHeight() {
  try { return normalizeRelationHeight(localStorage.getItem(RELATION_HEIGHT_KEY)); }
  catch { return 880; }
}
function applyRelationHeight(value, remember = true) {
  const height = normalizeRelationHeight(value);
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
  try { return normalizeRecentStocks(JSON.parse(localStorage.getItem(RECENT_STOCKS_KEY) || "[]")); }
  catch { return []; }
}
function renderRecentStocks() {
  $("recent-stock-list").innerHTML = (state.recentStocks || []).map(stock => `<button type="button" class="recent-stock" data-recent-code="${escapeHTML(stock.code)}" data-recent-name="${escapeHTML(stock.name)}" title="${escapeHTML(stock.name)} ${escapeHTML(stock.code)} · 查看历史">${escapeHTML(stock.name)}</button>`).join("") || '<span class="recent-stocks-empty">暂无记录</span>';
}
function rememberStock(stock) {
  state.recentStocks = normalizeRecentStocks([stock, ...readRecentStocks(), ...(state.recentStocks || [])]);
  try { localStorage.setItem(RECENT_STOCKS_KEY, JSON.stringify(state.recentStocks)); } catch {}
  renderRecentStocks();
}
function marketValue(value) { return markets[value] || textValue(value); }
function dateLabel(value) { return value ? String(value).replaceAll("-", ".") : "—"; }
function latestLimitUp(row) { return state.latestLimitUps?.has(String(row.code)) || false; }
function prioritizeLatest(rows, historicalOnly = false) {
  return [...rows].sort((a, b) => Number(latestLimitUp(b) && (!historicalOnly || b.date !== state.meta?.latest_date)) - Number(latestLimitUp(a) && (!historicalOnly || a.date !== state.meta?.latest_date)));
}
function latestLimitBadge(row) {
  if (!latestLimitUp(row)) return "";
  const day = state.meta.latest_date;
  return `<span class="latest-limit-badge" title="最新交易日 ${escapeHTML(dateLabel(day))} 涨停 · ${numberValue(state.latestLimitUps.get(String(row.code)))} 板">${escapeHTML(dateLabel(day).slice(5))} 涨停</span>`;
}
function latestPriorityNote() {
  return state.meta?.latest_date ? `<span class="latest-priority-note"><i aria-hidden="true"></i>${escapeHTML(dateLabel(state.meta.latest_date))} 涨停股票高亮置顶</span>` : "";
}
function debounce(fn, delay = 250) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
function emptyHTML(title, description, icon = "search") { return `<div class="empty-state">${icons[icon]}<h4>${escapeHTML(title)}</h4><p>${escapeHTML(description)}</p></div>`; }
function loadingHTML() { return '<div class="loading-state" aria-label="正在加载"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>'; }

async function request(path, channel, options = {}) {
  state.requests[channel]?.abort();
  const controller = new AbortController();
  state.requests[channel] = controller;
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

function showError(error, retry) { $("error-message").textContent = error.message || "无法连接本地服务，请确认服务正在运行。"; $("error-banner").hidden = false; state.retry = retry; }
function clearError() { $("error-banner").hidden = true; state.retry = null; }
function setStats(id, values = {}) { $(id).querySelectorAll("[data-stat]").forEach((element) => { element.textContent = numberValue(values[element.dataset.stat]); }); }
function updateQueryStickyOffset() {
  const query = $("stock-sticky");
  const offset = query.getBoundingClientRect().height + (parseFloat(getComputedStyle(query).top) || 0);
  document.documentElement.style.setProperty("--query-sticky-bottom", `${Math.ceil(offset)}px`);
}
function updateURL({replace = false} = {}) {
  const params = new URLSearchParams();
  if ($("trade-date").value) params.set("date", $("trade-date").value);
  if (state.tab === "stock" && state.selectedStock) {
    params.set("code", state.selectedStock.code);
  } else if (state.boards) params.set("boards", state.boards);
  if (state.tab === "blacklist") params.set("view", "blacklist");
  if (["region", "pinyin", "code"].includes(state.grouping)) params.set("layout", state.grouping);
  if (state.excludeST) params.set("exclude_st", "1");
  if (state.excludeGEM) params.set("exclude_gem", "1");
  if (state.relationExcludeST) params.set("relation_exclude_st", "1");
  if (state.relationExcludeGEM) params.set("relation_exclude_gem", "1");
  if (state.relationExcludeLatest) params.set("relation_exclude_latest", "1");
  const url = `${location.pathname}${params.size ? `?${params}` : ""}`;
  if (url === `${location.pathname}${location.search}`) return;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

function setView(view, update = true) {
  if (state.tab !== view) {
    ["date", "stock", "blacklist"].filter(channel => channel !== view).forEach(channel => state.requests[channel]?.abort());
  }
  state.tab = view;
  document.documentElement.classList.toggle("stock-mode", view === "stock");
  $("stock-summary").hidden = view !== "stock";
  if (view !== "stock") { state.requests.comparison?.abort(); state.requests.relations?.abort(); }
  const blacklist = view === "blacklist";
  $("stock-sticky").hidden = blacklist;
  $("date-view").hidden = view !== "date";
  $("stock-view").hidden = view !== "stock";
  $("blacklist-view").hidden = !blacklist;
  $("search-workspace").hidden = blacklist;
  $("archive-range").hidden = blacklist;
  $("page-title").textContent = blacklist ? "黑名单" : "连板档案";
  $("page-description").textContent = blacklist ? "管理你的黑名单股票，名单中的每一只都持续有效。" : "从交易日看市场高度，从个股看连板轨迹。";
  $("breadcrumb-page").textContent = blacklist ? "黑名单" : "历史连板";
  ["nav-search", "nav-blacklist"].forEach(id => {
    const active = (id === "nav-blacklist") === blacklist;
    $(id).classList.toggle("active", active);
    if (active) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  });
  if (blacklist) {
    state.requests.search?.abort();
    state.requests["stock-resolve"]?.abort();
    hideSuggestions();
  } else {
    state.requests["blacklist-search"]?.abort();
    hideBlacklistSuggestions();
  }
  $("stock-query-button").disabled = false;
  clearError();
  if (update) updateURL();
}

function canEditBlacklist() { return state.meta?.capabilities?.edit_blacklist === true; }
function blacklistError(message = "") {
  $("blacklist-error").textContent = message;
  $("blacklist-error").hidden = !message;
}
function updateBlacklistControls() {
  const editable = canEditBlacklist();
  $("blacklist-add-panel").hidden = !editable;
  $("blacklist-readonly").hidden = editable;
  $("blacklist-add-form").querySelectorAll("input, button").forEach(element => { element.disabled = !editable || Boolean(state.blacklistSaving || state.blacklistLoading); });
  $("blacklist-refresh").disabled = Boolean(state.blacklistSaving || state.blacklistLoading);
  $("blacklist-table-area").querySelectorAll("[data-blacklist-remove]").forEach(button => { button.disabled = !editable || Boolean(state.blacklistSaving || state.blacklistLoading); });
}
function renderBlacklist(data) {
  state.blacklistData = data;
  $("blacklist-count").textContent = numberValue(data.total);
  const editable = canEditBlacklist();
  $("blacklist-table-area").innerHTML = data.rows.length ? `<table class="blacklist-table"><caption class="sr-only">黑名单股票管理列表</caption><thead><tr><th scope="col">股票</th><th scope="col">注册省份</th><th scope="col">行业标签</th><th scope="col">加入时间</th>${editable ? '<th scope="col">操作</th>' : ""}</tr></thead><tbody>${data.rows.map(stock => `<tr><td><button type="button" class="stock-name-button" data-blacklist-code="${escapeHTML(stock.code)}" data-blacklist-name="${escapeHTML(stock.name)}" title="查看${escapeHTML(stock.name)}的历史">${escapeHTML(stock.name)}</button><div class="row-stock-code">${escapeHTML(stock.code)}</div></td><td class="blacklist-province">${escapeHTML(regionLabel(stock))}</td><td><div class="blacklist-tags">${stockTags(stock).map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</div></td><td class="blacklist-created">${escapeHTML(dateLabel(stock.created_at.slice(0, 10)))} <span>${escapeHTML(stock.created_at.slice(11, 16))}</span></td>${editable ? `<td><button type="button" class="blacklist-remove" data-blacklist-remove="${escapeHTML(stock.code)}" aria-label="将${escapeHTML(stock.name)}移出黑名单">移除</button></td>` : ""}</tr>`).join("")}</tbody></table>` : emptyHTML("黑名单还是空的", editable ? "在上方搜索并添加股票，建立你的黑名单。" : "目前没有黑名单股票。");
  updateBlacklistControls();
}
async function loadBlacklist() {
  setView("blacklist");
  if (state.blacklistSaving) return;
  blacklistError();
  const generation = (state.blacklistGeneration || 0) + 1;
  state.blacklistGeneration = generation;
  state.blacklistLoading = true;
  updateBlacklistControls();
  $("blacklist-table-area").setAttribute("aria-busy", "true");
  if (!state.blacklistData) $("blacklist-table-area").innerHTML = loadingHTML();
  try {
    const data = await request("/api/blacklist", "blacklist");
    if (data && state.tab === "blacklist" && state.blacklistGeneration === generation) renderBlacklist(data);
  } catch (error) {
    if (state.tab === "blacklist" && state.blacklistGeneration === generation) {
      blacklistError(error.message);
      if (!state.blacklistData) $("blacklist-table-area").innerHTML = emptyHTML("暂时无法读取黑名单", "请点击「刷新列表」重试。");
    }
  } finally {
    // Only the newest list request may unlock the controls.
    if (state.blacklistGeneration === generation) {
      state.blacklistLoading = false;
      $("blacklist-table-area").setAttribute("aria-busy", "false");
      updateBlacklistControls();
    }
  }
}
function hideBlacklistSuggestions() {
  $("blacklist-suggestions").hidden = true;
  $("blacklist-search").setAttribute("aria-expanded", "false");
  $("blacklist-search").removeAttribute("aria-activedescendant");
  state.blacklistSuggestionIndex = -1;
}
function showBlacklistSuggestions(rows) {
  state.blacklistSuggestions = rows.slice(0, 15);
  state.blacklistSuggestionIndex = -1;
  const codes = new Set((state.blacklistData?.rows || []).map(stock => stock.code));
  $("blacklist-suggestions").innerHTML = state.blacklistSuggestions.map((stock, index) => `<li role="presentation"><button type="button" role="option" aria-selected="false" id="blacklist-suggestion-${index}" data-blacklist-suggestion="${index}"><span class="suggestion-code">${escapeHTML(stock.code)}</span><span>${escapeHTML(stock.name)}</span><span class="suggestion-market">${codes.has(stock.code) ? "已在黑名单" : escapeHTML(marketValue(stock.market))}</span></button></li>`).join("") || '<li role="presentation" class="suggestion-message">未找到已收录的股票，请尝试名称、代码或首字母。</li>';
  $("blacklist-suggestions").hidden = false;
  $("blacklist-search").setAttribute("aria-expanded", "true");
}
function selectBlacklistStock(stock) {
  state.blacklistSelected = stock;
  state.requests["blacklist-search"]?.abort();
  $("blacklist-search").value = `${stock.name} ${stock.code}`;
  hideBlacklistSuggestions();
  blacklistError();
}
async function searchBlacklistStocks() {
  const query = $("blacklist-search").value.trim();
  if (!query || state.blacklistSelected || state.tab !== "blacklist" || state.blacklistSaving) return;
  try {
    const data = await request(`/api/stocks?${new URLSearchParams({q: query})}`, "blacklist-search");
    if (data && state.tab === "blacklist" && !state.blacklistSelected && $("blacklist-search").value.trim() === query) showBlacklistSuggestions(data.rows || []);
  } catch (error) { if (state.tab === "blacklist" && $("blacklist-search").value.trim() === query) blacklistError(error.message); }
}
async function changeBlacklist(action, code = null) {
  if (state.blacklistSaving || state.blacklistLoading || !canEditBlacklist()) return;
  state.blacklistSaving = true;
  blacklistError();
  $("blacklist-feedback").textContent = "";
  updateBlacklistControls();
  try {
    if (action === "add") {
      let stock = state.blacklistSelected;
      if (!stock) {
        const query = $("blacklist-search").value.trim();
        if (!query) throw new Error("请先搜索要添加的股票。");
        const data = await request(`/api/stocks?${new URLSearchParams({q: query})}`, "blacklist-search");
        if (!data || state.tab !== "blacklist") return;
        const rows = data.rows || [];
        const exact = rows.filter(row => row.code === query || row.name === query || row.initials === query.toUpperCase());
        stock = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
        if (!stock) { showBlacklistSuggestions(rows); throw new Error(rows.length ? "请选择一只股票后再加入黑名单。" : "未找到已收录的股票。"); }
      }
      code = stock.code;
    }
    hideBlacklistSuggestions();
    const data = await request("/api/blacklist", "blacklist-save", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code, action})});
    if (!data) return;
    renderBlacklist(data);
    $("blacklist-feedback").textContent = action === "add" ? (data.changed ? "已加入黑名单。" : "这只股票已在黑名单中。") : "已移出黑名单。";
    if (action === "add") { state.blacklistSelected = null; $("blacklist-search").value = ""; }
  } catch (error) { blacklistError(error.message); }
  finally { state.blacklistSaving = false; updateBlacklistControls(); }
}

function renderMeta(meta, initial = false) {
  document.documentElement.classList.toggle("read-only", !canEditTags());
  $("nav-blacklist").disabled = false;
  updateBlacklistControls();
  state.latestLimitUps = new Map((meta.latest_limit_ups || []).map(row => [String(row.code), Number(row.boards)]));
  const coverage = meta.coverage || {};
  const dates = [...new Set(meta.dates || [])].sort();
  meta.dates = dates;
  $("range-label").textContent = `${dateLabel(meta.available_start || meta.range_start)} — ${dateLabel(meta.available_end || meta.range_end)}`;
  $("range-detail").textContent = `${numberValue(coverage.days)} 个有数据交易日 · 本地历史库`;
  const status = String(coverage.status || "").toLowerCase();
  const waitingForLatest = meta.auto_update_status === "waiting" && meta.missing_dates?.length === 1 && meta.missing_dates[0] === meta.auto_update_expected;
  const syncing = ["syncing", "loading", "collecting"].includes(status);
  const source = typeof meta.source === "object" ? (meta.source.name || JSON.stringify(meta.source)) : (meta.source || "公开数据");
  const partial = syncing || (!waitingForLatest && ["partial", "incomplete", "limited", "gaps"].includes(status));
  const unavailable = ["empty", "unavailable", "error"].includes(status) || !dates.length;
  $("coverage-banner").classList.toggle("partial", partial);
  $("coverage-banner").classList.toggle("unavailable", unavailable);
  $("coverage-title").textContent = unavailable ? "历史数据尚未收录" : syncing ? `免费公开数据 · ${source} · 正在归档` : waitingForLatest ? "历史数据持续更新" : partial ? `${source} · 部分覆盖，请留意数据缺口` : status === "complete" ? "历史数据已补齐" : `免费公开数据 · ${source}`;
  $("coverage-note").textContent = status === "complete" || waitingForLatest
    ? `${dateLabel(meta.available_start)} 至 ${dateLabel(meta.available_end)} · ${numberValue(coverage.days)} 个交易日${waitingForLatest ? "" : ` · 缺失日期 ${numberValue((meta.missing_dates || []).length)}`} · 来源：${source}`
    : coverage.note || "按来源公开股票池收录，数据完整性以实际收录情况为准。";
  $("coverage-count").textContent = `${numberValue(coverage.records)} 条记录 / ${numberValue(coverage.stocks)} 只股票`;
  const autoStatus = meta.auto_update_status;
  const checked = meta.auto_update_checked_at ? `${dateLabel(meta.auto_update_checked_at.slice(0, 10))} ${meta.auto_update_checked_at.slice(11, 16)}` : "";
  const pending = meta.auto_update_pending || [];
  const onlyHistoricalGaps = pending.length > 0 && meta.latest_date === meta.auto_update_expected && pending.every(day => day < meta.latest_date);
  const updateSchedule = `交易日 ${meta.auto_update_time || "15:30"} 更新`;
  $("auto-update-note").textContent = autoStatus === "updating"
    ? `自动更新已开启 · ${updateSchedule} · 正在检查并补充数据…`
    : onlyHistoricalGaps
      ? `自动更新已开启 · ${updateSchedule} · 最新收录 ${dateLabel(meta.latest_date)} · ${numberValue(pending.length)} 个历史日期待重试`
    : autoStatus === "error"
      ? `自动更新暂未完成 · ${updateSchedule} · 每 5 分钟自动重试${checked ? ` · 最近检查 ${checked}` : ""}`
      : autoStatus === "waiting"
        ? `自动更新已开启 · ${updateSchedule} · 等待 ${pending.map(dateLabel).join("、")} 来源数据 · 每 5 分钟重试${checked ? ` · 最近检查 ${checked}` : ""}`
        : autoStatus === "current"
          ? `自动更新已开启 · ${updateSchedule} · 最近检查 ${checked}`
          : "自动更新尚未启动，请重新启动本地服务。";
  $("auto-update-note").title = meta.auto_update_error || "按上海时间每个交易日 15:30 起检查当天数据；未发布时每 5 分钟重试，历史缺口继续补充。";
  $("footer-source").textContent = "公开数据";
  $("method-source").textContent = source;
  $("method-note").textContent = `${meta.method_note || "连板高度以数据源提供的收盘涨停记录为准。缺失记录不用于推断股票是否断板。"}${meta.scope_note ? `\n\n${meta.scope_note}` : ""}`;
  $("method-coverage").textContent = `${coverage.note || "以实际收录为准。"}\n已收录 ${numberValue(coverage.days)} 个交易日，${numberValue(coverage.stocks)} 只股票，${numberValue(coverage.records)} 条记录。`;
  $("method-updated").textContent = textValue(meta.updated_at);
  $("trade-date").min = meta.available_start || meta.range_start || "";
  $("trade-date").max = meta.available_end || meta.range_end || "";
  $("latest-date").disabled = !meta.latest_date;

  clearTimeout(state.metaPoll);
  const industryStatus = meta.industry_status || "empty";
  const cached = Boolean(meta.industry_fetched_at);
  $("industry-note").textContent = cached
    ? `行业：申万一级（当前分类） · ${dateLabel(meta.industry_fetched_at.slice(0, 10))} 获取${industryStatus === "updating" ? " · 正在检查更新" : industryStatus === "error" ? " · 更新失败，使用缓存" : ""}`
    : industryStatus === "error" ? "行业暂未获取成功，稍后自动重试。" : "正在自动获取申万行业分类…";
  $("method-note").textContent += "\n\n行业标签默认取自申万一级分类，可按股票添加、修改或移除，手动标签会保存在本地并跟随股票跨日期使用。多个标签会在多个行业列中展示同一只股票，总数按股票去重统计。可恢复默认行业，并随来源更新。这里的标签和注册地均为当前资料。";
  const registrationStatus = meta.registration_status || "empty";
  $("registration-note").textContent = meta.registration_fetched_at
    ? `注册省份：公司当前资料 · ${dateLabel(meta.registration_fetched_at.slice(0, 10))} 获取${registrationStatus === "updating" ? " · 正在检查更新" : registrationStatus === "error" ? " · 更新失败，使用缓存" : ""}`
    : registrationStatus === "error" ? "注册省份暂未获取成功，稍后自动重试。" : "正在自动获取公司注册省份…";
  $("method-note").textContent += "\n\n注册省份来自东方财富公司当前资料的省份字段，仅获取和保存省份。";
  $("method-note").textContent += "\n\n个股历史、同期竞争和同日涨停统一按全部已收录数据的起止日期统计，上方查询日期仅用于当日涨停查询。同期竞争比较前日同板数、下一交易日的晋级情况，沪深主板合并、ST 单独比较。从首板进二板到更高板数都逐轮展示，每个晋级批次计 1 轮胜负，同一轮涉及的对手另行列出；对手名单中的数字为与该股票交手的轮次。赢过和输给的名单均为涨停池比较结果；未入池不代表已确认未涨停，胜负标记为待行情核实。缺失交易日及最新收录日之后的结果不计入胜负。同日涨停统计全市场已收录股票，不限板数，每只股票每天计 1 次，不含本票，并列出具体日期。";
  $("method-note").textContent += "\n\n交易日概览的最高连板包含停牌保留高度。停复牌资料来自东方财富，只有确认全天停牌、且停牌前一交易日有连板记录的股票才保留原高度；不会把停牌日记为涨停，也不会增加涨停家数或同日涨停次数。复牌当日起不再按停牌保留。";
  state.metaPoll = setTimeout(refreshMeta, autoStatus === "updating" || industryStatus === "updating" || registrationStatus === "updating" || meta.suspension_updating ? 3000 : 60000);
}

async function refreshMeta() {
  try {
    const previousIndustry = state.meta?.industry_fetched_at;
    const previousRegistration = state.meta?.registration_fetched_at;
    const previousStart = state.meta?.available_start;
    const previousEnd = state.meta?.available_end;
    const previousRecords = state.meta?.coverage?.records;
    const previousRevision = state.meta?.archive_updated_at;
    const previousLatest = state.meta?.latest_date;
    const previousSuspension = state.meta?.suspension_revision;
    const followingLatest = !$("trade-date").value || $("trade-date").value === previousLatest;
    const meta = await request("/api/meta", "meta");
    if (meta) {
      state.meta = meta; renderMeta(meta); updateDateNavigation();
      loadSiteLinks();
      const archiveChanged = meta.archive_updated_at !== previousRevision || meta.available_start !== previousStart || meta.available_end !== previousEnd || meta.coverage?.records !== previousRecords;
      const profilesChanged = meta.industry_fetched_at !== previousIndustry || meta.registration_fetched_at !== previousRegistration;
      if (followingLatest && meta.latest_date && meta.latest_date !== previousLatest) $("trade-date").value = meta.latest_date;
      updateDateNavigation();
      if (state.tab === "date" && (archiveChanged || profilesChanged || meta.suspension_revision !== previousSuspension)) loadDate();
      if (state.tab === "stock" && (archiveChanged || profilesChanged)) loadStock({remember: false});
    }
  } catch {
    $("auto-update-note").textContent = "更新状态暂时无法读取，将在 1 分钟后重试。";
    clearTimeout(state.metaPoll);
    state.metaPoll = setTimeout(refreshMeta, 60000);
  }
}

function updateDateNavigation() {
  const date = $("trade-date").value;
  const dates = state.meta?.dates || [];
  $("prev-date").disabled = !dates.some((item) => item < date);
  $("next-date").disabled = !dates.some((item) => item > date);
}
function getDateQuery() { return new URLSearchParams({ date: $("trade-date").value, boards: state.boards, exclude_st: state.excludeST ? "1" : "0", exclude_gem: state.excludeGEM ? "1" : "0" }); }

function renderBoardOptions(counts = [], availableTotal = null) {
  const distribution = new Map();
  counts.forEach((group) => { const boards = Number(group.boards); if (Number.isInteger(boards) && boards > 0) distribution.set(boards, Number(group.count) || 0); });
  if (state.boards && !distribution.has(Number(state.boards))) distribution.set(Number(state.boards), 0);
  const options = [{ value: "", label: "全部", count: availableTotal }, ...[...distribution].sort((a, b) => a[0] - b[0]).map(([boards, count]) => ({ value: String(boards), label: boards === 1 ? "首板" : `${boards} 板`, count }))];
  $("board-options").innerHTML = options.map((option) => `<button type="button" class="board-chip" data-boards="${option.value}" aria-pressed="${String(option.value === state.boards)}" aria-label="${option.label}${option.count === null ? "，数量待查询" : `，${numberValue(option.count)} 只股票`}">${option.label} <span class="board-chip-count">${numberValue(option.count)}</span></button>`).join("");
  $("board-options").setAttribute("aria-busy", "false");
}

async function loadDate() {
  setView("date", false);
  if (!$("trade-date").value) {
    state.requests.date?.abort(); state.dateData = null; clearError(); setStats("date-stats");
    const available = Boolean(state.meta?.dates?.length);
    $("date-table-area").innerHTML = emptyHTML(available ? "请选择查询日期" : "还没有可查询的交易日", available ? "选择实验数据区间内的日期，查看对应的来源池记录。" : "等待历史数据收录完成后，即可按日期查看涨停记录。", "calendar");
    $("date-table-area").setAttribute("aria-busy", "false"); renderBoardOptions();
    $("date-result-count").textContent = "0"; $("prev-date").disabled = true; $("next-date").disabled = true;
    $("date-subtitle").textContent = "选择交易日，查看涨停股票明细。";
    $("date-coverage-note").textContent = "仅供参考"; updateURL(); return;
  }
  clearError();
  $("date-table-area").innerHTML = loadingHTML();
  $("date-table-area").setAttribute("aria-busy", "true");
  $("board-options").setAttribute("aria-busy", "true");
  $("board-options").querySelectorAll("button").forEach((button) => { button.disabled = true; });
  
  setStats("date-stats");
  updateDateNavigation();
  updateURL();
  try {
    const data = await request(`/api/date?${getDateQuery()}`, "date");
    if (!data) return;
    state.dateData = data;
    renderDate(data);
  } catch (error) {
    showError(error, loadDate);
    $("date-table-area").innerHTML = emptyHTML("未能加载这个交易日", "请检查本地服务或点击上方「重新加载」。", "calendar");
    renderBoardOptions();
    $("date-table-area").setAttribute("aria-busy", "false");
  }
}

function renderDate(data) {
  const rows = data.rows || [];
  const stats = data.stats || { total: rows.length, consecutive: rows.filter((row) => row.boards >= 2).length, max_boards: Math.max(0, ...rows.map((row) => Number(row.boards) || 0)), first_boards: rows.filter((row) => row.boards === 1).length };
  setStats("date-stats", stats);
  const suspended = data.suspended_rows || [];
  $("date-height-note").textContent = suspended.length ? `含停牌保留高度 · 当日最高 ${numberValue(data.trading_max_boards)} 板`
    : data.suspension_status === "error" ? "当日池最高 · 停牌资料待核实"
    : ["unknown", "updating"].includes(data.suspension_status) ? "当日池最高 · 停牌资料核查中" : "当前筛选最高高度";
  $("date-result-count").textContent = numberValue(rows.length);
  const date = data.date || $("trade-date").value;
  const weekday = new Date(`${date}T12:00:00`).toLocaleDateString("zh-CN", { weekday: "long" });
  $("date-subtitle").textContent = `${dateLabel(date)} · ${weekday}`;
  $("date-coverage-note").textContent = "仅供参考";
  $("date-coverage-note").classList.toggle("warning", !rows.length || ["partial", "incomplete"].includes(state.meta?.coverage?.status));
  
  $("date-table-area").setAttribute("aria-busy", "false");
  const noSelectedBoards = data.data_status === "ok" && Number(data.available_total) > 0 && state.boards;
  $("date-table-area").innerHTML = rows.length ? renderIndustryColumns(rows, data.tag_board_counts) : noSelectedBoards
    ? emptyHTML(`没有 ${state.boards} 板股票`, `当前日期与其他筛选条件下，该板数为 0。点击「全部」查看 ${numberValue(data.available_total)} 只股票。`)
    : emptyHTML("没有符合条件的涨停记录", data.coverage_note || "这个日期可能不是交易日、尚未收录，或没有满足当前筛选条件的股票。", "calendar");
  if (suspended.length) $("date-table-area").innerHTML = renderSuspendedLeaders(suspended) + $("date-table-area").innerHTML;
  if (["unknown", "updating"].includes(data.suspension_status)) {
    clearTimeout(state.metaPoll); state.metaPoll = setTimeout(refreshMeta, 3000);
  }
  document.querySelectorAll("[data-grouping]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.grouping === state.grouping)));
  renderBoardOptions(data.board_counts || [], data.available_total ?? rows.length);
  updateIndustryNavigation();
}

function updateIndustryNavigation() {
  const board = $("date-table-area").querySelector(".industry-board");
  if (!board) return;
  $("date-table-area").querySelectorAll("[data-industry-scroll]").forEach(button => {
    button.disabled = Number(button.dataset.industryScroll) < 0
      ? board.scrollLeft <= 1 : board.scrollLeft + board.clientWidth >= board.scrollWidth - 1;
  });
}

function stockTags(row) {
  return Array.isArray(row.tags) ? row.tags : row.industry ? [row.industry] : [];
}

function canEditTags() {
  return state.meta?.capabilities?.edit_tags !== false;
}

function canEditNotes() {
  return state.meta?.capabilities?.edit_notes !== false;
}

function renderStockNote(row) {
  const content = typeof row.note === "string" ? row.note : "";
  if (!canEditNotes() && !content) return "";
  return `<button type="button" class="stock-note-button ${content ? "has-note" : ""}" data-edit-stock-note="${escapeHTML(row.code)}" aria-label="${canEditNotes() ? "编辑" : "查看"}${escapeHTML(row.name)}备注"><span class="stock-note-preview">${escapeHTML(content || "点击添加备注")}</span></button>`;
}

function renderStockHeaderNote(stock, loading = false) {
  hideStockNoteTooltip();
  const container = $("stock-profile-note");
  container.innerHTML = loading || stock.name === "尚未收录" ? "" : renderStockNote(stock);
  container.hidden = !container.innerHTML;
  if (container.hidden) container.removeAttribute("data-note-code");
  else container.setAttribute("data-note-code", stock.code);
}

function regionLabel(row) {
  const province = row.registered_province;
  if (!province) return "地区待补充";
  return province.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区/g, "").replace(/[省市]$/, "");
}

function nameInitials(row) {
  return typeof row.initials === "string" ? row.initials.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

function codeDigits(row) {
  const code = String(row.code ?? "");
  return /^[0-9]{6}$/.test(code) ? code : "";
}

function orderMatchingGroups(groups, unknown, sequenceOf, maxLength) {
  const matches = new Map();
  for (const [sequence, stocks] of groups) {
    if (sequence === unknown) continue;
    // Scan every position, keeping each stock once per token, across all matching groups.
    const tokens = new Set();
    for (let length = Math.min(maxLength, sequence.length); length >= 1; length--) {
      for (let start = 0; start <= sequence.length - length; start++) {
        tokens.add(sequence.slice(start, start + length));
      }
    }
    for (const token of tokens) {
      if (!matches.has(token)) matches.set(token, new Map());
      stocks.forEach(stock => matches.get(token).set(String(stock.code), stock));
    }
  }
  const ordered = [...matches].filter(([token, stocks]) => token.length === 1 || stocks.size > 1)
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0], "en"))
    .map(([token, stocks]) => [token, [...stocks.values()].sort((a, b) =>
      sequenceOf(a).indexOf(token) - sequenceOf(b).indexOf(token)
      || sequenceOf(a).localeCompare(sequenceOf(b), "en") || String(a.code).localeCompare(String(b.code)))]);
  if (groups.has(unknown)) ordered.push([unknown, [...groups.get(unknown)].sort((a, b) => String(a.code).localeCompare(String(b.code)))]);
  return ordered;
}

function orderPinyinGroups(groups, unknown) {
  return orderMatchingGroups(groups, unknown, nameInitials, 4);
}

function orderCodeGroups(groups, unknown) {
  return orderMatchingGroups(groups, unknown, codeDigits, 6);
}

function renderStockCard(row) {
  const boards = Number(row.boards) || 0;
  const location = regionLabel(row);
  const tags = stockTags(row);
  const highlighted = row.date !== state.meta?.latest_date && latestLimitUp(row);
  const blacklisted = row.blacklisted === true;
  const initials = nameInitials(row);
  return `<li class="industry-stock ${highlighted ? "latest-limit-up" : ""}${blacklisted ? " blacklisted-stock" : ""}" data-card-code="${escapeHTML(row.code)}"><div class="industry-stock-top"><button type="button" class="stock-name-button" data-stock-code="${escapeHTML(row.code)}" data-stock-name="${escapeHTML(row.name)}">${escapeHTML(textValue(row.name))}</button>${blacklisted ? '<span class="stock-blacklist-badge">黑名单</span>' : ""}<span class="board-badge ${boards >= 5 ? "high" : boards <= 1 ? "first" : ""}">${boards ? `${boards} 板` : "—"}</span></div>${highlighted ? latestLimitBadge(row) : ""}<div class="industry-stock-meta"><span class="row-stock-code">${escapeHTML(row.code)}</span><span class="stock-initials" title="股票名称首字母：${escapeHTML(initials || "暂未获取")}">${escapeHTML(initials || "—")}</span><span class="stock-location">${escapeHTML(location)}</span></div>${row.suspended ? renderSuspensionNote(row) : ""}<div class="stock-tags">${tags.map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}${canEditTags() ? `<button type="button" class="edit-stock-tags" data-edit-stock-tags="${escapeHTML(row.code)}" aria-label="编辑${escapeHTML(row.name)}标签">编辑</button>` : ""}</div><div class="stock-note-row" data-note-code="${escapeHTML(row.code)}">${renderStockNote(row)}</div></li>`;
}

function renderSuspensionNote(row) {
  return `<div class="suspension-card-note" role="group" aria-label="停牌信息"><div class="suspension-status"><i aria-hidden="true"></i>停牌中</div><dl class="suspension-dates"><div><dt>末次涨停</dt><dd><time datetime="${escapeHTML(row.board_date)}">${escapeHTML(dateLabel(row.board_date))}</time></dd></div><div><dt>预计复牌</dt><dd>${row.resume_date ? `<time datetime="${escapeHTML(row.resume_date)}">${escapeHTML(dateLabel(row.resume_date))}</time>` : "待公告"}</dd></div></dl></div>`;
}

function renderSuspendedLeaders(rows) {
  return `<section class="suspended-leaders" aria-label="停牌保留高度"><header><h4>停牌保留高度</h4><p>保留停牌前连板高度，未计入当日涨停家数</p></header><ul class="industry-stock-list">${rows.map(renderStockCard).join("")}</ul></section>`;
}

function industryTagBoardCounts(rows) {
  const counts = Object.create(null);
  rows.forEach(row => [...new Set(stockTags(row))].forEach(tag => {
    const heights = counts[tag] ||= Object.create(null);
    heights[row.boards] = (heights[row.boards] || 0) + 1;
  }));
  return counts;
}

function renderIndustryColumns(rows, dailyTagBoards = null) {
  const regional = state.grouping === "region";
  const phonetic = state.grouping === "pinyin";
  const numeric = state.grouping === "code";
  const matchingMode = phonetic || numeric;
  const groupType = numeric ? "代码分组" : phonetic ? "拼音分组" : regional ? "地区" : "行业";
  const unknown = matchingMode ? "#" : regional ? "地区待补充" : "未分类";
  const groups = new Map();
  const tagBoards = dailyTagBoards || industryTagBoardCounts(rows);
  let repeated = false;
  rows.forEach(row => {
    let labels = numeric ? [codeDigits(row) || unknown] : phonetic ? [nameInitials(row) || unknown] : regional ? [regionLabel(row)] : [...new Set(stockTags(row))];
    if (!regional && !matchingMode && Number(row.boards) > 1) {
      const related = labels.filter(label => Object.entries(tagBoards[label] || {})
        .some(([height, count]) => Number(height) !== Number(row.boards) && Number(count) > 0));
      labels = related.length ? related : labels.slice(0, 1);
    }
    if (labels.length > 1) repeated = true;
    (labels.length ? labels : [unknown]).forEach(label => {
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(row);
    });
  });
  const ordered = matchingMode ? (numeric ? orderCodeGroups(groups, unknown) : orderPinyinGroups(groups, unknown)) : [...groups].sort((a, b) => {
    if (a[0] === unknown) return 1;
    if (b[0] === unknown) return -1;
    return Math.max(...b[1].map(row => Number(row.boards) || 0)) - Math.max(...a[1].map(row => Number(row.boards) || 0))
      || b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-CN");
  });
  const heights = [...new Set(rows.map(row => Number(row.boards)))].sort((a, b) => b - a);
  const sections = heights.map(height => {
    const label = height === 1 ? "首板" : `${height} 板`;
    const total = rows.filter(row => Number(row.boards) === height).length;
    const cells = ordered.map(([name, stocks]) => {
      const selected = stocks.filter(row => Number(row.boards) === height);
      const matching = matchingMode ? selected : prioritizeLatest(selected.sort((a, b) => String(a.code).localeCompare(String(b.code))), true);
      return `<section class="matrix-cell ${matching.length ? "" : "matrix-cell-empty"}" data-group-label="${escapeHTML(name)}" aria-label="${escapeHTML(name)}，${label}，${matching.length} 只股票"><header class="matrix-cell-header"><h5>${escapeHTML(name)}</h5><span>${matching.length}<small>只</small></span></header>${matching.length ? `<ul class="industry-stock-list">${matching.map(renderStockCard).join("")}</ul>` : '<div class="matrix-empty" aria-label="本组没有这个板数的股票">—</div>'}</section>`;
    }).join("");
    return `<section class="board-height-section" data-board-height="${height}" aria-label="${label}，${total} 只股票"><header class="board-height-heading"><h4>${label}</h4><span>${total} 只股票</span></header><div class="board-matrix-row">${cells}</div></section>`;
  }).join("");
  const matchingHint = numeric ? "6 → 5 → 4 → 3 → 2 → 1 位连续数字匹配，同一股票可跨组展示" : "4 → 3 → 2 → 1 个连续字母匹配，同一股票可跨组展示";
  return `<div class="industry-board-summary"><span><strong>${ordered.length}</strong> 个${groupType} · <strong>${rows.length}</strong> 只股票${matchingMode ? `<span class="multi-tag-note"> · ${matchingHint}</span>` : repeated ? '<span class="multi-tag-note"> · 多标签跨列显示</span>' : ""}${rows[0]?.date !== state.meta?.latest_date ? latestPriorityNote() : ""}</span><div class="industry-board-controls"><span class="industry-scroll-hint">左右查看${groupType}</span><button type="button" class="icon-button" data-industry-scroll="-1" aria-label="查看左侧分组">←</button><button type="button" class="icon-button" data-industry-scroll="1" aria-label="查看右侧分组">→</button></div></div><div class="industry-board" role="region" aria-label="按${groupType}分列、按连板高度分行的股票" tabindex="0"><div class="board-comparison" style="--matrix-columns:${ordered.length}">${sections}</div></div>`;
}

function renderTagEditor() {
  $("tag-editor-list").innerHTML = state.tagDraft.length ? state.tagDraft.map((tag, index) => `<div class="tag-edit-chip"><input class="tag-name-input" type="text" value="${escapeHTML(tag)}" maxlength="30" required data-tag-index="${index}" aria-label="标签 ${index + 1}"><button type="button" data-remove-tag="${index}" aria-label="移除标签 ${escapeHTML(tag)}">×</button></div>`).join("") : '<p class="tag-empty-hint">暂无标签，保存后将归入“未分类”。</p>';
  $("tag-source-label").textContent = state.tagEditorData?.source_tag ? `默认行业：${state.tagEditorData.source_tag}` : "暂无默认行业，可以自行添加标签。";
  $("tag-editor-error").hidden = true;
}

function updateTagEditorControls() {
  const busy = Boolean(state.tagSaving || state.tagBlacklistSaving);
  $("save-tags").disabled = !state.tagEditorData || busy;
  $("close-tags").disabled = busy;
  $("cancel-tags").disabled = busy;
  $("tag-blacklist-control").hidden = !canEditBlacklist();
  $("tag-blacklist").disabled = !canEditBlacklist() || !state.tagEditorData || busy;
}

function syncTagBlacklistMembership(code, blacklisted, data) {
  state.blacklistData = data;
  for (const row of [...(state.dateData?.rows || []), ...(state.dateData?.suspended_rows || [])]) {
    if (row.code === code) row.blacklisted = blacklisted;
  }
  for (const stock of [state.stockData?.stock, state.selectedStock]) {
    if (stock?.code === code) stock.blacklisted = blacklisted;
  }
  if (state.tab === "date" && state.dateData) {
    const scrollLeft = $("date-table-area").querySelector(".industry-board")?.scrollLeft || 0;
    renderDate(state.dateData);
    const board = $("date-table-area").querySelector(".industry-board");
    if (board) { board.scrollLeft = scrollLeft; updateIndustryNavigation(); }
  } else if (state.tab === "stock" && state.selectedStock?.code === code) {
    $("stock-blacklist-label").hidden = !blacklisted;
  }
}

async function changeTagBlacklist() {
  const editor = state.tagEditorData;
  if (!editor || !canEditBlacklist() || state.tagSaving || state.tagBlacklistSaving) return;
  const previous = editor.blacklisted === true;
  const blacklisted = $("tag-blacklist").checked;
  if (blacklisted === previous) return;
  state.tagBlacklistSaving = true;
  $("tag-blacklist-error").hidden = true;
  $("tag-blacklist-status").textContent = "正在保存…";
  updateTagEditorControls();
  try {
    const data = await request("/api/blacklist", "tag-blacklist-save", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code: editor.code, action: blacklisted ? "add" : "remove"})});
    if (!data) throw new Error("未能确认黑名单状态，请重新打开弹窗核实后重试。");
    editor.blacklisted = blacklisted;
    syncTagBlacklistMembership(editor.code, blacklisted, data);
    $("tag-blacklist-status").textContent = blacklisted ? "已加入黑名单" : "已移出黑名单";
  } catch (error) {
    $("tag-blacklist").checked = previous;
    $("tag-blacklist-status").textContent = "";
    $("tag-blacklist-error").textContent = error.message;
    $("tag-blacklist-error").hidden = false;
  } finally {
    state.tagBlacklistSaving = false;
    updateTagEditorControls();
  }
}

async function openTagEditor(code) {
  if (!canEditTags() || state.tagSaving || state.tagBlacklistSaving) return;
  state.tagEditingCode = code;
  state.tagEditorData = null;
  state.tagDraft = [];
  state.tagUseSource = false;
  $("tag-stock-label").textContent = code;
  $("tag-editor-list").innerHTML = '<p class="tag-empty-hint">正在读取标签…</p>';
  $("tag-editor-error").hidden = true;
  $("tag-blacklist").checked = false;
  $("tag-blacklist-status").textContent = "";
  $("tag-blacklist-error").hidden = true;
  $("tag-new").value = "";
  updateTagEditorControls();
  if (!$("tag-dialog").open) $("tag-dialog").showModal();
  try {
    const data = await request(`/api/stock-tags?${new URLSearchParams({ code })}`, "tags");
    if (!data || !$("tag-dialog").open || state.tagEditingCode !== code) return;
    state.tagEditorData = data;
    state.tagDraft = [...data.tags];
    $("tag-blacklist").checked = data.blacklisted === true;
    $("tag-stock-label").textContent = `${data.name} · ${data.code}`;
    renderTagEditor();
    updateTagEditorControls();
  } catch (error) {
    if ($("tag-dialog").open && state.tagEditingCode === code) { $("tag-editor-error").textContent = error.message; $("tag-editor-error").hidden = false; }
  }
}

function addTagDraft() {
  const input = $("tag-new"), value = input.value.trim();
  input.setCustomValidity("");
  if (!value) return false;
  if (state.tagDraft.length >= 20) input.setCustomValidity("每只股票最多保留 20 个标签。");
  else if (state.tagDraft.some(tag => tag.trim().toLocaleLowerCase() === value.toLocaleLowerCase())) input.setCustomValidity("这个标签已存在。");
  if (!input.reportValidity()) return false;
  state.tagDraft.push(value);
  state.tagUseSource = false;
  input.value = "";
  renderTagEditor();
  input.focus();
  return true;
}

function closeTagEditor() {
  if (state.tagSaving || state.tagBlacklistSaving) return;
  state.requests.tags?.abort();
  $("tag-dialog").close();
}

async function saveTagEditor(event) {
  event.preventDefault();
  if (!state.tagEditorData || state.tagSaving || state.tagBlacklistSaving) return;
  if ($("tag-new").value.trim() && !addTagDraft()) return;
  if (!$("tag-editor-form").reportValidity()) return;
  state.tagSaving = true;
  $("tag-editor-form").querySelectorAll("button, input").forEach(element => { element.disabled = true; });
  updateTagEditorControls();
  try {
    const data = await request("/api/stock-tags", "tags-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: state.tagEditorData.code, tags: state.tagDraft, revision: state.tagEditorData.revision, use_source: state.tagUseSource }) });
    if (!data) return;
    $("tag-dialog").close();
    if (state.tab === "stock") await loadStock(); else await loadDate();
  } catch (error) { $("tag-editor-error").textContent = error.message; $("tag-editor-error").hidden = false; }
  finally {
    state.tagSaving = false;
    $("tag-editor-form").querySelectorAll("button, input").forEach(element => { element.disabled = false; });
    updateTagEditorControls();
  }
}

function updateStockNoteControls() {
  const busy = Boolean(state.noteSaving), ready = Boolean(state.noteEditorData), editable = canEditNotes();
  $("stock-note-content").disabled = busy || !ready;
  $("stock-note-content").readOnly = !editable;
  $("save-stock-note").disabled = busy || !ready || !editable;
  $("save-stock-note").hidden = !editable;
  ["close-stock-note", "cancel-stock-note", "retry-stock-note"].forEach(id => { $(id).disabled = busy; });
  $("stock-note-count").textContent = `${$("stock-note-content").value.length} / 5000`;
}

function hideStockNoteTooltip() {
  clearTimeout(state.noteTooltipTimer);
  state.noteTooltipAnchor?.removeAttribute("aria-describedby");
  state.noteTooltipAnchor = null;
  $("stock-note-tooltip").hidden = true;
}

function scheduleStockNoteTooltipHide() {
  clearTimeout(state.noteTooltipTimer);
  state.noteTooltipTimer = setTimeout(hideStockNoteTooltip, 150);
}

function showStockNoteTooltip(button) {
  clearTimeout(state.noteTooltipTimer);
  const tooltip = $("stock-note-tooltip");
  const content = button.querySelector(".stock-note-preview")?.textContent;
  if (!button.classList.contains("has-note") || !content) return;
  if (state.noteTooltipAnchor === button && !tooltip.hidden) return;
  hideStockNoteTooltip();
  tooltip.textContent = content;
  tooltip.hidden = false;
  state.noteTooltipAnchor = button;
  button.setAttribute("aria-describedby", "stock-note-tooltip");
  const anchor = button.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 20, above = anchor.top - 20;
  tooltip.style.maxHeight = `${Math.min(360, Math.max(80, above, below))}px`;
  const bounds = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
  const top = below >= bounds.height ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
  tooltip.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
}

async function openStockNoteEditor(code) {
  if (state.noteSaving) return;
  hideStockNoteTooltip();
  const generation = (state.noteGeneration || 0) + 1;
  state.noteGeneration = generation;
  state.noteEditingCode = code;
  state.noteEditorData = null;
  $("stock-note-title").textContent = canEditNotes() ? "编辑股票备注" : "查看股票备注";
  $("stock-note-label").textContent = code;
  $("stock-note-content").value = "";
  $("stock-note-feedback").textContent = "正在读取备注…";
  $("stock-note-error").hidden = true;
  $("retry-stock-note").hidden = true;
  updateStockNoteControls();
  if (!$("stock-note-dialog").open) $("stock-note-dialog").showModal();
  try {
    const data = await request(`/api/stock-note?${new URLSearchParams({code})}`, "stock-note");
    if (!data || state.noteGeneration !== generation || !$("stock-note-dialog").open) return;
    state.noteEditorData = data;
    $("stock-note-label").textContent = `${data.name} · ${data.code}`;
    $("stock-note-content").value = data.content || "";
    $("stock-note-feedback").textContent = canEditNotes() ? "支持换行，备注随股票保存；留空后保存可清除。" : "当前为只读模式。";
    updateStockNoteControls();
    $("stock-note-content").focus();
  } catch (error) {
    if (state.noteGeneration !== generation || !$("stock-note-dialog").open) return;
    $("stock-note-feedback").textContent = "";
    $("stock-note-error").textContent = error.message;
    $("stock-note-error").hidden = false;
    $("retry-stock-note").hidden = false;
  }
}

function closeStockNoteEditor() {
  if (state.noteSaving) return;
  state.noteGeneration = (state.noteGeneration || 0) + 1;
  state.requests["stock-note"]?.abort();
  state.noteEditorData = null;
  $("stock-note-dialog").close();
}

async function saveStockNoteEditor(event) {
  event.preventDefault();
  if (!canEditNotes() || !state.noteEditorData || state.noteSaving || !$("stock-note-form").reportValidity()) return;
  state.noteSaving = true;
  $("stock-note-error").hidden = true;
  updateStockNoteControls();
  try {
    const data = await request("/api/stock-note", "stock-note-save", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code: state.noteEditorData.code, content: $("stock-note-content").value, revision: state.noteEditorData.revision})});
    if (!data) throw new Error("备注未确认保存，请重试。");
    for (const row of [...(state.dateData?.rows || []), ...(state.dateData?.suspended_rows || []), state.stockData?.stock, state.selectedStock]) {
      if (row?.code === data.code) row.note = data.content;
    }
    document.querySelectorAll(`[data-note-code="${data.code}"]`).forEach(element => {
      element.innerHTML = renderStockNote({code: data.code, name: data.name, note: data.content});
    });
    state.noteSaving = false;
    closeStockNoteEditor();
  } catch (error) {
    $("stock-note-error").textContent = error.message;
    $("stock-note-error").hidden = false;
    $("retry-stock-note").hidden = false;
  } finally {
    state.noteSaving = false;
    updateStockNoteControls();
  }
}

function renderTable(rows, mode) {
  const dateMode = mode === "date";
  const heads = dateMode ? ["股票", "连板", "行业"] : ["交易日期", "当日高度"];
  const rowHTML = rows.map((row) => {
    const boards = Number(row.boards) || 0;
    const badge = `<span class="board-badge ${boards >= 5 ? "high" : boards <= 1 ? "first" : ""}">${boards ? `${boards} 板` : "—"}</span>`;
    return dateMode
      ? `<tr><td><button class="stock-name-button" data-stock-code="${escapeHTML(row.code)}" data-stock-name="${escapeHTML(row.name)}">${escapeHTML(textValue(row.name))}</button><div class="row-stock-code">${escapeHTML(textValue(row.code))}</div></td><td>${badge}</td><td><span class="industry-text">${escapeHTML(textValue(row.industry))}</span></td></tr>`
      : `<tr><td><button class="stock-name-button" data-history-date="${escapeHTML(row.date)}">${escapeHTML(dateLabel(row.date))}</button></td><td>${badge}</td></tr>`;
  }).join("");
  return `<table class="${dateMode ? "date-table" : "stock-table"}"><caption class="sr-only">${dateMode ? "当日涨停股票明细" : "个股逐日涨停记录"}</caption><thead><tr>${heads.map((head) => `<th scope="col">${head}</th>`).join("")}</tr></thead><tbody>${rowHTML}</tbody></table>`;
}

function hideSuggestions() { $("stock-suggestions").hidden = true; $("stock-search").setAttribute("aria-expanded", "false"); $("stock-search").removeAttribute("aria-activedescendant"); state.suggestionIndex = -1; }
function showSuggestions(rows, query) {
  state.suggestions = rows;
  state.suggestionsQuery = query;
  state.suggestionIndex = -1;
  $("stock-suggestions").innerHTML = rows.length ? rows.slice(0, 15).map((stock, index) => `<li role="presentation"><button type="button" role="option" aria-selected="false" id="suggestion-${index}" data-suggestion="${index}"><span class="suggestion-code">${escapeHTML(stock.code)}</span><span>${escapeHTML(stock.name)}</span><span class="suggestion-market">${escapeHTML(marketValue(stock.market))}</span></button></li>`).join("") : '<li role="presentation" class="suggestion-message">未找到已收录的股票，请尝试名称、代码或首字母。</li>';
  $("stock-suggestions").hidden = false;
  $("stock-search").setAttribute("aria-expanded", "true");
}
async function searchStocks() {
  const query = $("stock-search").value.trim();
  if (state.selectedStock) return;
  if (!query) { hideSuggestions(); return; }
  try {
    const data = await request(`/api/stocks?${new URLSearchParams({ q: query })}`, "search");
    if (!data || state.selectedStock || $("stock-search").value.trim() !== query) return;
    showSuggestions(data.rows || [], query);
  } catch (error) {
    $("stock-suggestions").innerHTML = '<li role="presentation" class="suggestion-message">暂时无法检索股票，仍可输入完整代码查询。</li>';
    $("stock-suggestions").hidden = false;
    $("stock-search").setAttribute("aria-expanded", "true");
  }
}
function chooseStock(stock, query = true) {
  state.selectedStock = { code: String(stock.code), name: stock.name || "", market: stock.market || "" };
  state.requests.search?.abort();
  state.requests["stock-resolve"]?.abort();
  $("stock-search").value = stock.name ? `${stock.name} ${stock.code}` : stock.code;
  hideSuggestions();
  setView("stock");
  if (query) loadStock();
}
async function loadStock({remember = true} = {}) {
  let stock = state.selectedStock;
  if (!stock) {
    const raw = $("stock-search").value.trim();
    if (/^\d{6}$/.test(raw)) stock = { code: raw, name: "" };
    else if (raw) {
      try {
        let rows = state.suggestionsQuery === raw ? state.suggestions : null;
        if (!rows) {
          const data = await request(`/api/stocks?${new URLSearchParams({ q: raw })}`, "stock-resolve");
          if (!data || $("stock-search").value.trim() !== raw) return;
          rows = data.rows || [];
        }
        const initials = raw.replace(/\s+/g, "").toUpperCase();
        const exact = rows.filter(item => item.name === raw || item.initials === initials);
        stock = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
        if (!stock) showSuggestions(rows, raw);
      } catch (error) { showError(error, loadStock); return; }
    }
  }
  if (!stock) { $("stock-search").setCustomValidity("请输入股票名称、代码或首字母；多个结果时请选择对应股票。"); $("stock-search").reportValidity(); return; }
  $("stock-search").setCustomValidity("");
  state.selectedStock = stock;
  const generation = (state.stockGeneration || 0) + 1;
  state.stockGeneration = generation;
  hideSuggestions();
  clearError();
  setView("stock", false);
  $("stock-results").hidden = false;
  $("stock-code-label").textContent = stock.code;
  $("stock-name-label").textContent = stock.name || "查询中";
  renderStockProfile(stock, true);
  state.requests.relations?.abort();
  state.relationsRequest = (state.relationsRequest || 0) + 1;
  state.relationsLoading = false;
  state.requests.comparison?.abort();
  state.comparisonCache = new Map();
  state.comparisonLoading = "";
  $("stock-cycles").innerHTML = '<div class="empty-inline">正在整理连板周期…</div>';
  $("stock-chart").innerHTML = '<div class="empty-inline">正在读取高度轨迹…</div>';
  state.relationships = null;
  state.relationPeers = [];
  if (state.stockData?.stock?.code !== stock.code) {
    state.relationPeerCode = "";
    state.relationQuery = "";
  }
  $("relations-range").textContent = "正在整理同期竞争和同日涨停记录…";
  $("stock-relations").setAttribute("aria-busy", "true");
  $("competition-results").innerHTML = loadingHTML();
  
  $("stock-query-button").disabled = true;
  setStats("stock-stats");
  updateURL();
  try {
    const params = new URLSearchParams({ code: stock.code });
    const data = await request(`/api/stock?${params}`, "stock");
    if (!data || state.stockGeneration !== generation || state.tab !== "stock") return;
    state.stockData = data;
    renderStock(data);
    if (remember && data.rows?.length && data.stock?.name !== "尚未收录") rememberStock(data.stock);
  } catch (error) {
    if (state.stockGeneration !== generation || state.tab !== "stock") return;
    showError(error, loadStock);
    $("stock-cycles").innerHTML = "";
    $("stock-chart").innerHTML = '<div class="empty-inline">查询失败，暂无轨迹数据</div>';
    $("relations-range").textContent = "关联记录暂时无法读取";
    $("competition-results").innerHTML = emptyHTML("未能加载竞争记录", "请重新加载个股历史。");
    $("stock-name-label").textContent = stock.name || stock.code;
  } finally { if (state.stockGeneration === generation) { $("stock-relations").setAttribute("aria-busy", String(!!state.relationsLoading)); $("stock-query-button").disabled = false; } }
}

function renderStockProfile(stock, loading = false) {
  renderStockHeaderNote(stock, loading);
  $("stock-initials-label").textContent = loading ? "…" : nameInitials(stock) || "—";
  $("stock-blacklist-label").hidden = loading || stock.blacklisted !== true;
  $("stock-province-label").textContent = loading ? "…" : regionLabel(stock);
  const tags = stockTags(stock);
  $("stock-industry-tags").innerHTML = loading ? '<span class="stock-tag-empty">正在读取标签…</span>'
    : tags.map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>';
  $("edit-stock-profile-tags").hidden = !canEditTags();
  $("edit-stock-profile-tags").disabled = !canEditTags() || loading || stock.name === "尚未收录";
  $("edit-stock-profile-tags").setAttribute("aria-label", `编辑${stock.name || stock.code}行业标签`);
}

function renderStock(data) {
  const rows = data.rows || [];
  const stock = data.stock || state.selectedStock;
  state.selectedStock = stock;
  $("stock-code-label").textContent = textValue(stock.code);
  $("stock-name-label").textContent = textValue(stock.name);
  renderStockProfile(stock);
  $("stock-search").value = `${stock.name || ""} ${stock.code}`.trim();
  setStats("stock-stats", data.stats || {});
  if (state.relationExcludeLatest) loadRelationHistory();
  else renderRelationships(data.relationships);
  
  $("stock-chart").innerHTML = rows.length ? renderChart(rows) : '<div class="empty-inline">暂无已收录的涨停轨迹</div>';
  $("cycle-competition-scope").textContent = data.relationships?.competition?.scope_note || "";
  $("stock-cycles").innerHTML = renderStockCycles(data);
  updateURL();
}

function relationStockButton(row) {
  return `<button type="button" class="stock-name-button relation-stock-name" data-relation-code="${escapeHTML(row.code)}" data-relation-name="${escapeHTML(row.name)}" title="查看${escapeHTML(row.name)}的股票详情">${escapeHTML(row.name)}</button>`;
}

function relationDateButton(day, label = dateLabel(day)) {
  return `<button type="button" class="relation-date" data-relation-date="${escapeHTML(day)}">${escapeHTML(label)}</button>`;
}

function renderRelationships(data) {
  state.relationships = data || null;
  state.relationPeers = mergeRelationPeers(data, state.selectedStock?.code);
  $("relations-range").textContent = data ? `${state.relationExcludeLatest ? "历史数据" : "全部数据"} · ${data.range_end < data.range_start ? "暂无可用历史交易日" : `${dateLabel(data.range_start)} — ${dateLabel(data.range_end)}`} · 本票 ${numberValue(data.target_limit_days)} 个涨停日${state.relationExcludeLatest ? ` · 已剔除 ${dateLabel(state.meta?.latest_date)}` : ""}` : "暂无关联记录";
  renderCompetition();
  loadPeerComparison();
}

async function loadRelationHistory() {
  const code = state.selectedStock?.code;
  if (!code || state.tab !== "stock") return;
  const generation = (state.relationsRequest || 0) + 1;
  state.relationsRequest = generation;
  state.requests.relations?.abort();
  state.requests.comparison?.abort();
  state.comparisonCache = new Map();
  state.comparisonLoading = "";
  state.relationsLoading = false;
  clearError();
  if (!state.relationExcludeLatest) {
    renderRelationships(state.stockData?.relationships);
    $("stock-relations").setAttribute("aria-busy", "false");
    return;
  }
  state.relationships = null;
  state.relationPeers = [];
  state.relationsLoading = true;
  $("stock-relations").setAttribute("aria-busy", "true");
  $("relations-range").textContent = "正在剔除最新交易日并重新统计历史关联…";
  $("competition-results").innerHTML = loadingHTML();
  try {
    const data = await request(`/api/stock?${new URLSearchParams({code, exclude_latest: "1"})}`, "relations");
    if (!data || state.relationsRequest !== generation || state.selectedStock?.code !== code || state.tab !== "stock" || !state.relationExcludeLatest) return;
    renderRelationships(data.relationships);
  } catch (error) {
    if (state.relationsRequest !== generation || state.selectedStock?.code !== code || state.tab !== "stock") return;
    $("relations-range").textContent = "历史关联暂时无法读取";
    $("competition-results").innerHTML = emptyHTML("未能加载历史关联", "请重新加载后查看。");
    showError(error, loadRelationHistory);
  } finally {
    if (state.relationsRequest === generation && state.selectedStock?.code === code && state.tab === "stock") {
      state.relationsLoading = false;
      $("stock-relations").setAttribute("aria-busy", "false");
    }
  }
}

function verificationBadge(label = "待行情核实") {
  return `<span class="verification-label" title="按涨停池比较：目前只确认一方晋级、另一方未入池；未入池不等于未涨停，仍需用完整行情核实。">${escapeHTML(label)}</span>`;
}

function renderRoundPeer(peer) {
  const tags = stockTags(peer);
  const location = regionLabel(peer);
  const tagTitle = peer.tags_customized ? "当前自定义行业标签" : "当前申万行业分类";
  return `<button type="button" class="round-peer ${latestLimitUp(peer) ? "latest-limit-up" : ""} ${peer.is_target ? "round-target" : ""}" data-promotion="${escapeHTML(peer.promotion_status || "")}" data-relation-code="${escapeHTML(peer.code)}" data-relation-name="${escapeHTML(peer.name)}"><span class="round-peer-heading"><strong>${escapeHTML(peer.name)}</strong><small>${escapeHTML(peer.code)}</small>${peer.is_target ? '<span class="round-target-label">本票</span>' : ""}</span><span class="round-peer-profile"><span class="round-peer-location">${escapeHTML(location)}</span>${tags.length ? tags.map(tag => `<span class="round-peer-industry" title="${escapeHTML(tagTitle)}">${escapeHTML(tag)}</span>`).join("") : `<span class="round-peer-industry empty">${peer.tags_customized ? "暂无标签" : "行业待补充"}</span>`}</span></button>`;
}

function renderCompetitionRounds(data) {
  const rounds = data.rounds || [];
  if (!rounds.length) return "";
  const segments = [];
  rounds.forEach(round => {
    const segment = segments.at(-1);
    const followingDate = round.next_date || round.next_trading_date;
    if (round.outcome === "no_peers" && segment?.first.outcome === "no_peers"
        && Number(round.boards) + 1 === Number(segment.first.boards)
        && followingDate === segment.first.date) {
      segment.first = round;
      segment.count += 1;
    } else segments.push({ first: round, last: round, count: 1 });
  });
  const labels = { win: "胜出 1 轮", loss: "落后 1 轮", together: "共同晋级", cutoff: "待后续结果", missing: "数据待补", no_peers: "无同级对手", unresolved: "未形成单方胜负" };
  const items = segments.map(({ first: round, last, count }) => {
    const next = last.next_date || last.next_trading_date;
    const dateRange = `${dateLabel(round.date)} → ${next ? dateLabel(next) : "下一交易日"}`;
    let description = "";
    if (round.outcome === "win") description = `本票晋级 ${round.boards + 1} 板，本批次胜出记 1 轮，涉及 ${round.wins.length} 只对手。`;
    else if (round.outcome === "loss") description = `本票次日未入池，同梯队有 ${round.losses.length} 只对手晋级 ${round.boards + 1} 板，本批次落后记 1 轮。`;
    else if (round.outcome === "cutoff") description = `${round.boards} 进 ${round.boards + 1} 的结果${next ? `需查看 ${dateLabel(next)}` : "尚未收录"}，超出当前数据收录范围，暂不计胜负。`;
    else if (round.outcome === "missing") description = `${dateLabel(next)} 的涨停池数据未确认，暂不计胜负。`;
    else if (round.outcome === "together") description = `本票与 ${round.together_count} 只同梯队股票共同晋级 ${round.boards + 1} 板，未形成单方胜负。`;
    else if (round.outcome !== "no_peers") description = "没有形成可归入单方晋级的胜负记录；共同未入池或板数异常不计胜负。";
    const heading = `<header class="competition-round-heading"><strong>${round.boards} 进 ${last.boards + 1}</strong><div class="competition-round-context"><span class="competition-round-date" title="${escapeHTML(dateRange)}">${escapeHTML(dateRange)}</span>${description ? `<span class="competition-round-description">${escapeHTML(description)}${round.wins.length || round.losses.length ? verificationBadge() : ""}</span>` : ""}</div><span class="competition-round-status status-${escapeHTML(round.outcome)}">${escapeHTML(labels[round.outcome] || "待确认")}</span></header>`;
    if (round.outcome === "no_peers") return `<article class="competition-round competition-round-compact" data-round-date="${escapeHTML(round.date)}" data-round-height="${round.boards}" data-round-count="${count}">${heading}</article>`;
    const cohort = round.cohort || [...round.wins, ...round.losses];
    const order = members => prioritizeLatest([...members].sort((a,b) => Number(!!b.is_target) - Number(!!a.is_target) || String(a.code).localeCompare(String(b.code))));
    const advanced = order(cohort.filter(peer => peer.promotion_status === "advanced"));
    const others = order(cohort.filter(peer => peer.promotion_status !== "advanced"));
    const group = (members, label, kind) => members.length ? `<section class="round-cohort-group" data-cohort-group="${kind}" aria-label="${escapeHTML(label)}"><h5>${escapeHTML(label)} <span>${numberValue(members.length)} 只</span></h5><div class="round-cohort-grid">${members.map(renderRoundPeer).join("")}</div></section>` : "";
    const groups = advanced.length
      ? group(advanced, `晋级 ${round.boards + 1} 板`, "advanced") + group(others, "同梯队其他股票", "others")
      : `<div class="round-cohort-grid">${others.map(renderRoundPeer).join("")}</div>`;
    const advancement = round.status === "compared" ? `已晋级 ${numberValue(advanced.length)} 只` : "晋级结果待确认";
    const opponentLists = cohort.length ? `<div class="round-opponents"><span>同梯队 ${numberValue(cohort.length)} 只 · ${advancement}</span>${groups}</div>` : "";
    return `<article class="competition-round" data-round-date="${escapeHTML(round.date)}" data-round-height="${round.boards}">${heading}<div class="competition-round-body">${opponentLists}<div class="competition-round-actions">${relationDateButton(round.date, "查看起始日涨停明细")}${round.next_date ? relationDateButton(round.next_date, "查看次日涨停明细") : ""}</div></div></article>`;
  }).join("");
  return `<section class="competition-rounds" aria-label="逐轮竞争"><div class="competition-rounds-heading"><h4>逐轮竞争</h4><span>共 ${numberValue(rounds.length)} 轮${segments.length < rounds.length ? ` · 合并展示 ${numberValue(segments.length)} 条` : ""} · 区域内滚动查看</span></div><div class="relation-scroll competition-rounds-scroll" role="region" aria-label="全部逐轮竞争记录" tabindex="0">${items}</div></section>`;
}

function renderStockCycles(data) {
  const cycles = data.cycles || [];
  const rounds = data.relationships?.competition?.rounds || [];
  return cycles.length ? cycles.map(cycle => {
    const uncertain = cycle.clipped || cycle.start_known === false;
    const status = uncertain ? "周期边界待确认" : cycle.ongoing ? `截至 ${dateLabel(data.as_of_date || data.range_end)} 仍在连板` : cycle.end_known === true ? "已结束" : "后续状态待确认";
    const count = Math.min(24, (cycle.dates || []).length || Number(cycle.boards) || 1);
    const dates = new Set(cycle.dates || []);
    const cycleRounds = rounds.filter(round => dates.size ? dates.has(round.date) : round.date >= cycle.start && round.date <= cycle.end);
    return `<article class="cycle-card cycle-with-rounds" data-cycle-start="${escapeHTML(cycle.start)}"><div class="cycle-summary"><div class="cycle-head"><strong>${numberValue(cycle.boards)}<small>板</small></strong><span class="cycle-status ${cycle.ongoing ? "ongoing" : ""}" title="${escapeHTML(status)}">${escapeHTML(status)}</span></div><div class="cycle-date">${escapeHTML(dateLabel(cycle.start))}<span>→</span>${escapeHTML(dateLabel(cycle.end))}</div><p class="cycle-height-label">周期内已收录的最高高度</p><div class="cycle-steps" aria-hidden="true">${Array.from({ length: count }, (_, index) => `<span class="cycle-step" style="height:${Math.min(28, 7 + index * (20 / count))}px"></span>`).join("")}</div>${cycle.note ? `<p class="cycle-note">${escapeHTML(cycle.note)}</p>` : ""}</div>${renderCompetitionRounds({rounds: cycleRounds}) || '<p class="cycle-rounds-empty">该周期暂无已收录的竞争记录。</p>'}</article>`;
  }).join("") : emptyHTML("暂无连板周期", "已收录数据中没有这只股票的涨停周期。");
}

function containRelationWheel(event) {
  const comparison = event.target.closest?.(".peer-comparison-records");
  if (event.ctrlKey && comparison && (event.deltaY || event.deltaX)) {
    const distance = Math.abs(event.deltaY || 0) >= Math.abs(event.deltaX || 0) ? event.deltaY : event.deltaX;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? comparison.clientWidth : 1;
    comparison.scrollLeft = Math.max(0, Math.min(comparison.scrollWidth - comparison.clientWidth, comparison.scrollLeft + distance * unit));
    event.preventDefault();
    return;
  }
  if (event.ctrlKey || !event.deltaY) return;
  const scroller = event.target.closest?.(".relation-scroll");
  if (!scroller) return;
  const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (event.deltaY < 0 && scroller.scrollTop <= 0 || event.deltaY > 0 && scroller.scrollTop >= bottom - 1) event.preventDefault();
}

function mergeRelationPeers(data, targetCode = "") {
  const peers = new Map();
  const get = row => {
    const code = String(row.code || "");
    if (!/^\d{6}$/.test(code) || code === targetCode) return null;
    if (!peers.has(code)) peers.set(code, {code, name: row.name || code, market: row.market || "", wins: [], losses: [], commonDates: []});
    const peer = peers.get(code);
    for (const key of ["name", "initials", "industry", "tags", "tags_customized", "registered_province"]) {
      if (row[key] !== undefined) peer[key] = row[key];
    }
    return peer;
  };
  for (const key of ["wins", "losses"]) (data?.competition?.[key] || []).forEach(row => {
    const peer = get(row);
    if (peer) peer[key] = [...new Map([...peer[key], ...(row.rounds || [])].map(round => [`${round.date}|${round.next_date}|${round.boards}`, {...round}])).values()];
  });
  (data?.cooccurrences?.rows || []).forEach(row => {
    const peer = get(row);
    if (!peer) return;
    peer.name = row.name || peer.name;
    peer.commonDates = [...new Map([...peer.commonDates, ...(row.dates || [])].map(day => [day.date, {...day}])).values()];
  });
  const rows = [...peers.values()].map(peer => ({...peer, winCount: peer.wins.length, lossCount: peer.losses.length,
    commonCount: peer.commonDates.length,
    lastDate: [...peer.commonDates.map(day => day.date), ...peer.wins.map(round => round.next_date || round.date), ...peer.losses.map(round => round.next_date || round.date)].sort().at(-1) || ""}));
  return prioritizeLatest(rows.sort((a,b) => b.commonCount - a.commonCount || b.lastDate.localeCompare(a.lastDate) || a.code.localeCompare(b.code)));
}

function peerComparisonEntries(peer) {
  const entries = new Map();
  const get = date => {
    if (!entries.has(date)) entries.set(date, {date, common: null, wins: [], losses: []});
    return entries.get(date);
  };
  peer.commonDates.forEach(day => { get(day.date).common = day; });
  for (const key of ["wins", "losses"]) peer[key].forEach(round => get(round.date)[key].push(round));
  return [...entries.values()].sort((a,b) => String(b.date).localeCompare(String(a.date)));
}

function comparisonRunHTML(stock, observations, days, commonDates, kind) {
  const name = stock.name || "本票";
  const byDate = new Map(observations.map(row => [row.date, row]));
  const max = Math.max(0, ...observations.map(row => Number(row.boards) || 0));
  const nodes = days.map((day, index) => {
    const row = byDate.get(day);
    if (!row) return '<span class="comparison-node-empty" aria-hidden="true"></span>';
    const previous = byDate.get(days[index - 1]);
    const connected = previous && row.boards === previous.boards + 1;
    return `<button type="button" class="comparison-node ${commonDates.has(day) ? "shared-day" : ""} ${connected ? "connected" : ""}" data-relation-date="${escapeHTML(day)}" title="${escapeHTML(name)} · ${escapeHTML(dateLabel(day))} · ${row.boards} 板" aria-label="${escapeHTML(name)} ${escapeHTML(dateLabel(day))}，${row.boards} 板，查看当日全部股票"><time datetime="${escapeHTML(day)}">${escapeHTML(dateLabel(day).slice(5))}</time><strong>${numberValue(row.boards)}<small>板</small></strong></button>`;
  }).join("");
  const leaderLabel = kind === "leader" ? `<span class="comparison-leader-label" title="当前两票之外，在对比日期内有涨停记录的股票；按相交的连续涨停周期最高板选取，并列时依次按周期内较近的涨停日期、股票代码选取。仅使用已收录数据。">同期最高板</span>` : "";
  const range = kind === "leader" ? `<span class="comparison-leader-range" title="相交的已收录连续涨停周期">${escapeHTML(dateLabel(stock.start))} — ${escapeHTML(dateLabel(stock.end))}</span>` : "";
  return `<div class="comparison-run comparison-run-${kind}"><div class="comparison-run-name">${leaderLabel}${relationStockButton(stock)}<span>${numberValue(observations.length)} 个涨停日 · 最高 ${max} 板</span>${range}</div>${nodes}</div>`;
}

function comparisonSegmentsHTML(peer, detail) {
  if (!detail) return '<div class="loading-state">正在整理双方完整连板周期…</div>';
  if (detail.error) return `<div class="comparison-load-error"><p>${escapeHTML(detail.error)}</p><button type="button" class="button secondary small" data-retry-comparison>重新加载</button></div>`;
  const entries = peerComparisonEntries(peer);
  const targetName = state.selectedStock?.name || "本票";
  const maxDays = Math.max(0, ...detail.segments.map(segment => new Set([...segment.target_dates, ...segment.peer_dates, ...(segment.leader?.dates || [])].map(row => row.date)).size));
  const records = detail.segments.map(segment => {
    const leader = segment.leader;
    const days = [...new Set([...segment.target_dates, ...segment.peer_dates, ...(leader?.dates || [])].map(row => row.date))].sort();
    const commonDates = new Set(segment.common_dates);
    const outcomes = entries.filter(entry => entry.date >= segment.start && entry.date <= segment.end).flatMap(entry =>
      ["wins", "losses"].flatMap(key => entry[key].map(round => `<div class="peer-outcome ${key}"><span class="peer-outcome-date">${relationDateButton(round.date)} → ${round.next_date ? relationDateButton(round.next_date) : "待收录"}</span><p>${key === "wins" ? `本票晋级 ${round.boards + 1} 板，对方未入池。` : `对方晋级 ${round.boards + 1} 板，本票未入池。`}${verificationBadge()}</p></div>`))).join("");
    return `<article class="peer-comparison-record" data-comparison-start="${escapeHTML(segment.start)}" data-comparison-end="${escapeHTML(segment.end)}"><header><span class="comparison-period">${relationDateButton(segment.start)}${segment.start !== segment.end ? `<span>—</span>${relationDateButton(segment.end)}` : ""}</span><span class="peer-record-kind">同涨 ${numberValue(commonDates.size)} 天</span></header><div class="comparison-timeline-section" role="group" aria-label="${escapeHTML(dateLabel(segment.start))} 起涨停节点对比"><div class="comparison-timeline" style="--comparison-days:${days.length}">${comparisonRunHTML(state.selectedStock || {name: targetName}, segment.target_dates, days, commonDates, "target")}${comparisonRunHTML(peer, segment.peer_dates, days, commonDates, "peer")}${leader ? comparisonRunHTML(leader, leader.dates, days, new Set(), "leader") : ""}</div></div>${segment.leader === null ? '<p class="comparison-leader-empty">该周期暂无其他已收录的涨停股票。</p>' : ""}${outcomes}</article>`;
  }).join("");
  return records ? `<div class="peer-comparison-content" style="--comparison-max-days:${maxDays}">${records}</div>` : '<p class="relation-picker-empty">暂无已收录的共同涨停周期。</p>';
}

async function loadPeerComparison({retry = false} = {}) {
  const code = state.selectedStock?.code, peerCode = state.relationPeerCode;
  if (!code || !peerCode || state.tab !== "stock") return;
  const cache = state.comparisonCache || (state.comparisonCache = new Map());
  const key = `${code}|${peerCode}`;
  if (!retry && (cache.has(peerCode) || state.comparisonLoading === key)) return;
  if (retry) cache.delete(peerCode);
  state.comparisonLoading = key;
  if (retry) $("relation-peer-detail").innerHTML = peerComparisonHTML(state.relationPeers.find(peer => peer.code === peerCode));
  const generation = (state.comparisonRequest || 0) + 1;
  state.comparisonRequest = generation;
  try {
    const data = await request(`/api/comparison?${new URLSearchParams({code, peer: peerCode,
      exclude_st: state.relationExcludeST ? "1" : "0", exclude_gem: state.relationExcludeGEM ? "1" : "0",
      exclude_latest: state.relationExcludeLatest ? "1" : "0"})}`, "comparison");
    if (!data || state.comparisonCache !== cache || state.comparisonRequest !== generation) return;
    cache.set(peerCode, data);
  } catch (error) {
    if (state.comparisonCache === cache && state.comparisonRequest === generation) cache.set(peerCode, {error: error.message});
  } finally {
    if (state.comparisonRequest === generation && state.comparisonCache === cache) state.comparisonLoading = "";
    if (state.tab === "stock" && state.selectedStock?.code === code && state.relationPeerCode === peerCode && state.comparisonCache === cache && state.comparisonRequest === generation) {
      $("relation-peer-detail").innerHTML = peerComparisonHTML(state.relationPeers.find(peer => peer.code === peerCode));
    }
  }
}

const relationSortLabels = {winCount: "赢", lossCount: "输", commonCount: "同涨"};

function setRelationSort(key) {
  if (!Object.hasOwn(relationSortLabels, key)) return false;
  state.relationSortDirection = state.relationSort === key && state.relationSortDirection === "desc" ? "asc" : "desc";
  state.relationSort = key;
  return true;
}

function relationSortButtonsHTML() {
  return Object.entries(relationSortLabels).map(([key, label]) => {
    const active = (state.relationSort || "commonCount") === key;
    const ascending = active && state.relationSortDirection === "asc";
    const description = active ? `当前${ascending ? "升序" : "降序"}，点击${ascending ? "降序" : "升序"}` : "点击降序";
    return `<button type="button" data-relation-sort="${key}" aria-pressed="${active}" aria-label="按${label}排序，${description}" title="按${label}的次数排序，${description}">${label}<span aria-hidden="true">${active ? ascending ? "↑" : "↓" : "↕"}</span></button>`;
  }).join("");
}

function relationSortNote() {
  return `最新日涨停优先 · ${relationSortLabels[state.relationSort] || "同涨"}次数${state.relationSortDirection === "asc" ? "升序" : "降序"}`;
}

function filteredRelationPeers() {
  const query = (state.relationQuery || "").trim().toLocaleLowerCase();
  const key = Object.hasOwn(relationSortLabels, state.relationSort) ? state.relationSort : "commonCount";
  const direction = state.relationSortDirection === "asc" ? 1 : -1;
  const rows = (state.relationPeers || []).filter(peer =>
    (!state.relationExcludeST || !/^\*?ST/i.test(String(peer.name || "").replace(/\s+/g, "")))
    && (!state.relationExcludeGEM || !/^(300|301)/.test(String(peer.code)))
    && (!query || `${peer.name} ${peer.code}`.toLocaleLowerCase().includes(query)));
  return prioritizeLatest(rows.sort((a, b) => direction * (a[key] - b[key]) || b.lastDate.localeCompare(a.lastDate) || a.code.localeCompare(b.code)));
}

function setRelationFilters() {
  const excludeLatest = $("relation-exclude-latest").checked === true;
  const latestChanged = excludeLatest !== !!state.relationExcludeLatest;
  state.relationExcludeST = $("relation-exclude-st").checked;
  state.relationExcludeGEM = $("relation-exclude-gem").checked;
  state.relationExcludeLatest = excludeLatest;
  state.requests.comparison?.abort();
  state.comparisonCache = new Map();
  state.comparisonLoading = "";
  if (latestChanged && state.stockData?.stock?.code === state.selectedStock?.code) loadRelationHistory();
  else if (state.relationships) renderPeerSelection({resetScroll: true});
  updateURL();
}

function relationPeerRowsHTML(rows) {
  return rows.map(peer => {
    const selected = peer.code === state.relationPeerCode;
    return `<button type="button" class="relation-peer-choice ${latestLimitUp(peer) ? "latest-limit-up" : ""} ${selected ? "selected" : ""}" data-select-peer="${escapeHTML(peer.code)}" aria-pressed="${selected}" tabindex="${selected ? "0" : "-1"}"><span class="peer-choice-heading"><strong>${escapeHTML(peer.name)}</strong><small>${escapeHTML(peer.code)}</small>${latestLimitBadge(peer)}</span><span class="peer-choice-metrics"><span class="${peer.winCount ? "has-wins" : ""}">赢 ${numberValue(peer.winCount)}</span><span class="${peer.lossCount ? "has-losses" : ""}">输 ${numberValue(peer.lossCount)}</span><span>同涨 ${numberValue(peer.commonCount)}</span></span></button>`;
  }).join("") || '<p class="relation-picker-empty">没有匹配的股票</p>';
}

function peerComparisonHTML(peer) {
  if (!peer) return emptyHTML("暂无对比记录", state.relationQuery ? "换个股票名称或代码试试。" : state.relationExcludeST || state.relationExcludeGEM ? "当前筛选下没有关联股票，可取消勾选后查看。" : "已收录数据中暂无与其他股票的关联记录。");
  const targetName = state.selectedStock?.name || "本票";
  const entries = peerComparisonEntries(peer);
  const detail = state.comparisonCache?.get(peer.code);
  const records = comparisonSegmentsHTML(peer, detail);
  return `<header class="peer-detail-heading"><div><h4>${relationStockButton(peer)}<small>${escapeHTML(peer.code)}</small><small class="peer-stock-initials" title="股票名称首字母">${escapeHTML(nameInitials(peer) || "—")}</small><small class="peer-stock-location">${escapeHTML(regionLabel(peer))}</small>${latestLimitBadge(peer)}</h4><div class="peer-detail-profile"><p>与 ${escapeHTML(targetName)} 的历史对比</p><div class="stock-tags" aria-label="${escapeHTML(peer.name)}行业标签">${stockTags(peer).map(tag => `<span class="stock-tag">${escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</div></div></div></header><div class="peer-comparison-totals"><div class="wins"><span>本票胜出</span><strong>${numberValue(peer.winCount)}<small>轮</small></strong></div><div class="losses"><span>本票落后</span><strong>${numberValue(peer.lossCount)}<small>轮</small></strong></div><div><span>同日涨停</span><strong>${numberValue(peer.commonCount)}<small>次</small></strong></div></div><div class="peer-records-heading">对比记录 · ${detail?.segments ? `${numberValue(detail.segments.length)} 组周期` : `${numberValue(entries.length)} 个关联日`}<span class="peer-scroll-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7" r=".8" fill="currentColor" stroke="none"/></svg>Ctrl＋滚轮横向浏览</span></div><div class="relation-scroll peer-comparison-records" role="region" aria-label="与${escapeHTML(peer.name)}的对比记录" tabindex="0">${records}</div>`;
}

function renderComparisonWorkspace() {
  const rows = filteredRelationPeers();
  if (!rows.some(peer => peer.code === state.relationPeerCode)) state.relationPeerCode = rows[0]?.code || "";
  const selected = rows.find(peer => peer.code === state.relationPeerCode);
  return `<section class="relation-workspace" aria-label="股票关联对比"><aside class="relation-peer-sidebar" aria-label="关联股票"><header><h4>关联股票</h4><span id="relation-peer-count">${numberValue(rows.length)} 只</span></header><label class="relation-peer-filter"><span class="sr-only">筛选关联股票</span><input id="relation-peer-search" type="search" placeholder="股票名称 / 代码" autocomplete="off" value="${escapeHTML(state.relationQuery || "")}"></label><div id="relation-peer-sort" class="relation-peer-sort" role="group" aria-label="关联股票排序">${relationSortButtonsHTML()}</div><p id="relation-sort-note" class="relation-picker-note">${relationSortNote()}</p><div id="relation-peer-list" class="relation-scroll relation-peer-list" role="region" aria-label="去重后的关联股票列表" tabindex="0">${relationPeerRowsHTML(rows)}</div></aside><div id="relation-peer-detail" class="relation-peer-main" aria-live="polite">${peerComparisonHTML(selected)}</div></section>`;
}

function renderPeerSelection({resetScroll = false} = {}) {
  const rows = filteredRelationPeers();
  if (!rows.some(peer => peer.code === state.relationPeerCode)) state.relationPeerCode = rows[0]?.code || "";
  const list = $("relation-peer-list");
  const scrollTop = list.scrollTop;
  const hadFocus = list.contains(document.activeElement);
  list.innerHTML = relationPeerRowsHTML(rows);
  list.scrollTop = resetScroll ? 0 : scrollTop;
  $("relation-peer-count").textContent = `${numberValue(rows.length)} 只`;
  $("relation-peer-detail").innerHTML = peerComparisonHTML(rows.find(peer => peer.code === state.relationPeerCode));
  if (hadFocus) list.querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  loadPeerComparison();
}

function renderCompetition() {
  const data = state.relationships?.competition;
  $("relations-summary-note").hidden = !data;
  $("relations-summary-note").innerHTML = data ? ` · 汇总胜出、落后与同日涨停记录，关联股票去重展示。${latestPriorityNote()}` : "";
  if (!data) { $("competition-results").innerHTML = emptyHTML("暂无历史关联", "请选择股票查看。"); return; }
  $("competition-results").innerHTML = renderComparisonWorkspace();
}

function renderChart(rows) {
  const ordered = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const width = Math.max(680, ordered.length * 30 + 70), height = 184, left = 32, top = 24, bottom = 134;
  const max = Math.max(1, ...ordered.map((row) => Number(row.boards) || 0));
  const chartWidth = width - left - 20, barSlot = chartWidth / ordered.length, barWidth = Math.min(24, barSlot * .57);
  const ticks = [...new Set([0, Math.ceil(max / 2), max])];
  const grid = ticks.map((tick) => { const y = bottom - tick / max * (bottom - top); return `<line class="grid-line" x1="${left}" y1="${y}" x2="${width - 10}" y2="${y}"/><text x="${left - 9}" y="${y + 3}" text-anchor="end">${tick}</text>`; }).join("");
  const bars = ordered.map((row, index) => {
    const board = Number(row.boards) || 0, x = left + barSlot * index + (barSlot - barWidth) / 2, barHeight = Math.max(2, board / max * (bottom - top));
    const label = index % Math.ceil(ordered.length / 8) === 0 || index === ordered.length - 1;
    const center = x + barWidth / 2;
    const tooltipX = Math.max(left, Math.min(width - 182, center - 84));
    return `<a href="?date=${escapeHTML(row.date)}" data-relation-date="${escapeHTML(row.date)}" aria-label="${escapeHTML(dateLabel(row.date))}，${board} 板，查看当日全部股票"><title>${escapeHTML(row.date)}：${board} 板</title><rect x="${x.toFixed(2)}" y="${(bottom - barHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2" fill="${board === max ? "#d94236" : "#efcdbb"}"/>${ordered.length <= 24 ? `<text class="bar-label" x="${center.toFixed(2)}" y="${(bottom - barHeight - 5).toFixed(2)}" text-anchor="middle">${board}</text>` : ""}${label ? `<text x="${center.toFixed(2)}" y="155" text-anchor="middle">${escapeHTML(String(row.date).slice(0, 7).replace("-", "."))}</text><text x="${center.toFixed(2)}" y="170" text-anchor="middle">${escapeHTML(String(row.date).slice(8))}日</text>` : ""}<g class="chart-hover-label" transform="translate(${tooltipX.toFixed(2)} 0)" aria-hidden="true"><rect width="168" height="25" rx="4"/><text x="84" y="17" text-anchor="middle">${escapeHTML(dateLabel(row.date))} · ${board} 板</text></g></a>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="group" aria-label="${ordered.length} 个涨停交易日的连板高度，最高 ${max} 板">${grid}${bars}</svg>`;
}

function returnToDate() {
  state.selectedStock = null;
  state.boards = "";
  state.suggestions = [];
  state.suggestionsQuery = "";
  $("stock-search").value = "";
  $("stock-search").setCustomValidity("");
  hideSuggestions();
  loadDate();
}

function runQuery() {
  if (!$("stock-search").value.trim()) return returnToDate();
  loadStock();
}

function changeQueryDate() {
  updateDateNavigation();
  returnToDate();
}

function openMethod() { if (!$("method-dialog").open) $("method-dialog").showModal(); }

function validSiteLink(value) {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function renderSiteLinks(links) {
  document.querySelectorAll("[data-site-link]").forEach(link => {
    const url = validSiteLink(links[link.dataset.siteLink]);
    if (url) { link.href = url; link.removeAttribute("aria-disabled"); }
    else { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); }
  });
}

async function loadSiteLinks() {
  const generation = (state.siteLinksRequest || 0) + 1;
  state.siteLinksRequest = generation;
  try {
    const data = await request("/api/site-links", "site-links");
    if (state.siteLinksRequest === generation && data?.links && typeof data.links === "object" && !Array.isArray(data.links)) renderSiteLinks(data.links);
  } catch { /* Keep the current links while their configuration is unavailable. */ }
}

async function openAnnouncement() {
  const dialog = $("announcement-dialog");
  if (!dialog.open) dialog.showModal();
  const generation = (state.announcementRequest || 0) + 1;
  state.announcementRequest = generation;
  $("announcement-title").textContent = "公告";
  $("announcement-content").textContent = "正在读取公告…";
  $("announcement-content").classList.remove("empty");
  $("announcement-updated").hidden = true;
  $("retry-announcement").hidden = true;
  try {
    const data = await request("/api/announcement", "announcement");
    if (!data || state.announcementRequest !== generation || !dialog.open) return;
    const notice = data.announcement || {};
    const enabled = notice.enabled === true && typeof notice.content === "string" && notice.content.trim();
    $("announcement-title").textContent = enabled && typeof notice.title === "string" && notice.title.trim() ? notice.title : "公告";
    $("announcement-content").textContent = enabled ? notice.content : "暂无公告";
    $("announcement-content").classList.toggle("empty", !enabled);
    $("announcement-updated").hidden = !enabled || !notice.updated_at;
    $("announcement-updated").textContent = enabled && notice.updated_at ? `更新于 ${String(notice.updated_at).replace("T", " ").slice(0, 16)}` : "";
  } catch {
    if (state.announcementRequest !== generation || !dialog.open) return;
    $("announcement-content").textContent = "公告暂时无法读取，请稍后重试。";
    $("retry-announcement").hidden = false;
  }
}

$("announcement-button").addEventListener("click", openAnnouncement);
$("retry-announcement").addEventListener("click", openAnnouncement);
["close-announcement", "confirm-announcement"].forEach(id => $(id).addEventListener("click", () => $("announcement-dialog").close()));
$("announcement-dialog").addEventListener("close", () => { state.requests.announcement?.abort(); });
$("announcement-dialog").addEventListener("click", event => {
  if (event.target !== $("announcement-dialog")) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
$("method-nav").addEventListener("click", openMethod);
["close-method", "confirm-method"].forEach((id) => $(id).addEventListener("click", () => $("method-dialog").close()));
$("method-dialog").addEventListener("click", (event) => { if (event.target === $("method-dialog")) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$("retry-button").addEventListener("click", () => state.retry?.());
$("trade-date").addEventListener("change", changeQueryDate);
$("latest-date").addEventListener("click", () => { $("trade-date").value = state.meta?.latest_date || ""; changeQueryDate(); });
["prev-date", "next-date"].forEach((id) => $(id).addEventListener("click", () => { const dates = state.meta?.dates || [], current = $("trade-date").value; const target = id === "prev-date" ? [...dates].reverse().find((date) => date < current) : dates.find((date) => date > current); if (target) { $("trade-date").value = target; changeQueryDate(); } }));
$("nav-search").addEventListener("click", () => {
  if (state.tab === "blacklist") { if (state.selectedStock) loadStock({remember: false}); else loadDate(); }
  $("search-workspace").scrollIntoView({ block: "center" }); $("stock-search").focus();
});
$("nav-blacklist").addEventListener("click", () => { loadBlacklist(); $("main").scrollIntoView({block: "start"}); });
$("blacklist-refresh").addEventListener("click", loadBlacklist);
$("blacklist-add-form").addEventListener("submit", event => { event.preventDefault(); changeBlacklist("add"); });
$("blacklist-search").addEventListener("input", () => {
  state.blacklistSelected = null;
  state.blacklistSuggestions = [];
  state.requests["blacklist-search"]?.abort();
  hideBlacklistSuggestions();
  blacklistError();
  $("blacklist-feedback").textContent = "";
});
$("blacklist-search").addEventListener("input", debounce(searchBlacklistStocks));
$("blacklist-search").addEventListener("keydown", event => {
  if (event.key === "Escape") { hideBlacklistSuggestions(); return; }
  const rows = state.blacklistSuggestions || [];
  if ($("blacklist-suggestions").hidden || !rows.length) return;
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    state.blacklistSuggestionIndex = ((state.blacklistSuggestionIndex ?? -1) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    $("blacklist-suggestions").querySelectorAll("[role=option]").forEach((button, index) => { const active = index === state.blacklistSuggestionIndex; button.classList.toggle("focused", active); button.setAttribute("aria-selected", String(active)); });
    $("blacklist-search").setAttribute("aria-activedescendant", `blacklist-suggestion-${state.blacklistSuggestionIndex}`);
    $("blacklist-suggestions").querySelector('[aria-selected="true"]')?.scrollIntoView({block: "nearest"});
  } else if (event.key === "Enter" && state.blacklistSuggestionIndex >= 0) { event.preventDefault(); selectBlacklistStock(rows[state.blacklistSuggestionIndex]); }
});
$("blacklist-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-blacklist-suggestion]"); if (button) selectBlacklistStock(state.blacklistSuggestions[Number(button.dataset.blacklistSuggestion)]); });
$("blacklist-table-area").addEventListener("click", event => {
  const remove = event.target.closest("[data-blacklist-remove]");
  if (remove) { changeBlacklist("remove", remove.dataset.blacklistRemove); return; }
  const stock = event.target.closest("[data-blacklist-code]");
  if (stock) chooseStock({code: stock.dataset.blacklistCode, name: stock.dataset.blacklistName});
});
document.addEventListener("click", event => { if (!event.target.closest("#blacklist-add-form")) hideBlacklistSuggestions(); });
$("back-to-date").addEventListener("click", returnToDate);
$("edit-stock-profile-tags").addEventListener("click", () => {
  if (state.selectedStock) openTagEditor(state.selectedStock.code);
});
$("board-options").addEventListener("click", (event) => { const button = event.target.closest("[data-boards]"); if (button && button.dataset.boards !== state.boards) { state.boards = button.dataset.boards; loadDate(); } });
$("date-table-area").addEventListener("click", (event) => { const button = event.target.closest("[data-stock-code]"); if (button) chooseStock({ code: button.dataset.stockCode, name: button.dataset.stockName }); });
$("date-table-area").addEventListener("click", (event) => {
  const button = event.target.closest("[data-industry-scroll]");
  const board = $("date-table-area").querySelector(".industry-board");
  if (button && board) board.scrollBy({ left: Number(button.dataset.industryScroll) * (board.clientWidth - 25), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
});
document.querySelectorAll("[data-grouping]").forEach(button => button.addEventListener("click", () => {
  if (state.grouping === button.dataset.grouping) return;
  state.grouping = button.dataset.grouping;
  if (state.dateData) renderDate(state.dateData);
  updateURL();
}));
$("exclude-st").addEventListener("change", event => {
  state.excludeST = event.target.checked;
  state.dateData = null;
  loadDate();
});
$("exclude-gem").addEventListener("change", event => {
  state.excludeGEM = event.target.checked;
  state.dateData = null;
  loadDate();
});
$("date-table-area").addEventListener("click", event => {
  const button = event.target.closest("[data-edit-stock-tags]");
  if (button) openTagEditor(button.dataset.editStockTags);
});
["close-tags", "cancel-tags"].forEach(id => $(id).addEventListener("click", closeTagEditor));
$("tag-dialog").addEventListener("cancel", event => { if (state.tagSaving || state.tagBlacklistSaving) event.preventDefault(); });
$("tag-blacklist").addEventListener("change", changeTagBlacklist);
$("tag-editor-list").addEventListener("input", event => {
  if (!event.target.matches("[data-tag-index]")) return;
  state.tagDraft[Number(event.target.dataset.tagIndex)] = event.target.value;
  state.tagUseSource = false;
});
$("tag-editor-list").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-tag]");
  if (button) { state.tagDraft.splice(Number(button.dataset.removeTag), 1); state.tagUseSource = false; renderTagEditor(); }
});
$("tag-new").addEventListener("input", () => $("tag-new").setCustomValidity(""));
$("tag-new").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addTagDraft(); } });
$("add-tag").addEventListener("click", () => { if (state.tagEditorData) addTagDraft(); });
$("restore-source-tags").addEventListener("click", () => {
  if (!state.tagEditorData) return;
  state.tagDraft = state.tagEditorData.source_tag ? [state.tagEditorData.source_tag] : [];
  state.tagUseSource = true;
  $("tag-new").value = "";
  renderTagEditor();
});
$("tag-editor-form").addEventListener("submit", saveTagEditor);
["close-stock-note", "cancel-stock-note"].forEach(id => $(id).addEventListener("click", closeStockNoteEditor));
$("retry-stock-note").addEventListener("click", () => openStockNoteEditor(state.noteEditingCode));
$("stock-note-content").addEventListener("input", updateStockNoteControls);
for (const container of [$("date-table-area"), $("stock-profile-note")]) {
  container.addEventListener("click", event => {
    const button = event.target.closest("[data-edit-stock-note]");
    if (button) openStockNoteEditor(button.dataset.editStockNote);
  });
  for (const name of ["pointerover", "focusin"]) container.addEventListener(name, event => {
    const button = event.target.closest(".stock-note-button.has-note");
    if (button && !button.contains(event.relatedTarget)) showStockNoteTooltip(button);
  });
  for (const name of ["pointerout", "focusout"]) container.addEventListener(name, event => {
    const button = event.target.closest(".stock-note-button.has-note");
    if (button && !button.contains(event.relatedTarget)) scheduleStockNoteTooltipHide();
  });
  new MutationObserver(() => {
    if (state.noteTooltipAnchor && !state.noteTooltipAnchor.isConnected) hideStockNoteTooltip();
  }).observe(container, {childList: true, subtree: true});
}
for (const name of ["pointerenter", "focusin"]) $("stock-note-tooltip").addEventListener(name, () => clearTimeout(state.noteTooltipTimer));
for (const name of ["pointerleave", "focusout"]) $("stock-note-tooltip").addEventListener(name, scheduleStockNoteTooltipHide);
document.addEventListener("scroll", event => { if (!$("stock-note-tooltip").contains(event.target)) hideStockNoteTooltip(); }, true);
document.addEventListener("keydown", event => { if (event.key === "Escape") hideStockNoteTooltip(); });
window.addEventListener("resize", hideStockNoteTooltip);
$("stock-note-form").addEventListener("submit", saveStockNoteEditor);
$("stock-note-dialog").addEventListener("cancel", event => { event.preventDefault(); closeStockNoteEditor(); });
$("stock-note-dialog").addEventListener("click", event => {
  if (event.target !== $("stock-note-dialog")) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeStockNoteEditor();
});
$("date-table-area").addEventListener("scroll", updateIndustryNavigation, true);
window.addEventListener("resize", debounce(updateIndustryNavigation, 100));
document.addEventListener("wheel", containRelationWheel, {passive: false});
$("relation-height").addEventListener("input", event => {
  const height = Number(event.target.value);
  if (height >= 600 && height <= 1600) applyRelationHeight(height);
});
$("relation-height").addEventListener("change", event => applyRelationHeight(event.target.value));
$("reset-relation-height").addEventListener("click", () => applyRelationHeight(880));
$("relation-exclude-st").addEventListener("change", setRelationFilters);
$("relation-exclude-gem").addEventListener("change", setRelationFilters);
$("relation-exclude-latest").addEventListener("change", setRelationFilters);
$("stock-query-form").addEventListener("submit", (event) => { event.preventDefault(); runQuery(); });
$("stock-search").addEventListener("input", () => {
  $("stock-search").setCustomValidity("");
  state.selectedStock = null;
  state.suggestions = [];
  state.suggestionsQuery = "";
  state.requests.search?.abort();
  state.requests["stock-resolve"]?.abort();
  state.requests.stock?.abort();
  state.stockGeneration = (state.stockGeneration || 0) + 1;
  $("stock-query-button").disabled = false;
  if (!$("stock-search").value.trim()) returnToDate();
});
$("stock-search").addEventListener("input", debounce(searchStocks));
$("stock-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { hideSuggestions(); return; }
  if (["ArrowDown", "ArrowUp"].includes(event.key) && !$("stock-suggestions").hidden && state.suggestions.length) {
    event.preventDefault(); const count = Math.min(15, state.suggestions.length); state.suggestionIndex = (state.suggestionIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    $("stock-suggestions").querySelectorAll("[role=option]").forEach((button, index) => { button.classList.toggle("focused", index === state.suggestionIndex); button.setAttribute("aria-selected", String(index === state.suggestionIndex)); });
    $("stock-search").setAttribute("aria-activedescendant", `suggestion-${state.suggestionIndex}`); $("stock-suggestions").querySelector(`#suggestion-${state.suggestionIndex}`)?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && state.suggestionIndex >= 0 && !$("stock-suggestions").hidden) { event.preventDefault(); chooseStock(state.suggestions[state.suggestionIndex]); }
});
$("stock-suggestions").addEventListener("click", (event) => { const button = event.target.closest("[data-suggestion]"); if (button) chooseStock(state.suggestions[Number(button.dataset.suggestion)]); });
$("recent-stock-list").addEventListener("click", event => {
  const button = event.target.closest("[data-recent-code]");
  if (button) chooseStock({code: button.dataset.recentCode, name: button.dataset.recentName});
});
window.addEventListener("storage", event => {
  if (event.key === RECENT_STOCKS_KEY || event.key === null) {
    state.recentStocks = readRecentStocks();
    renderRecentStocks();
  }
});
document.addEventListener("click", (event) => { if (!event.target.closest(".stock-picker")) hideSuggestions(); });
$("stock-relations").addEventListener("input", event => {
  if (event.target.id !== "relation-peer-search") return;
  state.relationQuery = event.target.value;
  renderPeerSelection();
});
$("stock-relations").addEventListener("keydown", event => {
  const button = event.target.closest("[data-select-peer]");
  if (!button || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = filteredRelationPeers();
  if (!rows.length) return;
  event.preventDefault();
  const current = rows.findIndex(peer => peer.code === state.relationPeerCode);
  const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  state.relationPeerCode = rows[index].code;
  renderPeerSelection();
  $("relation-peer-list").querySelector('[aria-pressed="true"]')?.scrollIntoView({block: "nearest"});
});
function handleRelationClick(event) {
  if (!state.relationships) return;
  if (event.target.closest("[data-retry-comparison]")) { loadPeerComparison({retry: true}); return; }
  const sort = event.target.closest("[data-relation-sort]");
  if (sort && setRelationSort(sort.dataset.relationSort)) {
    $("relation-peer-sort").innerHTML = relationSortButtonsHTML();
    $("relation-sort-note").textContent = relationSortNote();
    renderPeerSelection({resetScroll: true});
    $("relation-peer-sort").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
    return;
  }
  const peer = event.target.closest("[data-select-peer]");
  if (peer) { state.relationPeerCode = peer.dataset.selectPeer; renderPeerSelection(); return; }
  const stock = event.target.closest("[data-relation-code]");
  if (stock) {
    chooseStock({ code: stock.dataset.relationCode, name: stock.dataset.relationName });
    $("search-workspace").scrollIntoView({ block: "start" });
    return;
  }
  const day = event.target.closest("[data-relation-date]");
  if (day) { event.preventDefault(); $("trade-date").value = day.dataset.relationDate; returnToDate(); $("search-workspace").scrollIntoView({ block: "start" }); }
}
$("stock-relations").addEventListener("click", handleRelationClick);
$("stock-cycles").addEventListener("click", handleRelationClick);
$("stock-chart").addEventListener("click", handleRelationClick);

async function restoreFromURL({remember = false} = {}) {
  state.requests.search?.abort();
  state.requests["stock-resolve"]?.abort();
  state.stockGeneration = (state.stockGeneration || 0) + 1;
  state.suggestions = [];
  state.suggestionsQuery = "";
  hideSuggestions();
  $("stock-search").setCustomValidity("");
  const params = new URLSearchParams(location.search);
  state.grouping = ["region", "pinyin", "code"].includes(params.get("layout")) ? params.get("layout") : "industry";
  state.excludeST = params.get("exclude_st") === "1";
  $("exclude-st").checked = state.excludeST;
  state.excludeGEM = params.get("exclude_gem") === "1";
  $("exclude-gem").checked = state.excludeGEM;
  state.relationExcludeST = params.get("relation_exclude_st") === "1";
  $("relation-exclude-st").checked = state.relationExcludeST;
  state.relationExcludeGEM = params.get("relation_exclude_gem") === "1";
  $("relation-exclude-gem").checked = state.relationExcludeGEM;
  state.relationExcludeLatest = params.get("relation_exclude_latest") === "1";
  $("relation-exclude-latest").checked = state.relationExcludeLatest;
  $("trade-date").value = params.get("date") || state.meta.latest_date || state.meta.dates.at(-1) || "";
  const boards = Number(params.get("boards"));
  state.boards = Number.isSafeInteger(boards) && boards > 0 ? String(boards) : "";
  const view = params.get("view") === "blacklist" ? "blacklist" : params.get("code") ? "stock" : "date";
  state.selectedStock = view === "stock" ? {code: params.get("code"), name: ""} : null;
  $("stock-search").value = state.selectedStock?.code || "";
  renderBoardOptions();
  updateDateNavigation();
  setView(view, false);
  // Initial loads and history traversal may normalize a URL, but never add a visit.
  updateURL({replace: true});
  if (view === "blacklist") await loadBlacklist();
  else if (view === "stock") await loadStock({remember});
  else await loadDate();
}

async function initialize() {
  applyRelationHeight(readRelationHeight(), false);
  state.recentStocks = readRecentStocks();
  renderRecentStocks();
  try {
    clearError();
    const meta = await request("/api/meta", "meta");
    if (!meta) return;
    state.meta = meta;
    renderMeta(meta, true);
    await restoreFromURL({remember: true});
  } catch (error) { showError(error, initialize); $("coverage-title").textContent = "本地服务未连接"; $("coverage-note").textContent = "请先启动服务，再重新加载页面。"; $("coverage-banner").classList.add("unavailable"); $("date-table-area").innerHTML = emptyHTML("等待连接历史数据库", "服务连接成功后，将展示真实的历史涨停记录。", "calendar"); $("date-table-area").setAttribute("aria-busy", "false"); renderBoardOptions(); }
}

window.addEventListener("popstate", () => { if (state.meta) return restoreFromURL(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.meta) refreshMeta(); });
new ResizeObserver(updateQueryStickyOffset).observe($("stock-sticky"));
loadSiteLinks();
initialize();
// Expose font readiness for local preview checks without changing page content.
document.fonts.ready.then(() => {
  const loaded = [...document.fonts].filter(face => face.family.replaceAll('"', "") === "Noto Sans SC" && face.status === "loaded");
  document.documentElement.dataset.uiFont = loaded.length ? "Noto Sans SC" : "fallback";
  document.documentElement.dataset.uiFontWeights = loaded.map(face => face.weight).join(",");
});
