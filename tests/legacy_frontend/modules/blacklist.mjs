// blacklist: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {};
  const keys = new Set(["blacklistSaving","blacklistLoading","blacklistData","blacklistGeneration","blacklistSuggestionIndex","blacklistSuggestions","blacklistSelected"]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown blacklist state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown blacklist state: ' + key); featureState[key] = value; return value; }

function canEditBlacklist() { return features.shell.read("meta")?.capabilities?.edit_blacklist === true; }

function blacklistError(message = "") {
  $("blacklist-error").textContent = message;
  $("blacklist-error").hidden = !message;
}

function updateBlacklistControls() {
  const editable = features.blacklist.canEditBlacklist();
  $("blacklist-add-panel").hidden = !editable;
  $("blacklist-readonly").hidden = editable;
  $("blacklist-add-form").querySelectorAll("input, button").forEach(element => { element.disabled = !editable || Boolean(featureState.blacklistSaving || featureState.blacklistLoading); });
  $("blacklist-refresh").disabled = Boolean(featureState.blacklistSaving || featureState.blacklistLoading);
  $("blacklist-table-area").querySelectorAll("[data-blacklist-remove]").forEach(button => { button.disabled = !editable || Boolean(featureState.blacklistSaving || featureState.blacklistLoading); });
}

function renderBlacklist(data) {
  featureState.blacklistData = data;
  $("blacklist-count").textContent = features.format.numberValue(data.total);
  const editable = features.blacklist.canEditBlacklist();
  $("blacklist-table-area").innerHTML = data.rows.length ? `<table class="blacklist-table"><caption class="sr-only">黑名单股票管理列表</caption><thead><tr><th scope="col">股票</th><th scope="col">注册省份</th><th scope="col">行业标签</th><th scope="col">加入时间</th>${editable ? '<th scope="col">操作</th>' : ""}</tr></thead><tbody>${data.rows.map(stock => `<tr><td><button type="button" class="stock-name-button" data-blacklist-code="${features.format.escapeHTML(stock.code)}" data-blacklist-name="${features.format.escapeHTML(stock.name)}" title="查看${features.format.escapeHTML(stock.name)}的历史">${features.format.escapeHTML(stock.name)}</button><div class="row-stock-code">${features.format.escapeHTML(stock.code)}</div></td><td class="blacklist-province">${features.format.escapeHTML(features.daily.regionLabel(stock))}</td><td><div class="blacklist-tags">${features.tags.stockTags(stock).map(tag => `<span class="stock-tag">${features.format.escapeHTML(tag)}</span>`).join("") || '<span class="stock-tag-empty">暂无标签</span>'}</div></td><td class="blacklist-created">${features.format.escapeHTML(features.format.dateLabel(stock.created_at.slice(0, 10)))} <span>${features.format.escapeHTML(stock.created_at.slice(11, 16))}</span></td>${editable ? `<td><button type="button" class="blacklist-remove" data-blacklist-remove="${features.format.escapeHTML(stock.code)}" aria-label="将${features.format.escapeHTML(stock.name)}移出黑名单">移除</button></td>` : ""}</tr>`).join("")}</tbody></table>` : features.format.emptyHTML("黑名单还是空的", editable ? "在上方搜索并添加股票，建立你的黑名单。" : "目前没有黑名单股票。");
  features.blacklist.updateBlacklistControls();
}

async function loadBlacklist() {
  features.navigation.setView("blacklist");
  if (featureState.blacklistSaving) return;
  features.blacklist.blacklistError();
  const generation = (featureState.blacklistGeneration || 0) + 1;
  featureState.blacklistGeneration = generation;
  featureState.blacklistLoading = true;
  features.blacklist.updateBlacklistControls();
  $("blacklist-table-area").setAttribute("aria-busy", "true");
  if (!featureState.blacklistData) $("blacklist-table-area").innerHTML = features.format.loadingHTML();
  try {
    const data = await features.api.request("/api/blacklist", "blacklist");
    if (data && features.navigation.read("tab") === "blacklist" && featureState.blacklistGeneration === generation) features.blacklist.renderBlacklist(data);
  } catch (error) {
    if (features.navigation.read("tab") === "blacklist" && featureState.blacklistGeneration === generation) {
      features.blacklist.blacklistError(error.message);
      if (!featureState.blacklistData) $("blacklist-table-area").innerHTML = features.format.emptyHTML("暂时无法读取黑名单", "请点击「刷新列表」重试。");
    }
  } finally {
    // Only the newest list request may unlock the controls.
    if (featureState.blacklistGeneration === generation) {
      featureState.blacklistLoading = false;
      $("blacklist-table-area").setAttribute("aria-busy", "false");
      features.blacklist.updateBlacklistControls();
    }
  }
}

function hideBlacklistSuggestions() {
  $("blacklist-suggestions").hidden = true;
  $("blacklist-search").setAttribute("aria-expanded", "false");
  $("blacklist-search").removeAttribute("aria-activedescendant");
  featureState.blacklistSuggestionIndex = -1;
}

function showBlacklistSuggestions(rows) {
  featureState.blacklistSuggestions = rows.slice(0, 15);
  featureState.blacklistSuggestionIndex = -1;
  const codes = new Set((featureState.blacklistData?.rows || []).map(stock => stock.code));
  $("blacklist-suggestions").innerHTML = featureState.blacklistSuggestions.map((stock, index) => `<li role="presentation"><button type="button" role="option" aria-selected="false" id="blacklist-suggestion-${index}" data-blacklist-suggestion="${index}"><span class="suggestion-code">${features.format.escapeHTML(stock.code)}</span><span>${features.format.escapeHTML(stock.name)}</span><span class="suggestion-market">${codes.has(stock.code) ? "已在黑名单" : features.format.escapeHTML(features.format.marketValue(stock.market))}</span></button></li>`).join("") || '<li role="presentation" class="suggestion-message">未找到已收录的股票，请尝试名称、代码或首字母。</li>';
  $("blacklist-suggestions").hidden = false;
  $("blacklist-search").setAttribute("aria-expanded", "true");
}

function selectBlacklistStock(stock) {
  featureState.blacklistSelected = stock;
  features.api.channels["blacklist-search"]?.abort();
  $("blacklist-search").value = `${stock.name} ${stock.code}`;
  features.blacklist.hideBlacklistSuggestions();
  features.blacklist.blacklistError();
}

async function searchBlacklistStocks() {
  const query = $("blacklist-search").value.trim();
  if (!query || featureState.blacklistSelected || features.navigation.read("tab") !== "blacklist" || featureState.blacklistSaving) return;
  try {
    const data = await features.api.request(`/api/stocks?${new URLSearchParams({q: query})}`, "blacklist-search");
    if (data && features.navigation.read("tab") === "blacklist" && !featureState.blacklistSelected && $("blacklist-search").value.trim() === query) features.blacklist.showBlacklistSuggestions(data.rows || []);
  } catch (error) { if (features.navigation.read("tab") === "blacklist" && $("blacklist-search").value.trim() === query) features.blacklist.blacklistError(error.message); }
}

async function changeBlacklist(action, code = null) {
  if (featureState.blacklistSaving || featureState.blacklistLoading || !features.blacklist.canEditBlacklist()) return;
  featureState.blacklistSaving = true;
  features.blacklist.blacklistError();
  $("blacklist-feedback").textContent = "";
  features.blacklist.updateBlacklistControls();
  try {
    if (action === "add") {
      let stock = featureState.blacklistSelected;
      if (!stock) {
        const query = $("blacklist-search").value.trim();
        if (!query) throw new Error("请先搜索要添加的股票。");
        const data = await features.api.request(`/api/stocks?${new URLSearchParams({q: query})}`, "blacklist-search");
        if (!data || features.navigation.read("tab") !== "blacklist") return;
        const rows = data.rows || [];
        const exact = rows.filter(row => row.code === query || row.name === query || row.initials === query.toUpperCase());
        stock = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
        if (!stock) { features.blacklist.showBlacklistSuggestions(rows); throw new Error(rows.length ? "请选择一只股票后再加入黑名单。" : "未找到已收录的股票。"); }
      }
      code = stock.code;
    }
    features.blacklist.hideBlacklistSuggestions();
    const data = await features.api.request("/api/blacklist", "blacklist-save", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code, action})});
    if (!data) return;
    features.blacklist.renderBlacklist(data);
    $("blacklist-feedback").textContent = action === "add" ? (data.changed ? "已加入黑名单。" : "这只股票已在黑名单中。") : "已移出黑名单。";
    if (action === "add") { featureState.blacklistSelected = null; $("blacklist-search").value = ""; }
  } catch (error) { features.blacklist.blacklistError(error.message); }
  finally { featureState.blacklistSaving = false; features.blacklist.updateBlacklistControls(); }
}

  const bindings = {
binding053() {
$("blacklist-refresh").addEventListener("click", features.blacklist.loadBlacklist);
},
binding054() {
$("blacklist-add-form").addEventListener("submit", event => { event.preventDefault(); features.blacklist.changeBlacklist("add"); });
},
binding055() {
$("blacklist-search").addEventListener("input", () => {
  featureState.blacklistSelected = null;
  featureState.blacklistSuggestions = [];
  features.api.channels["blacklist-search"]?.abort();
  features.blacklist.hideBlacklistSuggestions();
  features.blacklist.blacklistError();
  $("blacklist-feedback").textContent = "";
});
},
binding056() {
$("blacklist-search").addEventListener("input", features.format.debounce(features.blacklist.searchBlacklistStocks));
},
binding057() {
$("blacklist-search").addEventListener("keydown", event => {
  if (event.key === "Escape") { features.blacklist.hideBlacklistSuggestions(); return; }
  const rows = featureState.blacklistSuggestions || [];
  if ($("blacklist-suggestions").hidden || !rows.length) return;
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    featureState.blacklistSuggestionIndex = ((featureState.blacklistSuggestionIndex ?? -1) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    $("blacklist-suggestions").querySelectorAll("[role=option]").forEach((button, index) => { const active = index === featureState.blacklistSuggestionIndex; button.classList.toggle("focused", active); button.setAttribute("aria-selected", String(active)); });
    $("blacklist-search").setAttribute("aria-activedescendant", `blacklist-suggestion-${featureState.blacklistSuggestionIndex}`);
    $("blacklist-suggestions").querySelector('[aria-selected="true"]')?.scrollIntoView({block: "nearest"});
  } else if (event.key === "Enter" && featureState.blacklistSuggestionIndex >= 0) { event.preventDefault(); features.blacklist.selectBlacklistStock(rows[featureState.blacklistSuggestionIndex]); }
});
},
binding058() {
$("blacklist-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-blacklist-suggestion]"); if (button) features.blacklist.selectBlacklistStock(featureState.blacklistSuggestions[Number(button.dataset.blacklistSuggestion)]); });
},
binding059() {
$("blacklist-table-area").addEventListener("click", event => {
  const remove = event.target.closest("[data-blacklist-remove]");
  if (remove) { features.blacklist.changeBlacklist("remove", remove.dataset.blacklistRemove); return; }
  const stock = event.target.closest("[data-blacklist-code]");
  if (stock) features.stock.chooseStock({code: stock.dataset.blacklistCode, name: stock.dataset.blacklistName});
});
},
binding060() {
document.addEventListener("click", event => { if (!event.target.closest("#blacklist-add-form")) features.blacklist.hideBlacklistSuggestions(); });
}
};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, canEditBlacklist, blacklistError, updateBlacklistControls, renderBlacklist, loadBlacklist, hideBlacklistSuggestions, showBlacklistSuggestions, selectBlacklistStock, searchBlacklistStocks, changeBlacklist };
}
