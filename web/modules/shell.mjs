// shell: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {meta: null, retry: null};
  const keys = new Set(["latestLimitUps","meta","retry","metaPoll","siteLinksRequest","announcementRequest"]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown shell state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown shell state: ' + key); featureState[key] = value; return value; }

function latestLimitUp(row) { return featureState.latestLimitUps?.has(String(row.code)) || false; }

function prioritizeLatest(rows, historicalOnly = false) {
  return [...rows].sort((a, b) => Number(features.shell.latestLimitUp(b) && (!historicalOnly || b.date !== featureState.meta?.latest_date)) - Number(features.shell.latestLimitUp(a) && (!historicalOnly || a.date !== featureState.meta?.latest_date)));
}

function latestLimitBadge(row) {
  if (!features.shell.latestLimitUp(row)) return "";
  const day = featureState.meta.latest_date;
  return `<span class="latest-limit-badge" title="最新交易日 ${features.format.escapeHTML(features.format.dateLabel(day))} 涨停 · ${features.format.numberValue(featureState.latestLimitUps.get(String(row.code)))} 板">${features.format.escapeHTML(features.format.dateLabel(day).slice(5))} 涨停</span>`;
}

function latestPriorityNote() {
  return featureState.meta?.latest_date ? `<span class="latest-priority-note"><i aria-hidden="true"></i>${features.format.escapeHTML(features.format.dateLabel(featureState.meta.latest_date))} 涨停股票高亮置顶</span>` : "";
}

function showError(error, retry) { $("error-message").textContent = error.message || "无法连接本地服务，请确认服务正在运行。"; $("error-banner").hidden = false; featureState.retry = retry; }

function clearError() { $("error-banner").hidden = true; featureState.retry = null; }

function setStats(id, values = {}) { $(id).querySelectorAll("[data-stat]").forEach((element) => { element.textContent = features.format.numberValue(values[element.dataset.stat]); }); }

function updateQueryStickyOffset() {
  const query = $("stock-sticky");
  const offset = query.getBoundingClientRect().height + (parseFloat(getComputedStyle(query).top) || 0);
  document.documentElement.style.setProperty("--query-sticky-bottom", `${Math.ceil(offset)}px`);
}

function renderMeta(meta, initial = false) {
  features.shareholders.updateShareholderAlerts(meta);
  document.documentElement.classList.toggle("read-only", !features.tags.canEditTags());
  $("nav-blacklist").disabled = false;
  $("nav-tags").disabled = false;
  features.blacklist.updateBlacklistControls();
  featureState.latestLimitUps = new Map((meta.latest_limit_ups || []).map(row => [String(row.code), Number(row.boards)]));
  const coverage = meta.coverage || {};
  const dates = [...new Set(meta.dates || [])].sort();
  meta.dates = dates;
  meta.query_dates = [...new Set([...dates, ...(meta.live?.dates || [])])].sort();
  $("range-label").textContent = `${features.format.dateLabel(meta.available_start || meta.range_start)} — ${features.format.dateLabel(meta.available_end || meta.range_end)}`;
  $("range-detail").textContent = `${features.format.numberValue(coverage.days)} 个有数据交易日 · 本地历史库`;
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
    ? `${features.format.dateLabel(meta.available_start)} 至 ${features.format.dateLabel(meta.available_end)} · ${features.format.numberValue(coverage.days)} 个交易日${waitingForLatest ? "" : ` · 缺失日期 ${features.format.numberValue((meta.missing_dates || []).length)}`} · 来源：${source}`
    : coverage.note || "按来源公开股票池收录，数据完整性以实际收录情况为准。";
  $("coverage-count").textContent = `${features.format.numberValue(coverage.records)} 条记录 / ${features.format.numberValue(coverage.stocks)} 只股票`;
  const autoStatus = meta.auto_update_status;
  const checked = meta.auto_update_checked_at ? `${features.format.dateLabel(meta.auto_update_checked_at.slice(0, 10))} ${meta.auto_update_checked_at.slice(11, 16)}` : "";
  const pending = meta.auto_update_pending || [];
  const onlyHistoricalGaps = pending.length > 0 && meta.latest_date === meta.auto_update_expected && pending.every(day => day < meta.latest_date);
  const updateSchedule = `交易日 ${meta.auto_update_time || "15:30"} 更新`;
  $("auto-update-note").textContent = autoStatus === "updating"
    ? `自动更新已开启 · ${updateSchedule} · 正在检查并补充数据…`
    : onlyHistoricalGaps
      ? `自动更新已开启 · ${updateSchedule} · 最新收录 ${features.format.dateLabel(meta.latest_date)} · ${features.format.numberValue(pending.length)} 个历史日期待重试`
    : autoStatus === "error"
      ? `自动更新暂未完成 · ${updateSchedule} · 每 5 分钟自动重试${checked ? ` · 最近检查 ${checked}` : ""}`
      : autoStatus === "waiting"
        ? `自动更新已开启 · ${updateSchedule} · 等待 ${pending.map(features.format.dateLabel).join("、")} 来源数据 · 每 5 分钟重试${checked ? ` · 最近检查 ${checked}` : ""}`
        : autoStatus === "current"
          ? `自动更新已开启 · ${updateSchedule} · 最近检查 ${checked}`
          : "自动更新尚未启动，请重新启动本地服务。";
  $("auto-update-note").title = meta.auto_update_error || "按上海时间每个交易日 15:30 起检查当天数据；未发布时每 5 分钟重试，历史缺口继续补充。";
  if (meta.live?.enabled) {
    const live = meta.live;
    const stamp = live.fetched_at ? `${features.format.dateLabel(live.fetched_at.slice(0, 10))} ${live.fetched_at.slice(11, 19)}` : "";
    const progress = live.status === "error" ? "获取失败，保留上次数据并自动重试"
      : live.status === "waiting" ? "等待来源数据，每分钟重试"
      : live.polling ? "盘中暂定" : "交易时段自动检查";
    $("auto-update-note").textContent = `盘中每分钟更新 · ${progress}${stamp ? ` · 最近获取 ${stamp}` : ""} · 15:30 起确认收盘档案`;
    $("auto-update-note").title = `${live.note}${live.error ? `\n${live.error}` : ""}\n${$("auto-update-note").title}`;
  }
  $("footer-source").textContent = "公开数据";
  $("method-source").textContent = source;
  $("method-note").textContent = `${meta.method_note || "连板高度以数据源提供的收盘涨停记录为准。缺失记录不用于推断股票是否断板。"}${meta.scope_note ? `\n\n${meta.scope_note}` : ""}`;
  $("method-coverage").textContent = `${coverage.note || "以实际收录为准。"}\n已收录 ${features.format.numberValue(coverage.days)} 个交易日，${features.format.numberValue(coverage.stocks)} 只股票，${features.format.numberValue(coverage.records)} 条记录。`;
  $("method-updated").textContent = features.format.textValue(meta.updated_at);
  $("trade-date").min = meta.available_start || meta.range_start || "";
  $("trade-date").max = meta.query_dates.at(-1) || meta.available_end || meta.range_end || "";
  $("latest-date").disabled = !meta.query_dates.length;

  clearTimeout(featureState.metaPoll);
  const industryStatus = meta.industry_status || "empty";
  const cached = Boolean(meta.industry_fetched_at);
  $("industry-note").textContent = cached
    ? `行业：申万一级（当前分类） · ${features.format.dateLabel(meta.industry_fetched_at.slice(0, 10))} 获取${industryStatus === "updating" ? " · 正在检查更新" : industryStatus === "error" ? " · 更新失败，使用缓存" : ""}`
    : industryStatus === "error" ? "行业暂未获取成功，稍后自动重试。" : "正在自动获取申万行业分类…";
  if (meta.default_tag_mode === "concept_intersection") {
    $("industry-note").textContent = `默认标签：同花顺与财联社共有概念${meta.concept_fetched_at ? ` · ${features.format.dateLabel(meta.concept_fetched_at.slice(0, 10))} 获取` : ""}${meta.concept_status === "updating" ? " · 正在补充" : meta.concept_status === "partial" || meta.concept_status === "error" ? " · 部分待重试，保留已验证缓存" : ""}`;
  }
  $("method-note").textContent += meta.default_tag_mode === "concept_intersection"
    ? "\n\n默认标签取同花顺与财联社当前概念的交集，统一等价名称，排除昨日涨停、百日新高、省份等信息；未匹配不猜测补充。共有概念与自定义标签合并去重展示，自动更新保留自定义标签，手动移除的默认概念不会被加回。多个标签可跨列展示，股票总数去重。概念与注册省份均为当前资料，不代表历史当日归属。"
    : "\n\n标签默认取自申万一级分类，可按股票编辑，手动标签跨日期使用。多个标签可跨列展示，股票总数去重。标签与注册省份均为当前资料。";
  const registrationStatus = meta.registration_status || "empty";
  $("registration-note").textContent = meta.registration_fetched_at
    ? `注册省份：公司当前资料 · ${features.format.dateLabel(meta.registration_fetched_at.slice(0, 10))} 获取${registrationStatus === "updating" ? " · 正在检查更新" : registrationStatus === "error" ? " · 更新失败，使用缓存" : ""}`
    : registrationStatus === "error" ? "注册省份暂未获取成功，稍后自动重试。" : "正在自动获取公司注册省份…";
  $("method-note").textContent += "\n\n注册省份来自东方财富公司当前资料的省份字段，仅获取和保存省份。";
  $("method-note").textContent += "\n\n个股历史、同期竞争和同日涨停统一按全部已收录数据的起止日期统计，上方查询日期仅用于当日涨停查询。同期竞争比较前日同板数、下一交易日的晋级情况，沪深主板合并、ST 单独比较。从首板进二板到更高板数都逐轮展示，每个晋级批次计 1 轮胜负，同一轮涉及的对手另行列出；对手名单中的数字为与该股票交手的轮次。赢过和输给的名单均为涨停池比较结果；未入池不代表已确认未涨停，胜负标记为待行情核实。缺失交易日及最新收录日之后的结果不计入胜负。同日涨停统计全市场已收录股票，不限板数，每只股票每天计 1 次，不含本票，并列出具体日期。";
  $("method-note").textContent += "\n\n交易日概览的最高连板包含停牌保留高度。停复牌资料来自东方财富，只有确认全天停牌、且停牌前一交易日有连板记录的股票才保留原高度；不会把停牌日记为涨停，也不会增加涨停家数或同日涨停次数。复牌当日起不再按停牌保留。";
  featureState.metaPoll = setTimeout(features.shell.refreshMeta, autoStatus === "updating" || industryStatus === "updating" || registrationStatus === "updating" || meta.suspension_updating ? 3000 : 60000);
}

async function refreshMeta() {
  try {
    const previousIndustry = featureState.meta?.industry_fetched_at;
    const previousConcepts = featureState.meta?.concept_fetched_at;
    const previousTagAliases = featureState.meta?.tag_alias_revision;
    const previousTagCatalog = featureState.meta?.tag_catalog_revision;
    const previousRegistration = featureState.meta?.registration_fetched_at;
    const previousStart = featureState.meta?.available_start;
    const previousEnd = featureState.meta?.available_end;
    const previousRecords = featureState.meta?.coverage?.records;
    const previousRevision = featureState.meta?.archive_updated_at;
    const previousLatest = featureState.meta?.query_dates?.at(-1) || featureState.meta?.latest_date;
    const previousLive = featureState.meta?.live?.fetched_at;
    const previousLiveDate = featureState.meta?.live?.date;
    const previousSuspension = featureState.meta?.suspension_revision;
    const followingLatest = !$("trade-date").value || $("trade-date").value === previousLatest;
    const meta = await features.api.request("/api/meta", "meta");
    if (meta) {
      featureState.meta = meta; features.shell.renderMeta(meta); features.daily.updateDateNavigation();
      features.shell.loadSiteLinks();
      const archiveChanged = meta.archive_updated_at !== previousRevision || meta.available_start !== previousStart || meta.available_end !== previousEnd || meta.coverage?.records !== previousRecords;
      const profilesChanged = meta.industry_fetched_at !== previousIndustry || meta.registration_fetched_at !== previousRegistration || meta.concept_fetched_at !== previousConcepts || meta.tag_alias_revision !== previousTagAliases || meta.tag_catalog_revision !== previousTagCatalog;
      const latestQuery = meta.query_dates.at(-1);
      const queryDateChanged = followingLatest && latestQuery && latestQuery !== previousLatest;
      if (queryDateChanged) $("trade-date").value = latestQuery;
      features.daily.updateDateNavigation();
      const liveChanged = meta.live?.fetched_at !== previousLive &&
        (meta.live?.dates?.includes($("trade-date").value) || previousLiveDate === $("trade-date").value);
      if (features.navigation.read("tab") === "date" && (archiveChanged || profilesChanged || liveChanged || queryDateChanged || meta.suspension_revision !== previousSuspension)) features.daily.loadDate({quiet: true});
      else if (features.navigation.read("tab") === "date" && features.daily.read("dateData")) features.daily.renderDateStatus(features.daily.read("dateData"));
      if (features.navigation.read("tab") === "stock" && (archiveChanged || profilesChanged)) features.stock.loadStock({remember: false});
      if (features.navigation.read("tab") === "intraday" && profilesChanged) features.intraday.loadIntraday();
      else if (features.navigation.read("tab") === "intraday" && meta.live?.enabled) features.intraday.refreshVisibleMinuteData();
      if (features.navigation.read("tab") === "blacklist" && profilesChanged) features.blacklist.loadBlacklist();
    }
  } catch {
    $("auto-update-note").textContent = "更新状态暂时无法读取，将在 1 分钟后重试。";
    clearTimeout(featureState.metaPoll);
    featureState.metaPoll = setTimeout(features.shell.refreshMeta, 60000);
  }
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
    const url = features.shell.validSiteLink(links[link.dataset.siteLink]);
    if (url) { link.href = url; link.removeAttribute("aria-disabled"); }
    else { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); }
  });
}

async function loadSiteLinks() {
  const generation = (featureState.siteLinksRequest || 0) + 1;
  featureState.siteLinksRequest = generation;
  try {
    const data = await features.api.request("/api/site-links", "site-links");
    if (featureState.siteLinksRequest === generation && data?.links && typeof data.links === "object" && !Array.isArray(data.links)) features.shell.renderSiteLinks(data.links);
  } catch { /* Keep the current links while their configuration is unavailable. */ }
}

async function openAnnouncement() {
  const dialog = $("announcement-dialog");
  if (!dialog.open) dialog.showModal();
  const generation = (featureState.announcementRequest || 0) + 1;
  featureState.announcementRequest = generation;
  $("announcement-title").textContent = "公告";
  $("announcement-content").textContent = "正在读取公告…";
  $("announcement-content").classList.remove("empty");
  $("announcement-updated").hidden = true;
  $("retry-announcement").hidden = true;
  try {
    const data = await features.api.request("/api/announcement", "announcement");
    if (!data || featureState.announcementRequest !== generation || !dialog.open) return;
    const notice = data.announcement || {};
    const enabled = notice.enabled === true && typeof notice.content === "string" && notice.content.trim();
    $("announcement-title").textContent = enabled && typeof notice.title === "string" && notice.title.trim() ? notice.title : "公告";
    $("announcement-content").textContent = enabled ? notice.content : "暂无公告";
    $("announcement-content").classList.toggle("empty", !enabled);
    $("announcement-updated").hidden = !enabled || !notice.updated_at;
    $("announcement-updated").textContent = enabled && notice.updated_at ? `更新于 ${String(notice.updated_at).replace("T", " ").slice(0, 16)}` : "";
  } catch {
    if (featureState.announcementRequest !== generation || !dialog.open) return;
    $("announcement-content").textContent = "公告暂时无法读取，请稍后重试。";
    $("retry-announcement").hidden = false;
  }
}

async function initialize() {
  features.preferences.applyRelationHeight(features.preferences.readRelationHeight(), false);
  features.stock.write("recentStocks", features.preferences.readRecentStocks());
  features.stock.renderRecentStocks();
  try {
    features.shell.clearError();
    const meta = await features.api.request("/api/meta", "meta");
    if (!meta) return;
    featureState.meta = meta;
    features.shell.renderMeta(meta, true);
    await features.navigation.restoreFromURL({remember: true});
  } catch (error) { features.shell.showError(error, features.shell.initialize); $("coverage-title").textContent = "本地服务未连接"; $("coverage-note").textContent = "请先启动服务，再重新加载页面。"; $("coverage-banner").classList.add("unavailable"); $("date-table-area").innerHTML = features.format.emptyHTML("等待连接历史数据库", "服务连接成功后，将展示真实的历史涨停记录。", "calendar"); $("date-table-area").setAttribute("aria-busy", "false"); features.daily.renderBoardOptions(); }
}

function updateBackToTop() {
  $("back-to-top").hidden = window.scrollY < window.innerHeight;
}

  const bindings = {
binding001() {
$("announcement-button").addEventListener("click", features.shell.openAnnouncement);
},
binding002() {
$("retry-announcement").addEventListener("click", features.shell.openAnnouncement);
},
binding003() {
["close-announcement", "confirm-announcement"].forEach(id => $(id).addEventListener("click", () => $("announcement-dialog").close()));
},
binding004() {
$("announcement-dialog").addEventListener("close", () => { features.api.channels.announcement?.abort(); });
},
binding005() {
$("announcement-dialog").addEventListener("click", event => {
  if (event.target !== $("announcement-dialog")) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
},
binding006() {
$("method-nav").addEventListener("click", features.shell.openMethod);
},
binding007() {
["close-method", "confirm-method"].forEach((id) => $(id).addEventListener("click", () => $("method-dialog").close()));
},
binding008() {
$("method-dialog").addEventListener("click", (event) => { if (event.target === $("method-dialog")) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
},
binding009() {
$("retry-button").addEventListener("click", () => featureState.retry?.());
},
binding083() {
window.addEventListener("resize", features.tags.positionTagSuggestions);
},
binding085() {
$("add-tag").addEventListener("click", () => { if (features.tags.read("tagEditorData")) features.tags.addTagDraft(); });
},
binding105() {
document.addEventListener("keydown", event => { if (event.key === "Escape") features.notes.hideStockNoteTooltip(); });
},
binding106() {
window.addEventListener("resize", features.notes.hideStockNoteTooltip);
},
binding107() {
window.addEventListener("resize", features.notes.resizeStockNoteContents);
},
binding133() {
$("back-to-top").addEventListener("click", () => {
  window.scrollTo({top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
});
},
binding134() {
window.addEventListener("scroll", features.shell.updateBackToTop, {passive: true});
},
binding135() {
window.addEventListener("resize", features.shell.updateBackToTop);
},
binding136() {
window.addEventListener("pageshow", features.shell.updateBackToTop);
},
binding137() {
features.shell.updateBackToTop();
},
binding139() {
document.addEventListener("visibilitychange", () => { if (!document.hidden && featureState.meta) features.shell.refreshMeta(); });
},
binding141() {
features.shell.loadSiteLinks();
},
binding142() {
features.shell.initialize();
},
binding143() {
document.fonts.ready.then(() => {
  const loaded = [...document.fonts].filter(face => face.family.replaceAll('"', "") === "Noto Sans SC" && face.status === "loaded");
  document.documentElement.dataset.uiFont = loaded.length ? "Noto Sans SC" : "fallback";
  document.documentElement.dataset.uiFontWeights = loaded.map(face => face.weight).join(",");
});
}
};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, latestLimitUp, prioritizeLatest, latestLimitBadge, latestPriorityNote, showError, clearError, setStats, updateQueryStickyOffset, renderMeta, refreshMeta, openMethod, validSiteLink, renderSiteLinks, loadSiteLinks, openAnnouncement, initialize, updateBackToTop };
}
