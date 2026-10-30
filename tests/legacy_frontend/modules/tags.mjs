// tags: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {};
  const keys = new Set(["tagManagerName","tagManagerSaving","tagManagerLoading","tagManagerMembers","tagManagerMembersLoading","tagManagerData","tagManagerPendingDelete","tagParentSuggestionIndex","tagParentSuggestionRows","tagManagerMemberGeneration","tagManagerStock","tagManagerGeneration","tagManagerSearchResults","tagManagerPendingMerge","tagBatchResults","tagBatchSaving","tagBatchRevision","tagBatchResolving","tagBatchSubmitted","tagBatchCatalogLoading","tagBatchTimer","tagBatchGeneration","tagBatchSession","tagBatchName","emptyTagHierarchy","tagHierarchySource","tagHierarchyCache","tagOrderCache","tagRankCache","tagDraft","tagEditorData","tagSuggestionsActive","tagSuggestionRows","tagSuggestionIndex","tagSaving","tagBlacklistSaving","tagSuggestionCatalog","tagSuggestionLoading","tagSuggestionError","tagSuggestionGeneration","tagEditingCode","tagUseSource"]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown tags state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown tags state: ' + key); featureState[key] = value; return value; }

function canManageTags() { return features.shell.read("meta")?.capabilities?.manage_tags ?? features.tags.canEditTags(); }

function tagManagerError(message = "") {
  $("tag-manager-error").textContent = message;
  $("tag-manager-error").hidden = !message;
}

function updateTagManagerControls() {
  const editable = features.tags.canManageTags(), busy = Boolean(featureState.tagManagerSaving || featureState.tagManagerLoading);
  $("tag-manager-refresh").disabled = busy;
  $("tag-manager-rename-form").hidden = !editable;
  $("tag-manager-add-form").hidden = !editable;
  $("tag-manager-readonly").hidden = editable;
  $("tag-manager-delete").hidden = !editable;
  $("tag-manager-delete").disabled = !editable || busy || !featureState.tagManagerMembers || Boolean(featureState.tagManagerMembersLoading);
  $("tag-manager-create").hidden = !editable;
  $("tag-manager-create").disabled = busy || !featureState.tagManagerData;
  $("tag-manager-parent-form").hidden = !editable;
  $("tag-manager-child").hidden = !editable;
  $("tag-manager-child").disabled = busy || !featureState.tagManagerMembers;
  for (const id of ["tag-manager-rename-form", "tag-manager-add-form", "tag-manager-parent-form", "tag-node-form"]) $(id).querySelectorAll("input, button, select").forEach(el => { el.disabled = !editable || busy || Boolean(featureState.tagManagerMembersLoading); });
  $("tag-manager-list").querySelectorAll("button").forEach(el => { el.disabled = busy; });
  $("tag-manager-members").querySelectorAll("[data-remove-stock-tag]").forEach(el => { el.disabled = !editable || busy || Boolean(featureState.tagManagerMembersLoading); });
  for (const id of ["tag-merge-confirm", "tag-merge-cancel", "tag-merge-close"]) $(id).disabled = Boolean(featureState.tagManagerSaving);
  for (const id of ["tag-delete-cancel", "tag-delete-close"]) $(id).disabled = Boolean(featureState.tagManagerSaving);
  $("tag-delete-confirm").disabled = !editable || Boolean(featureState.tagManagerSaving) || !featureState.tagManagerPendingDelete;
  $("tag-node-close").disabled = Boolean(featureState.tagManagerSaving);
}

function renderTagManagerCatalog() {
  const data = featureState.tagManagerData;
  if (!data) return;
  const query = $("tag-manager-filter").value.trim().toLocaleLowerCase();
  const tags = data.tags.filter(tag => tag.name.toLocaleLowerCase().includes(query));
  $("tag-manager-count").textContent = features.format.numberValue(data.total);
  $("tag-manager-summary").textContent = `${features.format.numberValue(data.total)} 个现有标签 · ${features.format.numberValue(data.stocks)} 只股票 · 全部已收录股票，跨日期去重统计${query ? ` · 当前匹配 ${features.format.numberValue(tags.length)} 个标签` : ""}`;
  const button = tag => `<button type="button" class="tag-manager-item ${tag.name === featureState.tagManagerName ? "selected" : ""}" data-manage-tag="${features.format.escapeHTML(tag.name)}" aria-pressed="${tag.name === featureState.tagManagerName}" title="${features.format.escapeHTML(tag.name)} · ${features.format.numberValue(tag.count)} 只股票"><span>${features.format.escapeHTML(tag.name)}</span><strong>${features.format.numberValue(tag.count)}<small>只</small></strong></button>`;
  if ((data.hierarchy || []).some(node => node.parent)) {
    const relevant = new Set(tags.flatMap(tag => [tag.name, ...features.tags.tagAncestors(tag.name)]));
    const branch = (parent = "", depth = 0) => data.tags.filter(tag => (features.tags.tagHierarchy().parents.get(tag.name.toLocaleLowerCase()) || "") === parent && relevant.has(tag.name)).map(tag => {
      const children = branch(tag.name, depth + 1);
      return `<div class="tag-manager-tree-node" style="--tag-depth:${Math.min(depth,6)}">${button(tag)}${children ? `<div class="tag-manager-tree-children">${children}</div>` : ""}</div>`;
    }).join("");
    $("tag-manager-list").innerHTML = branch() || features.format.emptyHTML("没有匹配的标签", "请尝试其他标签名称。");
    $("tag-manager-list").classList.toggle("tag-manager-tree", true);
  } else {
    $("tag-manager-list").innerHTML = tags.map(button).join("") || features.format.emptyHTML(query ? "没有匹配的标签" : "还没有标签", query ? "请尝试其他标签名称。" : "股票标签补充后，会在这里显示。");
    $("tag-manager-list").classList.toggle("tag-manager-tree", false);
  }
  $("tag-manager-parent").value = features.tags.tagHierarchy().parents.get((featureState.tagManagerName || "").toLocaleLowerCase()) || "";
  features.tags.hideManagerParentSuggestions();
  features.tags.updateTagManagerControls();
}

function hideManagerParentSuggestions() {
  $("tag-manager-parent-suggestions").hidden = true;
  $("tag-manager-parent").setAttribute("aria-expanded", "false");
  $("tag-manager-parent").setAttribute("aria-activedescendant", "");
  featureState.tagParentSuggestionIndex = -1;
}

function renderManagerParentSuggestions() {
  const input = $("tag-manager-parent"), query = input.value.trim();
  const choices = featureState.tagManagerData.tags.filter(tag => tag.name !== featureState.tagManagerName && !features.tags.tagAncestors(tag.name).includes(featureState.tagManagerName)
    && (!query || features.tags.matchesExistingTag(tag.name, query) || features.tags.tagAncestors(tag.name).some(parent => features.tags.matchesExistingTag(parent, query))));
  featureState.tagParentSuggestionRows = query ? choices : [{name:"", count:0}, ...choices];
  featureState.tagParentSuggestionIndex = -1;
  $("tag-manager-parent-suggestions").innerHTML = featureState.tagParentSuggestionRows.map((tag, index) => {
    const ancestors = tag.name ? features.tags.tagAncestors(tag.name).reverse() : [];
    return `<li role="presentation"><button type="button" role="option" id="tag-parent-option-${index}" aria-selected="false" data-parent-tag-index="${index}"><span>${ancestors.length ? `<span class="tag-suggestion-path">${features.format.escapeHTML(ancestors.join(" / "))} / </span>` : ""}${features.format.escapeHTML(tag.name || "无父级（独立标签）")}</span>${tag.name ? `<small>${features.format.numberValue(tag.count)} 只</small>` : ""}</button></li>`;
  }).join("") || '<li class="suggestion-message">没有匹配的标签，请尝试其他关键词。</li>';
  $("tag-manager-parent-suggestions").hidden = false;
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-activedescendant", "");
}

function chooseManagerParentTag(index) {
  $("tag-manager-parent").value = featureState.tagParentSuggestionRows[index].name;
  $("tag-manager-parent").focus();
  features.tags.hideManagerParentSuggestions();
}

async function selectManagerTag(name, replace = false) {
  const generation = featureState.tagManagerMemberGeneration = (featureState.tagManagerMemberGeneration || 0) + 1;
  features.api.channels["tag-members"]?.abort();
  featureState.tagManagerMembersLoading = false;
  featureState.tagManagerName = name;
  featureState.tagManagerMembers = null;
  featureState.tagManagerStock = null;
  $("tag-manager-stock-search").value = "";
  features.tags.hideManagerSuggestions();
  $("tag-manager-detail").hidden = !name;
  $("tag-manager-layout").classList.toggle("has-selection", Boolean(name));
  features.tags.renderTagManagerCatalog();
  features.navigation.updateURL({replace});
  if (!name) return;
  $("tag-manager-name").textContent = name;
  $("tag-manager-rename").value = name;
  $("tag-manager-member-count").textContent = "—";
  $("tag-manager-members").innerHTML = features.format.loadingHTML();
  $("tag-manager-members").setAttribute("aria-busy", "true");
  featureState.tagManagerMembersLoading = true;
  features.tags.updateTagManagerControls();
  try {
    const data = await features.api.request(`/api/tag-stocks?${new URLSearchParams({tag:name})}`, "tag-members");
    if (!data || features.navigation.read("tab") !== "tags" || featureState.tagManagerName !== name || featureState.tagManagerMemberGeneration !== generation) return;
    featureState.tagManagerMembers = data;
    $("tag-manager-member-count").textContent = `${features.format.numberValue(data.count)} 只`;
    $("tag-manager-members").innerHTML = data.rows.length ? `<ul>${data.rows.map(stock => `<li><div><button type="button" class="stock-name-button" data-tag-stock-code="${features.format.escapeHTML(stock.code)}" data-tag-stock-name="${features.format.escapeHTML(stock.name)}">${features.format.escapeHTML(stock.name)}</button><small>${features.format.escapeHTML(stock.code)} · ${features.format.escapeHTML(stock.initials)}</small></div><div class="tag-manager-stock-actions"><span>${features.format.escapeHTML(features.daily.regionLabel(stock))}</span>${features.tags.canManageTags() && stock.direct !== false ? `<button type="button" class="tag-manager-remove" data-remove-stock-tag="${features.format.escapeHTML(stock.code)}" aria-label="移除${features.format.escapeHTML(stock.name)}的${features.format.escapeHTML(data.name)}标签">移除标签</button>` : ""}</div></li>`).join("")}</ul>` : features.format.emptyHTML("暂无所属股票", "搜索并加入股票。");
  } catch (error) {
    if (features.navigation.read("tab") === "tags" && featureState.tagManagerMemberGeneration === generation) { features.tags.tagManagerError(error.message); $("tag-manager-members").innerHTML = features.format.emptyHTML("股票列表读取失败", "请点击刷新列表重试。"); }
  } finally {
    if (featureState.tagManagerMemberGeneration === generation) { featureState.tagManagerMembersLoading = false; $("tag-manager-members").setAttribute("aria-busy", "false"); features.tags.updateTagManagerControls(); }
  }
}

async function loadTagManager() {
  features.navigation.setView("tags");
  features.tags.tagManagerError();
  const generation = featureState.tagManagerGeneration = (featureState.tagManagerGeneration || 0) + 1;
  featureState.tagManagerLoading = true;
  $("tag-manager-list").setAttribute("aria-busy", "true");
  if (!featureState.tagManagerData) $("tag-manager-list").innerHTML = features.format.loadingHTML();
  features.tags.updateTagManagerControls();
  try {
    const data = await features.api.request("/api/tags", "tags");
    if (!data || features.navigation.read("tab") !== "tags" || generation !== featureState.tagManagerGeneration) return;
    featureState.tagManagerData = data;
    features.tags.applyTagOrder(data);
    const selected = data.tags.some(tag => tag.name === featureState.tagManagerName) ? featureState.tagManagerName : "";
    await features.tags.selectManagerTag(selected, true);
  } catch (error) { if (features.navigation.read("tab") === "tags" && generation === featureState.tagManagerGeneration) features.tags.tagManagerError(error.message); }
  finally {
    if (generation === featureState.tagManagerGeneration) { featureState.tagManagerLoading = false; $("tag-manager-list").setAttribute("aria-busy", "false"); features.tags.updateTagManagerControls(); }
  }
}

function hideManagerSuggestions() {
  $("tag-manager-suggestions").hidden = true;
  $("tag-manager-stock-search").setAttribute("aria-expanded", "false");
}

function showManagerSuggestions(rows) {
  featureState.tagManagerSearchResults = rows.slice(0, 15);
  const members = new Set((featureState.tagManagerMembers?.rows || []).map(row => row.code));
  $("tag-manager-suggestions").innerHTML = featureState.tagManagerSearchResults.map((stock, index) => `<li role="presentation"><button type="button" role="option" aria-selected="false" data-tag-suggestion="${index}"><span class="suggestion-code">${features.format.escapeHTML(stock.code)}</span><span>${features.format.escapeHTML(stock.name)}</span><span class="suggestion-market">${members.has(stock.code) ? (featureState.tagManagerMembers.rows.find(row => row.code === stock.code)?.direct === false ? "可加入标签" : "已在标签中") : features.format.escapeHTML(features.format.marketValue(stock.market))}</span></button></li>`).join("") || '<li class="suggestion-message">未找到已收录的股票。</li>';
  $("tag-manager-suggestions").hidden = false;
  $("tag-manager-stock-search").setAttribute("aria-expanded", "true");
}

async function searchManagerStocks() {
  const query = $("tag-manager-stock-search").value.trim(), name = featureState.tagManagerName;
  if (!query || featureState.tagManagerStock || featureState.tagManagerSaving || features.navigation.read("tab") !== "tags") return;
  try {
    const data = await features.api.request(`/api/stocks?${new URLSearchParams({q:query})}`, "tag-manager-search");
    if (data && features.navigation.read("tab") === "tags" && featureState.tagManagerName === name && !featureState.tagManagerStock && $("tag-manager-stock-search").value.trim() === query) features.tags.showManagerSuggestions(data.rows || []);
  } catch (error) { if (features.navigation.read("tab") === "tags" && featureState.tagManagerName === name && $("tag-manager-stock-search").value.trim() === query) features.tags.tagManagerError(error.message); }
}

async function refreshAfterTagWrite() {
  features.daily.write("dateData", null); features.stock.write("stockData", null);
  if (features.navigation.read("tab") === "tags") await features.tags.loadTagManager();
  else if (features.navigation.read("tab") === "stock") await features.stock.loadStock({remember:false});
  else if (features.navigation.read("tab") === "intraday") await features.intraday.loadIntraday();
  else if (features.navigation.read("tab") === "blacklist") await features.blacklist.loadBlacklist();
  else await features.daily.loadDate();
}

async function removeManagerStock(code) {
  if (!features.tags.canManageTags() || featureState.tagManagerSaving || featureState.tagManagerLoading || !featureState.tagManagerMembers) return;
  const stock = featureState.tagManagerMembers.rows.find(row => row.code === code);
  if (!stock || stock.direct === false) return;
  const name = featureState.tagManagerName, revision = featureState.tagManagerMembers.revision;
  const scroll = $("tag-manager-members").scrollTop;
  featureState.tagManagerSaving = true;
  features.tags.tagManagerError(); features.tags.updateTagManagerControls();
  try {
    const data = await features.api.request("/api/tag-stocks", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({tag:name,code,revision,action:"remove"})});
    if (!data) return;
    $("tag-manager-feedback").textContent = data.changed ? `已移除${stock.name}的“${name}”标签，其他标签已保留。` : `${stock.name}已没有“${name}”标签。`;
    await features.tags.refreshAfterTagWrite();
    if (features.navigation.read("tab") === "tags" && featureState.tagManagerName === name) $("tag-manager-members").scrollTop = scroll;
  } catch (error) { features.tags.tagManagerError(error.message); }
  finally { featureState.tagManagerSaving = false; features.tags.updateTagManagerControls(); }
}

async function addManagerStock(event) {
  event?.preventDefault();
  if (!features.tags.canManageTags() || featureState.tagManagerSaving || !featureState.tagManagerName || !featureState.tagManagerMembers) return;
  featureState.tagManagerSaving = true;
  features.tags.tagManagerError(); features.tags.updateTagManagerControls();
  const name = featureState.tagManagerName;
  try {
    let stock = featureState.tagManagerStock;
    if (!stock) {
      const query = $("tag-manager-stock-search").value.trim();
      if (!query) throw new Error("请先搜索要加入的股票。");
      const data = await features.api.request(`/api/stocks?${new URLSearchParams({q:query})}`, "tag-manager-search");
      if (!data || features.navigation.read("tab") !== "tags" || featureState.tagManagerName !== name) return;
      const exact = (data.rows || []).filter(row => row.code === query || row.name === query || row.initials === query.toUpperCase());
      stock = exact.length === 1 ? exact[0] : data.rows?.length === 1 ? data.rows[0] : null;
      if (!stock) { features.tags.showManagerSuggestions(data.rows || []); throw new Error("请选择一只股票后再加入标签。"); }
    }
    const data = await features.api.request("/api/tag-stocks", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({tag:name, code:stock.code, revision:featureState.tagManagerMembers.revision})});
    if (!data) return;
    $("tag-manager-feedback").textContent = data.changed ? `已将${stock.name}加入“${name}”。` : `${stock.name}已在“${name}”中。`;
    await features.tags.refreshAfterTagWrite();
  } catch (error) { features.tags.tagManagerError(error.message); }
  finally { featureState.tagManagerSaving = false; features.tags.updateTagManagerControls(); }
}

function cancelManagerMerge() {
  if (featureState.tagManagerSaving) return;
  featureState.tagManagerPendingMerge = null;
  $("tag-merge-dialog").close();
}

async function renameManagerTag(merge = false) {
  if (!features.tags.canManageTags() || featureState.tagManagerSaving || !featureState.tagManagerName || !featureState.tagManagerMembers) return;
  const pending = merge ? featureState.tagManagerPendingMerge : null;
  if (merge && !pending) return;
  const payload = pending ? {source:pending.source, target:pending.target, revision:pending.revision, merge:true} : {source:featureState.tagManagerName, target:$("tag-manager-rename").value.trim(), revision:featureState.tagManagerMembers.revision, merge:false};
  if (!payload.target) { features.tags.tagManagerError("请输入新的标签名称。"); return; }
  featureState.tagManagerSaving = true;
  features.tags.tagManagerError(); $("tag-merge-error").hidden = true; features.tags.updateTagManagerControls();
  try {
    const data = await features.api.request("/api/tag-rename", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    if (!data) return;
    if (data.needs_merge) {
      if (features.navigation.read("tab") !== "tags") return;
      featureState.tagManagerPendingMerge = data;
      $("tag-merge-message").textContent = `已经存在“${data.target}”标签（${features.format.numberValue(data.target_count)} 只股票）。是否将“${data.source}”（${features.format.numberValue(data.source_count)} 只股票）合并到“${data.target}”？合并后共 ${features.format.numberValue(data.combined_count)} 只股票，同一只股票只计一次。`;
      if (!$("tag-merge-dialog").open) $("tag-merge-dialog").showModal();
      return;
    }
    if ($("tag-merge-dialog").open) $("tag-merge-dialog").close();
    featureState.tagManagerPendingMerge = null;
    featureState.tagManagerName = data.name;
    if (!data.name.toLocaleLowerCase().includes($("tag-manager-filter").value.trim().toLocaleLowerCase())) $("tag-manager-filter").value = "";
    $("tag-manager-feedback").textContent = merge ? `已合并到“${data.name}”，所有股票已同步，重复标签已去重。` : data.changed ? `已改名为“${data.name}”，所有股票已同步。` : "标签名称没有变化。";
    await features.tags.refreshAfterTagWrite();
  } catch (error) {
    if (merge && $("tag-merge-dialog").open) { $("tag-merge-error").textContent = error.message; $("tag-merge-error").hidden = false; }
    else features.tags.tagManagerError(error.message);
  } finally { featureState.tagManagerSaving = false; features.tags.updateTagManagerControls(); }
}

function cancelManagerDelete() {
  if (featureState.tagManagerSaving) return;
  featureState.tagManagerPendingDelete = null;
  $("tag-delete-dialog").close();
}

async function deleteManagerTag(confirm = false) {
  if (!features.tags.canManageTags() || featureState.tagManagerSaving || featureState.tagManagerLoading || !featureState.tagManagerMembers) return;
  const pending = confirm ? featureState.tagManagerPendingDelete : null;
  if (confirm && !pending) return;
  const payload = {tag:pending?.name || featureState.tagManagerName, revision:pending?.revision || featureState.tagManagerMembers.revision, confirm};
  featureState.tagManagerSaving = true;
  features.tags.tagManagerError(); $("tag-delete-error").hidden = true; features.tags.updateTagManagerControls();
  try {
    const data = await features.api.request("/api/tag-delete", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    if (!data) return;
    if (data.needs_confirmation) {
      if (features.navigation.read("tab") !== "tags") return;
      featureState.tagManagerPendingDelete = data;
      $("tag-delete-message").textContent = `确认删除“${data.name}”标签吗？这会从 ${features.format.numberValue(data.count)} 只股票下移除该标签，其他标签和备注会保留。默认数据更新时也不会重新补回该标签。${data.children ? ` ${data.children} 个直属子级会保留，并移到上一级。` : ""}`;
      if (!$("tag-delete-dialog").open) $("tag-delete-dialog").showModal();
      return;
    }
    if (!data.deleted) throw new Error("未能确认删除结果，请刷新列表核实。");
    $("tag-delete-dialog").close();
    featureState.tagManagerPendingDelete = null;
    featureState.tagManagerName = "";
    $("tag-manager-feedback").textContent = `已删除“${data.name}”标签，已从 ${features.format.numberValue(data.count)} 只股票下移除。`;
    await features.tags.refreshAfterTagWrite();
  } catch (error) {
    if (confirm && $("tag-delete-dialog").open) { $("tag-delete-error").textContent = error.message; $("tag-delete-error").hidden = false; }
    else features.tags.tagManagerError(error.message);
  } finally { featureState.tagManagerSaving = false; features.tags.updateTagManagerControls(); }
}

function openTagNodeDialog(parent = "") {
  if (!features.tags.canManageTags() || featureState.tagManagerSaving || !featureState.tagManagerData) return;
  $("tag-node-name").value = "";
  $("tag-node-parent").innerHTML = '<option value="">无父级（新建独立父级）</option>' + featureState.tagManagerData.tags.map(tag => `<option value="${features.format.escapeHTML(tag.name)}">${features.format.escapeHTML(tag.name)}</option>`).join("");
  $("tag-node-parent").value = parent;
  $("tag-node-title").textContent = parent ? `在「${parent}」下新建子级` : "新建父级标签";
  $("tag-node-error").hidden = true;
  if (!$("tag-node-dialog").open) $("tag-node-dialog").showModal();
  features.tags.updateTagManagerControls();
  $("tag-node-name").focus();
}

async function saveManagerTagNode(event, action = "create") {
  event.preventDefault();
  if (!features.tags.canManageTags() || featureState.tagManagerSaving || !featureState.tagManagerData) return;
  const creating = action === "create";
  const name = creating ? $("tag-node-name").value.trim() : featureState.tagManagerName;
  let parent = $(creating ? "tag-node-parent" : "tag-manager-parent").value.trim();
  if (!name) return;
  if (!creating && parent) {
    const selected = featureState.tagManagerData.tags.find(tag => tag.name.toLocaleLowerCase() === parent.toLocaleLowerCase());
    if (!selected) { features.tags.tagManagerError("请选择已有的父级标签，或清空输入以设为独立标签。"); $("tag-manager-parent").focus(); features.tags.renderManagerParentSuggestions(); return; }
    parent = selected.name;
  }
  features.tags.hideManagerParentSuggestions();
  featureState.tagManagerSaving = true;
  features.tags.tagManagerError(); $("tag-node-error").hidden = true; features.tags.updateTagManagerControls();
  try {
    const data = await features.api.request("/api/tag-node", "tag-manager-write", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name, parent, action, revision:featureState.tagManagerData.revision})});
    if (!data) throw new Error("未能确认标签关系已保存，请刷新后重试。");
    features.tags.applyTagOrder(data.catalog);
    if (creating) $("tag-node-dialog").close();
    featureState.tagManagerName = creating ? parent || data.name : data.name;
    $("tag-manager-filter").value = "";
    $("tag-manager-feedback").textContent = creating ? `已创建“${data.name}”${parent ? `，父级为“${parent}”` : ""}。` : `已保存“${data.name}”的父级关系，股票原有标签归属保持不变。`;
    await features.tags.refreshAfterTagWrite();
  } catch (error) {
    if (creating) { $("tag-node-error").textContent = error.message; $("tag-node-error").hidden = false; }
    else features.tags.tagManagerError(error.message);
  } finally { featureState.tagManagerSaving = false; features.tags.updateTagManagerControls(); }
}

function openManagerTagBatch() {
  if (features.navigation.read("tab") !== "tags" || !features.tags.canManageTags() || featureState.tagManagerSaving || featureState.tagManagerLoading || featureState.tagManagerMembersLoading || !featureState.tagManagerName || !featureState.tagManagerMembers) return;
  features.tags.hideManagerSuggestions();
  features.api.channels["tag-manager-search"]?.abort();
  return features.tags.openTagBatch(featureState.tagManagerName);
}

function bindTagManager() {
  $("tag-manager-create").addEventListener("click", () => features.tags.openTagNodeDialog());
  $("tag-manager-child").addEventListener("click", () => features.tags.openTagNodeDialog(featureState.tagManagerName));
  $("tag-node-form").addEventListener("submit", event => features.tags.saveManagerTagNode(event));
  $("tag-manager-parent-form").addEventListener("submit", event => features.tags.saveManagerTagNode(event, "parent"));
  $("tag-manager-parent").addEventListener("focus", features.tags.renderManagerParentSuggestions);
  $("tag-manager-parent").addEventListener("input", features.tags.renderManagerParentSuggestions);
  $("tag-manager-parent").addEventListener("blur", features.tags.hideManagerParentSuggestions);
  $("tag-manager-parent").addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); features.tags.hideManagerParentSuggestions(); return; }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    if (event.key === "Enter") {
      if (!$("tag-manager-parent-suggestions").hidden && featureState.tagParentSuggestionRows.length) {
        event.preventDefault(); features.tags.chooseManagerParentTag(Math.max(0, featureState.tagParentSuggestionIndex));
      }
      return;
    }
    event.preventDefault();
    if ($("tag-manager-parent-suggestions").hidden) features.tags.renderManagerParentSuggestions();
    const count = featureState.tagParentSuggestionRows.length;
    if (!count) return;
    featureState.tagParentSuggestionIndex = featureState.tagParentSuggestionIndex < 0 ? (event.key === "ArrowDown" ? 0 : count - 1)
      : (featureState.tagParentSuggestionIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    $("tag-manager-parent-suggestions").querySelectorAll("[data-parent-tag-index]").forEach((button, index) => button.setAttribute("aria-selected", String(index === featureState.tagParentSuggestionIndex)));
    $("tag-manager-parent").setAttribute("aria-activedescendant", `tag-parent-option-${featureState.tagParentSuggestionIndex}`);
    $("tag-manager-parent-suggestions").querySelector(`[data-parent-tag-index="${featureState.tagParentSuggestionIndex}"]`)?.scrollIntoView({block:"nearest"});
  });
  $("tag-manager-parent-suggestions").addEventListener("mousedown", event => event.preventDefault());
  $("tag-manager-parent-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-parent-tag-index]"); if (button) features.tags.chooseManagerParentTag(Number(button.dataset.parentTagIndex)); });
  $("tag-node-close").addEventListener("click", () => { if (!featureState.tagManagerSaving) $("tag-node-dialog").close(); });
  $("tag-node-dialog").addEventListener("cancel", event => { if (featureState.tagManagerSaving) event.preventDefault(); });
  $("tag-manager-refresh").addEventListener("click", features.tags.loadTagManager);
  $("tag-manager-delete").addEventListener("click", () => features.tags.deleteManagerTag());
  $("tag-manager-filter").addEventListener("input", features.tags.renderTagManagerCatalog);
  $("tag-manager-close").addEventListener("click", () => { if (!featureState.tagManagerSaving) features.tags.selectManagerTag(""); });
  $("tag-manager-list").addEventListener("click", event => {
    const button = event.target.closest("[data-manage-tag]");
    if (button && !featureState.tagManagerSaving && !featureState.tagManagerLoading) {
      features.tags.tagManagerError();
      const name = button.dataset.manageTag;
      features.tags.selectManagerTag(name).then(() => { if (features.navigation.read("tab") === "tags" && featureState.tagManagerName === name) $("tag-manager-detail").scrollIntoView({block:"nearest"}); });
    }
  });
  $("tag-manager-rename-form").addEventListener("submit", event => { event.preventDefault(); features.tags.renameManagerTag(); });
  $("tag-manager-add-form").addEventListener("submit", features.tags.addManagerStock);
  $("tag-manager-batch-add").addEventListener("click", features.tags.openManagerTagBatch);
  const search = features.format.debounce(features.tags.searchManagerStocks);
  $("tag-manager-stock-search").addEventListener("input", () => { featureState.tagManagerStock = null; features.tags.hideManagerSuggestions(); if ($("tag-manager-stock-search").value.trim()) search(); });
  $("tag-manager-stock-search").addEventListener("keydown", event => { if (event.key === "Escape") features.tags.hideManagerSuggestions(); });
  $("tag-manager-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-tag-suggestion]"); if (!button) return; const stock = featureState.tagManagerSearchResults[Number(button.dataset.tagSuggestion)]; featureState.tagManagerStock = stock; $("tag-manager-stock-search").value = `${stock.name} ${stock.code}`; features.api.channels["tag-manager-search"]?.abort(); features.tags.hideManagerSuggestions(); });
  $("tag-manager-members").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove-stock-tag]");
    if (remove) { features.tags.removeManagerStock(remove.dataset.removeStockTag); return; }
    const button = event.target.closest("[data-tag-stock-code]");
    if (button) features.stock.chooseStock({code:button.dataset.tagStockCode, name:button.dataset.tagStockName});
  });
  $("tag-merge-confirm").addEventListener("click", () => features.tags.renameManagerTag(true));
  $("tag-merge-cancel").addEventListener("click", features.tags.cancelManagerMerge);
  $("tag-merge-close").addEventListener("click", features.tags.cancelManagerMerge);
  $("tag-merge-dialog").addEventListener("cancel", event => { if (featureState.tagManagerSaving) event.preventDefault(); else featureState.tagManagerPendingMerge = null; });
  $("tag-delete-confirm").addEventListener("click", () => features.tags.deleteManagerTag(true));
  $("tag-delete-cancel").addEventListener("click", features.tags.cancelManagerDelete);
  $("tag-delete-close").addEventListener("click", features.tags.cancelManagerDelete);
  $("tag-delete-dialog").addEventListener("cancel", event => { if (featureState.tagManagerSaving) event.preventDefault(); else featureState.tagManagerPendingDelete = null; });
}

function tagBatchError(message = "") {
  $("tag-batch-error").textContent = message;
  $("tag-batch-error").hidden = !message;
}

function tagBatchTokens(value) {
  const tokens = [...new Set(value.trim().split(/[\s,，;；、]+/u).filter(Boolean))];
  if (tokens.length > 200) throw new Error("每批最多输入 200 个名称或代码。");
  if (tokens.some(token => token.length > 100)) throw new Error("请用空格、逗号或换行分隔股票名称或代码。");
  return tokens;
}

function tagBatchStocks() {
  return [...new Map((featureState.tagBatchResults || []).filter(item => item.stock).map(item => [item.stock.code, item.stock])).values()];
}

function updateTagBatchControls() {
  const busy = Boolean(featureState.tagBatchSaving), results = featureState.tagBatchResults || [];
  const ready = Boolean(featureState.tagBatchRevision) && !featureState.tagBatchResolving && results.length && results.every(item => item.stock);
  const count = features.tags.tagBatchStocks().length;
  $("tag-batch-submit").disabled = busy || !features.tags.canManageTags() || !ready || featureState.tagBatchSubmitted;
  $("tag-batch-submit").textContent = count ? `添加 ${count} 只股票` : "添加股票";
  $("tag-batch-input").disabled = busy;
  $("tag-batch-preview").querySelectorAll("select").forEach(select => { select.disabled = busy; });
  ["tag-batch-close", "tag-batch-cancel"].forEach(id => { $(id).disabled = busy; });
  $("tag-batch-retry").disabled = busy || featureState.tagBatchCatalogLoading;
}

function renderTagBatchPreview() {
  const results = featureState.tagBatchResults || [], stocks = features.tags.tagBatchStocks();
  $("tag-batch-preview").innerHTML = results.map((item, index) => `<li><span class="tag-batch-query">${features.format.escapeHTML(item.query)}</span><div>${item.stock ? `<strong>${features.format.escapeHTML(item.stock.name)}</strong><small>${features.format.escapeHTML(item.stock.code)}</small>`
    : item.pending ? '<span class="muted">正在匹配…</span>'
    : item.candidates?.length ? `<select data-tag-batch-choice="${index}" aria-label="为${features.format.escapeHTML(item.query)}选择股票"><option value="">请选择对应股票</option>${item.candidates.map(stock => `<option value="${features.format.escapeHTML(stock.code)}">${features.format.escapeHTML(stock.name)} · ${features.format.escapeHTML(stock.code)}</option>`).join("")}</select>`
    : `<span class="tag-batch-missing">${features.format.escapeHTML(item.error || "未找到已收录股票，请修改名称或代码。")}</span>`}</div></li>`).join("");
  $("tag-batch-summary").textContent = results.length ? `已识别 ${stocks.length} 只股票${results.some(item => !item.stock) ? "，请处理未匹配或待选择的项目。" : "，重复股票已自动去重。"}` : "可一次输入多只股票，输入后自动匹配。";
  features.tags.updateTagBatchControls();
}

function cancelTagBatchSearch() {
  clearTimeout(featureState.tagBatchTimer);
  featureState.tagBatchGeneration = (featureState.tagBatchGeneration || 0) + 1;
  Object.entries(features.api.channels).forEach(([key, controller]) => { if (key.startsWith("tag-batch-search-")) controller.abort(); });
}

async function loadTagBatchCatalog() {
  if (featureState.tagBatchSaving) return;
  const session = featureState.tagBatchSession, name = featureState.tagBatchName;
  featureState.tagBatchCatalogLoading = true;
  featureState.tagBatchRevision = null;
  features.tags.tagBatchError(); features.tags.updateTagBatchControls();
  try {
    const catalog = await features.api.request("/api/tags", "tag-batch-catalog");
    if (!catalog || session !== featureState.tagBatchSession || !$("tag-batch-dialog").open) return;
    const tag = catalog.tags.find(tag => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!tag) throw new Error("这个标签已不存在，请关闭后刷新页面。");
    featureState.tagBatchName = tag.name;
    featureState.tagBatchRevision = catalog.revision;
    features.tags.applyTagOrder(catalog);
  } catch (error) {
    if (session === featureState.tagBatchSession && $("tag-batch-dialog").open) features.tags.tagBatchError(error.message);
  } finally {
    if (session === featureState.tagBatchSession) { featureState.tagBatchCatalogLoading = false; features.tags.updateTagBatchControls(); }
  }
}

async function openTagBatch(name) {
  if (!features.tags.canManageTags() || featureState.tagBatchSaving) return;
  features.tags.cancelTagBatchSearch();
  featureState.tagBatchSession = (featureState.tagBatchSession || 0) + 1;
  featureState.tagBatchName = name;
  featureState.tagBatchRevision = null;
  featureState.tagBatchResults = [];
  featureState.tagBatchSubmitted = false;
  featureState.tagBatchResolving = false;
  $("tag-batch-input").value = "";
  $("tag-batch-title").textContent = `添加股票到「${name}」`;
  $("tag-batch-feedback").textContent = "";
  features.tags.tagBatchError(); features.tags.renderTagBatchPreview();
  if (!$("tag-batch-dialog").open) $("tag-batch-dialog").showModal();
  $("tag-batch-input").focus();
  await features.tags.loadTagBatchCatalog();
}

function closeTagBatch() {
  if (featureState.tagBatchSaving) return;
  features.tags.cancelTagBatchSearch();
  featureState.tagBatchSession = (featureState.tagBatchSession || 0) + 1;
  features.api.channels["tag-batch-catalog"]?.abort();
  $("tag-batch-dialog").close();
}

async function resolveTagBatchInput() {
  if (featureState.tagBatchSaving || !$("tag-batch-dialog").open) return;
  features.tags.cancelTagBatchSearch();
  const generation = featureState.tagBatchGeneration;
  let tokens;
  try { tokens = features.tags.tagBatchTokens($("tag-batch-input").value); }
  catch (error) { featureState.tagBatchResults = []; featureState.tagBatchResolving = false; features.tags.tagBatchError(error.message); features.tags.renderTagBatchPreview(); return; }
  featureState.tagBatchResults = tokens.map(query => ({query, pending: true}));
  featureState.tagBatchResolving = true;
  features.tags.renderTagBatchPreview();
  let cursor = 0;
  const current = () => generation === featureState.tagBatchGeneration && $("tag-batch-dialog").open;
  const worker = async () => {
    while (current() && cursor < tokens.length) {
      const index = cursor++, query = tokens[index];
      try {
        const data = await features.api.request(`/api/stocks?${new URLSearchParams({q: query})}`, `tag-batch-search-${index}`);
        if (!current()) return;
        if (!data) throw new Error("读取失败，请修改输入后重试。");
        const rows = data.rows || [], exact = rows.filter(row => row.code === query || row.name === query || row.initials === query.toUpperCase());
        featureState.tagBatchResults[index] = {query, candidates: rows, stock: exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null};
      } catch (error) {
        if (!current()) return;
        featureState.tagBatchResults[index] = {query, error: error.message};
      }
      features.tags.renderTagBatchPreview();
    }
  };
  await Promise.all(Array.from({length: Math.min(4, tokens.length)}, worker));
  if (current()) { featureState.tagBatchResolving = false; features.tags.renderTagBatchPreview(); }
}

function changeTagBatchInput() {
  if (featureState.tagBatchSaving) return;
  features.tags.cancelTagBatchSearch();
  featureState.tagBatchResults = [];
  featureState.tagBatchSubmitted = false;
  featureState.tagBatchResolving = Boolean($("tag-batch-input").value.trim());
  $("tag-batch-feedback").textContent = "";
  features.tags.tagBatchError(); features.tags.renderTagBatchPreview();
  featureState.tagBatchTimer = setTimeout(features.tags.resolveTagBatchInput, 250);
}

async function saveTagBatch(event) {
  event.preventDefault();
  const results = featureState.tagBatchResults || [];
  if (!$("tag-batch-dialog").open || !features.tags.canManageTags() || featureState.tagBatchSaving || featureState.tagBatchResolving || featureState.tagBatchSubmitted || !featureState.tagBatchRevision
    || !results.length || results.some(item => !item.stock)) return;
  featureState.tagBatchSaving = true;
  features.tags.tagBatchError(); features.tags.updateTagBatchControls();
  try {
    const data = await features.api.request("/api/tag-stocks", "tag-batch-save", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({tag: featureState.tagBatchName, codes: features.tags.tagBatchStocks().map(stock => stock.code), revision: featureState.tagBatchRevision})});
    if (!data) throw new Error("未能确认保存结果，请刷新标签信息后重试。");
    featureState.tagBatchSubmitted = true;
    featureState.tagBatchRevision = data.catalog.revision;
    features.tags.applyTagOrder(data.catalog);
    $("tag-batch-feedback").textContent = `已添加 ${data.added} 只股票${data.existing ? `，${data.existing} 只已在标签中` : ""}。`;
    await features.tags.refreshAfterTagWrite();
  } catch (error) { features.tags.tagBatchError(error.message); }
  finally { featureState.tagBatchSaving = false; features.tags.updateTagBatchControls(); }
}

function bindTagBatch() {
  $("date-table-area").addEventListener("click", event => {
    const button = event.target.closest("[data-add-sector-tag]");
    if (button) features.tags.openTagBatch(button.dataset.addSectorTag);
  });
  ["tag-batch-close", "tag-batch-cancel"].forEach(id => $(id).addEventListener("click", features.tags.closeTagBatch));
  $("tag-batch-dialog").addEventListener("cancel", event => { event.preventDefault(); features.tags.closeTagBatch(); });
  $("tag-batch-input").addEventListener("input", features.tags.changeTagBatchInput);
  $("tag-batch-form").addEventListener("submit", features.tags.saveTagBatch);
  $("tag-batch-retry").addEventListener("click", features.tags.loadTagBatchCatalog);
  $("tag-batch-preview").addEventListener("change", event => {
    const select = event.target.closest("[data-tag-batch-choice]");
    if (!select || featureState.tagBatchSaving) return;
    const item = featureState.tagBatchResults?.[Number(select.dataset.tagBatchChoice)];
    if (!item) return;
    item.stock = item.candidates.find(stock => stock.code === select.value) || null;
    features.tags.renderTagBatchPreview();
  });
}

function stockTags(row) {
  const tags = features.tags.allStockTags(row);
  const parents = new Set(tags.flatMap(tag => features.tags.tagAncestors(tag).map(name => name.toLocaleLowerCase())));
  return tags.filter(tag => !parents.has(tag.toLocaleLowerCase()));
}

function allStockTags(row) {
  return features.tags.sortedTags(Array.isArray(row.tags) ? row.tags : row.industry ? [row.industry] : []);
}

function tagHierarchy() {
  const nodes = features.shell.read("meta")?.tag_hierarchy || (featureState.emptyTagHierarchy ||= []);
  if (featureState.tagHierarchySource !== nodes || !featureState.tagHierarchyCache) {
    const parents = new Map(nodes.filter(node => node.parent).map(node => [node.name.toLocaleLowerCase(), node.parent]));
    featureState.tagHierarchySource = nodes;
    featureState.tagHierarchyCache = {parents, parentKeys: new Set([...parents.values()].map(name => name.toLocaleLowerCase()))};
  }
  return featureState.tagHierarchyCache;
}

function tagAncestors(name) {
  const result = [], seen = new Set([name.toLocaleLowerCase()]), parents = features.tags.tagHierarchy().parents;
  while (parents.has(name.toLocaleLowerCase())) {
    name = parents.get(name.toLocaleLowerCase());
    if (seen.has(name.toLocaleLowerCase())) break;
    seen.add(name.toLocaleLowerCase()); result.push(name);
  }
  return result;
}

function tagRoot(name) { return features.tags.tagAncestors(name).at(-1) || name; }

function renderHierarchyStockGroups(rows, root, highlightLatest) {
  if (!features.tags.tagHierarchy().parentKeys.has(root.toLocaleLowerCase())) return `<ul class="industry-stock-list">${rows.map(row => features.daily.renderStockCard(row, {highlightLatest})).join("")}</ul>`;
  const groups = new Map();
  rows.forEach(row => {
    const tags = features.tags.allStockTags(row).filter(tag => features.tags.tagRoot(tag) === root);
    const leaves = tags.filter(tag => !tags.some(other => features.tags.tagAncestors(other).some(parent => parent.toLocaleLowerCase() === tag.toLocaleLowerCase())));
    leaves.forEach(tag => { if (!groups.has(tag)) groups.set(tag, []); groups.get(tag).push(row); });
  });
  const sections = [], cohorts = new Map();
  for (const [tag, stocks] of [...groups].sort((a,b) => features.tags.compareTags(a[0],b[0]))) {
    // Subgroups share a parent column and board height, so merge only exact
    // stock-code sets here, including higher boards as well as first boards.
    const key = JSON.stringify(stocks.map(row => String(row.code)).sort());
    const existing = cohorts.get(key);
    if (existing) existing.labels.push(tag);
    else {
      const section = {labels: [tag], stocks};
      sections.push(section); cohorts.set(key, section);
    }
  }
  return sections.map(({labels, stocks}) => {
    const name = labels.join(" / ");
    const heading = labels[0] === root ? "" : `<header>${labels.map(tag => {
      const ancestors = features.tags.tagAncestors(tag).reverse().slice(1);
      return `${ancestors.length ? `<small>${features.format.escapeHTML(ancestors.join(" / "))} / </small>` : ""}${features.daily.industryColumnHeading([tag], features.tags.canManageTags())}`;
    }).join('<span class="matrix-label-divider" aria-hidden="true"> / </span>')}<small>${stocks.length} 只</small></header>`;
    return `<section class="matrix-tag-subgroup" data-child-tag="${features.format.escapeHTML(name)}">${heading}<ul class="industry-stock-list">${stocks.map(row => features.daily.renderStockCard(row, {highlightLatest})).join("")}</ul></section>`;
  }).join("");
}

function tagRanks() {
  const order = features.shell.read("meta")?.tag_order;
  if (!Array.isArray(order)) return null;
  if (featureState.tagOrderCache !== order) {
    featureState.tagOrderCache = order;
    featureState.tagRankCache = new Map(order.map((tag, index) => [tag.toLocaleLowerCase(), index]));
  }
  return featureState.tagRankCache;
}

function compareTags(a, b) {
  const ranks = features.tags.tagRanks();
  if (!ranks) return 0;
  const left = a.toLocaleLowerCase(), right = b.toLocaleLowerCase();
  return (ranks.get(left) ?? Infinity) - (ranks.get(right) ?? Infinity) || (left < right ? -1 : left > right ? 1 : 0);
}

function sortedTags(tags) { return [...tags].sort(features.tags.compareTags); }

function applyTagOrder(catalog) {
  (features.shell.read("meta") || features.shell.write("meta", {}));
  features.shell.read("meta").tag_order = catalog.tags.map(tag => tag.name);
  features.shell.read("meta").tag_hierarchy = catalog.hierarchy || [];
  features.shell.read("meta").tag_catalog_revision = catalog.revision;
}

async function refreshTagOrder() {
  try {
    const catalog = await features.api.request("/api/tags", "tag-order");
    if (catalog) features.tags.applyTagOrder(catalog);
  } catch { /* Keep the last verified ordering until the next metadata refresh. */ }
}

function canEditTags() {
  return features.shell.read("meta")?.capabilities?.edit_tags !== false;
}

function renderTagEditor() {
  $("tag-editor-list").innerHTML = featureState.tagDraft.length ? featureState.tagDraft.map((tag, index) => ({tag,index,name:tag.split("/").at(-1).trim()})).sort((a,b) => features.tags.compareTags(a.name,b.name)).map(({tag,index,name}, position) => `<div class="tag-edit-chip"><span class="tag-edit-path" data-tag-path="${index}" hidden></span><input class="tag-name-input" type="text" value="${features.format.escapeHTML(name)}" maxlength="30" required data-tag-index="${index}" aria-label="标签 ${position + 1}"><button type="button" data-remove-tag="${index}" aria-label="移除标签 ${features.format.escapeHTML(tag)}">×</button></div>`).join("") : '<p class="tag-empty-hint">暂无标签，保存后将归入“独苗”。</p>';
  features.tags.updateTagEditorPaths();
  $("tag-editor-error").hidden = true;
  features.tags.renderTagSuggestions();
}

function updateTagEditorPaths() {
  $("tag-editor-list").querySelectorAll("[data-tag-path]").forEach(path => {
    const parts = featureState.tagDraft[Number(path.dataset.tagPath)].split("/").map(part => part.trim());
    const parents = [...features.tags.tagAncestors(parts[0]).reverse(), ...parts.slice(0, -1)];
    path.textContent = parents.length ? `${parents.join(" / ")} /` : "";
    path.hidden = !parents.length;
  });
  const defaults = features.tags.defaultEditorTags(featureState.tagEditorData);
  $("tag-source-label").textContent = defaults.length ? `默认标签：${defaults.map(tag => [...features.tags.tagAncestors(tag).reverse(), tag].join(" / ")).join("、")}` : "暂无默认标签，可以自行添加标签。";
}

function defaultEditorTags(data) {
  return features.tags.sortedTags(Array.isArray(data?.source_tags) ? data.source_tags : data?.source_tag ? [data.source_tag] : []);
}

function hideTagSuggestions() {
  featureState.tagSuggestionsActive = false;
  featureState.tagSuggestionRows = [];
  featureState.tagSuggestionIndex = -1;
  $("tag-new-suggestions").hidden = true;
  $("tag-new").setAttribute("aria-expanded", "false");
  $("tag-new").removeAttribute("aria-activedescendant");
}

function matchesExistingTag(name, query) {
  const value = name.toLocaleLowerCase().replace(/\s+/g, "");
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, "");
  if (!needle) return false;
  let offset = 0;
  for (const letter of needle) {
    const index = value.indexOf(letter, offset);
    if (index < 0) return false;
    offset = index + letter.length;
  }
  return true;
}

function positionTagSuggestions() {
  const list = $("tag-new-suggestions");
  if (list.hidden) return;
  const rect = $("tag-new").getBoundingClientRect();
  const width = Math.min(rect.width, window.innerWidth - 24), top = rect.bottom + 5;
  list.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  list.style.top = `${top}px`;
  list.style.width = `${width}px`;
  list.style.maxHeight = `${Math.max(32, Math.min(200, window.innerHeight - top - 12))}px`;
}

function renderTagSuggestions() {
  const input = $("tag-new"), list = $("tag-new-suggestions"), query = (input.value || "").trim();
  if (!featureState.tagSuggestionsActive || !$("tag-dialog").open || !featureState.tagEditorData || !query || featureState.tagSaving || featureState.tagBlacklistSaving) { features.tags.hideTagSuggestions(); return; }
  const draft = new Set((featureState.tagDraft || []).map(tag => tag.split("/").at(-1).trim().toLocaleLowerCase()));
  const parts = query.split("/").map(part => part.trim()), parents = parts.slice(0, -1), child = parts.at(-1);
  featureState.tagSuggestionRows = (featureState.tagSuggestionCatalog?.tags || []).filter(tag => {
    const ancestors = features.tags.tagAncestors(tag.name);
    const matches = parents.length
      ? parents.every(Boolean) && ancestors.length >= parents.length && parents.every((parent,index) => parent.toLocaleLowerCase() === ancestors[parents.length - index - 1].toLocaleLowerCase()) && (!child || features.tags.matchesExistingTag(tag.name, child))
      : features.tags.matchesExistingTag(tag.name, query) || ancestors.some(parent => features.tags.matchesExistingTag(parent, query));
    return matches && !draft.has(tag.name.toLocaleLowerCase());
  });
  featureState.tagSuggestionIndex = -1;
  const message = featureState.tagSuggestionLoading ? "正在读取已有标签…" : featureState.tagSuggestionError ? "已有标签暂时无法读取，仍可手动添加新标签。" : parents.length ? (child ? "没有匹配的子标签，可直接添加；新层级将在保存标签后生效。" : "没有可添加的子标签，请在斜杠后输入新子标签名称。") : "没有匹配的已有标签，可直接添加新标签。";
  list.innerHTML = featureState.tagSuggestionRows.map((tag,index) => {
    const parents = features.tags.tagAncestors(tag.name).reverse();
    return `<li role="presentation"><button type="button" id="tag-existing-option-${index}" role="option" aria-selected="false" data-existing-tag-index="${index}"><span>${parents.length ? `<span class="tag-suggestion-path">${features.format.escapeHTML(parents.join(" / "))} / </span>` : ""}<span>${features.format.escapeHTML(tag.name)}</span></span><small>${features.format.numberValue(tag.count)} 只股票</small></button></li>`;
  }).join("") || `<li class="tag-suggestion-message" role="presentation">${message}</li>`;
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  input.removeAttribute("aria-activedescendant");
  features.tags.positionTagSuggestions();
}

async function loadTagSuggestionCatalog() {
  const generation = featureState.tagSuggestionGeneration = (featureState.tagSuggestionGeneration || 0) + 1;
  const code = featureState.tagEditingCode;
  featureState.tagSuggestionCatalog = null;
  featureState.tagSuggestionLoading = true;
  featureState.tagSuggestionError = false;
  try {
    const data = await features.api.request("/api/tags", "tag-editor-catalog");
    if (!data || generation !== featureState.tagSuggestionGeneration || !$("tag-dialog").open || featureState.tagEditingCode !== code) return;
    if (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag.name !== "string")) throw new Error("标签列表格式无效");
    featureState.tagSuggestionCatalog = data;
    features.tags.applyTagOrder(data);
    features.tags.updateTagEditorPaths();
  } catch {
    if (generation === featureState.tagSuggestionGeneration) featureState.tagSuggestionError = true;
  } finally {
    if (generation === featureState.tagSuggestionGeneration) { featureState.tagSuggestionLoading = false; features.tags.renderTagSuggestions(); }
  }
}

function chooseExistingTag(index) {
  if (!featureState.tagEditorData || featureState.tagSaving || featureState.tagBlacklistSaving) return;
  const tag = featureState.tagSuggestionRows?.[index];
  if (!tag) return;
  $("tag-new").value = tag.name;
  features.tags.addTagDraft();
}

function onTagSuggestionInput() {
  $("tag-new").setCustomValidity("");
  featureState.tagSuggestionsActive = true;
  features.tags.renderTagSuggestions();
}

function onTagSuggestionKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape" && !$("tag-new-suggestions").hidden) { event.preventDefault(); event.stopPropagation(); features.tags.hideTagSuggestions(); return; }
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    if ($("tag-new-suggestions").hidden) { featureState.tagSuggestionsActive = true; features.tags.renderTagSuggestions(); }
    const rows = featureState.tagSuggestionRows || [];
    if (!rows.length) return;
    const previous = featureState.tagSuggestionIndex ?? -1;
    featureState.tagSuggestionIndex = previous < 0 ? event.key === "ArrowDown" ? 0 : rows.length - 1 : (previous + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    $("tag-new-suggestions").querySelectorAll("[data-existing-tag-index]").forEach((button,index) => button.setAttribute("aria-selected", String(index === featureState.tagSuggestionIndex)));
    $("tag-new").setAttribute("aria-activedescendant", `tag-existing-option-${featureState.tagSuggestionIndex}`);
    $("tag-new-suggestions").querySelector(`[data-existing-tag-index="${featureState.tagSuggestionIndex}"]`)?.scrollIntoView({block:"nearest"});
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (!$("tag-new-suggestions").hidden && featureState.tagSuggestionIndex >= 0) features.tags.chooseExistingTag(featureState.tagSuggestionIndex);
    else features.tags.addTagDraft();
  }
}

function updateTagEditorControls() {
  const busy = Boolean(featureState.tagSaving || featureState.tagBlacklistSaving);
  $("save-tags").textContent = featureState.tagSaving ? "正在保存…" : "保存标签";
  $("tag-dialog").setAttribute("aria-busy", String(busy));
  $("save-tags").disabled = !featureState.tagEditorData || busy;
  $("close-tags").disabled = busy;
  $("cancel-tags").disabled = busy;
  $("tag-blacklist-control").hidden = !features.blacklist.canEditBlacklist();
  $("tag-blacklist").disabled = !features.blacklist.canEditBlacklist() || !featureState.tagEditorData || busy;
  $("tag-new").disabled = !featureState.tagEditorData || busy;
  $("add-tag").disabled = !featureState.tagEditorData || busy;
  if (busy || !featureState.tagEditorData) features.tags.hideTagSuggestions();
}

function syncTagBlacklistMembership(code, blacklisted, data) {
  features.blacklist.write("blacklistData", data);
  for (const row of [...(features.daily.read("dateData")?.rows || []), ...(features.daily.read("dateData")?.suspended_rows || [])]) {
    if (row.code === code) row.blacklisted = blacklisted;
  }
  for (const stock of [features.stock.read("stockData")?.stock, features.stock.read("selectedStock")]) {
    if (stock?.code === code) stock.blacklisted = blacklisted;
  }
  if (features.navigation.read("tab") === "date" && features.daily.read("dateData")) {
    const scrollLeft = $("date-table-area").querySelector(".industry-board")?.scrollLeft || 0;
    features.daily.renderDate(features.daily.read("dateData"));
    const board = $("date-table-area").querySelector(".industry-board");
    if (board) { board.scrollLeft = scrollLeft; features.daily.updateIndustryNavigation(); }
  } else if (features.navigation.read("tab") === "stock" && features.stock.read("selectedStock")?.code === code) {
    $("stock-blacklist-label").hidden = !blacklisted;
  }
}

async function changeTagBlacklist() {
  const editor = featureState.tagEditorData;
  if (!editor || !features.blacklist.canEditBlacklist() || featureState.tagSaving || featureState.tagBlacklistSaving) return;
  const previous = editor.blacklisted === true;
  const blacklisted = $("tag-blacklist").checked;
  if (blacklisted === previous) return;
  featureState.tagBlacklistSaving = true;
  $("tag-blacklist-error").hidden = true;
  $("tag-blacklist-status").textContent = "正在保存…";
  features.tags.updateTagEditorControls();
  try {
    const data = await features.api.request("/api/blacklist", "tag-blacklist-save", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code: editor.code, action: blacklisted ? "add" : "remove"})});
    if (!data) throw new Error("未能确认黑名单状态，请重新打开弹窗核实后重试。");
    editor.blacklisted = blacklisted;
    features.tags.syncTagBlacklistMembership(editor.code, blacklisted, data);
    $("tag-blacklist-status").textContent = blacklisted ? "已加入黑名单" : "已移出黑名单";
  } catch (error) {
    $("tag-blacklist").checked = previous;
    $("tag-blacklist-status").textContent = "";
    $("tag-blacklist-error").textContent = error.message;
    $("tag-blacklist-error").hidden = false;
  } finally {
    featureState.tagBlacklistSaving = false;
    features.tags.updateTagEditorControls();
  }
}

async function openTagEditor(code) {
  if (!features.tags.canEditTags() || featureState.tagSaving || featureState.tagBlacklistSaving) return;
  featureState.tagEditingCode = code;
  featureState.tagEditorData = null;
  featureState.tagDraft = [];
  featureState.tagUseSource = false;
  $("tag-stock-label").textContent = code;
  $("tag-editor-list").innerHTML = '<p class="tag-empty-hint">正在读取标签…</p>';
  $("tag-editor-error").hidden = true;
  $("tag-blacklist").checked = false;
  $("tag-blacklist-status").textContent = "";
  $("tag-blacklist-error").hidden = true;
  $("tag-new").value = "";
  features.tags.hideTagSuggestions();
  features.tags.updateTagEditorControls();
  if (!$("tag-dialog").open) $("tag-dialog").showModal();
  features.tags.loadTagSuggestionCatalog();
  try {
    const data = await features.api.request(`/api/stock-tags?${new URLSearchParams({ code })}`, "tags");
    if (!data || !$("tag-dialog").open || featureState.tagEditingCode !== code) return;
    featureState.tagEditorData = data;
    featureState.tagDraft = [...data.tags];
    $("tag-blacklist").checked = data.blacklisted === true;
    $("tag-stock-label").textContent = `${data.name} · ${data.code}`;
    features.tags.renderTagEditor();
    features.tags.updateTagEditorControls();
  } catch (error) {
    if ($("tag-dialog").open && featureState.tagEditingCode === code) { $("tag-editor-error").textContent = error.message; $("tag-editor-error").hidden = false; }
  }
}

function addTagDraft() {
  if (!featureState.tagEditorData || featureState.tagSaving || featureState.tagBlacklistSaving) return false;
  const input = $("tag-new"), entered = input.value.trim();
  const parts = entered.split("/").map(part => part.trim());
  const value = parts.map(part => featureState.tagSuggestionCatalog?.tags.find(tag => tag.name.toLocaleLowerCase() === part.toLocaleLowerCase())?.name || part).join("/");
  input.setCustomValidity("");
  if (!value) return false;
  const limit = Math.max(20, featureState.tagEditorData?.tags?.length || 0, features.tags.defaultEditorTags(featureState.tagEditorData).length + (featureState.tagEditorData?.merge_defaults ? 20 : 0));
  if (parts.some(part => !part || part.length > 30)) input.setCustomValidity("斜杠前后需填写标签名称，每级 1 至 30 个字符。");
  else if (featureState.tagDraft.length >= limit) input.setCustomValidity(`每只股票最多保留 ${limit} 个标签。`);
  else if (featureState.tagDraft.some(tag => tag.split("/").at(-1).trim().toLocaleLowerCase() === parts.at(-1).toLocaleLowerCase())) input.setCustomValidity("这个标签已存在。");
  if (!input.reportValidity()) return false;
  featureState.tagDraft.push(value);
  featureState.tagUseSource = false;
  input.value = "";
  features.tags.renderTagEditor();
  input.focus();
  return true;
}

function closeTagEditor() {
  if (featureState.tagSaving || featureState.tagBlacklistSaving) return;
  features.api.channels.tags?.abort();
  features.api.channels["tag-editor-catalog"]?.abort();
  features.tags.hideTagSuggestions();
  $("tag-dialog").close();
}

async function saveTagEditor(event) {
  event.preventDefault();
  if (!featureState.tagEditorData || featureState.tagSaving || featureState.tagBlacklistSaving) return;
  if ($("tag-new").value.trim() && !features.tags.addTagDraft()) return;
  if (!$("tag-editor-form").reportValidity()) return;
  const position = {left: window.scrollX, top: window.scrollY, behavior: "instant"};
  const scrollLeft = $("date-table-area").querySelector(".industry-board")?.scrollLeft;
  featureState.tagSaving = true;
  $("tag-editor-form").querySelectorAll("button, input").forEach(element => { element.disabled = true; });
  features.tags.updateTagEditorControls();
  try {
    const data = await features.api.request("/api/stock-tags", "tags-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: featureState.tagEditorData.code, tags: featureState.tagDraft, revision: featureState.tagEditorData.revision, use_source: featureState.tagUseSource, tag_alias_revision: featureState.tagEditorData.tag_alias_revision }) });
    if (!data) return;
    await features.tags.refreshTagOrder();
    if (features.navigation.read("tab") === "stock") await features.stock.loadStock({remember:false, quiet:true}); else await features.daily.loadDate({quiet:true});
    $("tag-dialog").close();
    const board = $("date-table-area").querySelector(".industry-board");
    if (board && scrollLeft != null) { board.scrollLeft = scrollLeft; features.daily.updateIndustryNavigation(); }
    window.scrollTo(position);
  } catch (error) { $("tag-editor-error").textContent = error.message; $("tag-editor-error").hidden = false; }
  finally {
    featureState.tagSaving = false;
    $("tag-editor-form").querySelectorAll("button, input").forEach(element => { element.disabled = false; });
    features.tags.updateTagEditorControls();
  }
}

  const bindings = {
binding016() {
features.tags.bindTagManager();
},
binding017() {
features.tags.bindTagBatch();
},
binding062() {
$("edit-stock-profile-tags").addEventListener("click", () => {
  if (features.stock.read("selectedStock")) features.tags.openTagEditor(features.stock.read("selectedStock").code);
});
},
binding069() {
$("date-table-area").addEventListener("click", event => {
  const button = event.target.closest("[data-edit-stock-tags]");
  if (button) features.tags.openTagEditor(button.dataset.editStockTags);
});
},
binding070() {
["close-tags", "cancel-tags"].forEach(id => $(id).addEventListener("click", features.tags.closeTagEditor));
},
binding071() {
$("tag-dialog").addEventListener("cancel", event => { if (featureState.tagSaving || featureState.tagBlacklistSaving) event.preventDefault(); });
},
binding072() {
$("tag-blacklist").addEventListener("change", features.tags.changeTagBlacklist);
},
binding073() {
$("tag-editor-list").addEventListener("input", event => {
  if (!event.target.matches("[data-tag-index]")) return;
  const index = Number(event.target.dataset.tagIndex), parents = featureState.tagDraft[index].split("/").slice(0, -1);
  featureState.tagDraft[index] = [...parents, event.target.value].join("/");
  featureState.tagUseSource = false;
  features.tags.updateTagEditorPaths();
});
},
binding074() {
$("tag-editor-list").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-tag]");
  if (button) { featureState.tagDraft.splice(Number(button.dataset.removeTag), 1); featureState.tagUseSource = false; features.tags.renderTagEditor(); }
});
},
binding075() {
$("tag-new").addEventListener("input", features.tags.onTagSuggestionInput);
},
binding076() {
$("tag-new").addEventListener("focus", () => { featureState.tagSuggestionsActive = true; features.tags.renderTagSuggestions(); });
},
binding077() {
$("tag-new").addEventListener("keydown", features.tags.onTagSuggestionKeydown);
},
binding078() {
$("tag-new").addEventListener("blur", event => { if (!$("tag-new-suggestions").contains(event.relatedTarget)) features.tags.hideTagSuggestions(); });
},
binding079() {
$("tag-new-suggestions").addEventListener("mousedown", event => event.preventDefault());
},
binding080() {
$("tag-new-suggestions").addEventListener("click", event => { const button = event.target.closest("[data-existing-tag-index]"); if (button) features.tags.chooseExistingTag(Number(button.dataset.existingTagIndex)); });
},
binding081() {
$("tag-dialog").addEventListener("close", () => { features.api.channels["tag-editor-catalog"]?.abort(); features.tags.hideTagSuggestions(); });
},
binding082() {
$("tag-dialog").addEventListener("scroll", features.tags.positionTagSuggestions, true);
},
binding084() {
document.addEventListener("pointerdown", event => { if (!event.target.closest(".tag-new-picker")) features.tags.hideTagSuggestions(); });
},
binding086() {
$("restore-source-tags").addEventListener("click", () => {
  if (!featureState.tagEditorData) return;
  featureState.tagDraft = features.tags.defaultEditorTags(featureState.tagEditorData);
  featureState.tagUseSource = true;
  $("tag-new").value = "";
  features.tags.renderTagEditor();
});
},
binding087() {
$("tag-editor-form").addEventListener("submit", features.tags.saveTagEditor);
}
};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, canManageTags, tagManagerError, updateTagManagerControls, renderTagManagerCatalog, hideManagerParentSuggestions, renderManagerParentSuggestions, chooseManagerParentTag, selectManagerTag, loadTagManager, hideManagerSuggestions, showManagerSuggestions, searchManagerStocks, refreshAfterTagWrite, removeManagerStock, addManagerStock, cancelManagerMerge, renameManagerTag, cancelManagerDelete, deleteManagerTag, openTagNodeDialog, saveManagerTagNode, openManagerTagBatch, bindTagManager, tagBatchError, tagBatchTokens, tagBatchStocks, updateTagBatchControls, renderTagBatchPreview, cancelTagBatchSearch, loadTagBatchCatalog, openTagBatch, closeTagBatch, resolveTagBatchInput, changeTagBatchInput, saveTagBatch, bindTagBatch, stockTags, allStockTags, tagHierarchy, tagAncestors, tagRoot, renderHierarchyStockGroups, tagRanks, compareTags, sortedTags, applyTagOrder, refreshTagOrder, canEditTags, renderTagEditor, updateTagEditorPaths, defaultEditorTags, hideTagSuggestions, matchesExistingTag, positionTagSuggestions, renderTagSuggestions, loadTagSuggestionCatalog, chooseExistingTag, onTagSuggestionInput, onTagSuggestionKeydown, updateTagEditorControls, syncTagBlacklistMembership, changeTagBlacklist, openTagEditor, addTagDraft, closeTagEditor, saveTagEditor };
}
