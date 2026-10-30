// Common shareholder previews own their request lifecycle, filters and alert state.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, URLSearchParams, setTimeout, clearTimeout, MutationObserver } = environment;
  const featureState = {};
  const keys = new Set(["shareholderAlertTypes", "shareholderAnchor", "shareholderBlockedTypes", "shareholderData", "shareholderGeneration", "shareholderLimit", "shareholderPinned", "shareholderTimer"]);
  function read(key) { if (!keys.has(key)) throw new Error("Unknown shareholders state: " + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error("Unknown shareholders state: " + key); featureState[key] = value; return value; }

function shareholderHasAlert(code) {
  return (featureState.shareholderAlertTypes?.get(String(code)) || []).some(type => !shareholderTypeBlocked(type));
}

function syncShareholderAlertIcons() {
  for (const button of document.querySelectorAll("[data-shareholder-code]")) {
    const active = shareholderHasAlert(button.dataset.shareholderCode);
    button.classList.toggle("has-shareholder-alert", active);
    if (active) button.setAttribute("aria-description", "今日有未屏蔽的共同股东同涨停");
    else button.removeAttribute("aria-description");
  }
}

function renderShareholderIcon(stock) {
  const active = shareholderHasAlert(stock.code);
  return `<button type="button" class="shareholder-icon${active ? " has-shareholder-alert" : ""}" data-shareholder-code="${features.format.escapeHTML(stock.code)}" aria-label="查看${features.format.escapeHTML(stock.name || stock.code)}的共同股东"${active ? ' aria-description="今日有未屏蔽的共同股东同涨停"' : ""} aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-4-5"/></svg></button>`;
}

function hideShareholderTooltip() {
  clearTimeout(featureState.shareholderTimer);
  if ($("shareholder-info-dialog").open) $("shareholder-info-dialog").close();
  featureState.shareholderGeneration = (featureState.shareholderGeneration || 0) + 1;
  features.api.channels.shareholders?.abort();
  featureState.shareholderAnchor?.removeAttribute("aria-controls");
  featureState.shareholderAnchor?.setAttribute("aria-expanded", "false");
  featureState.shareholderAnchor = null;
  featureState.shareholderPinned = false;
  featureState.shareholderData = null;
  $("shareholder-tooltip").hidden = true;
}

function scheduleShareholderHide() {
  clearTimeout(featureState.shareholderTimer);
  if (!featureState.shareholderPinned) featureState.shareholderTimer = setTimeout(hideShareholderTooltip, 200);
}

function shareholderTypeBlocked(type) {
  if (!featureState.shareholderBlockedTypes) {
    let entries = [];
    try {
      const saved = JSON.parse(localStorage.getItem("limit-up-archive.shareholder-blocked-types.v1") || "[]");
      if (Array.isArray(saved)) entries = saved.filter(item => Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "boolean");
    } catch {}
    featureState.shareholderBlockedTypes = new Map(entries);
  }
  return featureState.shareholderBlockedTypes.get(type) ?? ["基金", "其他", "QFII"].includes(type);
}

function filteredShareholderRows(data) {
  return data.rows.map(peer => {
    const holders = peer.holders.filter(holder => !shareholderTypeBlocked(holder.type));
    return {...peer, holders, shared_count: holders.length};
  }).filter(peer => peer.shared_count > 0)
    .sort((a, b) => Number(b.today_together) - Number(a.today_together) || b.shared_count - a.shared_count || a.code.localeCompare(b.code));
}

function renderShareholderTooltip(data, limit = 50) {
  const scopes = {total: "十大股东", float: "十大流通"};
  const profiles = data.profiles.filter(p => p.report_date);
  const rows = filteredShareholderRows(data);
  const types = [...new Set(data.rows.flatMap(peer => peer.holders.map(holder => holder.type)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const today = data.today_status === "unavailable" ? "今天的涨停数据尚未取得，暂不标记同涨停"
    : `${features.format.escapeHTML(data.today)} · ${data.today_status === "provisional" ? "盘中暂定" : "收盘确认"}${data.today_stale ? " · 涨停快照延迟" : ""}${data.today_fetched_at ? ` · ${features.format.escapeHTML(data.today_fetched_at.slice(11, 16))} 获取` : ""}`;
  const message = !profiles.length ? (data.status === "error" ? "股东资料暂未获取成功，稍后自动重试" : data.profiles.length === 2 ? "来源暂无可用股东资料" : "股东资料正在获取，请稍后再查看")
    : !data.rows.length ? "在已取得资料的股票中，暂未发现共同股东" : !rows.length ? "当前分类下的共同股东已全部屏蔽，可取消勾选后查看关联股票" : "";
  return `<div class="shareholder-heading"><div class="shareholder-title"><strong>共同股东</strong><button type="button" class="shareholder-info-button" data-shareholder-info aria-label="共同股东说明" aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg></button></div><span class="shareholder-meta">${today}</span></div>
    <div class="shareholder-filter"><div class="shareholder-filter-heading"><span>屏蔽分类</span><span>${rows.length} 只关联股票</span></div><div class="shareholder-filter-options" role="group" aria-label="屏蔽股东分类">${types.map(type => `<label><input type="checkbox" data-shareholder-block-type="${features.format.escapeHTML(type)}"${shareholderTypeBlocked(type) ? " checked" : ""}><span>${features.format.escapeHTML(type)}</span></label>`).join("") || '<span class="shareholder-filter-empty">暂无可筛选分类</span>'}</div></div>
    ${rows.slice(0, limit).map(peer => `<div class="shareholder-peer${peer.today_together ? " together" : ""}"><div class="shareholder-peer-title"><button type="button" class="stock-name-button" data-shareholder-peer="${features.format.escapeHTML(peer.code)}" data-peer-name="${features.format.escapeHTML(peer.name)}">${features.format.escapeHTML(peer.name)}</button><span class="row-stock-code">${features.format.escapeHTML(peer.code)}</span>${peer.today_together ? '<span class="shareholder-together">今日同涨停</span>' : ""}<span class="shareholder-count">${peer.shared_count} 位共同股东</span></div><ul>${peer.holders.map(holder => `<li><span>${features.format.escapeHTML(holder.name)}</span><small>${features.format.escapeHTML(holder.type)} · ${holder.reports.map(r => `${scopes[r.scope]} ${features.format.escapeHTML(r.date)}`).join(" / ")}</small></li>`).join("")}</ul></div>`).join("")}
    ${rows.length > limit ? `<button type="button" class="shareholder-more" data-shareholder-more>继续显示 · 已展示 ${limit} / ${rows.length} 只</button>` : ""}
    ${message ? `<p class="shareholder-message">${message}</p>` : ""}`;
}

function openShareholderInfo() {
  const data = featureState.shareholderData;
  if (!data) return;
  clearTimeout(featureState.shareholderTimer);
  featureState.shareholderPinned = true;
  const profiles = data.profiles.filter(p => p.report_date);
  $("shareholder-info-content").innerHTML = `<p>${features.format.escapeHTML(data.source)} · 已取得 ${data.coverage} / ${data.requested} 只股票${data.status === "updating" ? " · 正在更新" : data.status === "error" ? " · 更新失败，保留已有缓存" : ""}</p>${profiles.length ? `<p>本股资料获取于 ${features.format.escapeHTML(profiles.map(p => p.fetched_at).sort()[0].slice(0, 16).replace("T", " "))}</p>` : ""}<p>${features.format.escapeHTML(data.scope_note)}</p>`;
  $("shareholder-info-dialog").showModal();
}

function positionShareholderTooltip(button) {
  const tooltip = $("shareholder-tooltip"), anchor = button.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 20, above = anchor.top - 20;
  tooltip.style.maxHeight = `${Math.min(460, Math.max(80, above, below))}px`;
  const bounds = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
  const top = below >= bounds.height ? anchor.bottom + 6 : anchor.top - bounds.height - 6;
  tooltip.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
}

async function showShareholderTooltip(button, pin = false) {
  clearTimeout(featureState.shareholderTimer);
  const code = button.dataset.shareholderCode;
  if (!/^[0-9]{6}$/.test(code || "") || (featureState.shareholderPinned && !pin)) return;
  if (featureState.shareholderAnchor === button) {
    if (pin) featureState.shareholderPinned = true;
    return;
  }
  hideShareholderTooltip();
  const generation = featureState.shareholderGeneration, tooltip = $("shareholder-tooltip");
  featureState.shareholderAnchor = button;
  featureState.shareholderPinned = pin;
  button.setAttribute("aria-controls", "shareholder-tooltip");
  button.setAttribute("aria-expanded", "true");
  tooltip.innerHTML = '<p class="shareholder-message">正在读取股东关联…</p>';
  tooltip.scrollTop = 0;
  tooltip.hidden = false;
  positionShareholderTooltip(button);
  try {
    const data = await features.api.request(`/api/stock-shareholders?${new URLSearchParams({code})}`, "shareholders");
    if (!data || generation !== featureState.shareholderGeneration || featureState.shareholderAnchor !== button || !button.isConnected) return;
    featureState.shareholderData = data;
    featureState.shareholderLimit = 50;
    tooltip.innerHTML = renderShareholderTooltip(data);
    positionShareholderTooltip(button);
  } catch {
    if (generation !== featureState.shareholderGeneration || featureState.shareholderAnchor !== button || !button.isConnected) return;
    tooltip.innerHTML = '<p class="shareholder-message">股东关联暂时无法读取，请移开后重新查看。</p>';
    positionShareholderTooltip(button);
  }
}

function toggleShareholderTooltip(button) {
  if (featureState.shareholderAnchor === button && featureState.shareholderPinned) {
    hideShareholderTooltip();
    return;
  }
  return showShareholderTooltip(button, true);
}


function updateShareholderAlerts(meta) {
  featureState.shareholderAlertTypes = new Map((meta.shareholder_alerts?.rows || []).map(row => [row.code, row.types]));
  syncShareholderAlertIcons();
}

function bindEvents() {
for (const name of ["pointerover", "focusin"]) document.addEventListener(name, event => {
  const button = event.target.closest("[data-shareholder-code]");
  if (button && !button.contains(event.relatedTarget)) showShareholderTooltip(button);
});
for (const name of ["pointerout", "focusout"]) document.addEventListener(name, event => {
  const button = event.target.closest("[data-shareholder-code]");
  if (button && !button.contains(event.relatedTarget)) scheduleShareholderHide();
});
document.addEventListener("click", event => {
  const icon = event.target.closest("[data-shareholder-code]");
  if (icon) { event.preventDefault(); toggleShareholderTooltip(icon); return; }
  if (event.target.closest("[data-shareholder-info]")) { openShareholderInfo(); return; }
  if (event.target.closest("#shareholder-info-dialog")) return;
  if (event.target.closest("[data-shareholder-more]") && featureState.shareholderData) {
    featureState.shareholderLimit += 50;
    const tooltip = $("shareholder-tooltip"), top = tooltip.scrollTop;
    tooltip.innerHTML = renderShareholderTooltip(featureState.shareholderData, featureState.shareholderLimit);
    tooltip.scrollTop = top;
    tooltip.focus({preventScroll: true});
    clearTimeout(featureState.shareholderTimer);
    return;
  }
  const peer = event.target.closest("[data-shareholder-peer]");
  if (peer) {
    hideShareholderTooltip();
    features.stock.chooseStock({code: peer.dataset.shareholderPeer, name: peer.dataset.peerName});
  } else if (!event.target.closest("#shareholder-tooltip")) hideShareholderTooltip();
});
for (const name of ["pointerenter", "focusin"]) $("shareholder-tooltip").addEventListener(name, () => clearTimeout(featureState.shareholderTimer));
for (const name of ["pointerleave", "focusout"]) $("shareholder-tooltip").addEventListener(name, scheduleShareholderHide);
$("shareholder-tooltip").addEventListener("change", event => {
  const input = event.target.closest("[data-shareholder-block-type]");
  if (!input || !featureState.shareholderData) return;
  const tooltip = $("shareholder-tooltip"), type = input.dataset.shareholderBlockType;
  featureState.shareholderBlockedTypes.set(type, input.checked);
  syncShareholderAlertIcons();
  try { localStorage.setItem("limit-up-archive.shareholder-blocked-types.v1", JSON.stringify([...featureState.shareholderBlockedTypes])); } catch {}
  featureState.shareholderLimit = 50;
  tooltip.innerHTML = renderShareholderTooltip(featureState.shareholderData);
  tooltip.scrollTop = 0;
  [...tooltip.querySelectorAll("[data-shareholder-block-type]")].find(item => item.dataset.shareholderBlockType === type)?.focus({preventScroll: true});
  clearTimeout(featureState.shareholderTimer);
  tooltip.style.maxHeight = `${Math.min(460, window.innerHeight - tooltip.getBoundingClientRect().top - 12)}px`;
});
document.addEventListener("scroll", event => { if (!$("shareholder-tooltip").contains(event.target) && !$("shareholder-info-dialog").contains(event.target)) hideShareholderTooltip(); }, true);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && $("shareholder-info-dialog").open) {
    event.preventDefault();
    $("shareholder-info-dialog").close();
    return;
  }
  const icon = event.target.closest("[data-shareholder-code]");
  if (icon && event.key === "ArrowDown") {
    event.preventDefault();
    showShareholderTooltip(icon).then(() => {
      if (featureState.shareholderAnchor === icon) $("shareholder-tooltip").focus({preventScroll: true});
    });
  }
  if (event.key === "Escape" && featureState.shareholderAnchor) {
    const anchor = featureState.shareholderAnchor;
    hideShareholderTooltip();
    // Restoring focus must not trigger a new popup.
    anchor.focus({preventScroll: true});
    hideShareholderTooltip();
  }
});
window.addEventListener("resize", hideShareholderTooltip);
$("close-shareholder-info").addEventListener("click", () => $("shareholder-info-dialog").close());
$("shareholder-info-dialog").addEventListener("click", event => {
  const dialog = $("shareholder-info-dialog");
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
new MutationObserver(() => {
  if (featureState.shareholderAnchor && (!featureState.shareholderAnchor.isConnected || featureState.shareholderAnchor.getClientRects().length === 0)) hideShareholderTooltip();
}).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"]});
}

  return {read, write, bindings: {}, shareholderHasAlert, syncShareholderAlertIcons, renderShareholderIcon, hideShareholderTooltip, scheduleShareholderHide, shareholderTypeBlocked, filteredShareholderRows, renderShareholderTooltip, openShareholderInfo, positionShareholderTooltip, showShareholderTooltip, toggleShareholderTooltip, updateShareholderAlerts, bindEvents};
}
