// notes: owns its state, rendering, requests and event registrations.
export function createFeature(environment, features) {
  const { $, document, window, localStorage, location, history, fetch, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, Option, requestAnimationFrame, cancelAnimationFrame, performance, CSS, ResizeObserver, MutationObserver, getComputedStyle, matchMedia } = environment;
  const featureState = {};
  const keys = new Set(["noteEditorData","noteSaving","noteAutoSaving","noteClosing","noteDrafts","noteUndoId","noteTooltipTimer","noteTooltipGeneration","noteTooltipAnchor","noteAutosaveTimer","noteGeneration","noteEditingCode","noteComposing","noteFlushPromise","noteWritePromise"]);
  function read(key) { if (!keys.has(key)) throw new Error('Unknown notes state: ' + key); return featureState[key]; }
  function write(key, value) { if (!keys.has(key)) throw new Error('Unknown notes state: ' + key); featureState[key] = value; return value; }

function canEditNotes() {
  return features.shell.read("meta")?.capabilities?.edit_notes !== false;
}

function renderStockNote(row) {
  const content = typeof row.note === "string" ? row.note : "";
  if (!features.notes.canEditNotes() && !content) return "";
  return `<button type="button" class="stock-note-button ${content ? "has-note" : ""}" data-edit-stock-note="${features.format.escapeHTML(row.code)}" aria-label="${features.notes.canEditNotes() ? "编辑" : "查看"}${features.format.escapeHTML(row.name)}备注"><span class="stock-note-preview">${features.format.escapeHTML(content || "点击添加备注")}</span></button>`;
}

function renderStockHeaderNote(stock, loading = false) {
  features.notes.hideStockNoteTooltip();
  const container = $("stock-profile-note");
  container.innerHTML = loading || stock.name === "尚未收录" ? "" : features.notes.renderStockNote(stock);
  container.hidden = !container.innerHTML;
  if (container.hidden) container.removeAttribute("data-note-code");
  else container.setAttribute("data-note-code", stock.code);
}

function noteLocalDate(value) {
  if (typeof value === "string") return value.slice(0, 10);
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function stockNoteFields(id = null) {
  if (id === null) return {content: $("stock-note-content"), time: $("stock-note-time"), dateButton: $("add-stock-note-date"), dateTag: $("stock-note-date-tag"), removeDate: $("remove-stock-note-date")};
  const row = $("stock-note-history").querySelector(`[data-note-id="${id}"]`);
  return row ? {content: row.querySelector("[data-note-content]"), time: row.querySelector("[data-note-time]"), dateButton: row.querySelector("[data-note-add-date]"), dateTag: row.querySelector("[data-note-date-tag]"), removeDate: row.querySelector("[data-note-remove-date]")} : null;
}

function expandStockNoteDate(id = null) {
  if (!features.notes.canEditNotes() || !featureState.noteEditorData || (featureState.noteSaving && !featureState.noteAutoSaving) || featureState.noteClosing) return;
  const fields = features.notes.stockNoteFields(id);
  if (!fields) return;
  if (!fields.time.value) fields.time.value = features.notes.noteLocalDate();
  features.notes.updateStockNoteControls();
  fields.time.focus();
  if (id !== null) features.notes.scheduleStockNoteAutosave();
}

function removeStockNoteDate(id = null) {
  if (!features.notes.canEditNotes() || !featureState.noteEditorData || (featureState.noteSaving && !featureState.noteAutoSaving) || featureState.noteClosing) return;
  const fields = features.notes.stockNoteFields(id);
  if (!fields) return;
  fields.time.value = "";
  features.notes.updateStockNoteControls();
  fields.content.focus();
  if (id !== null) features.notes.scheduleStockNoteAutosave();
}

function captureStockNoteDrafts() {
  const drafts = new Map();
  $("stock-note-history").querySelectorAll("[data-note-id]").forEach(row => {
    const id = Number(row.dataset.noteId), entry = featureState.noteEditorData?.entries?.find(item => item.id === id);
    const content = row.querySelector("[data-note-content]").value, time = row.querySelector("[data-note-time]").value;
    if (entry && (content !== entry.content || time !== (entry.note_date ?? features.notes.noteLocalDate(entry.occurred_at)))) drafts.set(id, {content, time});
  });
  featureState.noteDrafts = drafts;
}

function resizeStockNoteContents() {
  if (!$("stock-note-dialog").open) return;
  const fields = [$("stock-note-content"), ...$("stock-note-history").querySelectorAll("[data-note-content]")];
  fields.forEach(input => {
    input.style.height = "36px";
    input.style.height = `${Math.max(36, (input.scrollHeight || 0) + 2)}px`;
  });
}

function renderStockNoteHistory() {
  const entries = featureState.noteEditorData?.entries || [];
  $("stock-note-history").innerHTML = entries.length ? entries.map((entry, index) => {
    const draft = featureState.noteDrafts?.get(entry.id) || {content: entry.content, time: entry.note_date ?? features.notes.noteLocalDate(entry.occurred_at)};
    return `<div class="stock-note-node" data-note-id="${entry.id}"><div class="stock-note-node-body"><div class="stock-note-input"><button type="button" class="icon-button stock-note-date-button" data-note-add-date="${entry.id}" aria-label="为第 ${index + 1} 条备注设置日期" title="设置日期" aria-controls="stock-note-date-tag-${entry.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 11h16m-8 3v4m-2-2h4"/></svg></button><span class="stock-note-date-tag" id="stock-note-date-tag-${entry.id}" data-note-date-tag hidden><input id="stock-note-date-${entry.id}" type="date" data-note-time value="${features.format.escapeHTML(draft.time)}" aria-label="第 ${index + 1} 条备注日期（可选）"><button type="button" class="stock-note-date-remove" data-note-remove-date="${entry.id}" aria-label="移除第 ${index + 1} 条备注日期" title="移除日期"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></span><textarea data-note-content maxlength="5000" rows="1" aria-label="第 ${index + 1} 条备注内容" placeholder="空备注">${features.format.escapeHTML(draft.content)}</textarea></div><div class="stock-note-node-actions"><button type="button" class="button secondary small stock-note-delete" data-delete-note="${entry.id}" aria-label="删除第 ${index + 1} 条备注">删除</button></div></div></div>`;
  }).join("") : "";
  entries.forEach(entry => { features.notes.stockNoteFields(entry.id).content.value = featureState.noteDrafts?.get(entry.id)?.content ?? entry.content; });
}

function updateStockNoteControls() {
  const busy = Boolean(featureState.noteSaving), lockInputs = Boolean((busy && !featureState.noteAutoSaving) || featureState.noteClosing), ready = Boolean(featureState.noteEditorData), editable = features.notes.canEditNotes();
  features.notes.captureStockNoteDrafts();
  $("stock-note-form").hidden = !editable;
  $("stock-note-content").disabled = lockInputs || !ready;
  $("stock-note-content").readOnly = !editable;
  $("stock-note-time").disabled = lockInputs || !ready;
  $("stock-note-time").readOnly = !editable;
  for (const id of [null, ...(featureState.noteEditorData?.entries || []).map(entry => entry.id)]) {
    const fields = features.notes.stockNoteFields(id);
    const dated = Boolean(fields.time.value);
    fields.dateTag.hidden = !dated;
    fields.dateButton.hidden = !editable || dated;
    fields.dateButton.disabled = lockInputs || !ready;
    fields.dateButton.setAttribute("aria-expanded", String(dated));
    fields.removeDate.hidden = !editable;
    fields.removeDate.disabled = lockInputs || !ready;
  }
  $("save-stock-note").disabled = busy || featureState.noteClosing || !ready || !editable || !$("stock-note-content").value.trim();
  $("save-stock-note").hidden = !editable;
  $("stock-note-history").querySelectorAll("[data-note-id]").forEach(row => {
    row.querySelectorAll("input,textarea").forEach(input => { input.disabled = lockInputs || !ready; input.readOnly = !editable; });
    const remove = row.querySelector("[data-delete-note]");
    remove.hidden = !editable;
    remove.disabled = busy || featureState.noteClosing || !ready || !editable;
  });
  $("undo-stock-note").hidden = !editable || !featureState.noteUndoId;
  $("undo-stock-note").disabled = busy || featureState.noteClosing || !ready;
  ["close-stock-note", "cancel-stock-note"].forEach(id => { $(id).disabled = Boolean(featureState.noteClosing); });
  $("retry-stock-note").disabled = busy || featureState.noteClosing;
  $("cancel-stock-note").textContent = editable ? (featureState.noteClosing ? "保存中…" : "保存") : "关闭";
  $("stock-note-count").textContent = `${$("stock-note-content").value.length} / 5000`;
  features.notes.resizeStockNoteContents();
}

function hideStockNoteTooltip() {
  clearTimeout(featureState.noteTooltipTimer);
  featureState.noteTooltipGeneration = (featureState.noteTooltipGeneration || 0) + 1;
  features.api.channels?.["stock-note-tooltip"]?.abort();
  featureState.noteTooltipAnchor?.removeAttribute("aria-describedby");
  featureState.noteTooltipAnchor = null;
  $("stock-note-tooltip").hidden = true;
}

function scheduleStockNoteTooltipHide() {
  clearTimeout(featureState.noteTooltipTimer);
  featureState.noteTooltipTimer = setTimeout(features.notes.hideStockNoteTooltip, 150);
}

function renderStockNoteTooltip(entries) {
  return '<div role="list">' + entries.map(entry => {
    const day = entry.note_date ?? String(entry.occurred_at || "").slice(0, 10);
    return `<div class="stock-note-tooltip-entry" role="listitem">${day ? `<time datetime="${features.format.escapeHTML(day)}">${features.format.escapeHTML(day)}</time>` : ""}<div class="stock-note-tooltip-content">${features.format.escapeHTML(entry.content || "（空备注）")}</div></div>`;
  }).join("") + '</div>';
}

function positionStockNoteTooltip(button) {
  const tooltip = $("stock-note-tooltip");
  const anchor = button.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 20, above = anchor.top - 20;
  tooltip.style.maxHeight = `${Math.min(360, Math.max(80, above, below))}px`;
  const bounds = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
  const top = below >= bounds.height ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
  tooltip.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
}

async function showStockNoteTooltip(button) {
  clearTimeout(featureState.noteTooltipTimer);
  const code = button.dataset?.editStockNote;
  if (!/^[0-9]{6}$/.test(code || "") || featureState.noteTooltipAnchor === button) return;
  features.notes.hideStockNoteTooltip();
  const generation = featureState.noteTooltipGeneration;
  const tooltip = $("stock-note-tooltip");
  featureState.noteTooltipAnchor = button;
  button.setAttribute("aria-describedby", "stock-note-tooltip");
  tooltip.innerHTML = '<p class="stock-note-tooltip-message">正在读取全部备注…</p>';
  tooltip.scrollTop = 0;
  tooltip.hidden = !button.classList.contains("has-note");
  if (!tooltip.hidden) features.notes.positionStockNoteTooltip(button);
  try {
    const data = await features.api.request(`/api/stock-note?${new URLSearchParams({code})}`, "stock-note-tooltip");
    if (!data || featureState.noteTooltipGeneration !== generation || featureState.noteTooltipAnchor !== button || button.isConnected === false) return;
    if (!data.entries?.length) { features.notes.hideStockNoteTooltip(); return; }
    tooltip.innerHTML = features.notes.renderStockNoteTooltip(data.entries);
    tooltip.hidden = false;
    features.notes.positionStockNoteTooltip(button);
  } catch {
    if (featureState.noteTooltipGeneration !== generation || featureState.noteTooltipAnchor !== button || button.isConnected === false) return;
    tooltip.innerHTML = '<p class="stock-note-tooltip-message">历史备注暂时无法读取，请点击备注后重试。</p>';
    tooltip.hidden = false;
    features.notes.positionStockNoteTooltip(button);
  }
}

async function openStockNoteEditor(code) {
  if (featureState.noteSaving || featureState.noteClosing || (featureState.noteEditorData && $("stock-note-dialog").open)) return;
  clearTimeout(featureState.noteAutosaveTimer);
  features.notes.hideStockNoteTooltip();
  const generation = (featureState.noteGeneration || 0) + 1;
  featureState.noteGeneration = generation;
  featureState.noteEditingCode = code;
  featureState.noteEditorData = null;
  featureState.noteDrafts = new Map();
  featureState.noteUndoId = null;
  featureState.noteComposing = false;
  $("stock-note-title").textContent = features.notes.canEditNotes() ? "编辑股票备注" : "查看股票备注";
  $("stock-note-label").textContent = code;
  $("stock-note-content").value = "";
  $("stock-note-time").value = "";
  $("stock-note-history").innerHTML = "";
  $("stock-note-feedback").textContent = "正在读取备注…";
  $("stock-note-error").hidden = true;
  $("retry-stock-note").hidden = true;
  features.notes.updateStockNoteControls();
  if (!$("stock-note-dialog").open) $("stock-note-dialog").showModal();
  try {
    const data = await features.api.request(`/api/stock-note?${new URLSearchParams({code})}`, "stock-note");
    if (!data || featureState.noteGeneration !== generation || !$("stock-note-dialog").open) return;
    featureState.noteEditorData = data;
    $("stock-note-label").textContent = `${data.name} · ${data.code}`;
    features.notes.renderStockNoteHistory();
    $("stock-note-feedback").textContent = features.notes.canEditNotes() ? "" : "当前为只读模式。";
    features.notes.updateStockNoteControls();
    if (features.notes.canEditNotes()) $("stock-note-content").focus();
  } catch (error) {
    if (featureState.noteGeneration !== generation || !$("stock-note-dialog").open) return;
    $("stock-note-feedback").textContent = "";
    $("stock-note-error").textContent = error.message;
    $("stock-note-error").hidden = false;
    $("retry-stock-note").hidden = false;
  }
}

function closeStockNoteEditor() {
  if (featureState.noteSaving) return;
  clearTimeout(featureState.noteAutosaveTimer);
  featureState.noteGeneration = (featureState.noteGeneration || 0) + 1;
  features.api.channels["stock-note"]?.abort();
  featureState.noteEditorData = null;
  featureState.noteDrafts = new Map();
  featureState.noteUndoId = null;
  $("stock-note-dialog").close();
}

function applyStockNoteEditorUpdate(data, entryId, keepInputs = false) {
  const scrollTop = $("stock-note-history").scrollTop;
  for (const row of [...(features.daily.read("dateData")?.rows || []), ...(features.daily.read("dateData")?.suspended_rows || []), ...(features.intraday.read("intradayData")?.rows || []), features.intraday.read("minuteDetail")?.stock, features.stock.read("stockData")?.stock, features.stock.read("selectedStock")]) {
    if (row?.code === data.code) row.note = data.content;
  }
  document.querySelectorAll(`[data-note-code="${data.code}"]`).forEach(element => {
    element.innerHTML = features.notes.renderStockNote({code: data.code, name: data.name, note: data.content});
  });
  featureState.noteEditorData = data;
  if (keepInputs) features.notes.captureStockNoteDrafts();
  else { featureState.noteDrafts.delete(entryId); features.notes.renderStockNoteHistory(); }
  $("stock-note-history").scrollTop = entryId === null ? 0 : scrollTop;
}

function scheduleStockNoteAutosave(event) {
  clearTimeout(featureState.noteAutosaveTimer);
  features.notes.updateStockNoteControls();
  if (!features.notes.canEditNotes() || !featureState.noteEditorData || !$("stock-note-dialog").open || featureState.noteClosing || featureState.noteComposing || event?.isComposing || !featureState.noteDrafts.size) return;
  $("stock-note-feedback").textContent = "有修改待保存…";
  featureState.noteAutosaveTimer = setTimeout(features.notes.flushStockNoteDrafts, 500);
}

function flushStockNoteDrafts() {
  clearTimeout(featureState.noteAutosaveTimer);
  if (featureState.noteFlushPromise) return featureState.noteFlushPromise;
  const generation = featureState.noteGeneration;
  const run = async () => {
    if (featureState.noteSaving && !(await featureState.noteWritePromise)) return false;
    if (!features.notes.canEditNotes() || !featureState.noteEditorData || !$("stock-note-dialog").open || featureState.noteComposing || generation !== featureState.noteGeneration) return false;
    features.notes.captureStockNoteDrafts();
    while (featureState.noteDrafts.size) {
      const id = featureState.noteDrafts.keys().next().value;
      if (!(await features.notes.saveStockNoteEditor({preventDefault() {}}, id, true))) return false;
      if (generation !== featureState.noteGeneration || !$("stock-note-dialog").open || featureState.noteComposing) return false;
      features.notes.captureStockNoteDrafts();
    }
    return true;
  };
  const promise = run();
  featureState.noteFlushPromise = promise;
  promise.finally(() => { if (featureState.noteFlushPromise === promise) featureState.noteFlushPromise = null; });
  return promise;
}

async function finishStockNoteEditor() {
  if (featureState.noteClosing) return;
  if (!features.notes.canEditNotes() || !featureState.noteEditorData) { features.notes.closeStockNoteEditor(); return; }
  features.notes.captureStockNoteDrafts();
  for (const id of [...featureState.noteDrafts.keys(), ...($("stock-note-content").value.trim() ? [null] : [])]) {
    const fields = features.notes.stockNoteFields(id);
    if (!fields.time.reportValidity() || !fields.content.reportValidity()) return;
  }
  featureState.noteClosing = true;
  features.notes.updateStockNoteControls();
  try {
    if (!(await features.notes.flushStockNoteDrafts())) return;
    if ($("stock-note-content").value.trim() && !(await features.notes.saveStockNoteEditor({preventDefault() {}}, null))) return;
    features.notes.closeStockNoteEditor();
  } finally {
    featureState.noteClosing = false;
    if ($("stock-note-dialog").open) features.notes.updateStockNoteControls();
  }
}

function saveStockNoteEditor(event, entryId = null, autosave = false) {
  if (featureState.noteSaving) { event.preventDefault(); return Promise.resolve(false); }
  clearTimeout(featureState.noteAutosaveTimer);
  return featureState.noteWritePromise = features.notes.persistStockNoteEditor(event, entryId, autosave);
}

async function persistStockNoteEditor(event, entryId, autosave) {
  event.preventDefault();
  if (!features.notes.canEditNotes() || !featureState.noteEditorData || !$("stock-note-dialog").open) return false;
  const fields = features.notes.stockNoteFields(entryId);
  if (!fields || !fields.time.reportValidity() || !fields.content.reportValidity()) return false;
  if (entryId === null && !fields.content.value.trim()) return false;
  features.notes.captureStockNoteDrafts();
  if (entryId !== null && !featureState.noteDrafts.has(entryId)) return true;
  const content = fields.content.value, note_date = fields.time.value;
  featureState.noteSaving = true;
  featureState.noteAutoSaving = autosave;
  $("stock-note-error").hidden = true;
  $("stock-note-feedback").textContent = "正在保存…";
  features.notes.updateStockNoteControls();
  try {
    const data = await features.api.request("/api/stock-note", "stock-note-save", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code: featureState.noteEditorData.code, content, revision: featureState.noteEditorData.revision,
        entry_id: entryId, note_date, new_entry: entryId === null})});
    if (!data) throw new Error("备注未确认保存，请重试。");
    features.notes.applyStockNoteEditorUpdate(data, entryId, entryId !== null);
    if (entryId === null) {
      $("stock-note-content").value = "";
      $("stock-note-time").value = "";
    }
    $("stock-note-feedback").textContent = entryId === null ? "已添加备注，可继续输入。" : "该条备注已保存。";
    return true;
  } catch (error) {
    $("stock-note-feedback").textContent = "未能保存，输入内容已保留。可点击底部保存重试。";
    $("stock-note-error").textContent = error.message;
    $("stock-note-error").hidden = false;
    return false;
  } finally {
    featureState.noteSaving = false;
    featureState.noteAutoSaving = false;
    features.notes.updateStockNoteControls();
    if (!autosave && !featureState.noteClosing && $("stock-note-error").hidden) features.notes.stockNoteFields(entryId)?.content.focus();
    if (!autosave && $("stock-note-error").hidden && featureState.noteDrafts.size) features.notes.scheduleStockNoteAutosave();
  }
}

function changeStockNoteEntryEditor(event, entryId, action) {
  if (featureState.noteSaving || featureState.noteClosing) { event.preventDefault(); return Promise.resolve(false); }
  clearTimeout(featureState.noteAutosaveTimer);
  return featureState.noteWritePromise = features.notes.persistStockNoteEntryChange(event, entryId, action);
}

async function persistStockNoteEntryChange(event, entryId, action) {
  event.preventDefault();
  if (!features.notes.canEditNotes() || !featureState.noteEditorData || featureState.noteSaving) return;
  features.notes.captureStockNoteDrafts();
  featureState.noteSaving = true;
  $("stock-note-error").hidden = true;
  features.notes.updateStockNoteControls();
  try {
    const data = await features.api.request("/api/stock-note", "stock-note-save", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({code:featureState.noteEditorData.code,revision:featureState.noteEditorData.revision,entry_id:entryId,action})});
    if (!data) throw new Error("备注操作未确认完成，请重试。");
    features.notes.applyStockNoteEditorUpdate(data, entryId);
    featureState.noteUndoId = action === "delete" ? entryId : null;
    $("stock-note-feedback").textContent = action === "delete" ? "已删除该条备注，可撤销删除。" : "已恢复该条备注。";
    return true;
  } catch (error) {
    $("stock-note-error").textContent = error.message;
    $("stock-note-error").hidden = false;
    return false;
  } finally {
    featureState.noteSaving = false;
    features.notes.updateStockNoteControls();
    if ($("stock-note-error").hidden && featureState.noteDrafts.size) features.notes.scheduleStockNoteAutosave();
  }
}

function stockNoteKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229 || !event.target.matches("textarea")) return;
  const row = event.target.closest("[data-note-id]");
  return features.notes.saveStockNoteEditor(event, row ? Number(row.dataset.noteId) : null);
}

  const bindings = {
binding088() {
["close-stock-note", "cancel-stock-note"].forEach(id => $(id).addEventListener("click", features.notes.finishStockNoteEditor));
},
binding089() {
$("retry-stock-note").addEventListener("click", () => features.notes.openStockNoteEditor(featureState.noteEditingCode));
},
binding090() {
$("stock-note-content").addEventListener("input", features.notes.updateStockNoteControls);
},
binding091() {
$("stock-note-time").addEventListener("input", features.notes.updateStockNoteControls);
},
binding092() {
$("add-stock-note-date").addEventListener("click", () => features.notes.expandStockNoteDate());
},
binding093() {
$("remove-stock-note-date").addEventListener("click", () => features.notes.removeStockNoteDate());
},
binding094() {
$("stock-note-dialog").addEventListener("keydown", features.notes.stockNoteKeydown);
},
binding095() {
$("stock-note-history").addEventListener("input", features.notes.scheduleStockNoteAutosave);
},
binding096() {
$("stock-note-history").addEventListener("change", features.notes.scheduleStockNoteAutosave);
},
binding097() {
$("stock-note-dialog").addEventListener("compositionstart", () => { featureState.noteComposing = true; clearTimeout(featureState.noteAutosaveTimer); });
},
binding098() {
$("stock-note-dialog").addEventListener("compositionend", event => {
  featureState.noteComposing = false;
  if (event.target.closest("[data-note-id]")) features.notes.scheduleStockNoteAutosave();
});
},
binding099() {
$("stock-note-history").addEventListener("click", event => {
  const date = event.target.closest("[data-note-add-date]");
  if (date) features.notes.expandStockNoteDate(Number(date.dataset.noteAddDate));
  const removeDate = event.target.closest("[data-note-remove-date]");
  if (removeDate) features.notes.removeStockNoteDate(Number(removeDate.dataset.noteRemoveDate));
  const remove = event.target.closest("[data-delete-note]");
  if (remove) features.notes.changeStockNoteEntryEditor(event, Number(remove.dataset.deleteNote), "delete");
});
},
binding100() {
$("undo-stock-note").addEventListener("click", event => { if (featureState.noteUndoId) features.notes.changeStockNoteEntryEditor(event, featureState.noteUndoId, "restore"); });
},
binding102() {
for (const name of ["pointerenter", "focusin"]) $("stock-note-tooltip").addEventListener(name, () => clearTimeout(featureState.noteTooltipTimer));
},
binding103() {
for (const name of ["pointerleave", "focusout"]) $("stock-note-tooltip").addEventListener(name, features.notes.scheduleStockNoteTooltipHide);
},
binding104() {
document.addEventListener("scroll", event => { if (!$("stock-note-tooltip").contains(event.target)) features.notes.hideStockNoteTooltip(); }, true);
},
binding108() {
$("stock-note-form").addEventListener("submit", features.notes.saveStockNoteEditor);
},
binding109() {
$("stock-note-dialog").addEventListener("cancel", event => { event.preventDefault(); features.notes.finishStockNoteEditor(); });
},
binding110() {
$("stock-note-dialog").addEventListener("click", event => {
  if (event.target !== $("stock-note-dialog")) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) features.notes.finishStockNoteEditor();
});
}
};
  return { read, write, bindings, bindEvents() { Object.values(bindings).forEach(bind => bind()); }, canEditNotes, renderStockNote, renderStockHeaderNote, noteLocalDate, stockNoteFields, expandStockNoteDate, removeStockNoteDate, captureStockNoteDrafts, resizeStockNoteContents, renderStockNoteHistory, updateStockNoteControls, hideStockNoteTooltip, scheduleStockNoteTooltipHide, renderStockNoteTooltip, positionStockNoteTooltip, showStockNoteTooltip, openStockNoteEditor, closeStockNoteEditor, applyStockNoteEditorUpdate, scheduleStockNoteAutosave, flushStockNoteDrafts, finishStockNoteEditor, saveStockNoteEditor, persistStockNoteEditor, changeStockNoteEntryEditor, persistStockNoteEntryChange, stockNoteKeydown };
}
