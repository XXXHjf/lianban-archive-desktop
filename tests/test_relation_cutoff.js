const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname,"../web/app.js"),"utf8");
const elements = new Map(), requests = [], errors = [];
const full = {range_end:"2026-10-16",target_limit_days:22};
const filtered = {range_end:"2026-10-15",target_limit_days:21};
function element(id) {
  if (!elements.has(id)) elements.set(id,{innerHTML:"unchanged",setAttribute(key,value){this[key]=value;}});
  return elements.get(id);
}
const context = vm.createContext({URLSearchParams,$:element,
  state:{tab:"stock",requests:{},selectedStock:{code:"600668"},stockData:{stock:{code:"600668"},relationships:full},relationExcludeLatest:true},
  loadingHTML:()=>"loading",emptyHTML:()=>"error",clearError(){},showError(error,retry){errors.push({error,retry});},
  renderRelationships(data){context.state.relationships=data;},
  request:(url,channel)=>new Promise((resolve,reject)=>requests.push({url,channel,resolve,reject}))
});
vm.runInContext(source.slice(source.indexOf("async function loadRelationHistory"),source.indexOf("function verificationBadge")),context);
(async()=>{
  const original=JSON.stringify(context.state.stockData);
  const first=context.loadRelationHistory();
  assert.ok(requests[0].url.includes("exclude_latest=1"));
  assert.equal(requests[0].channel,"relations");
  assert.equal(context.state.relationships,null);
  assert.equal(element("stock-relations")["aria-busy"],"true");
  requests[0].resolve({relationships:filtered});await first;
  assert.equal(context.state.relationships,filtered);
  assert.equal(element("stock-relations")["aria-busy"],"false");
  assert.equal(JSON.stringify(context.state.stockData),original,"cutoff queries never replace the full stock history used by charts and cycles");
  assert.equal(element("stock-cycles").innerHTML,"unchanged");
  const stale=context.loadRelationHistory();
  context.state.relationExcludeLatest=false;
  await context.loadRelationHistory();
  assert.equal(context.state.relationships,full,"unchecking restores the original full relationship data");
  requests[1].resolve({relationships:filtered});await stale;
  assert.equal(context.state.relationships,full,"a late cutoff response cannot undo unchecking");
  context.state.relationExcludeLatest=true;
  const previousStock=context.loadRelationHistory();
  context.state.selectedStock={code:"000530"};
  requests[2].resolve({relationships:filtered});await previousStock;
  assert.notEqual(context.state.relationships,filtered,"previous stock responses cannot overwrite the current stock");
  const failure=context.loadRelationHistory();
  requests[3].reject(new Error("offline"));await failure;
  assert.equal(errors.length,1);assert.equal(errors[0].retry,context.loadRelationHistory);
  assert.equal(element("stock-relations")["aria-busy"],"false");
  const retry=context.loadRelationHistory();requests[4].resolve({relationships:filtered});await retry;
  assert.equal(context.state.relationships,filtered);
  console.log("Latest-day relationship cutoff, full-history isolation, toggle and stock races, failure and retry: passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
