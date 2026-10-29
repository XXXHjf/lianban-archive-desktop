// daily: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {grouping: "industry", boards: "", excludeST: false, excludeGEM: false, dateData: null};
  const keys = new Set(["boards","grouping","excludeST","excludeGEM","dateData"]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown daily state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown daily state: ' + key); featureState[key] = value; return value; }

function updateDateNavigation() {
  const date = $("trade-date").value;
  const dates = features.shell.read("meta")?.query_dates || features.shell.read("meta")?.dates || [];
  $("prev-date").disabled = !dates.some((item) => item < date);
  $("next-date").disabled = !dates.some((item) => item > date);
}

function getDateQuery() { return new URLSearchParams({ date: $("trade-date").value, boards: featureState.boards, exclude_st: featureState.excludeST ? "1" : "0", exclude_gem: featureState.excludeGEM ? "1" : "0" }); }

function renderBoardOptions(counts = [], availableTotal = null) {
  const distribution = new Map();
  counts.forEach((group) => { const boards = Number(group.boards); if (Number.isInteger(boards) && boards > 0) distribution.set(boards, Number(group.count) || 0); });
  if (featureState.boards && !distribution.has(Number(featureState.boards))) distribution.set(Number(featureState.boards), 0);
  const options = [{ value: "", label: "全部", count: availableTotal }, ...[...distribution].sort((a, b) => a[0] - b[0]).map(([boards, count]) => ({ value: String(boards), label: boards === 1 ? "首板" : `${boards} 板`, count }))];
  $("board-options").innerHTML = options.map((option) => `<button type="button" class="board-chip" data-boards="${option.value}" aria-pressed="${String(option.value === featureState.boards)}" aria-label="${option.label}${option.count === null ? "，数量待查询" : `，${features.format.numberValue(option.count)} 只股票`}">${option.label} <span class="board-chip-count">${features.format.numberValue(option.count)}</span></button>`).join("");
  $("board-options").setAttribute("aria-busy", "false");
}

async function loadDate({quiet = false} = {}) {
  if (!quiet) features.navigation.setView("date", false);
  if (!$("trade-date").value) {
    features.api.channels.date?.abort(); featureState.dateData = null; features.shell.clearError(); features.shell.setStats("date-stats");
    const available = Boolean(features.shell.read("meta")?.dates?.length);
    $("date-table-area").innerHTML = features.format.emptyHTML(available ? "请选择查询日期" : "还没有可查询的交易日", available ? "选择实验数据区间内的日期，查看对应的来源池记录。" : "等待历史数据收录完成后，即可按日期查看涨停记录。", "calendar");
    $("date-table-area").setAttribute("aria-busy", "false"); features.daily.renderBoardOptions();
    $("date-result-count").textContent = "0"; $("prev-date").disabled = true; $("next-date").disabled = true;
    $("date-subtitle").textContent = "选择交易日，查看涨停股票明细。";
    $("date-coverage-note").textContent = "仅供参考"; features.navigation.updateURL(); return;
  }
  if (!quiet) {
    features.shell.clearError();
    $("date-table-area").innerHTML = features.format.loadingHTML();
    $("date-table-area").setAttribute("aria-busy", "true");
    $("board-options").setAttribute("aria-busy", "true");
    $("board-options").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    features.shell.setStats("date-stats");
    features.daily.updateDateNavigation();
    features.navigation.updateURL();
  }
  const query = String(features.daily.getDateQuery());
  try {
    const data = await features.api.request(`/api/date?${query}`, "date");
    if (!data || features.navigation.read("tab") !== "date" || query !== String(features.daily.getDateQuery())) return;
    const scroll = quiet ? $("date-table-area").querySelector(".industry-board")?.scrollLeft : null;
    const position = quiet ? {left: window.scrollX, top: window.scrollY, behavior: "instant"} : null;
    featureState.dateData = data;
    features.daily.renderDate(data);
    if (scroll != null) { const board = $("date-table-area").querySelector(".industry-board"); if (board) board.scrollLeft = scroll; features.daily.updateIndustryNavigation(); }
    if (position) window.scrollTo(position);
  } catch (error) {
    if (quiet) { $("auto-update-note").textContent += " · 页面刷新未完成，保留上次结果"; return; }
    features.shell.showError(error, features.daily.loadDate);
    $("date-table-area").innerHTML = features.format.emptyHTML("未能加载这个交易日", "请检查本地服务或点击上方「重新加载」。", "calendar");
    features.daily.renderBoardOptions();
    $("date-table-area").setAttribute("aria-busy", "false");
  }
}

function renderDate(data) {
  const rows = data.rows || [];
  const stats = data.stats || { total: rows.length, consecutive: rows.filter((row) => row.boards >= 2).length, max_boards: Math.max(0, ...rows.map((row) => Number(row.boards) || 0)), first_boards: rows.filter((row) => row.boards === 1).length };
  features.shell.setStats("date-stats", stats);
  const suspended = data.suspended_rows || [];
  $("date-height-note").textContent = suspended.length ? `含停牌保留高度 · 当日最高 ${features.format.numberValue(data.trading_max_boards)} 板`
    : data.suspension_status === "error" ? "当日池最高 · 停牌资料待核实"
    : ["unknown", "updating"].includes(data.suspension_status) ? "当日池最高 · 停牌资料核查中" : "当前筛选最高高度";
  $("date-result-count").textContent = features.format.numberValue(rows.length);
  features.daily.renderDateStatus(data);
  $("date-coverage-note").classList.toggle("warning", !rows.length || ["partial", "incomplete"].includes(features.shell.read("meta")?.coverage?.status));

  $("date-table-area").setAttribute("aria-busy", "false");
  const noSelectedBoards = ["ok", "provisional"].includes(data.data_status) && Number(data.available_total) > 0 && featureState.boards;
  const highlightOptions = {highlightLatest: !data.provisional};
  $("date-table-area").innerHTML = rows.length ? features.daily.renderIndustryColumns(rows, data.tag_board_counts, highlightOptions) : noSelectedBoards
    ? features.format.emptyHTML(`没有 ${featureState.boards} 板股票`, `当前日期与其他筛选条件下，该板数为 0。点击「全部」查看 ${features.format.numberValue(data.available_total)} 只股票。`)
    : features.format.emptyHTML("没有符合条件的涨停记录", data.coverage_note || "这个日期可能不是交易日、尚未收录，或没有满足当前筛选条件的股票。", "calendar");
  if (suspended.length) $("date-table-area").innerHTML = features.daily.renderSuspendedLeaders(suspended, highlightOptions) + $("date-table-area").innerHTML;
  if (["unknown", "updating"].includes(data.suspension_status)) {
    clearTimeout(features.shell.read("metaPoll")); features.shell.write("metaPoll", setTimeout(features.shell.refreshMeta, 3000));
  }
  document.querySelectorAll("[data-grouping]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.grouping === featureState.grouping)));
  features.daily.renderBoardOptions(data.board_counts || [], data.available_total ?? rows.length);
  features.daily.updateIndustryNavigation();
}

function renderDateStatus(data) {
  const date = data.date || $("trade-date").value;
  const weekday = new Date(`${date}T12:00:00`).toLocaleDateString("zh-CN", {weekday: "long"});
  const live = features.shell.read("meta")?.live?.date === date ? features.shell.read("meta").live : data.live;
  const stamp = data.fetched_at ? data.fetched_at.slice(11, 19) : "";
  const problem = live?.status === "error" ? " · 获取失败，保留上次数据并重试"
    : live?.status === "waiting" ? " · 来源待更新，保留上次数据并重试"
    : live?.stale ? " · 上次快照，等待更新" : "";
  const freshness = data.provisional ? `盘中暂定${stamp ? ` · 获取于 ${stamp}` : ""} · 每分钟刷新${problem}`
    : data.live ? "盘中来源待更新 · 每分钟自动重试" : "";
  $("date-subtitle").textContent = `${features.format.dateLabel(date)} · ${weekday}${freshness ? ` · ${freshness}` : ""}`;
  $("date-coverage-note").textContent = freshness ? `${freshness} · 收盘后确认` : "仅供参考";
  $("date-coverage-note").title = data.provisional ? data.coverage_note : "";
}

function updateIndustryNavigation() {
  const board = $("date-table-area").querySelector(".industry-board");
  if (!board) return;
  $("date-table-area").querySelectorAll("[data-industry-scroll]").forEach(button => {
    button.disabled = Number(button.dataset.industryScroll) < 0
      ? board.scrollLeft <= 1 : board.scrollLeft + board.clientWidth >= board.scrollWidth - 1;
  });
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
  return features.daily.orderMatchingGroups(groups, unknown, features.daily.nameInitials, 4);
}

function orderCodeGroups(groups, unknown) {
  return features.daily.orderMatchingGroups(groups, unknown, features.daily.codeDigits, 6);
}

function renderStockCard(row, {highlightLatest = true} = {}) {
  const boards = Number(row.boards) || 0;
  const location = features.daily.regionLabel(row);
  const tags = features.tags.stockTags(row);
  const highlighted = highlightLatest && row.date !== features.shell.read("meta")?.latest_date && features.shell.latestLimitUp(row);
  const blacklisted = row.blacklisted === true;
  const initials = features.daily.nameInitials(row);
  return `<li class="industry-stock ${highlighted ? "latest-limit-up" : ""}${blacklisted ? " blacklisted-stock" : ""}" data-card-code="${features.format.escapeHTML(row.code)}"><div class="industry-stock-top"><button type="button" class="stock-name-button" data-stock-code="${features.format.escapeHTML(row.code)}" data-stock-name="${features.format.escapeHTML(row.name)}">${features.format.escapeHTML(features.format.textValue(row.name))}</button>${features.shareholders.renderShareholderIcon(row)}${blacklisted ? '<span class="stock-blacklist-badge">黑名单</span>' : ""}<span class="board-badge ${boards >= 5 ? "high" : boards <= 1 ? "first" : ""}">${boards ? `${boards} 板` : "—"}</span></div>${highlighted ? features.shell.latestLimitBadge(row) : ""}<div class="industry-stock-meta"><span class="row-stock-code">${features.format.escapeHTML(row.code)}</span><span class="stock-initials" title="股票名称首字母：${features.format.escapeHTML(initials || "暂未获取")}">${features.format.escapeHTML(initials || "—")}</span><span class="stock-location">${features.format.escapeHTML(location)}</span></div>${row.suspended ? features.daily.renderSuspensionNote(row) : ""}<div class="stock-tags">${tags.map(tag => `<span class="stock-tag">${features.format.escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}${features.tags.canEditTags() ? `<button type="button" class="edit-stock-tags" data-edit-stock-tags="${features.format.escapeHTML(row.code)}" aria-label="编辑${features.format.escapeHTML(row.name)}标签">编辑</button>` : ""}</div><div class="stock-note-row" data-note-code="${features.format.escapeHTML(row.code)}">${features.notes.renderStockNote(row)}</div></li>`;
}

function renderSuspensionNote(row) {
  return `<div class="suspension-card-note" role="group" aria-label="停牌信息"><div class="suspension-status"><i aria-hidden="true"></i>停牌中</div><dl class="suspension-dates"><div><dt>末次涨停</dt><dd><time datetime="${features.format.escapeHTML(row.board_date)}">${features.format.escapeHTML(features.format.dateLabel(row.board_date))}</time></dd></div><div><dt>预计复牌</dt><dd>${row.resume_date ? `<time datetime="${features.format.escapeHTML(row.resume_date)}">${features.format.escapeHTML(features.format.dateLabel(row.resume_date))}</time>` : "待公告"}</dd></div></dl></div>`;
}

function renderSuspendedLeaders(rows, options = {}) {
  return `<section class="suspended-leaders" aria-label="停牌保留高度"><header><h4>停牌保留高度</h4><p>保留停牌前连板高度，未计入当日涨停家数</p></header><ul class="industry-stock-list">${rows.map(row => features.daily.renderStockCard(row, options)).join("")}</ul></section>`;
}

function industryTagBoardCounts(rows) {
  const counts = Object.create(null);
  rows.forEach(row => [...new Set(features.tags.allStockTags(row).flatMap(tag => [tag, features.tags.tagRoot(tag)]))].forEach(tag => {
    const heights = counts[tag] ||= Object.create(null);
    heights[row.boards] = (heights[row.boards] || 0) + 1;
  }));
  return counts;
}

function industryGroupRank(stocks, boardCounts) {
  const counts = Object.entries(boardCounts || {}).filter(([height, count]) => Number(height) > 0 && Number(count) > 0);
  return counts.length ? {
    height: Math.max(...counts.map(([height]) => Number(height))),
    total: counts.reduce((total, [, count]) => total + Number(count), 0),
  } : {
    height: Math.max(...stocks.map(row => Number(row.boards) || 0)),
    total: stocks.length,
  };
}

function industryColumnHeading(labels, addable) {
  return labels.map(label => `<span class="matrix-label-item"><span>${features.format.escapeHTML(label)}</span>${addable ? `<button type="button" class="matrix-add-stock" data-add-sector-tag="${features.format.escapeHTML(label)}" aria-label="向${features.format.escapeHTML(label)}添加股票" title="添加股票"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>` : ""}</span>`).join('<span class="matrix-label-divider" aria-hidden="true"> / </span>');
}

function mergeIdenticalFirstBoardGroups(ordered, tagBoards, separateLabel = null, protectedLabels = new Set()) {
  const columns = [], cohorts = new Map();
  for (const [name, stocks] of ordered) {
    const unique = [...new Map(stocks.map(row => [String(row.code), row])).values()];
    const counts = Object.create(null);
    unique.forEach(row => { counts[Number(row.boards)] = (counts[Number(row.boards)] || 0) + 1; });
    const daily = Object.entries(tagBoards[name] || counts).filter(([, count]) => Number(count) > 0);
    // A board filter or a suppressed leader must not make different daily cohorts look identical.
    const complete = daily.length === Object.keys(counts).length
      && daily.every(([height, count]) => counts[Number(height)] === Number(count));
    const key = name !== separateLabel && !protectedLabels.has(name.toLocaleLowerCase()) && counts[1] && complete ? JSON.stringify(unique.map(row => [String(row.code), Number(row.boards)])
      .sort((a, b) => a[0].localeCompare(b[0]))) : null;
    const existing = key === null ? null : cohorts.get(key);
    if (existing) existing.labels.push(name);
    else {
      const column = {labels: [name], stocks: unique};
      columns.push(column);
      if (key !== null) cohorts.set(key, column);
    }
  }
  return columns;
}

function renderIndustryColumns(rows, dailyTagBoards = null, {highlightLatest = true} = {}) {
  const regional = featureState.grouping === "region";
  const phonetic = featureState.grouping === "pinyin";
  const numeric = featureState.grouping === "code";
  const matchingMode = phonetic || numeric;
  const groupType = numeric ? "代码分组" : phonetic ? "拼音分组" : regional ? "地区" : "行业";
  const unknown = matchingMode ? "#" : regional ? "地区待补充" : "独苗";
  const groups = new Map();
  const tagBoards = dailyTagBoards || features.daily.industryTagBoardCounts(rows);
  const solitaryTags = new Set(Object.entries(tagBoards).filter(([, counts]) =>
    Object.values(counts).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0) === 1).map(([tag]) => tag));
  rows.forEach(row => {
    let labels = numeric ? [features.daily.codeDigits(row) || unknown] : phonetic ? [features.daily.nameInitials(row) || unknown] : regional ? [features.daily.regionLabel(row)] : [...new Set(features.tags.allStockTags(row).map(features.tags.tagRoot))];
    const solitary = !regional && !matchingMode && labels.every(label => solitaryTags.has(label) && !features.tags.tagHierarchy().parentKeys.has(label.toLocaleLowerCase()));
    if (solitary) labels = [unknown];
    else if (!regional && !matchingMode && Number(row.boards) > 1) {
      const related = labels.filter(label => Object.entries(tagBoards[label] || {})
        .some(([height, count]) => Number(height) !== Number(row.boards) && Number(count) > 0));
      const parents = labels.filter(label => features.tags.tagHierarchy().parentKeys.has(label.toLocaleLowerCase()));
      labels = [...new Set([...parents, ...(related.length ? related : labels.slice(0, 1))])];
    }
    (labels.length ? labels : [unknown]).forEach(label => {
      if (!groups.has(label)) groups.set(label, []);
      if (!groups.get(label).some(stock => stock.code === row.code)) groups.get(label).push(row);
    });
  });
  // Keep the day's leader and follower counts when a single board height is selected.
  const groupRanks = matchingMode ? null : new Map([...groups].map(([name, stocks]) =>
    [name, features.daily.industryGroupRank(stocks, regional || name === unknown ? null : tagBoards[name])]));
  const ordered = matchingMode ? (numeric ? features.daily.orderCodeGroups(groups, unknown) : features.daily.orderPinyinGroups(groups, unknown)) : [...groups].sort((a, b) => {
    if (a[0] === unknown) return 1;
    if (b[0] === unknown) return -1;
    const left = groupRanks.get(a[0]), right = groupRanks.get(b[0]);
    return right.height - left.height || right.total - left.total
      || (!regional ? features.tags.compareTags(a[0], b[0]) : 0) || a[0].localeCompare(b[0], "zh-CN");
  });
  const columns = !regional && !matchingMode ? features.daily.mergeIdenticalFirstBoardGroups(ordered, tagBoards, unknown, features.tags.tagHierarchy().parentKeys)
    : ordered.map(([name, stocks]) => ({labels: [name], stocks}));
  const seen = new Set();
  const repeated = columns.some(column => column.stocks.some(row => {
    if (seen.has(row.code)) return true;
    seen.add(row.code); return false;
  }));
  const heights = [...new Set(rows.map(row => Number(row.boards)))].sort((a, b) => b - a);
  const sections = heights.map(height => {
    const label = height === 1 ? "首板" : `${height} 板`;
    const total = rows.filter(row => Number(row.boards) === height).length;
    const cells = columns.map(({labels, stocks}) => {
      const name = labels.join(" / "), merged = labels.length > 1;
      const selected = stocks.filter(row => Number(row.boards) === height);
      const orderedStocks = matchingMode ? selected : selected.sort((a, b) => String(a.code).localeCompare(String(b.code)));
      const matching = matchingMode || !highlightLatest ? orderedStocks : features.shell.prioritizeLatest(orderedStocks, true);
      const addable = !regional && !matchingMode && name !== unknown && (features.shell.read("meta")?.capabilities?.manage_tags ?? features.tags.canEditTags());
      return `<section class="matrix-cell ${matching.length ? "" : "matrix-cell-empty"}${merged ? " matrix-cell-merged" : ""}" data-group-label="${features.format.escapeHTML(name)}" aria-label="${features.format.escapeHTML(name)}，${label}，${matching.length} 只股票"><header class="matrix-cell-header"><h5${merged ? ` title="股票名单相同，合并展示：${features.format.escapeHTML(name)}"` : ""}>${features.daily.industryColumnHeading(labels, addable)}</h5><span>${matching.length}<small>只</small></span></header>${matching.length ? (!regional && !matchingMode ? features.tags.renderHierarchyStockGroups(matching, labels[0], highlightLatest) : `<ul class="industry-stock-list">${matching.map(row => features.daily.renderStockCard(row, {highlightLatest})).join("")}</ul>`) : '<div class="matrix-empty" aria-label="本组没有这个板数的股票">—</div>'}</section>`;
    }).join("");
    return `<section class="board-height-section" data-board-height="${height}" aria-label="${label}，${total} 只股票"><header class="board-height-heading"><h4>${label}</h4><span>${total} 只股票</span></header><div class="board-matrix-row">${cells}</div></section>`;
  }).join("");
  const matchingHint = numeric ? "6 → 5 → 4 → 3 → 2 → 1 位连续数字匹配，同一股票可跨组展示" : "4 → 3 → 2 → 1 个连续字母匹配，同一股票可跨组展示";
  const mergeHint = columns.length < ordered.length ? `<span class="multi-tag-note"> · 相同首板合并为 ${columns.length} 列</span>` : "";
  return `<div class="industry-board-summary"><span><strong>${ordered.length}</strong> 个${groupType} · <strong>${rows.length}</strong> 只股票${matchingMode ? `<span class="multi-tag-note"> · ${matchingHint}</span>` : repeated ? '<span class="multi-tag-note"> · 多标签跨列显示</span>' : ""}${mergeHint}${highlightLatest && rows[0]?.date !== features.shell.read("meta")?.latest_date ? features.shell.latestPriorityNote() : ""}</span><div class="industry-board-controls"><span class="industry-scroll-hint">左右查看${groupType}</span><button type="button" class="icon-button" data-industry-scroll="-1" aria-label="查看左侧分组">←</button><button type="button" class="icon-button" data-industry-scroll="1" aria-label="查看右侧分组">→</button></div></div><div class="industry-board" role="region" aria-label="按${groupType}分列、按连板高度分行的股票" tabindex="0"><div class="board-comparison" style="--matrix-columns:${columns.length}">${sections}</div></div>`;
}

function renderTable(rows, mode) {
  const dateMode = mode === "date";
  const heads = dateMode ? ["股票", "连板", "行业"] : ["交易日期", "当日高度"];
  const rowHTML = rows.map((row) => {
    const boards = Number(row.boards) || 0;
    const badge = `<span class="board-badge ${boards >= 5 ? "high" : boards <= 1 ? "first" : ""}">${boards ? `${boards} 板` : "—"}</span>`;
    return dateMode
      ? `<tr><td><button class="stock-name-button" data-stock-code="${features.format.escapeHTML(row.code)}" data-stock-name="${features.format.escapeHTML(row.name)}">${features.format.escapeHTML(features.format.textValue(row.name))}</button><div class="row-stock-code">${features.format.escapeHTML(features.format.textValue(row.code))}</div></td><td>${badge}</td><td><span class="industry-text">${features.format.escapeHTML(features.format.textValue(row.industry))}</span></td></tr>`
      : `<tr><td><button class="stock-name-button" data-history-date="${features.format.escapeHTML(row.date)}">${features.format.escapeHTML(features.format.dateLabel(row.date))}</button></td><td>${badge}</td></tr>`;
  }).join("");
  return `<table class="${dateMode ? "date-table" : "stock-table"}"><caption class="sr-only">${dateMode ? "当日涨停股票明细" : "个股逐日涨停记录"}</caption><thead><tr>${heads.map((head) => `<th scope="col">${head}</th>`).join("")}</tr></thead><tbody>${rowHTML}</tbody></table>`;
}

function returnToDate() {
  features.stock.write("selectedStock", null);
  featureState.boards = "";
  features.stock.write("suggestions", []);
  features.stock.write("suggestionsQuery", "");
  $("stock-search").value = "";
  $("stock-search").setCustomValidity("");
  features.stock.hideSuggestions();
  features.daily.loadDate();
}

function runQuery() {
  if (!$("stock-search").value.trim()) return features.daily.returnToDate();
  features.stock.loadStock();
}

function changeQueryDate() {
  features.daily.updateDateNavigation();
  features.daily.returnToDate();
}

  const bindings = {
binding010() {
$("trade-date").addEventListener("change", features.daily.changeQueryDate);
},
binding011() {
$("latest-date").addEventListener("click", () => { $("trade-date").value = features.shell.read("meta")?.query_dates?.at(-1) || features.shell.read("meta")?.latest_date || ""; features.daily.changeQueryDate(); });
},
binding012() {
["prev-date", "next-date"].forEach((id) => $(id).addEventListener("click", () => { const dates = features.shell.read("meta")?.query_dates || features.shell.read("meta")?.dates || [], current = $("trade-date").value; const target = id === "prev-date" ? [...dates].reverse().find((date) => date < current) : dates.find((date) => date > current); if (target) { $("trade-date").value = target; features.daily.changeQueryDate(); } }));
},
binding061() {
$("back-to-date").addEventListener("click", features.daily.returnToDate);
},
binding063() {
$("board-options").addEventListener("click", (event) => { const button = event.target.closest("[data-boards]"); if (button && button.dataset.boards !== featureState.boards) { featureState.boards = button.dataset.boards; features.daily.loadDate(); } });
},
binding065() {
$("date-table-area").addEventListener("click", (event) => {
  const button = event.target.closest("[data-industry-scroll]");
  const board = $("date-table-area").querySelector(".industry-board");
  if (button && board) board.scrollBy({ left: Number(button.dataset.industryScroll) * (board.clientWidth - 25), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
});
},
binding066() {
document.querySelectorAll("[data-grouping]").forEach(button => button.addEventListener("click", () => {
  if (featureState.grouping === button.dataset.grouping) return;
  featureState.grouping = button.dataset.grouping;
  if (featureState.dateData) features.daily.renderDate(featureState.dateData);
  features.navigation.updateURL();
}));
},
binding067() {
$("exclude-st").addEventListener("change", event => {
  featureState.excludeST = event.target.checked;
  featureState.dateData = null;
  features.daily.loadDate();
});
},
binding068() {
$("exclude-gem").addEventListener("change", event => {
  featureState.excludeGEM = event.target.checked;
  featureState.dateData = null;
  features.daily.loadDate();
});
},
binding111() {
$("date-table-area").addEventListener("scroll", features.daily.updateIndustryNavigation, true);
},
binding112() {
window.addEventListener("resize", features.format.debounce(features.daily.updateIndustryNavigation, 100));
}
};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, updateDateNavigation, getDateQuery, renderBoardOptions, loadDate, renderDate, renderDateStatus, updateIndustryNavigation, regionLabel, nameInitials, codeDigits, orderMatchingGroups, orderPinyinGroups, orderCodeGroups, renderStockCard, renderSuspensionNote, renderSuspendedLeaders, industryTagBoardCounts, industryGroupRank, industryColumnHeading, mergeIdenticalFirstBoardGroups, renderIndustryColumns, renderTable, returnToDate, runQuery, changeQueryDate };
}
