const { install } = require('./frontend-harness.cjs');
// The checkbox's daily API query and shareable URL must retain the same state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let url = "";
const context = vm.createContext({
  URLSearchParams, state: { tab:"date", boards:"2", grouping:"region", excludeST:true, excludeGEM:true },
  $: () => ({value:"2026-10-15"}), location: {pathname:"/"},
  history: { replaceState: (_a, _b, next) => { url = next; }, pushState: (_a, _b, next) => { url = next; } }
});
install(context, ["updateURL"], []);
install(context, ["getDateQuery"], []);
assert.equal(context.getDateQuery().get("exclude_st"), "1");
assert.equal(context.getDateQuery().get("exclude_gem"), "1");
assert.equal(context.getDateQuery().get("boards"), "2");
context.updateURL();
assert.ok(url.includes("exclude_st=1") && url.includes("exclude_gem=1") && url.includes("layout=region") && url.includes("boards=2"));
context.state.tab = "stock";
context.state.selectedStock = {code:"600825"};
context.updateURL();
assert.ok(url.includes("exclude_st=1") && url.includes("exclude_gem=1") && url.includes("code=600825"), "returning from a stock preserves both daily preferences");
context.state.excludeST = false;
context.updateURL();
assert.ok(!url.includes("exclude_st"));
assert.equal(context.getDateQuery().get("exclude_st"), "0");
assert.equal(context.getDateQuery().get("exclude_gem"), "1", "ST and GEM checkboxes operate independently");
context.state.excludeGEM = false;
context.updateURL();
assert.ok(!url.includes("exclude_gem"));
assert.equal(context.getDateQuery().get("exclude_gem"), "0");
context.state.excludeGEM = true;
context.state.grouping = "pinyin";
context.state.tab = "date";
context.updateURL();
assert.ok(url.includes("layout=pinyin") && url.includes("boards=2") && url.includes("exclude_gem=1") && !url.includes("code="),"the pinyin layout, board and GEM checkbox are shareable together");
context.state.grouping = "code";
context.updateURL();
assert.ok(url.includes("layout=code") && url.includes("boards=2") && url.includes("exclude_gem=1"));
context.state.tab = "stock";
context.updateURL();
assert.ok(url.includes("layout=code") && url.includes("code=600825"),"the code layout must not replace the selected stock code parameter");
console.log("Independent ST/GEM filter queries, selected board, region/pinyin/code layouts, and URL state: passed.");
