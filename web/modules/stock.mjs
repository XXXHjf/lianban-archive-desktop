// stock: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {relationExcludeST: false, relationExcludeGEM: false, relationExcludeLatest: false, stockData: null, selectedStock: null, suggestions: [], suggestionIndex: -1, relationPeers: [], relationPeerCode: "", relationQuery: "", relationSort: "commonCount", relationSortDirection: "desc"};
  const keys = new Set(["recentStocks","selectedStock","relationExcludeST","relationExcludeGEM","relationExcludeLatest","stockData","suggestionIndex","suggestions","suggestionsQuery","stockGeneration","relationsRequest","relationsLoading","comparisonCache","comparisonLoading","relationships","relationPeers","relationPeerCode","relationQuery","comparisonRequest","relationSortDirection","relationSort"]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown stock state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown stock state: ' + key); featureState[key] = value; return value; }
const relationSortLabels = {winCount: "赢", lossCount: "输", commonCount: "同涨"};
function renderRecentStocks() {
  $("recent-stock-list").innerHTML = (featureState.recentStocks || []).map(stock => `<button type="button" class="recent-stock" data-recent-code="${features.format.escapeHTML(stock.code)}" data-recent-name="${features.format.escapeHTML(stock.name)}" title="${features.format.escapeHTML(stock.name)} ${features.format.escapeHTML(stock.code)} · 查看历史">${features.format.escapeHTML(stock.name)}</button>`).join("") || '<span class="recent-stocks-empty">暂无记录</span>';
}

function rememberStock(stock) {
  featureState.recentStocks = features.preferences.normalizeRecentStocks([stock, ...features.preferences.readRecentStocks(), ...(featureState.recentStocks || [])]);
  try { localStorage.setItem(features.preferences.RECENT_STOCKS_KEY, JSON.stringify(featureState.recentStocks)); } catch {}
  features.stock.renderRecentStocks();
}

function hideSuggestions() { $("stock-suggestions").hidden = true; $("stock-search").setAttribute("aria-expanded", "false"); $("stock-search").removeAttribute("aria-activedescendant"); featureState.suggestionIndex = -1; }

function showSuggestions(rows, query) {
  featureState.suggestions = rows;
  featureState.suggestionsQuery = query;
  featureState.suggestionIndex = -1;
  $("stock-suggestions").innerHTML = rows.length ? rows.slice(0, 15).map((stock, index) => `<li role="presentation"><button type="button" role="option" aria-selected="false" id="suggestion-${index}" data-suggestion="${index}"><span class="suggestion-code">${features.format.escapeHTML(stock.code)}</span><span>${features.format.escapeHTML(stock.name)}</span><span class="suggestion-market">${features.format.escapeHTML(features.format.marketValue(stock.market))}</span></button></li>`).join("") : '<li role="presentation" class="suggestion-message">未找到已收录的股票，请尝试名称、代码或首字母。</li>';
  $("stock-suggestions").hidden = false;
  $("stock-search").setAttribute("aria-expanded", "true");
}

async function searchStocks() {
  const query = $("stock-search").value.trim();
  if (featureState.selectedStock) return;
  if (!query) { features.stock.hideSuggestions(); return; }
  try {
    const data = await features.api.request(`/api/stocks?${new URLSearchParams({ q: query })}`, "search");
    if (!data || featureState.selectedStock || $("stock-search").value.trim() !== query) return;
    features.stock.showSuggestions(data.rows || [], query);
  } catch (error) {
    $("stock-suggestions").innerHTML = '<li role="presentation" class="suggestion-message">暂时无法检索股票，仍可输入完整代码查询。</li>';
    $("stock-suggestions").hidden = false;
    $("stock-search").setAttribute("aria-expanded", "true");
  }
}

function chooseStock(stock, query = true) {
  featureState.selectedStock = { code: String(stock.code), name: stock.name || "", market: stock.market || "" };
  features.api.channels.search?.abort();
  features.api.channels["stock-resolve"]?.abort();
  $("stock-search").value = stock.name ? `${stock.name} ${stock.code}` : stock.code;
  features.stock.hideSuggestions();
  features.navigation.setView("stock");
  if (query) features.stock.loadStock();
}

async function loadStock({remember = true, quiet = false} = {}) {
  let stock = featureState.selectedStock;
  if (!stock) {
    const raw = $("stock-search").value.trim();
    if (/^\d{6}$/.test(raw)) stock = { code: raw, name: "" };
    else if (raw) {
      try {
        let rows = featureState.suggestionsQuery === raw ? featureState.suggestions : null;
        if (!rows) {
          const data = await features.api.request(`/api/stocks?${new URLSearchParams({ q: raw })}`, "stock-resolve");
          if (!data || $("stock-search").value.trim() !== raw) return;
          rows = data.rows || [];
        }
        const initials = raw.replace(/\s+/g, "").toUpperCase();
        const exact = rows.filter(item => item.name === raw || item.initials === initials);
        stock = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
        if (!stock) features.stock.showSuggestions(rows, raw);
      } catch (error) { features.shell.showError(error, features.stock.loadStock); return; }
    }
  }
  if (!stock) { $("stock-search").setCustomValidity("请输入股票名称、代码或首字母；多个结果时请选择对应股票。"); $("stock-search").reportValidity(); return; }
  $("stock-search").setCustomValidity("");
  featureState.selectedStock = stock;
  const generation = (featureState.stockGeneration || 0) + 1;
  featureState.stockGeneration = generation;
  features.stock.hideSuggestions();
  features.shell.clearError();
  features.navigation.setView("stock", false);
  $("stock-results").hidden = false;
  $("stock-code-label").textContent = stock.code;
  if (!quiet) {
    $("stock-name-label").textContent = stock.name || "查询中";
    features.stock.renderStockProfile(stock, true);
  }
  features.api.channels.relations?.abort();
  featureState.relationsRequest = (featureState.relationsRequest || 0) + 1;
  featureState.relationsLoading = false;
  features.api.channels.comparison?.abort();
  featureState.comparisonCache = new Map();
  featureState.comparisonLoading = "";
  if (!quiet) {
    $("stock-cycles").innerHTML = '<div class="empty-inline">正在整理连板周期…</div>';
    $("stock-chart").innerHTML = '<div class="empty-inline">正在读取高度轨迹…</div>';
  }
  featureState.relationships = null;
  featureState.relationPeers = [];
  if (featureState.stockData?.stock?.code !== stock.code) {
    featureState.relationPeerCode = "";
    featureState.relationQuery = "";
  }
  $("stock-relations").setAttribute("aria-busy", "true");
  if (!quiet) {
    $("relations-range").textContent = "正在整理同期竞争和同日涨停记录…";
    $("competition-results").innerHTML = features.format.loadingHTML();
    features.shell.setStats("stock-stats");
  }

  $("stock-query-button").disabled = true;
  features.navigation.updateURL();
  try {
    const params = new URLSearchParams({ code: stock.code });
    const data = await features.api.request(`/api/stock?${params}`, "stock");
    if (!data || featureState.stockGeneration !== generation || features.navigation.read("tab") !== "stock") return;
    featureState.stockData = data;
    features.stock.renderStock(data);
    if (remember && data.rows?.length && data.stock?.name !== "尚未收录") features.stock.rememberStock(data.stock);
  } catch (error) {
    if (featureState.stockGeneration !== generation || features.navigation.read("tab") !== "stock") return;
    features.shell.showError(error, features.stock.loadStock);
    if (quiet) return;
    $("stock-cycles").innerHTML = "";
    $("stock-chart").innerHTML = '<div class="empty-inline">查询失败，暂无轨迹数据</div>';
    $("relations-range").textContent = "关联记录暂时无法读取";
    $("competition-results").innerHTML = features.format.emptyHTML("未能加载竞争记录", "请重新加载个股历史。");
    $("stock-name-label").textContent = stock.name || stock.code;
  } finally { if (featureState.stockGeneration === generation) { $("stock-relations").setAttribute("aria-busy", String(!!featureState.relationsLoading)); $("stock-query-button").disabled = false; } }
}

function renderStockProfile(stock, loading = false) {
  features.notes.renderStockHeaderNote(stock, loading);
  $("stock-initials-label").textContent = loading ? "…" : features.daily.nameInitials(stock) || "—";
  $("stock-blacklist-label").hidden = loading || stock.blacklisted !== true;
  $("stock-province-label").textContent = loading ? "…" : features.daily.regionLabel(stock);
  const tags = features.tags.stockTags(stock);
  $("stock-industry-tags").innerHTML = loading ? '<span class="stock-tag-empty">正在读取标签…</span>'
    : tags.map(tag => `<span class="stock-tag">${features.format.escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>';
  $("edit-stock-profile-tags").hidden = !features.tags.canEditTags();
  $("edit-stock-profile-tags").disabled = !features.tags.canEditTags() || loading || stock.name === "尚未收录";
  $("edit-stock-profile-tags").setAttribute("aria-label", `编辑${stock.name || stock.code}行业标签`);
}

function renderStock(data) {
  const rows = data.rows || [];
  const stock = data.stock || featureState.selectedStock;
  featureState.selectedStock = stock;
  $("stock-code-label").textContent = features.format.textValue(stock.code);
  $("stock-name-label").textContent = features.format.textValue(stock.name);
  features.stock.renderStockProfile(stock);
  $("stock-search").value = `${stock.name || ""} ${stock.code}`.trim();
  features.shell.setStats("stock-stats", data.stats || {});
  if (featureState.relationExcludeLatest) features.stock.loadRelationHistory();
  else features.stock.renderRelationships(data.relationships);

  $("stock-chart").innerHTML = rows.length ? features.stock.renderChart(rows) : '<div class="empty-inline">暂无已收录的涨停轨迹</div>';
  $("cycle-competition-scope").textContent = data.relationships?.competition?.scope_note || "";
  $("stock-cycles").innerHTML = features.stock.renderStockCycles(data);
  features.navigation.updateURL();
}

function relationStockButton(row) {
  return `<button type="button" class="stock-name-button relation-stock-name" data-relation-code="${features.format.escapeHTML(row.code)}" data-relation-name="${features.format.escapeHTML(row.name)}" title="查看${features.format.escapeHTML(row.name)}的股票详情">${features.format.escapeHTML(row.name)}</button>`;
}

function relationDateButton(day, label = features.format.dateLabel(day)) {
  return `<button type="button" class="relation-date" data-relation-date="${features.format.escapeHTML(day)}">${features.format.escapeHTML(label)}</button>`;
}

function renderRelationships(data) {
  featureState.relationships = data || null;
  featureState.relationPeers = features.stock.mergeRelationPeers(data, featureState.selectedStock?.code);
  $("relations-range").textContent = data ? `${featureState.relationExcludeLatest ? "历史数据" : "全部数据"} · ${data.range_end < data.range_start ? "暂无可用历史交易日" : `${features.format.dateLabel(data.range_start)} — ${features.format.dateLabel(data.range_end)}`} · 本票 ${features.format.numberValue(data.target_limit_days)} 个涨停日${featureState.relationExcludeLatest ? ` · 已剔除 ${features.format.dateLabel(features.shell.read("meta")?.latest_date)}` : ""}` : "暂无关联记录";
  features.stock.renderCompetition();
  features.stock.loadPeerComparison();
}

async function loadRelationHistory() {
  const code = featureState.selectedStock?.code;
  if (!code || features.navigation.read("tab") !== "stock") return;
  const generation = (featureState.relationsRequest || 0) + 1;
  featureState.relationsRequest = generation;
  features.api.channels.relations?.abort();
  features.api.channels.comparison?.abort();
  featureState.comparisonCache = new Map();
  featureState.comparisonLoading = "";
  featureState.relationsLoading = false;
  features.shell.clearError();
  if (!featureState.relationExcludeLatest) {
    features.stock.renderRelationships(featureState.stockData?.relationships);
    $("stock-relations").setAttribute("aria-busy", "false");
    return;
  }
  featureState.relationships = null;
  featureState.relationPeers = [];
  featureState.relationsLoading = true;
  $("stock-relations").setAttribute("aria-busy", "true");
  $("relations-range").textContent = "正在剔除最新交易日并重新统计历史关联…";
  $("competition-results").innerHTML = features.format.loadingHTML();
  try {
    const data = await features.api.request(`/api/stock?${new URLSearchParams({code, exclude_latest: "1"})}`, "relations");
    if (!data || featureState.relationsRequest !== generation || featureState.selectedStock?.code !== code || features.navigation.read("tab") !== "stock" || !featureState.relationExcludeLatest) return;
    features.stock.renderRelationships(data.relationships);
  } catch (error) {
    if (featureState.relationsRequest !== generation || featureState.selectedStock?.code !== code || features.navigation.read("tab") !== "stock") return;
    $("relations-range").textContent = "历史关联暂时无法读取";
    $("competition-results").innerHTML = features.format.emptyHTML("未能加载历史关联", "请重新加载后查看。");
    features.shell.showError(error, features.stock.loadRelationHistory);
  } finally {
    if (featureState.relationsRequest === generation && featureState.selectedStock?.code === code && features.navigation.read("tab") === "stock") {
      featureState.relationsLoading = false;
      $("stock-relations").setAttribute("aria-busy", "false");
    }
  }
}

function verificationBadge(label = "待行情核实") {
  return `<span class="verification-label" title="按涨停池比较：目前只确认一方晋级、另一方未入池；未入池不等于未涨停，仍需用完整行情核实。">${features.format.escapeHTML(label)}</span>`;
}

function renderRoundPeer(peer) {
  const tags = features.tags.stockTags(peer);
  const location = features.daily.regionLabel(peer);
  const tagTitle = "当前股票标签";
  return `<button type="button" class="round-peer ${features.shell.latestLimitUp(peer) ? "latest-limit-up" : ""} ${peer.is_target ? "round-target" : ""}" data-promotion="${features.format.escapeHTML(peer.promotion_status || "")}" data-relation-code="${features.format.escapeHTML(peer.code)}" data-relation-name="${features.format.escapeHTML(peer.name)}"><span class="round-peer-heading"><strong>${features.format.escapeHTML(peer.name)}</strong><small>${features.format.escapeHTML(peer.code)}</small>${peer.is_target ? '<span class="round-target-label">本票</span>' : ""}</span><span class="round-peer-profile"><span class="round-peer-location">${features.format.escapeHTML(location)}</span>${tags.length ? tags.map(tag => `<span class="round-peer-industry" title="${features.format.escapeHTML(tagTitle)}">${features.format.escapeHTML(tag)}</span>`).join("") : `<span class="round-peer-industry empty">${peer.tags_customized ? "暂无标签" : "行业待补充"}</span>`}</span></button>`;
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
    const dateRange = `${features.format.dateLabel(round.date)} → ${next ? features.format.dateLabel(next) : "下一交易日"}`;
    let description = "";
    if (round.outcome === "win") description = `本票晋级 ${round.boards + 1} 板，本批次胜出记 1 轮，涉及 ${round.wins.length} 只对手。`;
    else if (round.outcome === "loss") description = `本票次日未入池，同梯队有 ${round.losses.length} 只对手晋级 ${round.boards + 1} 板，本批次落后记 1 轮。`;
    else if (round.outcome === "cutoff") description = `${round.boards} 进 ${round.boards + 1} 的结果${next ? `需查看 ${features.format.dateLabel(next)}` : "尚未收录"}，超出当前数据收录范围，暂不计胜负。`;
    else if (round.outcome === "missing") description = `${features.format.dateLabel(next)} 的涨停池数据未确认，暂不计胜负。`;
    else if (round.outcome === "together") description = `本票与 ${round.together_count} 只同梯队股票共同晋级 ${round.boards + 1} 板，未形成单方胜负。`;
    else if (round.outcome !== "no_peers") description = "没有形成可归入单方晋级的胜负记录；共同未入池或板数异常不计胜负。";
    const heading = `<header class="competition-round-heading"><strong>${round.boards} 进 ${last.boards + 1}</strong><div class="competition-round-context"><span class="competition-round-date" title="${features.format.escapeHTML(dateRange)}">${features.format.escapeHTML(dateRange)}</span>${description ? `<span class="competition-round-description">${features.format.escapeHTML(description)}${round.wins.length || round.losses.length ? features.stock.verificationBadge() : ""}</span>` : ""}</div><span class="competition-round-status status-${features.format.escapeHTML(round.outcome)}">${features.format.escapeHTML(labels[round.outcome] || "待确认")}</span></header>`;
    if (round.outcome === "no_peers") return `<article class="competition-round competition-round-compact" data-round-date="${features.format.escapeHTML(round.date)}" data-round-height="${round.boards}" data-round-count="${count}">${heading}</article>`;
    const cohort = round.cohort || [...round.wins, ...round.losses];
    const order = members => features.shell.prioritizeLatest([...members].sort((a,b) => Number(!!b.is_target) - Number(!!a.is_target) || String(a.code).localeCompare(String(b.code))));
    const advanced = order(cohort.filter(peer => peer.promotion_status === "advanced"));
    const others = order(cohort.filter(peer => peer.promotion_status !== "advanced"));
    const group = (members, label, kind) => members.length ? `<section class="round-cohort-group" data-cohort-group="${kind}" aria-label="${features.format.escapeHTML(label)}"><h5>${features.format.escapeHTML(label)} <span>${features.format.numberValue(members.length)} 只</span></h5><div class="round-cohort-grid">${members.map(features.stock.renderRoundPeer).join("")}</div></section>` : "";
    const groups = advanced.length
      ? group(advanced, `晋级 ${round.boards + 1} 板`, "advanced") + group(others, "同梯队其他股票", "others")
      : `<div class="round-cohort-grid">${others.map(features.stock.renderRoundPeer).join("")}</div>`;
    const advancement = round.status === "compared" ? `已晋级 ${features.format.numberValue(advanced.length)} 只` : "晋级结果待确认";
    const opponentLists = cohort.length ? `<div class="round-opponents"><span>同梯队 ${features.format.numberValue(cohort.length)} 只 · ${advancement}</span>${groups}</div>` : "";
    return `<article class="competition-round" data-round-date="${features.format.escapeHTML(round.date)}" data-round-height="${round.boards}">${heading}<div class="competition-round-body">${opponentLists}<div class="competition-round-actions">${features.stock.relationDateButton(round.date, "查看起始日涨停明细")}${round.next_date ? features.stock.relationDateButton(round.next_date, "查看次日涨停明细") : ""}</div></div></article>`;
  }).join("");
  return `<section class="competition-rounds" aria-label="逐轮竞争"><div class="competition-rounds-heading"><h4>逐轮竞争</h4><span>共 ${features.format.numberValue(rounds.length)} 轮${segments.length < rounds.length ? ` · 合并展示 ${features.format.numberValue(segments.length)} 条` : ""} · 区域内滚动查看</span></div><div class="relation-scroll competition-rounds-scroll" role="region" aria-label="全部逐轮竞争记录" tabindex="0">${items}</div></section>`;
}

function renderStockCycles(data) {
  const cycles = data.cycles || [];
  const rounds = data.relationships?.competition?.rounds || [];
  return cycles.length ? cycles.map(cycle => {
    const uncertain = cycle.clipped || cycle.start_known === false;
    const status = uncertain ? "周期边界待确认" : cycle.ongoing ? `截至 ${features.format.dateLabel(data.as_of_date || data.range_end)} 仍在连板` : cycle.end_known === true ? "已结束" : "后续状态待确认";
    const count = Math.min(24, (cycle.dates || []).length || Number(cycle.boards) || 1);
    const dates = new Set(cycle.dates || []);
    const cycleRounds = rounds.filter(round => dates.size ? dates.has(round.date) : round.date >= cycle.start && round.date <= cycle.end);
    return `<article class="cycle-card cycle-with-rounds" data-cycle-start="${features.format.escapeHTML(cycle.start)}"><div class="cycle-summary"><div class="cycle-head"><strong>${features.format.numberValue(cycle.boards)}<small>板</small></strong><span class="cycle-status ${cycle.ongoing ? "ongoing" : ""}" title="${features.format.escapeHTML(status)}">${features.format.escapeHTML(status)}</span></div><div class="cycle-date">${features.format.escapeHTML(features.format.dateLabel(cycle.start))}<span>→</span>${features.format.escapeHTML(features.format.dateLabel(cycle.end))}</div><p class="cycle-height-label">周期内已收录的最高高度</p><div class="cycle-steps" aria-hidden="true">${Array.from({ length: count }, (_, index) => `<span class="cycle-step" style="height:${Math.min(28, 7 + index * (20 / count))}px"></span>`).join("")}</div>${cycle.note ? `<p class="cycle-note">${features.format.escapeHTML(cycle.note)}</p>` : ""}</div>${features.stock.renderCompetitionRounds({rounds: cycleRounds}) || '<p class="cycle-rounds-empty">该周期暂无已收录的竞争记录。</p>'}</article>`;
  }).join("") : features.format.emptyHTML("暂无连板周期", "已收录数据中没有这只股票的涨停周期。");
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
  return features.shell.prioritizeLatest(rows.sort((a,b) => b.commonCount - a.commonCount || b.lastDate.localeCompare(a.lastDate) || a.code.localeCompare(b.code)));
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
    return `<button type="button" class="comparison-node ${commonDates.has(day) ? "shared-day" : ""} ${connected ? "connected" : ""}" data-relation-date="${features.format.escapeHTML(day)}" title="${features.format.escapeHTML(name)} · ${features.format.escapeHTML(features.format.dateLabel(day))} · ${row.boards} 板" aria-label="${features.format.escapeHTML(name)} ${features.format.escapeHTML(features.format.dateLabel(day))}，${row.boards} 板，查看当日全部股票"><time datetime="${features.format.escapeHTML(day)}">${features.format.escapeHTML(features.format.dateLabel(day).slice(5))}</time><strong>${features.format.numberValue(row.boards)}<small>板</small></strong></button>`;
  }).join("");
  const leaderLabel = kind === "leader" ? `<span class="comparison-leader-label" title="当前两票之外，在对比日期内有涨停记录的股票；按相交的连续涨停周期最高板选取，并列时依次按周期内较近的涨停日期、股票代码选取。仅使用已收录数据。">同期最高板</span>` : "";
  const range = kind === "leader" ? `<span class="comparison-leader-range" title="相交的已收录连续涨停周期">${features.format.escapeHTML(features.format.dateLabel(stock.start))} — ${features.format.escapeHTML(features.format.dateLabel(stock.end))}</span>` : "";
  return `<div class="comparison-run comparison-run-${kind}"><div class="comparison-run-name">${leaderLabel}${features.stock.relationStockButton(stock)}<span>${features.format.numberValue(observations.length)} 个涨停日 · 最高 ${max} 板</span>${range}</div>${nodes}</div>`;
}

function comparisonSegmentsHTML(peer, detail) {
  if (!detail) return '<div class="loading-state">正在整理双方完整连板周期…</div>';
  if (detail.error) return `<div class="comparison-load-error"><p>${features.format.escapeHTML(detail.error)}</p><button type="button" class="button secondary small" data-retry-comparison>重新加载</button></div>`;
  const entries = features.stock.peerComparisonEntries(peer);
  const targetName = featureState.selectedStock?.name || "本票";
  const maxDays = Math.max(0, ...detail.segments.map(segment => new Set([...segment.target_dates, ...segment.peer_dates, ...(segment.leader?.dates || [])].map(row => row.date)).size));
  const records = detail.segments.map(segment => {
    const leader = segment.leader;
    const days = [...new Set([...segment.target_dates, ...segment.peer_dates, ...(leader?.dates || [])].map(row => row.date))].sort();
    const commonDates = new Set(segment.common_dates);
    const outcomes = entries.filter(entry => entry.date >= segment.start && entry.date <= segment.end).flatMap(entry =>
      ["wins", "losses"].flatMap(key => entry[key].map(round => `<div class="peer-outcome ${key}"><span class="peer-outcome-date">${features.stock.relationDateButton(round.date)} → ${round.next_date ? features.stock.relationDateButton(round.next_date) : "待收录"}</span><p>${key === "wins" ? `本票晋级 ${round.boards + 1} 板，对方未入池。` : `对方晋级 ${round.boards + 1} 板，本票未入池。`}${features.stock.verificationBadge()}</p></div>`))).join("");
    return `<article class="peer-comparison-record" data-comparison-start="${features.format.escapeHTML(segment.start)}" data-comparison-end="${features.format.escapeHTML(segment.end)}"><header><span class="comparison-period">${features.stock.relationDateButton(segment.start)}${segment.start !== segment.end ? `<span>—</span>${features.stock.relationDateButton(segment.end)}` : ""}</span><span class="peer-record-kind">同涨 ${features.format.numberValue(commonDates.size)} 天</span></header><div class="comparison-timeline-section" role="group" aria-label="${features.format.escapeHTML(features.format.dateLabel(segment.start))} 起涨停节点对比"><div class="comparison-timeline" style="--comparison-days:${days.length}">${features.stock.comparisonRunHTML(featureState.selectedStock || {name: targetName}, segment.target_dates, days, commonDates, "target")}${features.stock.comparisonRunHTML(peer, segment.peer_dates, days, commonDates, "peer")}${leader ? features.stock.comparisonRunHTML(leader, leader.dates, days, new Set(), "leader") : ""}</div></div>${segment.leader === null ? '<p class="comparison-leader-empty">该周期暂无其他已收录的涨停股票。</p>' : ""}${outcomes}</article>`;
  }).join("");
  return records ? `<div class="peer-comparison-content" style="--comparison-max-days:${maxDays}">${records}</div>` : '<p class="relation-picker-empty">暂无已收录的共同涨停周期。</p>';
}

async function loadPeerComparison({retry = false} = {}) {
  const code = featureState.selectedStock?.code, peerCode = featureState.relationPeerCode;
  if (!code || !peerCode || features.navigation.read("tab") !== "stock") return;
  const cache = featureState.comparisonCache || (featureState.comparisonCache = new Map());
  const key = `${code}|${peerCode}`;
  if (!retry && (cache.has(peerCode) || featureState.comparisonLoading === key)) return;
  if (retry) cache.delete(peerCode);
  featureState.comparisonLoading = key;
  if (retry) $("relation-peer-detail").innerHTML = features.stock.peerComparisonHTML(featureState.relationPeers.find(peer => peer.code === peerCode));
  const generation = (featureState.comparisonRequest || 0) + 1;
  featureState.comparisonRequest = generation;
  try {
    const data = await features.api.request(`/api/comparison?${new URLSearchParams({code, peer: peerCode,
      exclude_st: featureState.relationExcludeST ? "1" : "0", exclude_gem: featureState.relationExcludeGEM ? "1" : "0",
      exclude_latest: featureState.relationExcludeLatest ? "1" : "0"})}`, "comparison");
    if (!data || featureState.comparisonCache !== cache || featureState.comparisonRequest !== generation) return;
    cache.set(peerCode, data);
  } catch (error) {
    if (featureState.comparisonCache === cache && featureState.comparisonRequest === generation) cache.set(peerCode, {error: error.message});
  } finally {
    if (featureState.comparisonRequest === generation && featureState.comparisonCache === cache) featureState.comparisonLoading = "";
    if (features.navigation.read("tab") === "stock" && featureState.selectedStock?.code === code && featureState.relationPeerCode === peerCode && featureState.comparisonCache === cache && featureState.comparisonRequest === generation) {
      $("relation-peer-detail").innerHTML = features.stock.peerComparisonHTML(featureState.relationPeers.find(peer => peer.code === peerCode));
    }
  }
}

function setRelationSort(key) {
  if (!Object.hasOwn(relationSortLabels, key)) return false;
  featureState.relationSortDirection = featureState.relationSort === key && featureState.relationSortDirection === "desc" ? "asc" : "desc";
  featureState.relationSort = key;
  return true;
}

function relationSortButtonsHTML() {
  return Object.entries(relationSortLabels).map(([key, label]) => {
    const active = (featureState.relationSort || "commonCount") === key;
    const ascending = active && featureState.relationSortDirection === "asc";
    const description = active ? `当前${ascending ? "升序" : "降序"}，点击${ascending ? "降序" : "升序"}` : "点击降序";
    return `<button type="button" data-relation-sort="${key}" aria-pressed="${active}" aria-label="按${label}排序，${description}" title="按${label}的次数排序，${description}">${label}<span aria-hidden="true">${active ? ascending ? "↑" : "↓" : "↕"}</span></button>`;
  }).join("");
}

function relationSortNote() {
  return `最新日涨停优先 · ${relationSortLabels[featureState.relationSort] || "同涨"}次数${featureState.relationSortDirection === "asc" ? "升序" : "降序"}`;
}

function filteredRelationPeers() {
  const query = (featureState.relationQuery || "").trim().toLocaleLowerCase();
  const key = Object.hasOwn(relationSortLabels, featureState.relationSort) ? featureState.relationSort : "commonCount";
  const direction = featureState.relationSortDirection === "asc" ? 1 : -1;
  const rows = (featureState.relationPeers || []).filter(peer =>
    (!featureState.relationExcludeST || !/^\*?ST/i.test(String(peer.name || "").replace(/\s+/g, "")))
    && (!featureState.relationExcludeGEM || !/^(300|301)/.test(String(peer.code)))
    && (!query || `${peer.name} ${peer.code}`.toLocaleLowerCase().includes(query)));
  return features.shell.prioritizeLatest(rows.sort((a, b) => direction * (a[key] - b[key]) || b.lastDate.localeCompare(a.lastDate) || a.code.localeCompare(b.code)));
}

function setRelationFilters() {
  const excludeLatest = $("relation-exclude-latest").checked === true;
  const latestChanged = excludeLatest !== !!featureState.relationExcludeLatest;
  featureState.relationExcludeST = $("relation-exclude-st").checked;
  featureState.relationExcludeGEM = $("relation-exclude-gem").checked;
  featureState.relationExcludeLatest = excludeLatest;
  features.api.channels.comparison?.abort();
  featureState.comparisonCache = new Map();
  featureState.comparisonLoading = "";
  if (latestChanged && featureState.stockData?.stock?.code === featureState.selectedStock?.code) features.stock.loadRelationHistory();
  else if (featureState.relationships) features.stock.renderPeerSelection({resetScroll: true});
  features.navigation.updateURL();
}

function relationPeerRowsHTML(rows) {
  return rows.map(peer => {
    const selected = peer.code === featureState.relationPeerCode;
    return `<button type="button" class="relation-peer-choice ${features.shell.latestLimitUp(peer) ? "latest-limit-up" : ""} ${selected ? "selected" : ""}" data-select-peer="${features.format.escapeHTML(peer.code)}" aria-pressed="${selected}" tabindex="${selected ? "0" : "-1"}"><span class="peer-choice-heading"><strong>${features.format.escapeHTML(peer.name)}</strong><small>${features.format.escapeHTML(peer.code)}</small>${features.shell.latestLimitBadge(peer)}</span><span class="peer-choice-metrics"><span class="${peer.winCount ? "has-wins" : ""}">赢 ${features.format.numberValue(peer.winCount)}</span><span class="${peer.lossCount ? "has-losses" : ""}">输 ${features.format.numberValue(peer.lossCount)}</span><span>同涨 ${features.format.numberValue(peer.commonCount)}</span></span></button>`;
  }).join("") || '<p class="relation-picker-empty">没有匹配的股票</p>';
}

function peerComparisonHTML(peer) {
  if (!peer) return features.format.emptyHTML("暂无对比记录", featureState.relationQuery ? "换个股票名称或代码试试。" : featureState.relationExcludeST || featureState.relationExcludeGEM ? "当前筛选下没有关联股票，可取消勾选后查看。" : "已收录数据中暂无与其他股票的关联记录。");
  const targetName = featureState.selectedStock?.name || "本票";
  const entries = features.stock.peerComparisonEntries(peer);
  const detail = featureState.comparisonCache?.get(peer.code);
  const records = features.stock.comparisonSegmentsHTML(peer, detail);
  return `<header class="peer-detail-heading"><div><h4>${features.stock.relationStockButton(peer)}<small>${features.format.escapeHTML(peer.code)}</small><small class="peer-stock-initials" title="股票名称首字母">${features.format.escapeHTML(features.daily.nameInitials(peer) || "—")}</small><small class="peer-stock-location">${features.format.escapeHTML(features.daily.regionLabel(peer))}</small>${features.shell.latestLimitBadge(peer)}</h4><div class="peer-detail-profile"><p>与 ${features.format.escapeHTML(targetName)} 的历史对比</p><div class="stock-tags" aria-label="${features.format.escapeHTML(peer.name)}行业标签">${features.tags.stockTags(peer).map(tag => `<span class="stock-tag">${features.format.escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</div></div></div></header><div class="peer-comparison-totals"><div class="wins"><span>本票胜出</span><strong>${features.format.numberValue(peer.winCount)}<small>轮</small></strong></div><div class="losses"><span>本票落后</span><strong>${features.format.numberValue(peer.lossCount)}<small>轮</small></strong></div><div><span>同日涨停</span><strong>${features.format.numberValue(peer.commonCount)}<small>次</small></strong></div></div><div class="peer-records-heading">对比记录 · ${detail?.segments ? `${features.format.numberValue(detail.segments.length)} 组周期` : `${features.format.numberValue(entries.length)} 个关联日`}<span class="peer-scroll-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7" r=".8" fill="currentColor" stroke="none"/></svg>Ctrl＋滚轮横向浏览</span></div><div class="relation-scroll peer-comparison-records" role="region" aria-label="与${features.format.escapeHTML(peer.name)}的对比记录" tabindex="0">${records}</div>`;
}

function renderComparisonWorkspace() {
  const rows = features.stock.filteredRelationPeers();
  if (!rows.some(peer => peer.code === featureState.relationPeerCode)) featureState.relationPeerCode = rows[0]?.code || "";
  const selected = rows.find(peer => peer.code === featureState.relationPeerCode);
  return `<section class="relation-workspace" aria-label="股票关联对比"><aside class="relation-peer-sidebar" aria-label="关联股票"><header><h4>关联股票</h4><span id="relation-peer-count">${features.format.numberValue(rows.length)} 只</span></header><label class="relation-peer-filter"><span class="sr-only">筛选关联股票</span><input id="relation-peer-search" type="search" placeholder="股票名称 / 代码" autocomplete="off" value="${features.format.escapeHTML(featureState.relationQuery || "")}"></label><div id="relation-peer-sort" class="relation-peer-sort" role="group" aria-label="关联股票排序">${features.stock.relationSortButtonsHTML()}</div><p id="relation-sort-note" class="relation-picker-note">${features.stock.relationSortNote()}</p><div id="relation-peer-list" class="relation-scroll relation-peer-list" role="region" aria-label="去重后的关联股票列表" tabindex="0">${features.stock.relationPeerRowsHTML(rows)}</div></aside><div id="relation-peer-detail" class="relation-peer-main" aria-live="polite">${features.stock.peerComparisonHTML(selected)}</div></section>`;
}

function renderPeerSelection({resetScroll = false} = {}) {
  const rows = features.stock.filteredRelationPeers();
  if (!rows.some(peer => peer.code === featureState.relationPeerCode)) featureState.relationPeerCode = rows[0]?.code || "";
  const list = $("relation-peer-list");
  const scrollTop = list.scrollTop;
  const hadFocus = list.contains(document.activeElement);
  list.innerHTML = features.stock.relationPeerRowsHTML(rows);
  list.scrollTop = resetScroll ? 0 : scrollTop;
  $("relation-peer-count").textContent = `${features.format.numberValue(rows.length)} 只`;
  $("relation-peer-detail").innerHTML = features.stock.peerComparisonHTML(rows.find(peer => peer.code === featureState.relationPeerCode));
  if (hadFocus) list.querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  features.stock.loadPeerComparison();
}

function renderCompetition() {
  const data = featureState.relationships?.competition;
  $("relations-summary-note").hidden = !data;
  $("relations-summary-note").innerHTML = data ? ` · 汇总胜出、落后与同日涨停记录，关联股票去重展示。${features.shell.latestPriorityNote()}` : "";
  if (!data) { $("competition-results").innerHTML = features.format.emptyHTML("暂无历史关联", "请选择股票查看。"); return; }
  $("competition-results").innerHTML = features.stock.renderComparisonWorkspace();
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
    return `<a href="?date=${features.format.escapeHTML(row.date)}" data-relation-date="${features.format.escapeHTML(row.date)}" aria-label="${features.format.escapeHTML(features.format.dateLabel(row.date))}，${board} 板，查看当日全部股票"><title>${features.format.escapeHTML(row.date)}：${board} 板</title><rect x="${x.toFixed(2)}" y="${(bottom - barHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2" fill="${board === max ? "#d94236" : "#efcdbb"}"/>${ordered.length <= 24 ? `<text class="bar-label" x="${center.toFixed(2)}" y="${(bottom - barHeight - 5).toFixed(2)}" text-anchor="middle">${board}</text>` : ""}${label ? `<text x="${center.toFixed(2)}" y="155" text-anchor="middle">${features.format.escapeHTML(String(row.date).slice(0, 7).replace("-", "."))}</text><text x="${center.toFixed(2)}" y="170" text-anchor="middle">${features.format.escapeHTML(String(row.date).slice(8))}日</text>` : ""}<g class="chart-hover-label" transform="translate(${tooltipX.toFixed(2)} 0)" aria-hidden="true"><rect width="168" height="25" rx="4"/><text x="84" y="17" text-anchor="middle">${features.format.escapeHTML(features.format.dateLabel(row.date))} · ${board} 板</text></g></a>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="group" aria-label="${ordered.length} 个涨停交易日的连板高度，最高 ${max} 板">${grid}${bars}</svg>`;
}

function handleRelationClick(event) {
  if (!featureState.relationships) return;
  if (event.target.closest("[data-retry-comparison]")) { features.stock.loadPeerComparison({retry: true}); return; }
  const sort = event.target.closest("[data-relation-sort]");
  if (sort && features.stock.setRelationSort(sort.dataset.relationSort)) {
    $("relation-peer-sort").innerHTML = features.stock.relationSortButtonsHTML();
    $("relation-sort-note").textContent = features.stock.relationSortNote();
    features.stock.renderPeerSelection({resetScroll: true});
    $("relation-peer-sort").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
    return;
  }
  const peer = event.target.closest("[data-select-peer]");
  if (peer) { featureState.relationPeerCode = peer.dataset.selectPeer; features.stock.renderPeerSelection(); return; }
  const stock = event.target.closest("[data-relation-code]");
  if (stock) {
    features.stock.chooseStock({ code: stock.dataset.relationCode, name: stock.dataset.relationName });
    $("search-workspace").scrollIntoView({ block: "start" });
    return;
  }
  const day = event.target.closest("[data-relation-date]");
  if (day) { event.preventDefault(); $("trade-date").value = day.dataset.relationDate; features.daily.returnToDate(); $("search-workspace").scrollIntoView({ block: "start" }); }
}

  const bindings = {
binding064() {
$("date-table-area").addEventListener("click", (event) => { const button = event.target.closest("[data-stock-code]"); if (button) features.stock.chooseStock({ code: button.dataset.stockCode, name: button.dataset.stockName }); });
},
binding113() {
document.addEventListener("wheel", features.stock.containRelationWheel, {passive: false});
},
binding114() {
$("relation-height").addEventListener("input", event => {
  const height = Number(event.target.value);
  if (height >= 600 && height <= 1600) features.preferences.applyRelationHeight(height);
});
},
binding115() {
$("relation-height").addEventListener("change", event => features.preferences.applyRelationHeight(event.target.value));
},
binding116() {
$("reset-relation-height").addEventListener("click", () => features.preferences.applyRelationHeight(880));
},
binding117() {
$("relation-exclude-st").addEventListener("change", features.stock.setRelationFilters);
},
binding118() {
$("relation-exclude-gem").addEventListener("change", features.stock.setRelationFilters);
},
binding119() {
$("relation-exclude-latest").addEventListener("change", features.stock.setRelationFilters);
},
binding120() {
$("stock-query-form").addEventListener("submit", (event) => { event.preventDefault(); features.daily.runQuery(); });
},
binding121() {
$("stock-search").addEventListener("input", () => {
  $("stock-search").setCustomValidity("");
  featureState.selectedStock = null;
  featureState.suggestions = [];
  featureState.suggestionsQuery = "";
  features.api.channels.search?.abort();
  features.api.channels["stock-resolve"]?.abort();
  features.api.channels.stock?.abort();
  featureState.stockGeneration = (featureState.stockGeneration || 0) + 1;
  $("stock-query-button").disabled = false;
  if (!$("stock-search").value.trim()) features.daily.returnToDate();
});
},
binding122() {
$("stock-search").addEventListener("input", features.format.debounce(features.stock.searchStocks));
},
binding123() {
$("stock-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { features.stock.hideSuggestions(); return; }
  if (["ArrowDown", "ArrowUp"].includes(event.key) && !$("stock-suggestions").hidden && featureState.suggestions.length) {
    event.preventDefault(); const count = Math.min(15, featureState.suggestions.length); featureState.suggestionIndex = (featureState.suggestionIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    $("stock-suggestions").querySelectorAll("[role=option]").forEach((button, index) => { button.classList.toggle("focused", index === featureState.suggestionIndex); button.setAttribute("aria-selected", String(index === featureState.suggestionIndex)); });
    $("stock-search").setAttribute("aria-activedescendant", `suggestion-${featureState.suggestionIndex}`); $("stock-suggestions").querySelector(`#suggestion-${featureState.suggestionIndex}`)?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && featureState.suggestionIndex >= 0 && !$("stock-suggestions").hidden) { event.preventDefault(); features.stock.chooseStock(featureState.suggestions[featureState.suggestionIndex]); }
});
},
binding124() {
$("stock-suggestions").addEventListener("click", (event) => { const button = event.target.closest("[data-suggestion]"); if (button) features.stock.chooseStock(featureState.suggestions[Number(button.dataset.suggestion)]); });
},
binding125() {
$("recent-stock-list").addEventListener("click", event => {
  const button = event.target.closest("[data-recent-code]");
  if (button) features.stock.chooseStock({code: button.dataset.recentCode, name: button.dataset.recentName});
});
},
binding126() {
window.addEventListener("storage", event => {
  if (event.key === features.preferences.RECENT_STOCKS_KEY || event.key === null) {
    featureState.recentStocks = features.preferences.readRecentStocks();
    features.stock.renderRecentStocks();
  }
});
},
binding127() {
document.addEventListener("click", (event) => { if (!event.target.closest(".stock-picker")) features.stock.hideSuggestions(); });
},
binding128() {
$("stock-relations").addEventListener("input", event => {
  if (event.target.id !== "relation-peer-search") return;
  featureState.relationQuery = event.target.value;
  features.stock.renderPeerSelection();
});
},
binding129() {
$("stock-relations").addEventListener("keydown", event => {
  const button = event.target.closest("[data-select-peer]");
  if (!button || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = features.stock.filteredRelationPeers();
  if (!rows.length) return;
  event.preventDefault();
  const current = rows.findIndex(peer => peer.code === featureState.relationPeerCode);
  const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  featureState.relationPeerCode = rows[index].code;
  features.stock.renderPeerSelection();
  $("relation-peer-list").querySelector('[aria-pressed="true"]')?.scrollIntoView({block: "nearest"});
});
},
binding130() {
$("stock-relations").addEventListener("click", features.stock.handleRelationClick);
},
binding131() {
$("stock-cycles").addEventListener("click", features.stock.handleRelationClick);
},
binding132() {
$("stock-chart").addEventListener("click", features.stock.handleRelationClick);
},
binding140() {
new ResizeObserver(features.shell.updateQueryStickyOffset).observe($("stock-sticky"));
}
};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, renderRecentStocks, rememberStock, hideSuggestions, showSuggestions, searchStocks, chooseStock, loadStock, renderStockProfile, renderStock, relationStockButton, relationDateButton, renderRelationships, loadRelationHistory, verificationBadge, renderRoundPeer, renderCompetitionRounds, renderStockCycles, containRelationWheel, mergeRelationPeers, peerComparisonEntries, comparisonRunHTML, comparisonSegmentsHTML, loadPeerComparison, setRelationSort, relationSortButtonsHTML, relationSortNote, filteredRelationPeers, setRelationFilters, relationPeerRowsHTML, peerComparisonHTML, renderComparisonWorkspace, renderPeerSelection, renderCompetition, renderChart, handleRelationClick, relationSortLabels };
}
