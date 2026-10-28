// Exercise the actual manager loaders and mutation handlers, with an isolated UI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../web/app.js"), "utf8");
const elements = new Map(), calls = [];
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value:"", textContent:"", innerHTML:"", hidden:false, disabled:false, open:false,
    classList:{toggle() {}},
    setAttribute(name, value) { this[name] = value; },
    querySelectorAll() { return []; }, addEventListener() {},
    showModal() { this.open = true; }, close() { this.open = false; }
  });
  return elements.get(id);
}
let catalog = {tags:[{name:"人形机器人",count:2},{name:"机器人",count:3},{name:'<特殊"标签>',count:1}], total:3, stocks:4, revision:"v1"};
let pendingRename = null;
const context = vm.createContext({
  URLSearchParams, $:element, state:{tab:"date",requests:{},meta:{capabilities:{manage_tags:true}}},
  canEditTags:() => true, setView(view) { context.state.tab = view; },
  updateURL() {}, emptyHTML:(title, description) => `${title} ${description}`, loadingHTML:() => "loading",
  regionLabel:stock => stock.registered_province || "—", marketValue:value => value || "—",
  debounce:fn => fn, chooseStock() {},
  async request(url, channel, options) {
    calls.push({url,channel,body:options && JSON.parse(options.body)});
    if (context.override) return context.override(url,channel,options);
    if (url === "/api/tags") return catalog;
    if (url.startsWith("/api/tag-stocks?")) return {name:new URLSearchParams(url.split("?")[1]).get("tag"),count:2,revision:catalog.revision,rows:[{code:"000001",name:"甲",initials:"J"},{code:"000002",name:"乙",initials:"Y"}]};
    if (url === "/api/tag-rename") {
      const body = JSON.parse(options.body);
      if (pendingRename) return pendingRename;
      catalog = {...catalog, tags:[{name:body.target,count:3}],total:1,revision:"v2"};
      return {needs_merge:false,name:body.target,changed:true};
    }
    if (url === "/api/tag-stocks") return {name:context.state.tagManagerName,code:"600003",changed:true};
    if (url === "/api/tag-delete") {
      const body = JSON.parse(options.body);
      if (!body.confirm) return {needs_confirmation:true,name:body.tag,count:3,revision:catalog.revision};
      catalog = {...catalog,tags:catalog.tags.filter(tag=>tag.name!==body.tag),total:0,revision:"v3"};
      return {needs_confirmation:false,name:body.tag,count:3,deleted:true};
    }
    if (url.startsWith("/api/stocks?")) return {rows:[{code:"600003",name:"丙",initials:"B"}]};
    throw Error(`Unexpected request: ${url}`);
  }
});
vm.runInContext(source.slice(source.indexOf("function escapeHTML"), source.indexOf("const RECENT_STOCKS_KEY")), context);
vm.runInContext(source.slice(source.indexOf("function canManageTags"), source.indexOf("function renderMeta")), context);
vm.runInContext(source.slice(source.indexOf("function stockTags"), source.indexOf("function canEditTags")), context);

(async () => {
  await context.loadTagManager();
  assert.equal(context.state.tab, "tags");
  assert.equal(context.state.tagManagerName, "");
  assert.equal(element("tag-manager-detail").hidden,true,"initial page devotes full width to all tags");
  await context.selectManagerTag("人形机器人");
  assert.equal(context.state.tagManagerName, "人形机器人");
  assert.equal(element("tag-manager-member-count").textContent,"2 只");
  assert.match(element("tag-manager-members").innerHTML,/data-remove-stock-tag="000001"/);
  assert.match(element("tag-manager-summary").textContent,/跨日期去重统计/);
  assert.match(element("tag-manager-list").innerHTML,/&lt;特殊&quot;标签&gt;/, "source labels are escaped in text and attributes");
  element("tag-manager-filter").value = "人形";
  context.renderTagManagerCatalog();
  assert.match(element("tag-manager-summary").textContent,/当前匹配 1/);
  assert.doesNotMatch(element("tag-manager-list").innerHTML,/data-manage-tag="机器人"/);
  element("tag-manager-filter").value = "";

  element("tag-manager-rename").value = "机器人";
  pendingRename = {needs_merge:true,source:"人形机器人",target:"机器人",source_count:2,target_count:3,combined_count:4,revision:"v1"};
  await context.renameManagerTag();
  assert.equal(element("tag-merge-dialog").open,true);
  assert.match(element("tag-merge-message").textContent,/合并后共 4 只股票/);
  assert.equal(calls.at(-1).body.merge,false);
  const preflightCalls = calls.length;
  context.cancelManagerMerge();
  assert.equal(element("tag-merge-dialog").open,false);
  assert.equal(calls.length,preflightCalls,"cancel sends no mutation");
  assert.equal(context.state.tagManagerName,"人形机器人");
  await context.renameManagerTag();
  pendingRename = null;
  await context.renameManagerTag(true);
  const merge = calls.findLast(call => call.url === "/api/tag-rename");
  assert.equal(merge.body.merge,true);
  assert.equal(merge.body.revision,"v1");
  assert.equal(context.state.tagManagerName,"机器人");
  assert.equal(element("tag-merge-dialog").open,false);
  assert.match(element("tag-manager-feedback").textContent,/已合并/);

  element("tag-manager-stock-search").value = "600003";
  await context.addManagerStock();
  const added = calls.findLast(call => call.url === "/api/tag-stocks");
  assert.deepEqual(added.body,{tag:"机器人",code:"600003",revision:"v2"});
  assert.match(element("tag-manager-feedback").textContent,/加入“机器人”/);

  element("tag-manager-members").scrollTop = 128;
  await context.removeManagerStock("000001");
  assert.deepEqual(calls.findLast(call => call.url === "/api/tag-stocks").body,{tag:"机器人",code:"000001",revision:"v2",action:"remove"});
  assert.match(element("tag-manager-feedback").textContent,/已移除甲的“机器人”标签/);
  assert.equal(element("tag-manager-members").scrollTop,128,"removing one row retains the member list scroll");

  context.override = async () => { throw Error("数据已变化，请刷新"); };
  element("tag-manager-rename").value = "保留草稿";
  await context.renameManagerTag();
  assert.equal(element("tag-manager-rename").value,"保留草稿");
  assert.equal(element("tag-manager-error").hidden,false);
  assert.equal(context.state.tagManagerSaving,false);
  const rowsBeforeFailure = element("tag-manager-members").innerHTML;
  await context.removeManagerStock("000001");
  assert.equal(element("tag-manager-members").innerHTML,rowsBeforeFailure,"failed removal leaves membership visible");
  context.override = null;

  context.state.meta.capabilities.manage_tags = false;
  context.updateTagManagerControls();
  assert.equal(element("tag-manager-rename-form").hidden,true);
  assert.equal(element("tag-manager-add-form").hidden,true);
  assert.equal(element("tag-manager-delete").hidden,true);
  const readonlyCalls = calls.length;
  await context.renameManagerTag(); await context.addManagerStock();
  await context.removeManagerStock("000001");
  await context.deleteManagerTag();
  assert.equal(calls.length,readonlyCalls,"read-only controls cannot submit");
  context.state.meta.capabilities.manage_tags = true;

  let resolveOlder;
  context.override = (url) => new Promise(resolve => { resolveOlder = resolve; });
  const slow = context.selectManagerTag("旧标签");
  context.override = null;
  await context.selectManagerTag("机器人");
  resolveOlder({count:99,revision:"old",rows:[]});
  await slow;
  assert.equal(context.state.tagManagerName,"机器人");
  assert.equal(element("tag-manager-member-count").textContent,"2 只","older member responses cannot replace current selection");
  await context.deleteManagerTag();
  assert.equal(element("tag-delete-dialog").open,true);
  assert.match(element("tag-delete-message").textContent,/3 只股票/);
  assert.match(element("tag-delete-message").textContent,/默认数据更新时也不会重新补回/);
  assert.equal(calls.at(-1).body.confirm,false,"first click only opens a verified preview");
  const previewCalls = calls.length;
  context.cancelManagerDelete();
  assert.equal(element("tag-delete-dialog").open,false);
  assert.equal(calls.length,previewCalls,"cancel does not send a deletion");
  assert.equal(context.state.tagManagerName,"机器人");
  await context.deleteManagerTag();
  context.override = async () => { throw Error("标签已变化，请刷新"); };
  await context.deleteManagerTag(true);
  assert.equal(element("tag-delete-dialog").open,true);
  assert.equal(element("tag-delete-error").hidden,false);
  assert.equal(context.state.tagManagerName,"机器人","failed confirmation keeps the original selection");
  context.override = null;
  await context.deleteManagerTag(true);
  assert.equal(calls.findLast(call=>call.url==="/api/tag-delete").body.confirm,true);
  assert.equal(element("tag-delete-dialog").open,false);
  assert.equal(context.state.tagManagerName,"");
  assert.equal(element("tag-manager-detail").hidden,true);
  assert.equal(context.state.meta.tag_order.length,0);
  assert.match(element("tag-manager-feedback").textContent,/已删除“机器人”/);
  console.log("Tag manager catalog, counts, search, confirmation/cancel/merge, assignment, read-only and stale responses: passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
