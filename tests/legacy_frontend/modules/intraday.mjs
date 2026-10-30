// intraday: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {};
  const keys = new Set(["intradayDate","intradayCode","minuteCompareCodes","intradayData","minuteDetail","minuteTimelineData","minuteListLimit","minuteCompareLimit","minuteComparisons","minuteChartScale","minuteLoading","minuteHoverMode","minutePointIndex","intradayGeneration","minuteTimelineCollecting","minuteLiveRefreshing","minuteLiveRefreshKey","minuteLiveRefreshedAt","minuteStockGeneration","minuteTimelineLiveStatus","minuteVolumeScale","minuteTimelineExcludeCodes","minuteTimelineSort","minuteTimelineDayModel","minuteTimelineSelectedDate","minuteTimelineSelectedNode","minuteTimelineLocateCode","minuteTimelinePitch","minuteTimelineGuideObserver","minuteTimelineStockLabels","minuteTimelinePickerKeys","minuteTimelinePickerOpen","minuteTimelineGeneration","minuteTimelineTimesRequested","minuteTimelineCollectGeneration","minuteTimelineNavigation"]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown intraday state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown intraday state: ' + key); featureState[key] = value; return value; }

function minuteRows(searchId = "minute-search") {
  const query = ($(searchId).value || "").trim().toUpperCase();
  const extra = searchId === "minute-compare-search" && featureState.minuteTimelineData?.date === featureState.intradayDate && featureState.minuteTimelineData.scope?.exclude_gem === false
    ? (featureState.minuteTimelineData.pool || []).filter(row => /^(300|301)\d{3}$/.test(row.code)) : [];
  const rows = [...(featureState.intradayData?.rows || []), ...extra].filter(row => !query || `${row.code} ${row.name} ${row.initials || ""}`.toUpperCase().includes(query))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  // Same stable priorities as the daily search cards: board height, latest
  // limit-up within that height, then code. Filtering preserves this order.
  return features.shell.prioritizeLatest(rows, true).sort((a, b) => Number(b.boards) - Number(a.boards));
}

function minuteDates() {
  return [...new Set(featureState.intradayData?.dates || [])].sort();
}

function updateMinuteDateNavigation() {
  const dates = features.intraday.minuteDates(), day = featureState.intradayDate || "", input = $("minute-date");
  input.value = day;
  input.min = dates[0] || "";
  input.max = dates.at(-1) || "";
  input.disabled = !dates.length;
  $("minute-prev-date").disabled = !dates.some(value => value < day);
  $("minute-next-date").disabled = !dates.some(value => value > day);
  $("minute-latest-date").disabled = !dates.length;
}

function changeMinuteDate(day = $("minute-date").value) {
  const input = $("minute-date");
  input.value = day;
  if (!day || input.checkValidity?.() === false) { input.reportValidity?.(); return; }
  if (!features.intraday.minuteDates().includes(day)) {
    input.setCustomValidity("请选择交易日，周末和休市日没有分时数据");
    input.reportValidity?.();
    input.setCustomValidity("");
    input.value = featureState.intradayDate || "";
    return;
  }
  if (day === featureState.intradayDate) return;
  featureState.intradayDate = day;
  features.intraday.updateMinuteDateNavigation();
  features.navigation.updateURL();
  return features.intraday.loadIntraday();
}

function navigateMinuteDate(direction) {
  const dates = features.intraday.minuteDates(), day = featureState.intradayDate || "";
  const target = direction === "latest" ? dates.at(-1) : direction === "previous" ? [...dates].reverse().find(value => value < day) : dates.find(value => value > day);
  if (target) return features.intraday.changeMinuteDate(target);
}

function renderMinuteProfile(stock, loading = false) {
  $("minute-stock-initials").textContent = loading ? "" : features.daily.nameInitials(stock) || "—";
  $("minute-stock-region").textContent = loading ? "" : features.daily.regionLabel(stock);
  $("minute-stock-blacklist").hidden = loading || stock.blacklisted !== true;
  $("minute-stock-tags").innerHTML = loading ? "" : features.tags.stockTags(stock).map(tag => `<span class="stock-tag">${features.format.escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>';
  const note = $("minute-stock-note");
  note.innerHTML = loading ? "" : features.notes.renderStockNote(stock);
  if (loading) note.removeAttribute("data-note-code");
  else note.setAttribute("data-note-code", stock.code);
}

function renderMinuteList() {
  const rows = features.intraday.minuteRows();
  const limit = featureState.minuteListLimit || 150;
  const visible = rows.slice(0, limit), selected = rows.find(row => row.code === featureState.intradayCode);
  if (selected && !visible.includes(selected)) visible.push(selected);
  $("minute-stock-count").textContent = `${rows.length} / ${featureState.intradayData?.total || 0}`;
  $("minute-stock-list").innerHTML = visible.map(row => `<button type="button" class="minute-stock-row${row.code === featureState.intradayCode ? " selected" : ""}" data-minute-code="${features.format.escapeHTML(row.code)}" aria-pressed="${row.code === featureState.intradayCode}"><span class="minute-stock-row-name">${features.format.escapeHTML(row.name)}<small>${features.format.escapeHTML(row.code)}</small></span><span class="minute-stock-row-info"><b>${row.boards ? `${features.format.numberValue(row.boards)} 板` : "主板"}</b><small data-minute-status="${features.format.escapeHTML(row.code)}" class="${row.status === "ok" ? "" : "minute-incomplete"}">${row.status === "ok" ? "已采集" : row.status === "partial" ? "部分数据" : "按需采集"}</small></span></button>`).join("") + (rows.length > visible.length ? `<button type="button" class="minute-more" data-minute-more>显示更多（剩余 ${rows.length - visible.length} 只）</button>` : "") || features.format.emptyHTML("没有匹配的股票", "试试其他名称、代码或首字母。");
}

function updateMinuteSelection() {
  $("minute-stock-list").querySelectorAll("[data-minute-code]").forEach(button => {
    const selected = button.dataset.minuteCode === featureState.intradayCode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function minuteCompareStyle(index) {
  const colors = ["#487da9", "#7e62a3", "#379286", "#b87935", "#b55a89", "#667f3c", "#6364b2", "#8b6e60"];
  return {color: colors[index % colors.length], dash: ["", "6 3", "2 3", "8 3 2 3"][Math.floor(index / colors.length) % 4]};
}

function renderMinuteCompareList() {
  const rows = features.intraday.minuteRows("minute-compare-search"), limit = featureState.minuteCompareLimit || 150;
  const visible = rows.slice(0, limit);
  visible.push(...rows.filter(row => (featureState.minuteCompareCodes || []).includes(row.code) && !visible.includes(row)));
  $("minute-compare-list").innerHTML = visible.map(row => `<label class="minute-stock-row minute-compare-row" data-compare-row="${features.format.escapeHTML(row.code)}"><input type="checkbox" data-minute-compare="${features.format.escapeHTML(row.code)}" aria-label="对比 ${features.format.escapeHTML(row.name)} ${features.format.escapeHTML(row.code)}"><span class="minute-stock-row-name">${features.format.escapeHTML(row.name)}<small>${features.format.escapeHTML(row.code)} · ${row.boards ? `${features.format.numberValue(row.boards)} 板` : "主板"}</small></span><small class="minute-compare-status"></small></label>`).join("") + (rows.length > visible.length ? `<button type="button" class="minute-more" data-minute-compare-more>显示更多（剩余 ${rows.length - visible.length} 只）</button>` : "") || features.format.emptyHTML("没有匹配的股票", "试试其他名称、代码或首字母。");
  features.intraday.updateMinuteCompareSelection();
}

function updateMinuteCompareSelection() {
  const codes = featureState.minuteCompareCodes || [];
  $("minute-compare-count").textContent = String(codes.length);
  $("minute-compare-clear").disabled = !codes.length;
  $("minute-compare-list").querySelectorAll("[data-compare-row]").forEach(row => {
    const code = row.dataset.compareRow, primary = code === featureState.intradayCode, index = codes.indexOf(code);
    const entry = featureState.minuteComparisons?.get(code), input = row.querySelector("input");
    input.checked = index >= 0;
    input.disabled = primary;
    row.classList.toggle("selected", index >= 0);
    row.classList.toggle("is-primary", primary);
    row.style.setProperty("--compare-color", index >= 0 ? features.intraday.minuteCompareStyle(index).color : "#8b8795");
    row.querySelector(".minute-compare-status").textContent = primary ? "主图" : index < 0 ? "" : entry?.loading ? "读取中" : entry?.error ? "读取失败" : entry?.data?.points.length ? (entry.data.status === "partial" ? "部分数据" : "已叠加") : "无数据";
  });
}

function renderMinuteCompareLegend(slot = null, clock = null) {
  const codes = featureState.minuteCompareCodes || [], data = featureState.minuteDetail;
  $("minute-compare-legend").hidden = !codes.length;
  const item = (detail, label, color, dash, status = "") => {
    const point = features.intraday.minutePointAt(detail, slot, clock);
    const pct = point && detail.previous_close > 0 ? (point.price / detail.previous_close - 1) * 100 : null;
    const value = pct === null ? status || "该分钟缺失" : `${pct >= 0 ? "+" : ""}${features.format.numberValue(pct, 2)}% · ${features.format.numberValue(features.intraday.minuteDisplayPoint(detail, point).volume / 100)} 手`;
    return `<span class="minute-compare-chip"><svg viewBox="0 0 20 8" aria-hidden="true"><path d="M0 4H20" stroke="${color}"${dash ? ` stroke-dasharray="${dash}"` : ""}/></svg><span>${features.format.escapeHTML(label)}</span><span>${features.format.escapeHTML(value)}</span></span>`;
  };
  $("minute-compare-legend").innerHTML = !codes.length ? "" :
    (data ? item(data, `${data.stock.name}（主图）`, "#ce6251", "") : "") + codes.map((code, index) => {
      const entry = featureState.minuteComparisons?.get(code), row = featureState.intradayData?.rows.find(r => r.code === code) || featureState.minuteTimelineData?.pool?.find(r => r.code === code) || entry?.data?.stock, style = features.intraday.minuteCompareStyle(index);
      return item(entry?.data, row?.name || code, style.color, style.dash, entry?.loading ? "读取中…" : entry?.error ? "读取失败，请重选" : entry?.data?.points.length ? "" : "暂无分时");
    }).join("");
  features.intraday.updateMinuteVolumeReadings(slot, clock);
}

function minutePointAt(detail, slot = null, clock = null) {
  return slot === "auction" ? detail?.auction?.points?.at(-1) : slot === null ? detail?.points.at(-1) : detail?.points.find(p => clock ? p.time === clock : p.slot === slot);
}

function updateMinuteVolumeReadings(slot = null, clock = null) {
  $("minute-chart").querySelectorAll("[data-minute-volume-row]").forEach(row => {
    const code = row.dataset.minuteVolumeRow;
    const detail = featureState.minuteDetail?.stock.code === code ? featureState.minuteDetail : featureState.minuteComparisons?.get(code)?.data;
    const point = features.intraday.minutePointAt(detail, slot, clock), stamp = slot === "auction" ? "09:25" : clock || point?.time || "";
    row.querySelector("[data-volume-reading]").textContent = `${stamp ? `${stamp} · ` : ""}${point ? `${features.format.numberValue(features.intraday.minuteDisplayPoint(detail, point).volume / 100)} 手` : "该分钟缺失"}`;
    const cursor = row.querySelector(".minute-volume-cursor");
    cursor.toggleAttribute("hidden", slot === null);
    if (slot !== null) {
      const xx = slot === "auction" ? 140 : featureState.minuteChartScale.x(slot);
      cursor.setAttribute("x1", xx);
      cursor.setAttribute("x2", xx);
    }
  });
}

function refreshMinuteComparisonChart() {
  features.intraday.updateMinuteCompareSelection();
  if (!featureState.minuteLoading && featureState.minuteDetail?.points.length) {
    const refocus = document.activeElement?.matches?.(".minute-svg"), hoverMode = featureState.minuteHoverMode;
    $("minute-chart").innerHTML = features.intraday.minuteChartHTML(featureState.minuteDetail);
    if (refocus) $("minute-chart").querySelector(".minute-svg")?.focus({preventScroll: true});
    if (hoverMode === "auction") features.intraday.showMinuteAuctionPoint(); else features.intraday.showMinutePoint(featureState.minutePointIndex || 0);
  } else features.intraday.renderMinuteCompareLegend();
}

async function loadMinuteComparison(code) {
  const day = featureState.intradayDate, generation = featureState.intradayGeneration;
  const entry = {loading: true};
  featureState.minuteComparisons ??= new Map();
  featureState.minuteComparisons.set(code, entry);
  const current = () => features.navigation.read("tab") === "intraday" && day === featureState.intradayDate && generation === featureState.intradayGeneration &&
    featureState.minuteComparisons.get(code) === entry && featureState.minuteCompareCodes.includes(code);
  features.intraday.updateMinuteCompareSelection();
  features.intraday.renderMinuteCompareLegend();
  try {
    const data = await features.intraday.requestMinuteData(day, code, `minute-compare-${code}`, current);
    if (!current()) return;
    if (!data) throw new Error("分时读取已中断");
    entry.data = data;
    features.intraday.recordMinuteData(data);
  } catch (error) {
    if (!current()) return;
    entry.error = error.message;
  } finally {
    if (current()) {
      entry.loading = false;
      features.intraday.refreshMinuteComparisonChart();
    }
  }
}

async function selectMinuteComparison(code, selected) {
  const available = featureState.intradayData?.rows.some(row => row.code === code) || featureState.minuteTimelineData?.date === featureState.intradayDate && featureState.minuteTimelineData?.pool?.some(row => row.code === code);
  if (code === featureState.intradayCode || selected && !available) return;
  const codes = featureState.minuteCompareCodes ||= [];
  if (selected && !codes.includes(code)) codes.push(code);
  else if (!selected) {
    featureState.minuteCompareCodes = codes.filter(value => value !== code);
    features.api.channels[`minute-compare-${code}`]?.abort();
    featureState.minuteComparisons?.delete(code);
  } else return;
  features.navigation.updateURL();
  features.intraday.refreshMinuteComparisonChart();
  if (selected) await features.intraday.loadMinuteComparison(code);
}

function clearMinuteComparisons() {
  (featureState.minuteCompareCodes || []).forEach(code => features.api.channels[`minute-compare-${code}`]?.abort());
  featureState.minuteCompareCodes = [];
  featureState.minuteComparisons = new Map();
  features.navigation.updateURL();
  features.intraday.refreshMinuteComparisonChart();
}

async function requestMinuteData(day, code, channel, current = () => true) {
  let data = await features.api.request(`/api/intraday/stock?date=${encodeURIComponent(day)}&code=${encodeURIComponent(code)}`, channel);
  if (!current()) return null;
  if ((data?.needs_collection || data?.needs_refresh) && features.shell.read("meta")?.capabilities?.edit_tags === true) {
    data = await features.api.request("/api/intraday/collect", channel, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({date: day, code})});
  }
  return data;
}

function recordMinuteData(data) {
  if (data.date !== featureState.intradayDate || !featureState.intradayData) return;
  const rows = featureState.intradayData.rows, row = rows.find(r => r.code === data.stock.code);
  const changed = row && (row.status !== data.status || row.point_count !== data.points.length);
  if (row) { row.status = data.status; row.point_count = data.points.length; }
  featureState.intradayData.ready = rows.filter(r => r.status === "ok").length;
  featureState.intradayData.partial = rows.filter(r => r.status === "partial").length;
  $("minute-coverage").textContent = `主板 ${featureState.intradayData.total} 只 · 已缓存 ${featureState.intradayData.ready} 只完整分时${featureState.intradayData.partial ? ` · ${featureState.intradayData.partial} 只部分数据` : ""} · 未缓存按需采集`;
  $("minute-stock-list").querySelectorAll(`[data-minute-status="${data.stock.code}"]`).forEach(label => { label.textContent = data.status === "ok" ? "已采集" : data.status === "partial" ? "部分数据" : "读取失败，可重选"; });
  if (changed && !featureState.minuteTimelineCollecting && !featureState.minuteLiveRefreshing && featureState.minuteTimelineData?.date === data.date && featureState.minuteTimelineData.pool?.some(stock => stock.code === data.stock.code)) features.intraday.loadMinuteTimeline({quiet: true});
}

async function refreshVisibleMinuteData() {
  if (features.navigation.read("tab") !== "intraday" || document.hidden || featureState.minuteLiveRefreshing || featureState.minuteLoading || featureState.minuteTimelineCollecting ||
      !featureState.intradayDate || !features.shell.read("meta")?.live?.enabled ||
      featureState.intradayDate !== features.shell.read("meta").live.today) return;
  const refreshKey = `${featureState.intradayDate}|${$("minute-timeline-exclude-gem").checked !== false}`;
  if (featureState.minuteLiveRefreshKey === refreshKey && Date.now() - (featureState.minuteLiveRefreshedAt || 0) < 60000) return;
  const day = featureState.intradayDate, generation = featureState.intradayGeneration, primary = featureState.intradayCode;
  const stockGeneration = featureState.minuteStockGeneration;
  const current = () => features.navigation.read("tab") === "intraday" && !document.hidden && day === featureState.intradayDate && generation === featureState.intradayGeneration;
  const timelineEnabled = features.intraday.minuteTimelineLiveEnabled(), excludeGem = $("minute-timeline-exclude-gem").checked !== false;
  const scopeCurrent = () => current() && (!timelineEnabled || excludeGem === ($("minute-timeline-exclude-gem").checked !== false));
  const status = timelineEnabled ? {date: day, key: refreshKey, running: true, done: 0, total: 0, failed: 0} : null;
  if (status) { featureState.minuteTimelineLiveStatus = status; $("minute-timeline-progress").hidden = true; }
  featureState.minuteLiveRefreshing = true;
  featureState.minuteLiveRefreshKey = refreshKey;
  featureState.minuteLiveRefreshedAt = Date.now();
  features.intraday.updateMinuteTimelineControls();
  try {
    const overview = await features.api.request(`/api/intraday?date=${encodeURIComponent(day)}`, "minute-live-overview");
    if (!overview || !current()) return;
    featureState.intradayData = overview;
    featureState.minuteComparisons ||= new Map();
    features.intraday.updateMinuteDateNavigation();
    const leftScroll = $("minute-stock-list").scrollTop, rightScroll = $("minute-compare-list").scrollTop;
    features.intraday.renderMinuteList(); features.intraday.renderMinuteCompareList();
    $("minute-stock-list").scrollTop = leftScroll; $("minute-compare-list").scrollTop = rightScroll;
    if (timelineEnabled) await features.intraday.loadMinuteTimeline({quiet: true});
    if (!scopeCurrent()) return;
    const pool = timelineEnabled && featureState.minuteTimelineData?.date === day ? featureState.minuteTimelineData.pool || [] : [];
    const poolCodes = new Set(pool.map(stock => stock.code));
    // Share three workers between visible charts and the current timeline pool.
    const codes = [...new Set([primary, ...(featureState.minuteCompareCodes || []), ...poolCodes])].filter(Boolean);
    if (status) { status.total = codes.length; features.intraday.updateMinuteTimelineLiveStatus(); }
    const collect = async () => {
      while (codes.length && scopeCurrent()) {
        const code = codes.shift();
        const selected = () => scopeCurrent() && (code === featureState.intradayCode || featureState.minuteCompareCodes?.includes(code) || poolCodes.has(code) && features.intraday.minuteTimelineLiveEnabled());
        try {
          const data = await features.intraday.requestMinuteData(day, code, `minute-live-${code}`, selected);
          if (!data || !selected()) continue;
          if (!data.points.length) { if (status) status.failed++; continue; }
          if (status && data.refresh_error) status.failed++;
          const existing = code === primary ? featureState.minuteDetail : featureState.minuteComparisons.get(code)?.data;
          if (existing?.fetched_at && data.fetched_at < existing.fetched_at) continue;
          features.intraday.recordMinuteData(data);
          if (code === primary && featureState.intradayCode === primary && stockGeneration === featureState.minuteStockGeneration) {
            const refocus = document.activeElement?.matches?.(".minute-svg");
            featureState.minuteDetail = data;
            features.intraday.renderMinuteStockData(data);
            if (refocus) $("minute-chart").querySelector(".minute-svg")?.focus({preventScroll: true});
            if (featureState.minuteHoverMode === "auction") features.intraday.showMinuteAuctionPoint(); else features.intraday.showMinutePoint(featureState.minutePointIndex || 0);
          } else if (featureState.minuteCompareCodes?.includes(code)) {
            featureState.minuteComparisons.set(code, {loading: false, data});
          }
        } catch {
          if (selected()) {
            if (status) status.failed++;
            if (code === primary) $("minute-data-note").textContent += " · 自动刷新未完成，保留已缓存数据";
          }
        } finally {
          if (status && scopeCurrent()) { status.done++; features.intraday.updateMinuteTimelineLiveStatus(); }
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(3, codes.length)}, collect));
    if (scopeCurrent()) {
      features.intraday.refreshMinuteComparisonChart();
      await features.intraday.loadMinuteTimeline({quiet: true});
    }
  } catch {
    if (current()) $("minute-data-note").textContent += " · 自动刷新未完成，1 分钟后重试";
    if (status && current()) status.failed++;
  } finally {
    featureState.minuteLiveRefreshing = false;
    if (status) { status.running = false; status.checkedAt = new Date().toISOString(); }
    features.intraday.updateMinuteTimelineControls();
  }
}

function minuteTimelineLiveEnabled() {
  return features.navigation.read("tab") === "intraday" && features.shell.read("meta")?.capabilities?.edit_tags === true &&
    features.shell.read("meta")?.live?.polling === true && featureState.intradayDate === features.shell.read("meta").live.today;
}

function updateMinuteTimelineLiveStatus() {
  const label = $("minute-timeline-live-status");
  label.hidden = !(features.navigation.read("tab") === "intraday" && features.shell.read("meta")?.capabilities?.edit_tags === true && features.shell.read("meta")?.live?.enabled && featureState.intradayDate === features.shell.read("meta").live.today);
  if (label.hidden) return;
  if (!features.shell.read("meta").live.polling) { label.textContent = "盘中每分钟自动获取 · 当前非采集时段，已暂停"; return; }
  const key = `${featureState.intradayDate}|${$("minute-timeline-exclude-gem").checked !== false}`;
  const status = featureState.minuteTimelineLiveStatus?.key === key ? featureState.minuteTimelineLiveStatus : null;
  const stamp = status?.checkedAt ? new Date(status.checkedAt).toLocaleTimeString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false}) : "";
  label.textContent = `盘中每分钟自动获取${status?.running ? ` · 正在更新 ${status.done} / ${status.total} 只` : stamp ? ` · 最近检查 ${stamp}${status.failed ? " · 部分未更新，下分钟重试" : ""}` : ""}`;
}

function minuteDisplayPoint(data, point) {
  const match = data.auction?.points?.find(p => p.time === "09:25");
  if (point.time === "09:30" && match && point.volume >= match.volume && point.amount + 0.1 >= match.amount) {
    return {...point, volume: Math.max(0, point.volume - match.volume), amount: Math.max(0, point.amount - match.amount)};
  }
  return point;
}

async function loadIntraday({day = featureState.intradayDate || "", code = featureState.intradayCode || ""} = {}) {
  features.intraday.stopMinuteTimelineCollection(false);
  features.intraday.closeMinuteTimelineStockPickers();
  featureState.minuteTimelineData = null;
  $("minute-timeline-list").innerHTML = features.format.loadingHTML();
  $("minute-timeline-coverage").textContent = "正在读取当日股票节点…";
  features.intraday.updateMinuteTimelineControls();
  const generation = featureState.intradayGeneration = (featureState.intradayGeneration || 0) + 1;
  featureState.minuteStockGeneration = (featureState.minuteStockGeneration || 0) + 1;
  featureState.minuteDetail = null;
  featureState.minuteLoading = false;
  Object.keys(features.api.channels).filter(channel => channel.startsWith("minute-compare-")).forEach(channel => features.api.channels[channel]?.abort());
  featureState.minuteComparisons = new Map();
  $("minute-compare-list").innerHTML = features.format.loadingHTML();
  $("minute-compare-list").setAttribute("aria-busy", "true");
  $("minute-compare-clear").disabled = true;
  $("minute-compare-legend").hidden = true;
  featureState.intradayDate = day;
  featureState.intradayCode = code;
  features.intraday.updateMinuteDateNavigation();
  features.api.channels["intraday-stock"]?.abort();
  features.navigation.setView("intraday");
  $("minute-stock-list").setAttribute("aria-busy", "true");
  $("minute-stock-list").innerHTML = features.format.loadingHTML();
  $("minute-chart").innerHTML = features.format.loadingHTML();
  $("minute-chart").setAttribute("aria-busy", "true");
  $("minute-chart").setAttribute("data-loading-label", "正在读取分时…");
  $("minute-show-average").disabled = false;
  $("minute-stock-history").disabled = false;
  $("minute-stock-title").textContent = "正在读取分时";
  $("minute-stock-code").textContent = "";
  features.intraday.renderMinuteProfile({}, true);
  $("minute-stock-boards").hidden = true;
  $("minute-quote").hidden = true;
  $("minute-stock-history").hidden = true;
  $("minute-hover").textContent = "正在读取本地分钟数据…";
  $("minute-data-note").textContent = "";
  try {
    const data = await features.api.request(`/api/intraday${day ? `?date=${encodeURIComponent(day)}` : ""}`, "intraday");
    if (!data || features.navigation.read("tab") !== "intraday" || generation !== featureState.intradayGeneration) return;
    featureState.intradayData = data;
    featureState.intradayDate = data.date || "";
    features.intraday.updateMinuteDateNavigation();
    $("minute-coverage").textContent = `主板 ${data.total} 只 · 已缓存 ${data.ready} 只完整分时${data.partial ? ` · ${data.partial} 只部分数据` : ""} · 未缓存按需采集`;
    $("minute-scope").textContent = `${data.scope_note} 已采集的数据可离线查看。`;
    await features.intraday.loadMinuteTimeline();
    if (features.navigation.read("tab") !== "intraday" || generation !== featureState.intradayGeneration) return;
    const timelineCodes = new Set((featureState.minuteTimelineData?.pool || []).map(row => row.code));
    const visible = features.intraday.minuteRows();
    featureState.intradayCode = visible.some(row => row.code === code) || timelineCodes.has(code) ? code : visible[0]?.code || "";
    featureState.minuteCompareCodes = [...new Set(featureState.minuteCompareCodes || [])].filter(value => value !== featureState.intradayCode && (data.rows.some(row => row.code === value) || timelineCodes.has(value)));
    features.intraday.renderMinuteList();
    features.intraday.renderMinuteCompareList();
    features.navigation.updateURL({replace: true});
    if (featureState.intradayCode) await Promise.all([features.intraday.loadMinuteStock(featureState.intradayCode, false), ...featureState.minuteCompareCodes.map(value => features.intraday.loadMinuteComparison(value))]);
    else {
      featureState.minuteDetail = null;
      $("minute-stock-title").textContent = "暂无可查看的数据";
      $("minute-stock-detail").textContent = "";
      $("minute-hover").textContent = "";
      $("minute-chart").innerHTML = features.format.emptyHTML("暂无可选交易日", "项目交易日历就绪后，切换日期即可按需读取分时。", "calendar");
    }
  } catch (error) {
    if (features.navigation.read("tab") === "intraday" && generation === featureState.intradayGeneration) {
      features.shell.showError(error, () => features.intraday.loadIntraday({day, code}));
      $("minute-coverage").textContent = "本地分时数据暂未读取成功";
      $("minute-stock-list").innerHTML = features.format.emptyHTML("读取失败", "请点击重新加载。");
      $("minute-stock-title").textContent = "读取失败";
      $("minute-chart").innerHTML = features.format.emptyHTML("分时查询未完成", error.message);
      $("minute-compare-list").innerHTML = features.format.emptyHTML("读取失败", "请点击刷新数据。");
    }
  } finally {
    if (generation === featureState.intradayGeneration) {
      $("minute-stock-list").setAttribute("aria-busy", "false");
      $("minute-compare-list").setAttribute("aria-busy", "false");
      $("minute-chart").setAttribute("aria-busy", String(featureState.minuteLoading));
      if (features.intraday.minuteTimelineLiveEnabled()) features.intraday.refreshVisibleMinuteData();
    }
  }
}

function renderMinuteStockData(data) {
  const day = data.date;
  $("minute-stock-title").textContent = data.stock.name;
  $("minute-stock-code").textContent = data.stock.code;
  $("minute-stock-boards").hidden = !data.stock.boards;
  $("minute-stock-boards").textContent = `${data.stock.boards || "—"} 板`;
  features.intraday.renderMinuteProfile(data.stock);
  $("minute-stock-history").hidden = false;
  $("minute-stock-detail").textContent = `${features.format.dateLabel(day)} · 不复权${data.provisional ? " · 盘中暂定" : ""}${data.stock.first_time ? ` · 首封 ${data.stock.first_time.slice(-8)}` : ""}`;
  $("minute-data-note").textContent = `${data.source || "本地分时档案"} · ${data.note}${data.reference_basis?.includes("未校正除权") ? " · 涨幅按前交易日分时收盘参考，除权日可能有差异" : ""}${data.fetched_at ? ` · 采集于 ${data.fetched_at.slice(0, 19).replace("T", " ")}（北京时间）` : ""}${data.provisional ? " · 每分钟刷新，收盘前数据可能变化" : ""}${data.refresh_error ? " · 本次采集未完成，保留上次分时并自动重试" : ""}`;
  if (!data.points.length) {
    $("minute-quote").hidden = true;
    $("minute-hover").textContent = "";
    $("minute-chart").innerHTML = features.format.emptyHTML("该日暂无可用分时", data.note, "calendar");
    return;
  }
  const last = data.points.at(-1);
  const pct = (last.price / data.previous_close - 1) * 100;
  $("minute-quote").hidden = false;
  $("minute-quote").innerHTML = `<strong class="${pct >= 0 ? "minute-up" : "minute-down"}">${features.format.numberValue(last.price, 2)}</strong><span class="${pct >= 0 ? "minute-up" : "minute-down"}">${pct >= 0 ? "+" : ""}${features.format.numberValue(pct, 2)}%</span><small title="${features.format.escapeHTML(data.reference_basis || "当日收盘价和涨幅推算")}">昨收参考 ${features.format.numberValue(data.previous_close, 2)}</small><small>成交 ${features.format.numberValue(data.points.reduce((sum, p) => sum + p.amount, 0) / 100000000, 2)} 亿元</small>`;
  $("minute-hover").textContent = "移动到图表查看分钟数据，也可聚焦图表后使用左右方向键。";
  $("minute-chart").innerHTML = features.intraday.minuteChartHTML(data);
}

async function loadMinuteStock(code, update = true) {
  const day = featureState.intradayDate;
  if (update && !featureState.minuteLoading && featureState.intradayCode === code && featureState.minuteDetail?.stock.code === code && featureState.minuteDetail.date === day) return;
  const generation = featureState.minuteStockGeneration = (featureState.minuteStockGeneration || 0) + 1;
  const current = () => generation === featureState.minuteStockGeneration && features.navigation.read("tab") === "intraday" && day === featureState.intradayDate && code === featureState.intradayCode;
  featureState.intradayCode = code;
  featureState.minuteLoading = true;
  // A selected peer becomes the primary without drawing the same stock twice.
  featureState.minuteCompareCodes = (featureState.minuteCompareCodes || []).filter(value => value !== code);
  features.api.channels[`minute-compare-${code}`]?.abort();
  featureState.minuteComparisons?.delete(code);
  features.intraday.updateMinuteSelection();
  features.intraday.updateMinuteCompareSelection();
  if (update) features.navigation.updateURL();
  features.shell.clearError();
  const row = featureState.intradayData?.rows.find(item => item.code === code);
  // Keep the rendered stock and panel height until its replacement is ready.
  // Selection only changes classes; the list retains its nodes and scroll.
  if (!featureState.minuteDetail) {
    $("minute-stock-title").textContent = row?.name || code;
    $("minute-stock-code").textContent = code;
    $("minute-stock-boards").hidden = !row?.boards;
    $("minute-stock-boards").textContent = `${row?.boards || "—"} 板`;
    features.intraday.renderMinuteProfile(row || {code, name: code}, !row);
    $("minute-stock-detail").textContent = `${features.format.dateLabel(day)} · 不复权`;
  }
  $("minute-stock-history").disabled = true;
  $("minute-show-average").disabled = true;
  $("minute-chart").setAttribute("data-loading-label", `正在切换至 ${row?.name || code}…`);
  $("minute-chart").setAttribute("aria-busy", "true");
  try {
    const data = await features.intraday.requestMinuteData(day, code, "intraday-stock", current);
    if (!data || !current()) return;
    featureState.minuteDetail = data;
    featureState.minutePointIndex = 0;
    featureState.minuteHoverMode = "regular";
    features.intraday.recordMinuteData(data);
    features.intraday.renderMinuteCompareLegend();
    features.intraday.renderMinuteStockData(data);
  } catch (error) {
    if (current()) {
      features.shell.showError(error, () => features.intraday.loadMinuteStock(code, false));
      if (!featureState.minuteDetail) {
        $("minute-chart").innerHTML = features.format.emptyHTML("读取分时失败", error.message);
        $("minute-hover").textContent = "";
      }
    }
  } finally {
    if (generation === featureState.minuteStockGeneration) {
      featureState.minuteLoading = false;
      $("minute-chart").setAttribute("aria-busy", "false");
      $("minute-stock-history").disabled = false;
      $("minute-show-average").disabled = false;
      features.intraday.renderMinuteCompareLegend();
    }
  }
}

function minuteChartHTML(data) {
  const prev = data.previous_close, showAverage = $("minute-show-average").checked;
  const peers = (featureState.minuteCompareCodes || []).map((code, index) => ({code, index, data: featureState.minuteComparisons?.get(code)?.data}))
    .filter(peer => peer.data?.points.length && peer.data.previous_close > 0);
  const series = [{data, color: "#ce6251"}, ...peers.map(peer => ({data: peer.data, color: features.intraday.minuteCompareStyle(peer.index).color}))];
  const prices = series.flatMap(item => [...item.data.points, ...(item.data.auction?.points || [])].flatMap(p => [Math.abs(p.price / item.data.previous_close - 1) * prev, showAverage && item.data === data && p.average ? Math.abs(p.average - prev) : 0]));
  const extent = Math.max(prev * 0.01, ...prices) * 1.08, low = Math.max(0.001, prev - extent), high = prev + extent;
  const x = slot => 170 + slot / 240 * 750;
  const y = price => 28 + (high - price) / (high - low) * 270;
  featureState.minuteChartScale = {x, y, slotAt: px => (px - 170) / 750 * 240};
  const path = (key, points = data.points, previousClose = prev) => {
    let previous = null;
    return points.map(p => {
      if (!Number.isFinite(p[key])) { previous = null; return ""; }
      const move = previous === null || p.slot - previous > 1;
      previous = p.slot;
      return `${move ? "M" : "L"}${x(p.slot).toFixed(2)},${y(p[key] / previousClose * prev).toFixed(2)}`;
    }).join(" ");
  };
  let axes = "";
  for (let i = 0; i <= 4; i++) {
    const price = high - (high - low) * i / 4, yy = y(price);
    axes += `<line x1="70" y1="${yy}" x2="920" y2="${yy}" class="minute-grid"/><text x="59" y="${yy + 4}" text-anchor="end">${price.toFixed(2)}</text><text x="932" y="${yy + 4}">${((price / prev - 1) * 100).toFixed(2)}%</text>`;
  }
  const sharedScale = featureState.minuteVolumeScale !== "individual";
  const maxima = series.map(item => [...item.data.points.map(p => features.intraday.minuteDisplayPoint(item.data, p).volume), ...(item.data.auction?.points || []).map(p => p.volume)].reduce((max, volume) => Math.max(max, volume), 1));
  const commonMax = maxima.reduce((max, volume) => Math.max(max, volume), 1);
  const volume = series.map((item, index) => {
    const maxVolume = sharedScale ? commonMax : maxima[index], stock = item.data.stock;
    const bars = item.data.points.map(raw => {
      const p = features.intraday.minuteDisplayPoint(item.data, raw), height = p.volume / maxVolume * 86;
      return `<rect x="${(x(p.slot) - 1.4).toFixed(2)}" y="${(94 - height).toFixed(2)}" width="2.8" height="${height.toFixed(2)}" class="minute-volume-bar${index ? " minute-compare-volume" : ""}" data-volume-code="${features.format.escapeHTML(stock.code)}" style="fill:${item.color}"/>`;
    }).join("");
    const match = (item.data.auction?.points || []).map(p => {
      const height = p.volume / maxVolume * 86;
      return `<rect x="136.5" y="${(94 - height).toFixed(2)}" width="7" height="${height.toFixed(2)}" class="minute-auction-volume" style="fill:${item.color}"/>`;
    }).join("");
    const last = features.intraday.minuteDisplayPoint(item.data, item.data.points.at(-1));
    return `<div class="minute-volume-row" data-minute-volume-row="${features.format.escapeHTML(stock.code)}" data-volume-max="${maxVolume}" style="--volume-color:${item.color}">
      <div class="minute-volume-heading"><span class="minute-volume-stock" title="${features.format.escapeHTML(stock.name)} ${features.format.escapeHTML(stock.code)}"><i style="background:${item.color}"></i>${features.format.escapeHTML(stock.name)}${index ? "" : "（主图）"}<small>${features.format.escapeHTML(stock.code)}</small></span><span data-volume-reading>${features.format.escapeHTML(last.time)} · ${features.format.numberValue(last.volume / 100)} 手</span></div>
      <div class="minute-volume-limit">刻度上限 ${features.format.numberValue(maxVolume / 100)} 手</div>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" class="minute-volume-svg" role="img" aria-label="${features.format.escapeHTML(stock.name)} ${features.format.escapeHTML(stock.code)} 的分钟成交量，${sharedScale ? "统一" : "各自"}刻度">
        <rect x="70" y="0" width="85" height="94" class="minute-auction-bg"/><line x1="70" x2="920" y1="94" y2="94" class="minute-grid"/><line x1="545" x2="545" y1="0" y2="94" class="minute-grid"/>${bars}${match}<line class="minute-volume-cursor" x1="170" x2="170" y1="0" y2="94" hidden/>
      </svg></div>`;
  }).join("");
  const auction = series.map(item => (item.data.auction?.points || []).map(p => {
    const yy = y(p.price / item.data.previous_close * prev);
    return `<circle cx="140" cy="${yy.toFixed(2)}" r="3.5" class="minute-auction-point" data-auction-code="${features.format.escapeHTML(item.data.stock.code)}" style="fill:${item.color}"/>`;
  }).join("")).join("");
  const comparisons = peers.map(peer => {
    const style = features.intraday.minuteCompareStyle(peer.index);
    return `<path d="${path("price", peer.data.points, peer.data.previous_close)}" class="minute-compare-line" data-compare-code="${features.format.escapeHTML(peer.code)}" stroke="${style.color}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`;
  }).join("");
  return `<svg viewBox="0 0 1000 335" class="minute-svg" tabindex="0" role="img" aria-label="${features.format.escapeHTML(data.stock.name)} ${features.format.escapeHTML(data.date)} 分时价格、${showAverage ? "均价和" : ""}成交量。${peers.length ? `与 ${features.format.escapeHTML(peers.map(peer => peer.data.stock.name).join("、"))} 按昨收涨幅及分行成交量对比。` : ""}左侧竞价区域仅显示已取得的 09:25 撮合点。使用左右方向键逐分钟查看。">
    <rect x="70" y="28" width="85" height="270" class="minute-auction-bg"/><text x="112" y="47" text-anchor="middle">竞价</text><text x="16" y="16">${peers.length ? "主图价格 / 元" : "价格 / 元"}</text><text x="932" y="16">涨幅</text>${axes}
    <line x1="70" y1="${y(prev)}" x2="920" y2="${y(prev)}" class="minute-reference"/><line x1="545" y1="28" x2="545" y2="298" class="minute-grid"/>
    ${comparisons}${showAverage ? `<path d="${path("average")}" class="minute-average-line"/>` : ""}<path d="${path("price")}" class="minute-price-line"/>
    ${auction}${!data.auction?.points?.length ? '<text x="112" y="180" text-anchor="middle">暂无竞价</text>' : ""}
    <text x="70" y="324" text-anchor="middle">09:15</text><text x="130" y="324" text-anchor="middle">09:25</text><text x="180" y="324" text-anchor="middle">09:30</text><text x="357.5" y="324" text-anchor="middle">10:30</text><text x="545" y="324" text-anchor="middle">11:30 / 13:00</text><text x="732.5" y="324" text-anchor="middle">14:00</text><text x="920" y="324" text-anchor="middle">15:00</text>
    <g id="minute-crosshair" hidden><line id="minute-cursor-line" x1="170" x2="170" y1="28" y2="298"/><circle id="minute-cursor-dot" cx="170" cy="28" r="4"/></g>
  </svg><div class="minute-volume-toolbar"><span>成交量 / 手</span>${series.length > 1 ? `<div class="minute-volume-modes" role="group" aria-label="成交量刻度"><button type="button" data-minute-volume-scale="shared" aria-pressed="${sharedScale}" title="相同柱高代表相同手数">统一刻度</button><button type="button" data-minute-volume-scale="individual" aria-pressed="${!sharedScale}" title="各行独立缩放，便于查看各股量能变化；柱高不直接比较手数">各自刻度</button></div>` : ""}</div>${volume}<div class="minute-volume-times" aria-hidden="true"><span style="left:17%">09:30</span><span style="left:54.5%">11:30 / 13:00</span><span style="left:92%">15:00</span></div>`;
}

function showMinuteAuctionPoint() {
  const data = featureState.minuteDetail, point = data?.auction?.points?.at(-1);
  if (featureState.minuteLoading || !data?.points.length || !$("minute-crosshair")) return;
  featureState.minuteHoverMode = "auction";
  $("minute-crosshair").removeAttribute("hidden");
  $("minute-cursor-line").setAttribute("x1", 140);
  $("minute-cursor-line").setAttribute("x2", 140);
  if (!point) {
    $("minute-cursor-dot").setAttribute("hidden", "");
    $("minute-hover").textContent = "主图该日竞价记录未取得；下方显示对比股已取得的竞价读数。";
    features.intraday.renderMinuteCompareLegend("auction");
    return;
  }
  $("minute-cursor-dot").removeAttribute("hidden");
  $("minute-cursor-dot").setAttribute("cx", 140);
  $("minute-cursor-dot").setAttribute("cy", featureState.minuteChartScale.y(point.price));
  $("minute-hover").textContent = `09:25 开盘竞价撮合　价格 ${features.format.numberValue(point.price, 2)}　涨幅 ${features.format.numberValue((point.price / data.previous_close - 1) * 100, 2)}%　撮合量 ${features.format.numberValue(point.volume / 100)} 手　金额 ${features.format.numberValue(point.amount / 10000, 2)} 万元`;
  features.intraday.renderMinuteCompareLegend("auction");
}

function showMinutePoint(index) {
  const data = featureState.minuteDetail;
  if (featureState.minuteLoading || !data?.points.length || !$("minute-crosshair")) return;
  index = Math.max(0, Math.min(data.points.length - 1, index));
  featureState.minutePointIndex = index;
  featureState.minuteHoverMode = "regular";
  $("minute-cursor-dot").removeAttribute("hidden");
  const point = features.intraday.minuteDisplayPoint(data, data.points[index]), {x, y} = featureState.minuteChartScale;
  $("minute-crosshair").removeAttribute("hidden");
  $("minute-cursor-line").setAttribute("x1", x(point.slot));
  $("minute-cursor-line").setAttribute("x2", x(point.slot));
  $("minute-cursor-dot").setAttribute("cx", x(point.slot));
  $("minute-cursor-dot").setAttribute("cy", y(point.price));
  const average = $("minute-show-average").checked ? `　均价 ${features.format.numberValue(point.average, 3)}` : "";
  $("minute-hover").textContent = `${point.time}　价格 ${features.format.numberValue(point.price, 2)}${average}　涨幅 ${features.format.numberValue((point.price / data.previous_close - 1) * 100, 2)}%　成交量 ${features.format.numberValue(point.volume / 100)} 手　成交额 ${features.format.numberValue(point.amount / 10000, 2)} 万元`;
  features.intraday.renderMinuteCompareLegend(point.slot, point.time);
}

function toggleMinuteAverage() {
  if (!featureState.minuteDetail?.points.length) return;
  $("minute-chart").innerHTML = features.intraday.minuteChartHTML(featureState.minuteDetail);
  if (featureState.minuteHoverMode === "auction") features.intraday.showMinuteAuctionPoint(); else features.intraday.showMinutePoint(featureState.minutePointIndex || 0);
}

function minuteTimelineViewSnapshot(list) {
  const view = list.ownerDocument?.defaultView, nodes = [...list.querySelectorAll("[data-interaction-id]")];
  const anchor = view && nodes.find(node => { const box = node.getBoundingClientRect(); return box.bottom > 0 && box.top < view.innerHeight; });
  return {view, scrollY: view?.scrollY, scrollLeft: list.querySelector(".minute-day-scroll")?.scrollLeft || 0, anchorId: anchor?.dataset.interactionId, top: anchor?.getBoundingClientRect().top,
    focusId: list.ownerDocument?.activeElement?.closest(".minute-day-node")?.dataset.dayNode,
    open: new Set(nodes.filter(node => (node.matches?.(".minute-interaction-evidence") ? node : node.querySelector(".minute-interaction-evidence"))?.open).map(node => node.dataset.interactionId))};
}

function restoreMinuteTimelineView(list, snapshot) {
  const nodes = [...list.querySelectorAll("[data-interaction-id]")];
  nodes.forEach(node => { const details = node.matches?.(".minute-interaction-evidence") ? node : node.querySelector(".minute-interaction-evidence"); if (details) details.open = snapshot.open.has(node.dataset.interactionId); });
  const anchor = nodes.find(node => node.dataset.interactionId === snapshot.anchorId);
  const scroller = list.querySelector(".minute-day-scroll");
  if (scroller) scroller.scrollLeft = snapshot.scrollLeft || 0;
  if (snapshot.focusId) [...list.querySelectorAll(".minute-day-node")].find(node => node.dataset.dayNode === snapshot.focusId)?.focus({preventScroll: true});
  if (snapshot.view) snapshot.view.scrollTo({top: anchor ? snapshot.view.scrollY + anchor.getBoundingClientRect().top - snapshot.top : snapshot.scrollY, behavior: "instant"});
}

function renderMinuteTimeline({preserve = false} = {}) {
  const data = featureState.minuteTimelineData, list = $("minute-timeline-list");
  if (!data || data.date !== featureState.intradayDate) return;
  const snapshot = preserve ? features.intraday.minuteTimelineViewSnapshot(list) : null;
  const model = features.intraday.minuteTimelineDayModel(data, {group: $("minute-timeline-group").value || "all", kind: $("minute-timeline-kind").value || "all",
    exclude: featureState.minuteTimelineExcludeCodes || [], sort: featureState.minuteTimelineSort || "boards"});
  featureState.minuteTimelineDayModel = model;
  if (featureState.minuteTimelineSelectedDate !== data.date || !model.nodes.has(featureState.minuteTimelineSelectedNode)) featureState.minuteTimelineSelectedNode = null;
  if (featureState.minuteTimelineSelectedDate !== data.date || !model.rows.some(row => row.stock.code === featureState.minuteTimelineLocateCode)) featureState.minuteTimelineLocateCode = null;
  if (!featureState.minuteTimelineSelectedNode && featureState.minuteTimelineLocateCode) {
    const row = model.rows.find(row => row.stock.code === featureState.minuteTimelineLocateCode);
    featureState.minuteTimelineSelectedNode = (row.events.find(event => event.kind === "seal") || row.events[0])?.id || null;
  }
  featureState.minuteTimelineSelectedDate = data.date;
  const excludedCodes = new Set((data.pool || data.events || []).filter(stock => (featureState.minuteTimelineExcludeCodes || []).includes(stock.code)).map(stock => stock.code));
  const coverage = data.coverage || {total: 0, analyzed: 0, missing: 0, partial: 0};
  $("minute-timeline-coverage").textContent = `${features.format.dateLabel(data.date)} · ${data.provisional ? "盘中暂定涨停池" : "当日收盘涨停池"} ${coverage.total} 只 · 已分析分时 ${coverage.analyzed} 只${coverage.partial ? `（${coverage.partial} 只不完整）` : ""} · 展示 ${model.rows.length} 只股票 · ${model.nodes.size} 个自身节点${excludedCodes.size ? ` · 已排除 ${excludedCodes.size} 只` : ""}${coverage.missing ? ` · ${coverage.missing} 只待补齐` : ""}`;
  const scope = data.scope || {start_time: "09:30", exclude_st: true, exclude_gem: true};
  $("minute-timeline-scope").textContent = `09:25 起 · ST 固定屏蔽 · ${scope.exclude_gem ? "已屏蔽创业板" : "已纳入创业板"}`;
  const pitch = featureState.minuteTimelinePitch || 120;
  const ticks = Array.from({length: 242}, (_, slot) => {
    const label = slot === 121 ? "11:30 / 13:00" : features.intraday.minuteTimelineDayClock(slot);
    const seconds = pitch >= 360 ? [10, 20, 30, 40, 50] : [15, 30, 45];
    return `<span class="minute-day-tick${slot === 241 ? " is-last" : ""}" style="left:${slot * pitch}px"><time>${label}</time></span>${slot > 0 && slot < 241 ? seconds.map(second => `<span class="minute-day-second" aria-hidden="true" style="left:${(slot + second / 60) * pitch}px">${second}″</span>`).join("") : ""}`;
  }).join("");
  const evidence = [...model.nodes.values()].sort(features.intraday.minuteTimelineEventOrder).map(event => `<button type="button" class="minute-interaction-evidence-row" data-day-node="${features.format.escapeHTML(event.id)}"><time>${features.format.escapeHTML(event.time)}</time><strong>${features.format.escapeHTML(event.name)}</strong><span>${features.format.escapeHTML(event.label)}</span><small>${event.precision === "source" ? "来源时间" : "分钟观察"}${features.intraday.minuteTimelineMetric(event) ? ` · ${features.format.escapeHTML(features.intraday.minuteTimelineMetric(event))}` : ""}</small></button>`).join("");
  featureState.minuteTimelineGuideObserver?.disconnect();
  list.innerHTML = model.rows.length ? `<div class="minute-day-toolbar"><div class="minute-day-legend"><span class="day-seal">封板 / 回封</span><span class="day-break">开板</span><span class="day-volume">放量</span></div><div class="minute-day-navigation"><button type="button" data-day-pan="-1" aria-label="时间轴向前查看">←</button><span id="minute-day-visible-time">09:25 起</span><button type="button" data-day-pan="1" aria-label="时间轴向后查看">→</button><label>定位时间<input id="minute-day-jump-time" type="time" min="09:25" max="15:00" step="1" value="09:25:00" aria-label="时间轴定位时间"></label><button type="button" data-day-jump>跳转</button></div><div class="minute-day-zoom" role="group" aria-label="时间轴刻度">${[[60, "紧凑"], [120, "分钟"], [360, "秒序"]].map(([value, label]) => `<button type="button" data-day-zoom="${value}" aria-pressed="${pitch === value}" title="每分钟 ${value} 像素">${label}</button>`).join("")}</div></div><div id="minute-day-selection" class="minute-day-selection" aria-live="polite"></div><div class="minute-day-chart" data-pitch="${pitch}" style="--day-track-width:${241 * pitch}px"><div class="minute-day-header-wrap"><div class="minute-day-pan-row"><span>横向滑动 →</span><div class="minute-day-pan" tabindex="0" role="region" aria-label="时间轴横向滚动条"><div></div></div></div><div class="minute-day-axis"><div class="minute-day-axis-title"><label for="minute-day-sort">股票排序 <small>左侧冻结</small></label><select id="minute-day-sort" aria-label="股票行排序"><option value="boards"${featureState.minuteTimelineSort !== "first_time" ? " selected" : ""}>连板高度</option><option value="first_time"${featureState.minuteTimelineSort === "first_time" ? " selected" : ""}>首次涨停时间</option></select></div><div class="minute-day-ruler-scroll"><div class="minute-day-axis-track"><div class="minute-day-axis-guides" aria-hidden="true"></div><span class="minute-day-axis-active-guide" hidden aria-hidden="true"></span><span class="minute-day-axis-selected-column" hidden aria-hidden="true"></span>${ticks}<time class="minute-day-axis-cursor" hidden></time></div></div></div></div><div class="minute-day-scroll" tabindex="0" role="region" aria-label="股票自身节点时间轴，左右移动查看分钟和秒序"><div class="minute-day-board"><div class="minute-day-guides" aria-hidden="true"></div><span class="minute-day-active-guide" hidden aria-hidden="true"></span><span class="minute-day-selected-column" hidden aria-hidden="true"></span>${model.rows.map(row => features.intraday.minuteTimelineLaneHTML(row, pitch)).join("")}</div></div></div><details class="minute-interaction-evidence minute-day-evidence" data-interaction-id="day-evidence"><summary>查看全天 ${model.nodes.size} 条分时记录</summary>${evidence}</details>` : features.format.emptyHTML(coverage.total ? "当前筛选下暂无股票节点" : "该日暂无已确认的涨停池", coverage.missing ? "可补齐当日分时，识别各股自己的封板、开板和放量节点。" : "可调整股票范围、节点类型或包含／排除股票。");
  features.intraday.toggleMinuteTimelineTags();
  features.intraday.renderMinuteTimelineStockPickers();
  features.intraday.updateMinuteTimelineControls();
  features.intraday.renderMinuteTimelineSelection();
  list.querySelectorAll(".minute-day-scroll, .minute-day-pan").forEach(scroller => scroller.addEventListener("scroll", () => features.intraday.syncMinuteTimelineScroll(scroller), {passive: true}));
  if (snapshot) features.intraday.restoreMinuteTimelineView(list, snapshot);
  features.intraday.syncMinuteTimelineScroll(list.querySelector(".minute-day-scroll"));
  features.intraday.updateMinuteTimelineGuides();
  const board = list.querySelector(".minute-day-board");
  if (board && typeof ResizeObserver === "function") {
    featureState.minuteTimelineGuideObserver = new ResizeObserver(features.intraday.updateMinuteTimelineGuides);
    featureState.minuteTimelineGuideObserver.observe(board);
    board.querySelectorAll(".minute-day-lane").forEach(row => featureState.minuteTimelineGuideObserver.observe(row));
  }
}

function updateMinuteTimelineGuides() {
  const list = $("minute-timeline-list"), board = list.querySelector(".minute-day-board");
  if (!board) return;
  const guides = board.querySelector(".minute-day-guides"), axis = list.querySelector(".minute-day-axis-guides");
  if (!guides || !axis) return;
  const top = board.getBoundingClientRect().top, positions = new Map();
  board.querySelectorAll(".minute-day-node").forEach(button => {
    const x = Number.parseFloat(button.style.getPropertyValue("--node-x"));
    const height = Math.max(0, button.getBoundingClientRect().top - top);
    if (Number.isFinite(x)) positions.set(x, Math.max(positions.get(x) || 0, height));
  });
  // Equal timestamps share a guide; each node still meets it at its own height.
  guides.innerHTML = [...positions].map(([x, height]) => `<span class="minute-day-guide" style="--guide-x:${x}px;height:${height}px"></span>`).join("");
  axis.innerHTML = [...positions.keys()].map(x => `<span class="minute-day-axis-guide" style="left:${x}px"></span>`).join("");
  features.intraday.highlightMinuteTimelineGuide();
}

function highlightMinuteTimelineGuide(id) {
  const list = $("minute-timeline-list"), board = list.querySelector(".minute-day-board");
  if (!board) return;
  id ||= list.querySelector(".minute-day-node:hover")?.dataset.dayNode ||
    list.ownerDocument?.activeElement?.closest(".minute-day-node")?.dataset.dayNode || featureState.minuteTimelineSelectedNode;
  const guide = board.querySelector(".minute-day-active-guide"), axis = list.querySelector(".minute-day-axis-active-guide");
  if (!guide || !axis) return;
  const button = [...board.querySelectorAll(".minute-day-node")].find(node => node.dataset.dayNode === id);
  guide.hidden = axis.hidden = !button;
  if (!button) return;
  const x = button.style.getPropertyValue("--node-x");
  guide.style.setProperty("--guide-x", x);
  guide.style.height = `${Math.max(0, button.getBoundingClientRect().top - board.getBoundingClientRect().top)}px`;
  axis.style.left = x;
}

function minuteTimelineRegularEvent(event) {
  if (!/^\d{2}:[0-5]\d(?::[0-5]\d)?$/.test(event?.time || "")) return false;
  const parts = event.time.split(":").map(Number), seconds = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
  return seconds >= 34200 && seconds <= 41400 || seconds >= 46800 && seconds <= 54000;
}

function minuteTimelineDayModel(data, {group = "all", kind = "all", exclude = [], sort = "boards"} = {}) {
  const excluded = new Set(exclude), seals = ["seal", "relock", "last_seal"];
  const raw = data.events || (data.interactions || []).flatMap(row => row.events || []);
  const profiles = new Map((data.pool || raw).filter(stock => Number.isInteger(stock.boards) && stock.boards >= 1).map(stock => [stock.code, stock]));
  const stocks = new Map([...profiles].filter(([code, stock]) => !excluded.has(code) &&
    (group === "all" || (group === "first" ? stock.boards === 1 : stock.boards >= 2))).map(([code, stock]) => [code, {stock, firstSeal: features.intraday.minuteTimelineFirstSeal(stock, raw), events: []}]));
  // Pool clocks are usable even when the minute cache omitted the opening seal.
  const firstSeals = [...stocks.values()].filter(row => row.firstSeal && !row.firstSeal.observed).map(({stock, firstSeal}) => {
    const original = raw.find(event => event.code === stock.code && event.kind === "seal" &&
      features.intraday.minuteTimelineClock(event) === features.intraday.minuteTimelineClock(firstSeal) && event.precision === "source");
    return {...original, code: stock.code, name: stock.name, boards: stock.boards, kind: "seal", label: "首次封板", time: firstSeal.time, precision: "source",
      detail: original?.detail || `${stock.clock_source || "当日涨停池"}提供的首次封板时间`};
  });
  const nodes = new Map(), seen = new Set();
  [...firstSeals, ...raw].forEach(event => {
    const openingSeal = event.kind === "seal" && event.precision === "source" && /^09:25(?::[0-5]\d)?$/.test(event.time || "");
    if (!stocks.has(event.code) || ![...seals, "break", "volume"].includes(event.kind) || !(openingSeal || features.intraday.minuteTimelineRegularEvent(event)) ||
        kind !== "all" && !(kind === "seal" ? seals.includes(event.kind) : kind === event.kind)) return;
    const id = `${event.code}-${event.kind}-${event.time}`;
    const key = `${event.code}-${event.kind}-${features.intraday.minuteTimelineClock(event)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const {related, links, ...own} = event;
    const node = {...own, id, boards: stocks.get(event.code).stock.boards};
    nodes.set(id, node); stocks.get(event.code).events.push(node);
  });
  const rows = [...stocks.values()].map(row => ({...row, events: row.events.sort(features.intraday.minuteTimelineEventOrder)}))
    .filter(row => kind === "all" || row.events.length)
    .sort((a, b) => (sort === "first_time" ? Number(!a.firstSeal) - Number(!b.firstSeal) ||
      (a.firstSeal ? features.intraday.minuteTimelineClock(a.firstSeal) : "").localeCompare(b.firstSeal ? features.intraday.minuteTimelineClock(b.firstSeal) : "") : 0) ||
      b.stock.boards - a.stock.boards || a.stock.code.localeCompare(b.stock.code));
  return {nodes, rows};
}

function minuteTimelineFirstSeal(stock, events) {
  const valid = time => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time) &&
    (time.startsWith("09:25") || features.intraday.minuteTimelineRegularEvent({time}));
  if (valid(stock.first_time)) return {time: stock.first_time, observed: false};
  const event = events.filter(event => event.code === stock.code && event.kind === "seal" && valid(event.time))
    .sort(features.intraday.minuteTimelineEventOrder)[0];
  return event ? {time: event.time, observed: event.precision !== "source"} : null;
}

function changeMinuteTimelineSort(value) {
  const list = $("minute-timeline-list"), snapshot = features.intraday.minuteTimelineViewSnapshot(list);
  featureState.minuteTimelineSort = value === "first_time" ? "first_time" : "boards";
  features.intraday.renderMinuteTimeline();
  features.intraday.restoreMinuteTimelineView(list, {...snapshot, anchorId: null, focusId: null});
  features.intraday.syncMinuteTimelineScroll(list.querySelector(".minute-day-scroll"));
  const chart = list.querySelector(".minute-day-chart");
  if (snapshot.view && chart && chart.getBoundingClientRect().top < 0) {
    snapshot.view.scrollTo({top: snapshot.view.scrollY + chart.getBoundingClientRect().top, behavior: "instant"});
  }
  $("minute-day-sort")?.focus({preventScroll: true});
}

function minuteTimelineDayPosition(clock) {
  const parts = clock.split(":").map(Number), minute = parts[0] * 60 + parts[1] + (parts[2] || 0) / 60;
  // The auction is a single point; normal minute spacing starts at 09:30.
  return minute < 570 ? 0 : Math.max(0, Math.min(100, (minute >= 780 ? minute - 780 + 121 : minute - 570 + 1) / 241 * 100));
}

function minuteTimelineDayClock(slot) {
  if (slot < 1) return "09:25";
  const minute = Math.floor(slot) + (slot < 121 ? 569 : 659);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function minuteTimelineLaneLayout(row, pitch) {
  const tracks = [];
  const events = row.events.map(event => {
    const x = Math.round(features.intraday.minuteTimelineDayPosition(event.time) / 100 * 241 * pitch * 1e6) / 1e6;
    const left = Math.min(x, 241 * pitch - 120);
    let track = tracks.findIndex(end => left >= end);
    if (track < 0) track = tracks.length;
    tracks[track] = left + 126;
    return {event, x, left, track};
  });
  return {events, height: Math.max(84, tracks.length * 56 + 16)};
}

function minuteTimelineLaneHTML(row, pitch) {
  const stock = row.stock, layout = features.intraday.minuteTimelineLaneLayout(row, pitch);
  const nodes = layout.events.map(({event, x, left, track}) => {
    const type = ["seal", "relock", "last_seal"].includes(event.kind) ? "seal" : event.kind;
    const label = `${event.name} ${event.time} ${event.label}${event.precision !== "source" ? "，分钟观察" : ""}`;
    return `<button type="button" class="minute-day-node day-${type}" data-day-node="${features.format.escapeHTML(event.id)}" data-day-code="${features.format.escapeHTML(event.code)}" style="--node-x:${x}px;--node-left:${left}px;--node-track:${track};--node-offset:${x - left}px" aria-pressed="false" aria-label="${features.format.escapeHTML(label)}" title="${features.format.escapeHTML(event.detail || label)}${features.intraday.minuteTimelineMetric(event) ? ` · ${features.format.escapeHTML(features.intraday.minuteTimelineMetric(event))}` : ""}"><time>${features.format.escapeHTML(event.time)}</time><span>${features.format.escapeHTML(event.label)}</span>${event.precision !== "source" ? '<small>分钟观察</small>' : ""}</button>`;
  }).join("");
  return `<article class="minute-day-lane" data-interaction-id="stock-${features.format.escapeHTML(stock.code)}" data-day-stock="${features.format.escapeHTML(stock.code)}" style="--lane-height:${layout.height}px"><div class="minute-day-stock"><button type="button" data-timeline-code="${features.format.escapeHTML(stock.code)}" data-timeline-time="${features.format.escapeHTML(row.events[0]?.time || "09:30")}"><strong>${features.format.escapeHTML(stock.name)}</strong><span class="minute-day-board-count">${features.format.numberValue(stock.boards)} 板</span></button><small>${features.format.escapeHTML(stock.code)} · ${row.events.length} 个节点</small>${featureState.minuteTimelineSort === "first_time" ? `<small class="minute-day-first-seal">${row.firstSeal ? `${row.firstSeal.observed ? "涨停价出现" : "首次涨停"} <time>${features.format.escapeHTML(row.firstSeal.time)}</time>${row.firstSeal.observed ? "（分钟观察）" : ""}` : "首次涨停时间缺失"}</small>` : ""}${features.intraday.minuteTimelineTagsHTML(stock)}</div><div class="minute-day-lane-track">${nodes || '<span class="minute-day-no-events">尚无可显示节点</span>'}</div></article>`;
}

function renderMinuteTimelineSelection() {
  const model = featureState.minuteTimelineDayModel, panel = $("minute-day-selection"), list = $("minute-timeline-list");
  if (!panel || !model) return;
  const selected = model.nodes.get(featureState.minuteTimelineSelectedNode);
  const chart = list.querySelector(".minute-day-chart");
  if (chart) {
    chart.dataset.selected = String(!!selected);
    const x = selected ? Math.round(features.intraday.minuteTimelineDayPosition(selected.time) / 100 * 241 * (featureState.minuteTimelinePitch || 120) * 1e6) / 1e6 : 0;
    chart.style.setProperty("--day-selected-x", `${x}px`);
    chart.querySelectorAll(".minute-day-selected-column, .minute-day-axis-selected-column").forEach(marker => {marker.hidden = !selected;});
    const cursor = chart.querySelector(".minute-day-axis-cursor");
    if (cursor) { cursor.hidden = !selected; cursor.textContent = selected?.time || ""; }
  }
  list.querySelectorAll(".minute-day-node").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.dayNode === selected?.id)));
  const stock = model.rows.find(row => row.stock.code === (selected?.code || featureState.minuteTimelineLocateCode))?.stock;
  list.querySelectorAll(".minute-day-lane").forEach(lane => lane.classList.toggle("is-selected", lane.dataset.dayStock === stock?.code));
  panel.innerHTML = selected ? `<div class="minute-day-selected-heading"><div><time>${features.format.escapeHTML(selected.time)}</time><strong>${features.format.escapeHTML(selected.name)}</strong><span>${features.format.escapeHTML(selected.label)}</span><small>${selected.precision === "source" ? "来源时间" : "分钟观察"}${features.intraday.minuteTimelineMetric(selected) ? ` · ${features.format.escapeHTML(features.intraday.minuteTimelineMetric(selected))}` : ""}</small></div><div><button type="button" data-timeline-code="${features.format.escapeHTML(selected.code)}" data-timeline-time="${features.format.escapeHTML(selected.time)}">查看该股分时 ↗</button><button type="button" data-day-clear>清除选择</button></div></div>` : stock ? `<div class="minute-day-selected-heading"><div><strong>${features.format.escapeHTML(stock.name)}</strong><small>尚无可显示节点</small></div><button type="button" data-day-clear>清除选择</button></div>` : '<p class="minute-day-hint">每行只显示本股票的节点；左右滑动查看全天，名称列固定。已有秒数按实际位置排列，分钟观察保留原精度。</p>';
  features.intraday.renderMinuteTimelineStockPicker("locate");
  features.intraday.highlightMinuteTimelineGuide();
}

function selectMinuteTimelineDayNode(id) {
  if (!featureState.minuteTimelineDayModel?.nodes.has(id)) return;
  featureState.minuteTimelineSelectedNode = id;
  featureState.minuteTimelineLocateCode = featureState.minuteTimelineDayModel.nodes.get(id).code;
  features.intraday.renderMinuteTimelineSelection();
}

function syncMinuteTimelineScroll(source) {
  if (!source) return;
  const list = $("minute-timeline-list"), left = source.scrollLeft;
  list.querySelectorAll(".minute-day-scroll, .minute-day-pan, .minute-day-ruler-scroll").forEach(scroller => {if (Math.abs(scroller.scrollLeft - left) > 1) scroller.scrollLeft = left;});
  const pitch = featureState.minuteTimelinePitch || 120, labelWidth = list.querySelector(".minute-day-stock")?.offsetWidth || 170;
  const body = list.querySelector(".minute-day-scroll");
  $("minute-day-visible-time").textContent = `${features.intraday.minuteTimelineDayClock(left / pitch)} — ${features.intraday.minuteTimelineDayClock(Math.min(241, (left + Math.max(0, (body?.clientWidth || 0) - labelWidth - 32)) / pitch))}`;
}

function panMinuteTimelineDay(direction) {
  const scroller = $("minute-timeline-list").querySelector(".minute-day-scroll");
  if (!scroller) return;
  const labelWidth = scroller.querySelector(".minute-day-stock")?.offsetWidth || 170;
  scroller.scrollLeft += direction * Math.max(120, scroller.clientWidth - labelWidth - 32);
  features.intraday.syncMinuteTimelineScroll(scroller);
}

function jumpMinuteTimelineDay() {
  const input = $("minute-day-jump-time"), clock = input.value;
  if (!features.intraday.minuteTimelineRegularEvent({time: clock}) && !/^09:25(?::[0-5]\d)?$/.test(clock)) { input.setCustomValidity("请输入 09:25、09:30—11:30 或 13:00—15:00 内的时间"); input.reportValidity(); return; }
  input.setCustomValidity("");
  const scroller = $("minute-timeline-list").querySelector(".minute-day-scroll");
  if (scroller) { scroller.scrollLeft = features.intraday.minuteTimelineDayPosition(clock) / 100 * 241 * (featureState.minuteTimelinePitch || 120); features.intraday.syncMinuteTimelineScroll(scroller); }
}

function zoomMinuteTimelineDay(value) {
  if (![60, 120, 360].includes(value)) return;
  const scroller = $("minute-timeline-list").querySelector(".minute-day-scroll"), previous = featureState.minuteTimelinePitch || 120;
  const leftSlot = (scroller?.scrollLeft || 0) / previous;
  featureState.minuteTimelinePitch = value;
  features.intraday.renderMinuteTimeline({preserve: true});
  const next = $("minute-timeline-list").querySelector(".minute-day-scroll");
  if (next) {next.scrollLeft = leftSlot * value; features.intraday.syncMinuteTimelineScroll(next);}
}

function minuteTimelinePickerStocks() {
  const data = featureState.minuteTimelineData, labels = featureState.minuteTimelineStockLabels ||= {};
  const source = data?.date === featureState.intradayDate ? data.pool || data.events || [] : [];
  const current = new Map(source.map(stock => [stock.code, stock]));
  current.forEach(stock => { labels[stock.code] = {code: stock.code, name: stock.name, boards: stock.boards, initials: stock.initials || ""}; });
  const codes = new Set([...current.keys(), ...(featureState.minuteTimelineExcludeCodes || [])]);
  return [...codes].map(code => ({...(labels[code] || {code, name: code, boards: 0}), inPool: current.has(code)}))
    .sort((a, b) => Number(b.inPool) - Number(a.inPool) || (b.boards || 0) - (a.boards || 0) || a.code.localeCompare(b.code));
}

function renderMinuteTimelineStockPickers() {
  const stocks = features.intraday.minuteTimelinePickerStocks();
  ["locate", "exclude"].forEach(kind => features.intraday.renderMinuteTimelineStockPicker(kind, stocks));
}

function renderMinuteTimelineStockPicker(kind, stocks = features.intraday.minuteTimelinePickerStocks()) {
  const locate = kind === "locate", label = locate ? "定位" : "排除";
  if (locate) {
    const visible = new Set((featureState.minuteTimelineDayModel?.rows || []).map(row => row.stock.code));
    stocks = stocks.filter(stock => visible.has(stock.code));
  }
  const codes = new Set(locate ? featureState.minuteTimelineLocateCode ? [featureState.minuteTimelineLocateCode] : [] : featureState.minuteTimelineExcludeCodes || []);
  const selected = stocks.filter(stock => codes.has(stock.code));
  const names = selected.map(stock => stock.name).join("、");
  $("minute-timeline-" + kind + "-summary").textContent = codes.size ? locate ? names : `${selected.slice(0, 2).map(stock => stock.name).join("、")}${codes.size > 2 ? "等" : ""}（${codes.size} 只）` : locate ? "选择股票定位（单选）" : "不排除股票（可多选）";
  $("minute-timeline-" + kind + "-toggle").title = codes.size ? names : locate ? "选择一只股票，跳转并选中其时间轴节点" : "选择要排除的股票，可多选";
  $("minute-timeline-" + kind + "-count").textContent = `已选 ${codes.size} 只`;
  $("minute-timeline-" + kind + "-clear").disabled = !codes.size;
  const query = $(locate ? "minute-timeline-search" : "minute-timeline-exclude").value.trim().toUpperCase();
  const matches = stocks.filter(stock => !query || `${stock.code} ${stock.name} ${stock.initials}`.toUpperCase().includes(query));
  const list = $("minute-timeline-" + kind + "-options"), key = JSON.stringify(matches);
  const keys = featureState.minuteTimelinePickerKeys ||= {};
  if (keys[kind] !== key) {
    list.innerHTML = matches.map(stock => `<label class="minute-stock-option"><input type="${locate ? "radio" : "checkbox"}"${locate ? ' name="minute-timeline-locate-stock"' : ""} data-timeline-stock="${features.format.escapeHTML(stock.code)}" data-timeline-stock-mode="${kind}" aria-label="${label} ${features.format.escapeHTML(stock.name)} ${features.format.escapeHTML(stock.code)}"${codes.has(stock.code) ? " checked" : ""}><span><span>${features.format.escapeHTML(stock.name)}</span><small>${features.format.escapeHTML(stock.code)} · ${stock.inPool ? stock.boards ? `${features.format.numberValue(stock.boards)} 板` : "当日涨停池" : "当日池外"}</small></span></label>`).join("") || `<p class="minute-stock-picker-empty">${query ? "没有匹配的股票" : "当日暂无可选股票"}</p>`;
    list.scrollTop = 0;
    keys[kind] = key;
  }
  list.querySelectorAll("[data-timeline-stock]").forEach(input => { input.checked = codes.has(input.dataset.timelineStock); });
}

function changeMinuteTimelineStockSelection(kind, code, selected) {
  if (!["locate", "exclude"].includes(kind) || !/^\d{6}$/.test(code)) return;
  if (kind === "locate") {
    const row = featureState.minuteTimelineDayModel?.rows.find(row => row.stock.code === code);
    if (!row) return;
    const node = row.events.find(event => event.kind === "seal") || row.events[0];
    featureState.minuteTimelineLocateCode = code;
    featureState.minuteTimelineSelectedNode = node?.id || null;
    features.intraday.closeMinuteTimelineStockPickers();
    features.intraday.renderMinuteTimelineSelection();
    const list = $("minute-timeline-list"), scroller = list.querySelector(".minute-day-scroll");
    const lane = [...list.querySelectorAll(".minute-day-lane")].find(lane => lane.dataset.dayStock === code);
    const target = node ? [...(lane?.querySelectorAll(".minute-day-node") || [])].find(button => button.dataset.dayNode === node.id) : lane?.querySelector("button");
    if (node && scroller) {
      const width = scroller.clientWidth - (lane?.querySelector(".minute-day-stock")?.offsetWidth || 170) - 32;
      scroller.scrollLeft = Math.max(0, features.intraday.minuteTimelineDayPosition(node.time) / 100 * 241 * (featureState.minuteTimelinePitch || 120) - width / 3);
      features.intraday.syncMinuteTimelineScroll(scroller);
    }
    target?.focus({preventScroll: true});
    (target || lane)?.scrollIntoView({block: "center", inline: "nearest", behavior: "instant"});
    return;
  }
  const codes = new Set(featureState.minuteTimelineExcludeCodes || []);
  if (selected) codes.add(code); else codes.delete(code);
  featureState.minuteTimelineExcludeCodes = [...codes];
  features.intraday.renderMinuteTimeline();
}

function clearMinuteTimelineStockSelection(kind) {
  if (kind === "locate") {
    featureState.minuteTimelineLocateCode = null; featureState.minuteTimelineSelectedNode = null;
    features.intraday.renderMinuteTimelineSelection();
  } else {
    featureState.minuteTimelineExcludeCodes = [];
    features.intraday.renderMinuteTimeline();
  }
}

function closeMinuteTimelineStockPickers() {
  ["locate", "exclude"].forEach(kind => {
    $("minute-timeline-" + kind + "-popup").hidden = true;
    $("minute-timeline-" + kind + "-toggle").setAttribute("aria-expanded", "false");
  });
  featureState.minuteTimelinePickerOpen = null;
}

function toggleMinuteTimelineStockPicker(kind) {
  const open = $("minute-timeline-" + kind + "-popup").hidden;
  features.intraday.closeMinuteTimelineStockPickers();
  if (!open) return;
  $(kind === "locate" ? "minute-timeline-search" : "minute-timeline-exclude").value = "";
  features.intraday.renderMinuteTimelineStockPicker(kind);
  $("minute-timeline-" + kind + "-popup").hidden = false;
  $("minute-timeline-" + kind + "-toggle").setAttribute("aria-expanded", "true");
  featureState.minuteTimelinePickerOpen = kind;
  $(kind === "locate" ? "minute-timeline-search" : "minute-timeline-exclude").focus();
}

function minuteTimelineMetric(event) {
  return event.kind === "volume" ? `${features.format.numberValue(event.volume / 100)} 手 · ${features.format.numberValue(event.ratio, 1)} 倍` : event.price ? `${features.format.numberValue(event.price, 2)} 元` : "";
}

function minuteTimelineClock(event) {
  return event.time.length === 5 ? `${event.time}:00` : event.time;
}

function minuteTimelineEventOrder(a, b) {
  return features.intraday.minuteTimelineClock(a).localeCompare(features.intraday.minuteTimelineClock(b)) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id);
}

function toggleMinuteTimelineTags() {
  $("minute-timeline-list").setAttribute("data-show-tags", String($("minute-timeline-show-tags").checked === true));
}

function minuteTimelineTagsHTML(stock) {
  const profile = featureState.minuteTimelineData?.pool?.find(row => row.code === stock.code) || stock;
  return `<span class="stock-tags minute-timeline-tags" aria-label="${features.format.escapeHTML(stock.name)}标签">${features.tags.stockTags(profile).map(tag => `<span class="stock-tag">${features.format.escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</span>`;
}

function updateMinuteTimelineControls() {
  const busy = !!featureState.minuteTimelineCollecting, editable = features.shell.read("meta")?.capabilities?.edit_tags === true;
  const data = featureState.minuteTimelineData?.date === featureState.intradayDate ? featureState.minuteTimelineData : null;
  const coverage = data?.coverage, pending = data?.jobs?.length || 0;
  const inContent = editable && !!data && coverage?.total > 0 && coverage.analyzed === 0 && (busy || pending > 0);
  const collect = $("minute-timeline-collect"), stop = $("minute-timeline-stop");
  const target = $(inContent ? "minute-timeline-collection-actions" : "minute-timeline-actions");
  if (collect.parentElement !== target || stop.parentElement !== target) target.append(collect, stop);
  $("minute-timeline-data-gap").hidden = !inContent;
  $("minute-timeline-data-gap-message").textContent = busy || featureState.minuteLiveRefreshing ? "正在获取当日分时…" : "当日尚无分时数据，点击下方按钮采集。";
  collect.hidden = !editable;
  collect.disabled = busy || featureState.minuteLiveRefreshing || !pending;
  stop.hidden = !busy;
  $("minute-timeline-refresh").disabled = busy;
  $("minute-timeline-multiple").disabled = busy;
  $("minute-timeline-exclude-gem").disabled = busy || featureState.minuteTimelineData?.date !== featureState.intradayDate;
  ["locate", "exclude"].forEach(kind => { $("minute-timeline-" + kind + "-toggle").disabled = featureState.minuteTimelineData?.date !== featureState.intradayDate; });
  if (!busy) collect.textContent = `补齐当日分时${pending ? `（${pending} 只）` : ""}`;
  features.intraday.updateMinuteTimelineLiveStatus();
}

async function loadMinuteTimeline({quiet = false, refreshTimes = false} = {}) {
  const day = featureState.intradayDate;
  const generation = featureState.minuteTimelineGeneration = (featureState.minuteTimelineGeneration || 0) + 1;
  const current = () => generation === featureState.minuteTimelineGeneration && featureState.intradayDate === day && features.navigation.read("tab") === "intraday";
  if (!day) return;
  $("minute-timeline-list").setAttribute("aria-busy", "true");
  if (!quiet || featureState.minuteTimelineData?.date !== day) {
    $("minute-timeline-list").innerHTML = features.format.loadingHTML();
    $("minute-timeline-coverage").textContent = "正在读取当日股票节点…";
  }
  try {
    const url = `/api/intraday/timeline?date=${encodeURIComponent(day)}&window=2&multiple=${encodeURIComponent($("minute-timeline-multiple").value || "3")}&exclude_gem=${$("minute-timeline-exclude-gem").checked === false ? "0" : "1"}`;
    const data = await features.api.request(url, "minute-timeline");
    if (!data || !current()) return;
    const sameDay = featureState.minuteTimelineData?.date === day;
    featureState.minuteTimelineData = data;
    features.intraday.renderMinuteTimeline({preserve: quiet && sameDay});
    const attempted = featureState.minuteTimelineTimesRequested ||= new Set();
    if (!data.provisional && features.shell.read("meta")?.capabilities?.edit_tags === true && data.time_coverage?.missing && (refreshTimes || !data.time_coverage.cached && !attempted.has(day))) {
      attempted.add(day);
      try {
        await features.api.request("/api/intraday/timeline/times", "minute-timeline-times", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({date: day, force: refreshTimes})});
        if (!current()) return;
        const enriched = await features.api.request(url, "minute-timeline");
        if (!enriched || !current()) return;
        featureState.minuteTimelineData = enriched;
        features.intraday.renderMinuteTimeline({preserve: true});
      } catch (error) {
        if (current() && refreshTimes) {
          $("minute-timeline-progress").hidden = false;
          $("minute-timeline-progress").textContent = `秒级封板时间暂未补齐：${error.message}；分钟记录按原精度展示。`;
        }
      }
    }
  } catch (error) {
    if (!current()) return;
    $("minute-timeline-coverage").textContent = `节点读取失败：${error.message}`;
    if (!quiet || featureState.minuteTimelineData?.date !== day) $("minute-timeline-list").innerHTML = features.format.emptyHTML("时间轴暂未读取成功", "请点击刷新节点重试。");
  } finally {
    if (current()) $("minute-timeline-list").setAttribute("aria-busy", "false");
  }
}

async function changeMinuteTimelineGemFilter() {
  features.navigation.updateURL();
  await features.intraday.loadMinuteTimeline();
  if (features.navigation.read("tab") === "intraday" && featureState.minuteTimelineData?.date === featureState.intradayDate) features.intraday.renderMinuteCompareList();
}

function stopMinuteTimelineCollection(refresh = true) {
  const busy = featureState.minuteTimelineCollecting;
  featureState.minuteTimelineCollectGeneration = (featureState.minuteTimelineCollectGeneration || 0) + 1;
  featureState.minuteTimelineCollecting = false;
  featureState.minuteTimelineGeneration = (featureState.minuteTimelineGeneration || 0) + 1;
  features.api.channels["minute-timeline"]?.abort();
  features.api.channels["minute-timeline-times"]?.abort();
  Object.keys(features.api.channels).filter(channel => channel.startsWith("timeline-collect-")).forEach(channel => features.api.channels[channel]?.abort());
  features.intraday.updateMinuteTimelineControls();
  $("minute-timeline-progress").hidden = !busy || !refresh;
  if (busy && refresh) {
    $("minute-timeline-progress").textContent = "已停止启动新请求，已取得的数据保留在当天缓存。";
    if (features.navigation.read("tab") === "intraday") features.intraday.loadMinuteTimeline({quiet: true});
  }
}

async function collectMinuteTimeline() {
  if (featureState.minuteTimelineCollecting || featureState.minuteLiveRefreshing || features.shell.read("meta")?.capabilities?.edit_tags !== true) return;
  const day = featureState.intradayDate, jobs = [...(featureState.minuteTimelineData?.date === day ? featureState.minuteTimelineData.jobs || [] : [])];
  if (!jobs.length) return;
  const generation = featureState.minuteTimelineCollectGeneration = (featureState.minuteTimelineCollectGeneration || 0) + 1;
  const current = () => generation === featureState.minuteTimelineCollectGeneration && featureState.intradayDate === day && features.navigation.read("tab") === "intraday";
  featureState.minuteTimelineCollecting = true;
  $("minute-timeline-progress").hidden = false;
  let next = 0, done = 0, failed = 0;
  const progress = () => { $("minute-timeline-progress").textContent = `正在补齐 ${features.format.dateLabel(day)}：${done} / ${jobs.length} 只${failed ? ` · ${failed} 只未取得完整分时` : ""}`; };
  features.intraday.updateMinuteTimelineControls(); progress();
  await Promise.all(Array.from({length: Math.min(3, jobs.length)}, async (_, worker) => {
    while (current() && next < jobs.length) {
      const job = jobs[next++];
      try {
        const data = await features.api.request("/api/intraday/collect", `timeline-collect-${worker}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({date: day, code: job.code, force: job.force})});
        if (!current()) return;
        if (!data?.points?.length || data.status !== "ok") failed++;
        if (data?.stock) features.intraday.recordMinuteData(data);
      } catch { if (!current()) return; failed++; }
      done++; progress();
    }
  }));
  if (!current()) return;
  featureState.minuteTimelineCollecting = false;
  features.intraday.updateMinuteTimelineControls();
  $("minute-timeline-progress").textContent = `当日分时处理完成：${done} 只${failed ? ` · ${failed} 只未取得完整分时` : ""}，股票节点已更新。`;
  await features.intraday.loadMinuteTimeline({quiet: true});
}

async function openMinuteTimelineNode(code, clock, peer = "") {
  const day = featureState.intradayDate, dateGeneration = featureState.intradayGeneration;
  const generation = featureState.minuteTimelineNavigation = (featureState.minuteTimelineNavigation || 0) + 1;
  const current = () => generation === featureState.minuteTimelineNavigation && day === featureState.intradayDate && dateGeneration === featureState.intradayGeneration && features.navigation.read("tab") === "intraday" && featureState.intradayCode === code;
  if (peer && peer !== code) features.intraday.clearMinuteComparisons();
  await features.intraday.loadMinuteStock(code);
  if (!current() || featureState.minuteDetail?.stock.code !== code || featureState.minuteDetail?.date !== day) return;
  if (peer && peer !== code) await features.intraday.selectMinuteComparison(peer, true);
  if (!current() || !featureState.minuteDetail?.points.length) return;
  $("minute-chart").querySelector(".minute-svg")?.focus({preventScroll: true});
  if (clock.slice(0, 5) === "09:25" && featureState.minuteDetail.auction?.points?.length) features.intraday.showMinuteAuctionPoint();
  else {
    const target = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) + Number(clock.slice(6, 8) || 0) / 60;
    let nearest = 0;
    featureState.minuteDetail.points.forEach((point, index) => { const minute = value => Number(value.time.slice(0, 2)) * 60 + Number(value.time.slice(3, 5)); if (Math.abs(minute(point) - target) < Math.abs(minute(featureState.minuteDetail.points[nearest]) - target)) nearest = index; });
    features.intraday.showMinutePoint(nearest);
  }
  $("minute-chart").scrollIntoView?.({block: "center", behavior: "smooth"});
}

  const bindings = {
binding019() {
$("minute-date").addEventListener("change", () => features.intraday.changeMinuteDate());
},
binding020() {
$("minute-prev-date").addEventListener("click", () => features.intraday.navigateMinuteDate("previous"));
},
binding021() {
$("minute-next-date").addEventListener("click", () => features.intraday.navigateMinuteDate("next"));
},
binding022() {
$("minute-latest-date").addEventListener("click", () => features.intraday.navigateMinuteDate("latest"));
},
binding023() {
$("minute-refresh").addEventListener("click", () => features.intraday.loadIntraday());
},
binding024() {
$("minute-timeline-refresh").addEventListener("click", () => features.intraday.loadMinuteTimeline({refreshTimes: true}));
},
binding025() {
$("minute-timeline-exclude-gem").addEventListener("change", features.intraday.changeMinuteTimelineGemFilter);
},
binding026() {
$("minute-timeline-show-tags").addEventListener("change", features.intraday.toggleMinuteTimelineTags);
},
binding027() {
$("minute-timeline-collect").addEventListener("click", features.intraday.collectMinuteTimeline);
},
binding028() {
$("minute-timeline-stop").addEventListener("click", () => features.intraday.stopMinuteTimelineCollection());
},
binding029() {
$("minute-timeline-multiple").addEventListener("change", () => features.intraday.loadMinuteTimeline());
},
binding030() {
["minute-timeline-group", "minute-timeline-kind"].forEach(id => $(id).addEventListener("change", () => features.intraday.renderMinuteTimeline()));
},
binding031() {
["locate", "exclude"].forEach(kind => {
  $("minute-timeline-" + kind + "-toggle").addEventListener("click", () => features.intraday.toggleMinuteTimelineStockPicker(kind));
  $(kind === "locate" ? "minute-timeline-search" : "minute-timeline-exclude").addEventListener("input", () => features.intraday.renderMinuteTimelineStockPicker(kind));
  $("minute-timeline-" + kind + "-clear").addEventListener("click", () => features.intraday.clearMinuteTimelineStockSelection(kind));
  $("minute-timeline-" + kind + "-options").addEventListener("change", event => {
    const input = event.target.closest("[data-timeline-stock]");
    if (input) features.intraday.changeMinuteTimelineStockSelection(kind, input.dataset.timelineStock, input.checked);
  });
  if (kind === "locate") $("minute-timeline-locate-options").addEventListener("click", event => {
    const input = event.target.closest("[data-timeline-stock]");
    if (input?.dataset.timelineStock === featureState.minuteTimelineLocateCode) features.intraday.changeMinuteTimelineStockSelection(kind, input.dataset.timelineStock, true);
  });
});
},
binding032() {
document.addEventListener("click", event => { if (featureState.minuteTimelinePickerOpen && !event.target.closest("[data-timeline-stock-picker]")) features.intraday.closeMinuteTimelineStockPickers(); });
},
binding033() {
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && featureState.minuteTimelinePickerOpen) {
    const kind = featureState.minuteTimelinePickerOpen;
    features.intraday.closeMinuteTimelineStockPickers();
    $("minute-timeline-" + kind + "-toggle").focus();
    event.preventDefault();
  }
});
},
binding034() {
$("minute-timeline-list").addEventListener("change", event => {
  if (event.target.id === "minute-day-sort") features.intraday.changeMinuteTimelineSort(event.target.value);
});
},
binding035() {
$("minute-timeline-list").addEventListener("click", event => {
  const node = event.target.closest("[data-day-node]");
  if (node) { features.intraday.selectMinuteTimelineDayNode(node.dataset.dayNode); return; }
  const zoom = event.target.closest("[data-day-zoom]");
  if (zoom) { features.intraday.zoomMinuteTimelineDay(Number(zoom.dataset.dayZoom)); return; }
  const pan = event.target.closest("[data-day-pan]");
  if (pan) { features.intraday.panMinuteTimelineDay(Number(pan.dataset.dayPan)); return; }
  if (event.target.closest("[data-day-jump]")) { features.intraday.jumpMinuteTimelineDay(); return; }
  if (event.target.closest("[data-day-clear]")) {
    const previous = featureState.minuteTimelineSelectedNode;
    featureState.minuteTimelineSelectedNode = null; featureState.minuteTimelineLocateCode = null; features.intraday.renderMinuteTimelineSelection();
    [...$("minute-timeline-list").querySelectorAll(".minute-day-node")].find(button => button.dataset.dayNode === previous)?.focus({preventScroll: true});
    return;
  }
  const button = event.target.closest("[data-timeline-code]");
  if (button) features.intraday.openMinuteTimelineNode(button.dataset.timelineCode, button.dataset.timelineTime, button.dataset.timelinePeer || "");
});
},
binding036() {
["pointerover", "focusin"].forEach(type => $("minute-timeline-list").addEventListener(type, event => {
  const button = event.target.closest(".minute-day-node");
  if (button) features.intraday.highlightMinuteTimelineGuide(button.dataset.dayNode);
}));
},
binding037() {
["pointerout", "focusout"].forEach(type => $("minute-timeline-list").addEventListener(type, event => {
  if (event.target.closest(".minute-day-node") && !event.relatedTarget?.closest?.(".minute-day-node")) features.intraday.highlightMinuteTimelineGuide();
}));
},
binding038() {
$("minute-timeline-list").addEventListener("keydown", event => {
  const button = event.target.closest(".minute-day-node"), model = featureState.minuteTimelineDayModel;
  if (!button || !model || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const rows = model.rows.filter(row => row.events.length);
  const selected = model.nodes.get(button.dataset.dayNode), rowIndex = rows.findIndex(row => row.stock.code === selected?.code);
  if (rowIndex < 0) return;
  event.preventDefault();
  let row = rows[rowIndex], target;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    row = rows[Math.max(0, Math.min(rows.length - 1, rowIndex + (event.key === "ArrowUp" ? -1 : 1)))];
    target = row.events.reduce((best, node) => Math.abs(features.intraday.minuteTimelineDayPosition(node.time) - features.intraday.minuteTimelineDayPosition(selected.time)) < Math.abs(features.intraday.minuteTimelineDayPosition(best.time) - features.intraday.minuteTimelineDayPosition(selected.time)) ? node : best);
  } else {
    const index = row.events.findIndex(node => node.id === selected.id);
    target = row.events[event.key === "Home" ? 0 : event.key === "End" ? row.events.length - 1 : Math.max(0, Math.min(row.events.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)))];
  }
  features.intraday.selectMinuteTimelineDayNode(target.id);
  const next = [...$("minute-timeline-list").querySelectorAll(".minute-day-node")].find(node => node.dataset.dayNode === target.id);
  next?.focus({preventScroll: true});
  next?.scrollIntoView({block: "nearest", inline: "nearest"});
});
},
binding039() {
$("minute-show-average").checked = false;
},
binding040() {
$("minute-show-average").addEventListener("change", features.intraday.toggleMinuteAverage);
},
binding041() {
$("minute-compare-search").addEventListener("input", () => { featureState.minuteCompareLimit = 150; features.intraday.renderMinuteCompareList(); });
},
binding042() {
$("minute-compare-list").addEventListener("click", event => { if (event.target.closest("[data-minute-compare-more]")) { const top = $("minute-compare-list").scrollTop; featureState.minuteCompareLimit = (featureState.minuteCompareLimit || 150) + 150; features.intraday.renderMinuteCompareList(); $("minute-compare-list").scrollTop = top; } });
},
binding043() {
$("minute-compare-list").addEventListener("change", event => {
  const input = event.target.closest("[data-minute-compare]");
  if (input) features.intraday.selectMinuteComparison(input.dataset.minuteCompare, input.checked);
});
},
binding044() {
$("minute-compare-clear").addEventListener("click", features.intraday.clearMinuteComparisons);
},
binding045() {
$("minute-search").addEventListener("input", () => {
  featureState.minuteListLimit = 150;
  features.intraday.renderMinuteList();
});
},
binding046() {
$("minute-stock-list").addEventListener("click", event => {
  if (event.target.closest("[data-minute-more]")) { const top = $("minute-stock-list").scrollTop; featureState.minuteListLimit = (featureState.minuteListLimit || 150) + 150; features.intraday.renderMinuteList(); $("minute-stock-list").scrollTop = top; return; }
  const button = event.target.closest("[data-minute-code]");
  if (button) features.intraday.loadMinuteStock(button.dataset.minuteCode);
});
},
binding047() {
$("minute-stock-list").addEventListener("keydown", event => {
  if (!event.target.closest("[data-minute-code]") || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = features.intraday.minuteRows();
  if (!rows.length) return;
  event.preventDefault();
  const current = rows.findIndex(row => row.code === featureState.intradayCode);
  const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  if (index >= (featureState.minuteListLimit || 150)) { featureState.minuteListLimit = index + 1; features.intraday.renderMinuteList(); }
  features.intraday.loadMinuteStock(rows[index].code);
  $("minute-stock-list").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  $("minute-stock-list").querySelector('[aria-pressed="true"]')?.scrollIntoView({block: "nearest"});
});
},
binding048() {
$("minute-stock-history").addEventListener("click", () => {
  const stock = featureState.minuteDetail?.stock;
  if (stock) features.stock.chooseStock({code: stock.code, name: stock.name});
});
},
binding049() {
$("minute-chart").addEventListener("pointermove", event => {
  const svg = event.target.closest(".minute-svg,.minute-volume-svg"), points = featureState.minuteDetail?.points;
  if (!svg || !points?.length) return;
  const rect = svg.getBoundingClientRect(), px = (event.clientX - rect.left) / rect.width * 1000;
  if (px < 155) { features.intraday.showMinuteAuctionPoint(); return; }
  const slot = featureState.minuteChartScale.slotAt(px);
  let nearest = 0;
  points.forEach((point, index) => { if (Math.abs(point.slot - slot) < Math.abs(points[nearest].slot - slot)) nearest = index; });
  features.intraday.showMinutePoint(nearest);
});
},
binding050() {
$("minute-chart").addEventListener("click", event => {
  const button = event.target.closest("[data-minute-volume-scale]");
  if (!button || featureState.minuteLoading) return;
  featureState.minuteVolumeScale = button.dataset.minuteVolumeScale;
  features.intraday.refreshMinuteComparisonChart();
  $("minute-chart").querySelector(`[data-minute-volume-scale="${featureState.minuteVolumeScale}"]`)?.focus({preventScroll: true});
});
},
binding051() {
$("minute-chart").addEventListener("focusin", event => { if (event.target.matches(".minute-svg")) features.intraday.showMinutePoint(featureState.minutePointIndex || 0); });
},
binding052() {
$("minute-chart").addEventListener("keydown", event => {
  if (!event.target.matches(".minute-svg") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !featureState.minuteDetail?.points.length) return;
  event.preventDefault();
  if ((event.key === "Home" && featureState.minuteDetail.auction?.points.length) || (event.key === "ArrowLeft" && !featureState.minutePointIndex)) { features.intraday.showMinuteAuctionPoint(); return; }
  if (featureState.minuteHoverMode === "auction" && event.key === "ArrowRight") { features.intraday.showMinutePoint(0); return; }
  const index = event.key === "Home" ? 0 : event.key === "End" ? featureState.minuteDetail.points.length - 1 : (featureState.minutePointIndex || 0) + (event.key === "ArrowRight" ? 1 : -1);
  features.intraday.showMinutePoint(index);
});
},
binding101() {
for (const container of [$("date-table-area"), $("stock-profile-note"), $("minute-stock-note")]) {
  container.addEventListener("click", event => {
    const button = event.target.closest("[data-edit-stock-note]");
    if (button) features.notes.openStockNoteEditor(button.dataset.editStockNote);
  });
  for (const name of ["pointerover", "focusin"]) container.addEventListener(name, event => {
    const button = event.target.closest(".stock-note-button");
    if (button && !button.contains(event.relatedTarget)) features.notes.showStockNoteTooltip(button);
  });
  for (const name of ["pointerout", "focusout"]) container.addEventListener(name, event => {
    const button = event.target.closest(".stock-note-button");
    if (button && !button.contains(event.relatedTarget)) features.notes.scheduleStockNoteTooltipHide();
  });
  new MutationObserver(() => {
    if (features.notes.read("noteTooltipAnchor") && !features.notes.read("noteTooltipAnchor").isConnected) features.notes.hideStockNoteTooltip();
  }).observe(container, {childList: true, subtree: true});
}
}
};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, minuteRows, minuteDates, updateMinuteDateNavigation, changeMinuteDate, navigateMinuteDate, renderMinuteProfile, renderMinuteList, updateMinuteSelection, minuteCompareStyle, renderMinuteCompareList, updateMinuteCompareSelection, renderMinuteCompareLegend, minutePointAt, updateMinuteVolumeReadings, refreshMinuteComparisonChart, loadMinuteComparison, selectMinuteComparison, clearMinuteComparisons, requestMinuteData, recordMinuteData, refreshVisibleMinuteData, minuteTimelineLiveEnabled, updateMinuteTimelineLiveStatus, minuteDisplayPoint, loadIntraday, renderMinuteStockData, loadMinuteStock, minuteChartHTML, showMinuteAuctionPoint, showMinutePoint, toggleMinuteAverage, minuteTimelineViewSnapshot, restoreMinuteTimelineView, renderMinuteTimeline, updateMinuteTimelineGuides, highlightMinuteTimelineGuide, minuteTimelineRegularEvent, minuteTimelineDayModel, minuteTimelineFirstSeal, changeMinuteTimelineSort, minuteTimelineDayPosition, minuteTimelineDayClock, minuteTimelineLaneLayout, minuteTimelineLaneHTML, renderMinuteTimelineSelection, selectMinuteTimelineDayNode, syncMinuteTimelineScroll, panMinuteTimelineDay, jumpMinuteTimelineDay, zoomMinuteTimelineDay, minuteTimelinePickerStocks, renderMinuteTimelineStockPickers, renderMinuteTimelineStockPicker, changeMinuteTimelineStockSelection, clearMinuteTimelineStockSelection, closeMinuteTimelineStockPickers, toggleMinuteTimelineStockPicker, minuteTimelineMetric, minuteTimelineClock, minuteTimelineEventOrder, toggleMinuteTimelineTags, minuteTimelineTagsHTML, updateMinuteTimelineControls, loadMinuteTimeline, changeMinuteTimelineGemFilter, stopMinuteTimelineCollection, collectMinuteTimeline, openMinuteTimelineNode };
}
