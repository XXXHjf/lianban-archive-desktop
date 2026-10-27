"use strict";

// Independent extension: the frozen application's files and personal settings stay intact.
(() => {
  const queryDates = () => [...new Set([...(state.meta?.dates || []), ...(state.meta?.live?.dates || [])])].sort();
  const latestQuery = () => queryDates().at(-1) || state.meta?.latest_date || "";
  const baseMeta = renderMeta, baseRefresh = refreshMeta, baseRestore = restoreFromURL;
  const baseDate = renderDate, basePriorityNote = latestPriorityNote;
  let provisionalRendering = false;

  function freshness(data) {
    const day = data.date, live = state.meta?.live?.date === day ? state.meta.live : data.live;
    const stamp = data.fetched_at ? data.fetched_at.slice(11, 19) : "";
    const problem = live?.status === "error" ? " · 获取失败，保留上次数据并重试"
      : live?.stale ? " · 上次快照，等待来源更新" : "";
    const note = data.provisional ? `盘中暂定${stamp ? ` · 获取于 ${stamp}` : ""} · 每分钟刷新${problem}`
      : data.live ? "盘中来源待更新 · 每分钟重试" : "";
    if (note) {
      const weekday = new Date(`${day}T12:00:00`).toLocaleDateString("zh-CN", {weekday: "long"});
      $("date-subtitle").textContent = `${dateLabel(day)} · ${weekday} · ${note}`;
      $("date-coverage-note").textContent = `${note} · 收盘后确认`;
    }
  }

  latestPriorityNote = function () { return provisionalRendering ? "" : basePriorityNote(); };
  renderDate = function (data) {
    const latest = state.latestLimitUps;
    provisionalRendering = Boolean(data.provisional);
    if (provisionalRendering) state.latestLimitUps = new Map();
    try { baseDate(data.provisional ? {...data, data_status:"ok"} : data); freshness(data); }
    finally { state.latestLimitUps = latest; provisionalRendering = false; }
  };
  renderMeta = function (meta, initial = false) {
    baseMeta(meta, initial);
    const dates = queryDates();
    $("trade-date").max = dates.at(-1) || $("trade-date").max;
    $("latest-date").disabled = !dates.length;
    if (meta.live?.enabled) {
      const stamp = meta.live.fetched_at?.slice(11, 19);
      $("auto-update-note").textContent = `盘中每分钟更新${stamp ? ` · 最近获取 ${stamp}` : ""} · 15:30 后确认收盘档案`;
      $("auto-update-note").title = meta.live.note;
    }
  };
  updateDateNavigation = function () {
    const dates = queryDates(), day = $("trade-date").value;
    $("prev-date").disabled = !dates.some(item => item < day);
    $("next-date").disabled = !dates.some(item => item > day);
  };
  for (const id of ["latest-date", "prev-date", "next-date"]) {
    $(id).addEventListener("click", event => {
      event.stopImmediatePropagation();
      const dates = queryDates(), day = $("trade-date").value;
      const target = id === "latest-date" ? latestQuery() : id === "prev-date" ? [...dates].reverse().find(item => item < day) : dates.find(item => item > day);
      if (target) { $("trade-date").value = target; changeQueryDate(); }
    }, true);
  }
  restoreFromURL = async function (options) {
    const params = new URLSearchParams(location.search);
    if (!params.has("date") && state.meta?.live?.date) {
      params.set("date", latestQuery());
      history.replaceState(null, "", `${location.pathname}?${params}`);
    }
    return baseRestore(options);
  };

  async function quietDate() {
    const query = String(getDateQuery());
    try {
      const data = await request(`/api/date?${query}`, "date");
      if (!data || state.tab !== "date" || query !== String(getDateQuery())) return;
      const board = $("date-table-area").querySelector(".industry-board"), horizontal = board?.scrollLeft;
      const position = {left: window.scrollX, top: window.scrollY, behavior: "instant"};
      state.dateData = data;
      renderDate(data);
      const nextBoard = $("date-table-area").querySelector(".industry-board");
      if (nextBoard && horizontal != null) nextBoard.scrollLeft = horizontal;
      window.scrollTo(position);
      updateDateNavigation();
      updateURL({replace: true});
    } catch { if (state.dateData) freshness(state.dateData); }
  }
  refreshMeta = async function () {
    const oldLatest = latestQuery(), following = !$("trade-date").value || $("trade-date").value === oldLatest;
    const previousStamp = state.meta?.live?.fetched_at, previousArchive = state.meta?.archive_updated_at;
    await baseRefresh();
    const latest = latestQuery(), changedDate = following && latest && latest !== oldLatest;
    if (changedDate) $("trade-date").value = latest;
    updateDateNavigation();
    const liveChanged = previousStamp !== state.meta?.live?.fetched_at && state.meta?.live?.dates?.includes($("trade-date").value);
    if (state.tab === "date" && (changedDate || liveChanged) && previousArchive === state.meta?.archive_updated_at) await quietDate();
    else if (state.tab === "date" && state.dateData) freshness(state.dateData);
  };
})();
