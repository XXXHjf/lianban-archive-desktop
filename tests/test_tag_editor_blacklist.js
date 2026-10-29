const { install } = require('./frontend-harness.cjs');
// Exercise the real dialog workflow without changing the user's database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const elements = new Map();
const calls = [];
let stored = false, pending = null, fail = false, dateRenders = 0;
const board = {scrollLeft: 340};
const element = id => {
  if (!elements.has(id)) elements.set(id, {value: "", disabled: false, checked: false, hidden: false,
    setAttribute(name,value) {this[name]=value;}, removeAttribute(name) {delete this[name];},
    querySelector: () => board, querySelectorAll: () => [], reportValidity: () => true,
    showModal() { this.open = true; }, close() { this.open = false; }});
  return elements.get(id);
};
const context = vm.createContext({
  URLSearchParams, $: element, state: {tab: "date", requests: {}, meta: {capabilities: {edit_tags: true, edit_blacklist: true}},
    dateData: {rows: [{code:"600668",blacklisted:false},{code:"600802",blacklisted:false}],
      suspended_rows: [{code:"600668",blacklisted:false}]},
    stockData: {stock: {code:"600668",blacklisted:false}}, selectedStock: {code:"600668",blacklisted:false}},
  renderDate: () => { dateRenders++; board.scrollLeft = 0; }, updateIndustryNavigation() {},
  request: async (url, channel, options) => {
    calls.push({url, body: options ? JSON.parse(options.body) : null});
    if (pending) await pending;
    if (fail) throw new Error("测试保存失败");
    if (url === "/api/tags") return {tags:[{name:"水泥",count:10}],revision:"catalog"};
    if (!options) return {code:"600668", name:"尖峰集团", tags:["水泥"],revision:2,blacklisted:stored};
    stored = JSON.parse(options.body).action === "add";
    return {rows:stored ? [{code:"600668"}] : [],total:stored ? 1 : 0};
  }, loadStock() {}, loadDate() {}
});

install(context, ["escapeHTML"], []);
install(context, ["canEditBlacklist"], []);
install(context, ["stockTags","allStockTags","tagHierarchy","tagAncestors","tagRoot","renderHierarchyStockGroups","tagRanks","compareTags","sortedTags","applyTagOrder","refreshTagOrder"], []);
install(context, ["canEditTags","canEditNotes","renderStockNote","renderStockHeaderNote","regionLabel","nameInitials","codeDigits","orderMatchingGroups","orderPinyinGroups","orderCodeGroups","renderStockCard","renderSuspensionNote","renderSuspendedLeaders","industryTagBoardCounts","industryGroupRank","industryColumnHeading","mergeIdenticalFirstBoardGroups","renderIndustryColumns"], []);
install(context, ["renderTagEditor","updateTagEditorPaths","defaultEditorTags","hideTagSuggestions","matchesExistingTag","positionTagSuggestions","renderTagSuggestions","loadTagSuggestionCatalog","chooseExistingTag","onTagSuggestionInput","onTagSuggestionKeydown","updateTagEditorControls","syncTagBlacklistMembership","changeTagBlacklist","openTagEditor","addTagDraft","closeTagEditor","saveTagEditor","noteLocalDate","stockNoteFields","expandStockNoteDate","removeStockNoteDate","captureStockNoteDrafts","resizeStockNoteContents","renderStockNoteHistory","updateStockNoteControls","hideStockNoteTooltip","scheduleStockNoteTooltipHide","renderStockNoteTooltip","positionStockNoteTooltip","showStockNoteTooltip","openStockNoteEditor","closeStockNoteEditor","applyStockNoteEditorUpdate","scheduleStockNoteAutosave","flushStockNoteDrafts","finishStockNoteEditor","saveStockNoteEditor","persistStockNoteEditor","changeStockNoteEntryEditor","persistStockNoteEntryChange","stockNoteKeydown"], []);
(async () => {
  await context.openTagEditor("600668");
  assert.equal(element("tag-blacklist").checked, false);
  assert.equal(element("tag-blacklist").disabled, false);
  context.state.tagDraft = ["未保存的标签"];
  element("tag-blacklist").checked = true;
  let finish;
  pending = new Promise(resolve => { finish = resolve; });
  const save = context.changeTagBlacklist();
  assert.equal(element("tag-blacklist").disabled, true);
  assert.equal(element("save-tags").disabled, true);
  context.closeTagEditor();
  assert.equal(element("tag-dialog").open, true, "closing is blocked during persistence");
  await context.changeTagBlacklist();
  await context.saveTagEditor({preventDefault(){}});
  assert.equal(calls.filter(call => call.body).length, 1, "no duplicate or tag write while blacklist is saving");
  finish(); await save; pending = null;
  assert.equal(stored, true);
  assert.deepEqual(calls.at(-1), {url:"/api/blacklist",body:{code:"600668",action:"add"}});
  assert.equal(context.state.dateData.rows[0].blacklisted, true);
  assert.equal(context.state.dateData.rows[1].blacklisted, false);
  assert.equal(context.state.dateData.suspended_rows[0].blacklisted, true);
  assert.equal(context.state.stockData.stock.blacklisted, true);
  assert.equal(dateRenders, 1);
  assert.equal(board.scrollLeft, 340, "matrix scroll stays in place");
  assert.deepEqual(context.state.tagDraft, ["未保存的标签"], "checkbox does not save or overwrite tag drafts");
  context.closeTagEditor();
  await context.openTagEditor("600668");
  assert.equal(element("tag-blacklist").checked, true, "reopening reads persistent membership");
  context.state.tab = "stock";
  element("tag-blacklist").checked = false;
  await context.changeTagBlacklist();
  assert.equal(stored, false);
  assert.equal(element("stock-blacklist-label").hidden, true, "individual header updates immediately");
  assert.equal(context.state.selectedStock.blacklisted, false);
  element("tag-blacklist").checked = true; fail = true;
  await context.changeTagBlacklist(); fail = false;
  assert.equal(element("tag-blacklist").checked, false, "failed requests restore the last confirmed checkbox state");
  assert.equal(element("tag-blacklist-error").hidden, false);
  assert.equal(element("tag-blacklist").disabled, false);
  assert.equal(element("save-tags").disabled, false);
  const count = calls.length;
  context.state.meta.capabilities.edit_blacklist = false;
  context.updateTagEditorControls();
  await context.changeTagBlacklist();
  assert.equal(calls.length, count, "read-only capability blocks writes");
  assert.equal(element("tag-blacklist-control").hidden, true);
  context.state.meta.capabilities.edit_blacklist = true;
  context.state.tagEditorData = null;
  context.updateTagEditorControls();
  assert.equal(element("tag-blacklist").disabled, true, "membership cannot change before loading finishes");
  console.log("Tag editor blacklist add/remove, persistence, draft independence, live flags, and error/busy guards: passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
