const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const elements = new Map(), requests = [], cards = [{innerHTML: ""}, {innerHTML: ""}];
function element(id) {
  if (!elements.has(id)) elements.set(id, {value: "", textContent: "", innerHTML: "", hidden: false, disabled: false,
    style: {}, getBoundingClientRect() {return {width: 380, height: 200};},
    setAttribute(name, value) {this[name] = value;}, removeAttribute(name) {delete this[name];},
    open: false, focus() {}, showModal() {this.open = true;}, close() {this.open = false;}, reportValidity() {return true;}});
  return elements.get(id);
}
const context = vm.createContext({$: element, state: {meta: {capabilities: {}}, requests: {}, dateData: {rows: [{code: "601811"}]}},
  URLSearchParams, setTimeout, clearTimeout, window: {innerWidth: 1236, innerHeight: 1044}, document: {querySelectorAll(selector) {
    const profile = element("stock-profile-note");
    return [...cards, ...(selector === `[data-note-code="${profile["data-note-code"]}"]` ? [profile] : [])];
  }},
  request: (route, channel, options) => new Promise((resolve, reject) => requests.push({route, options, resolve, reject}))});
vm.runInContext(source.slice(source.indexOf("function escapeHTML"), source.indexOf("function textValue")), context);
vm.runInContext(source.slice(source.indexOf("function canEditNotes"), source.indexOf("function regionLabel")), context);
vm.runInContext(source.slice(source.indexOf("function updateStockNoteControls"), source.indexOf("function renderTable")), context);
const note = (code = "601811", content = "", revision = 0) => ({code, name: "样本股票", content, revision});
const submit = {preventDefault() {}};
const tooltipContent = "完整备注 <script>plain text</script>\n" + "长内容".repeat(1000);
const attributes = {};
const tooltipAnchor = {classList: {contains: name => name === "has-note"},
  querySelector: () => ({textContent: tooltipContent}),
  getBoundingClientRect: () => ({left: 1140, top: 980, bottom: 1005}),
  setAttribute(name, value) {attributes[name] = value;}, removeAttribute(name) {delete attributes[name];}};
context.showStockNoteTooltip(tooltipAnchor);
assert.equal(element("stock-note-tooltip").textContent, tooltipContent, "tooltip retains all text and line breaks");
assert.equal(element("stock-note-tooltip").hidden, false);
assert.ok(parseFloat(element("stock-note-tooltip").style.left) + 380 <= 1236 - 12, "right-edge tooltip stays in viewport");
assert.ok(parseFloat(element("stock-note-tooltip").style.top) + 200 < 980, "bottom-edge tooltip opens above the note");
assert.equal(attributes["aria-describedby"], "stock-note-tooltip");
context.scheduleStockNoteTooltipHide();
context.hideStockNoteTooltip();
assert.equal(element("stock-note-tooltip").hidden, true);
assert.equal(attributes["aria-describedby"], undefined);
assert.ok(context.renderStockNote({code: "601811", name: "股票", note: "内容"}).includes("has-note"));
assert.ok(!context.renderStockNote({code: "601811", name: "股票", note: "内容"}).includes("stock-note-label"));
assert.ok(!context.renderStockNote({code: "601811", name: "股票", note: ""}).includes("stock-note-label"));
const profileStock = {code: "601811", name: "样本股票", note: "已有备注 <纯文本>\n下一行"};
context.renderStockHeaderNote(profileStock);
assert.equal(element("stock-profile-note").hidden, false);
assert.equal(element("stock-profile-note")["data-note-code"], "601811");
assert.ok(element("stock-profile-note").innerHTML.includes("已有备注 &lt;纯文本&gt;\n下一行"));
context.renderStockHeaderNote({code: "000001", name: "其他股票"}, true);
assert.equal(element("stock-profile-note").innerHTML, "", "switching stocks clears the old note while loading");
assert.equal(element("stock-profile-note")["data-note-code"], undefined, "a pending header cannot receive another stock's save");
context.renderStockHeaderNote({code: "000001", name: "其他股票"});
assert.ok(element("stock-profile-note").innerHTML.includes("点击添加备注"));
context.renderStockHeaderNote({code: "000001", name: "尚未收录"});
assert.equal(element("stock-profile-note").hidden, true);
context.renderStockHeaderNote(profileStock);
context.state.stockData = {stock: {...profileStock}};
context.state.selectedStock = {...profileStock};
(async () => {
  const first = context.openStockNoteEditor("601811");
  assert.equal(element("save-stock-note").disabled, true);
  requests[0].resolve(note()); await first;
  const draft = "第一行\n<script>plain text</script>";
  element("stock-note-content").value = draft;
  const save = context.saveStockNoteEditor(submit);
  context.closeStockNoteEditor();
  assert.equal(element("stock-note-dialog").open, true, "saving cannot be closed accidentally");
  assert.equal(JSON.parse(requests[1].options.body).content, draft);
  requests[1].resolve(note("601811", draft, 1)); await save;
  assert.equal(element("stock-note-dialog").open, false);
  assert.equal(context.state.dateData.rows[0].note, draft);
  assert.equal(context.state.stockData.stock.note, draft, "detail cache receives saved notes");
  assert.equal(context.state.selectedStock.note, draft, "current stock receives saved notes");
  assert.equal(cards[0].innerHTML, cards[1].innerHTML, "all duplicate cards update together");
  assert.equal(element("stock-profile-note").innerHTML, cards[0].innerHTML, "header and repeated cards update together");
  context.renderStockHeaderNote(context.state.stockData.stock);
  assert.equal(element("stock-profile-note").innerHTML, cards[0].innerHTML, "rerendering does not restore an obsolete note");
  assert.ok(cards[0].innerHTML.includes("&lt;script&gt;"));
  assert.ok(!cards[0].innerHTML.includes("<script>"));
  const failure = context.openStockNoteEditor("601811"); requests[2].reject(new Error("读取失败")); await failure;
  assert.equal(element("retry-stock-note").hidden, false);
  assert.equal(element("save-stock-note").disabled, true);
  const retry = context.openStockNoteEditor("601811"); requests[3].resolve(note("601811", draft, 1)); await retry;
  element("stock-note-content").value = "冲突后保留的草稿";
  const conflict = context.saveStockNoteEditor(submit); requests[4].reject(new Error("版本冲突")); await conflict;
  assert.equal(element("stock-note-content").value, "冲突后保留的草稿");
  assert.equal(element("stock-note-dialog").open, true);
  context.closeStockNoteEditor();
  assert.equal(requests.length, 5, "cancel never submits");
  const old = context.openStockNoteEditor("000001"), latest = context.openStockNoteEditor("000002");
  requests[6].resolve(note("000002", "新窗口")); await latest;
  requests[5].resolve(note("000001", "旧响应")); await old;
  assert.equal(context.state.noteEditorData.code, "000002");
  context.closeStockNoteEditor();
  context.state.meta.capabilities.edit_notes = false;
  assert.equal(context.renderStockNote({code: "601811", name: "股票", note: ""}), "");
  context.renderStockHeaderNote({code: "000001", name: "其他股票"});
  assert.equal(element("stock-profile-note").hidden, true, "empty notes stay hidden for public read-only viewers");
  context.renderStockHeaderNote(context.state.selectedStock);
  assert.ok(element("stock-profile-note").innerHTML.includes('aria-label="查看样本股票备注"'));
  const readOnly = context.openStockNoteEditor("601811"); requests[7].resolve(note("601811", draft)); await readOnly;
  assert.equal(element("stock-note-content").readOnly, true);
  assert.equal(element("save-stock-note").hidden, true);
  await context.saveStockNoteEditor(submit); assert.equal(requests.length, 8);
  context.closeStockNoteEditor();
  context.state.meta.capabilities.edit_notes = true;
  const closed = context.openStockNoteEditor("601811"); context.closeStockNoteEditor();
  requests[8].resolve(note("601811", "关闭后的旧响应")); await closed;
  assert.equal(context.state.noteEditorData, null);
  console.log("Stock notes: highlighted/empty states, full-text tooltip bounds, repeated cards, escaping, saves, conflicts and read-only controls passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
