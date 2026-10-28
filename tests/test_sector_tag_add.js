const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const elements = new Map(), requests = [], timers = [];
function element(id) {
  if (!elements.has(id)) elements.set(id, {value:"",textContent:"",innerHTML:"",hidden:false,disabled:false,open:false,listeners:{},
    focus(){},showModal(){this.open=true;},close(){this.open=false;},querySelectorAll(){return [];},
    addEventListener(name,callback){this.listeners[name]=callback;}});
  return elements.get(id);
}
let refreshes=0, applied;
const context=vm.createContext({$:element,state:{requests:{},meta:{capabilities:{manage_tags:true}}},URLSearchParams,
  setTimeout(callback){timers.push(callback);return timers.length;},clearTimeout(){},
  canManageTags(){return context.state.meta.capabilities.manage_tags;},
  applyTagOrder(data){applied=data;},async refreshAfterTagWrite(){refreshes++;},
  request(route,channel,options){return new Promise((resolve,reject)=>requests.push({route,channel,options,resolve,reject}));}});
vm.runInContext(source.slice(source.indexOf("function escapeHTML"),source.indexOf("function debounce")),context);
vm.runInContext(source.slice(source.indexOf("function tagBatchError"),source.indexOf("function renderMeta")),context);
vm.runInContext(source.slice(source.indexOf("function industryColumnHeading"),source.indexOf("function mergeIdenticalFirstBoardGroups")),context);
context.bindTagBatch();
const tag="消费<&>", catalog=revision=>({tags:[{name:tag,count:2}],revision});
const a={code:"000001",name:"测试甲",initials:"CSJ"}, b={code:"000002",name:"测试乙",initials:"CSY"}, c={code:"600003",name:"模糊甲",initials:"MHJ"};
const submit={preventDefault(){}};
(async()=>{
  assert.ok(context.industryColumnHeading([tag,"机器人"],true).includes('data-add-sector-tag="消费&lt;&amp;&gt;"'));
  assert.ok(!context.industryColumnHeading([tag],false).includes('data-add-sector-tag'));
  const open=context.openTagBatch(tag); requests[0].resolve(catalog("r1")); await open;
  assert.equal(element("tag-batch-dialog").open,true);
  assert.equal(element("tag-batch-title").textContent,`添加股票到「${tag}」`);
  element("tag-batch-input").value="测试甲 000001,000002\n模糊";
  context.changeTagBatchInput();
  assert.equal(element("tag-batch-submit").disabled,true,"typing immediately invalidates old matches");
  const resolve=context.resolveTagBatchInput();
  for (const [i,rows] of [[1,[a]],[2,[a]],[3,[b]],[4,[c,{code:"600004",name:"模糊乙"}]]]) requests[i].resolve({rows});
  await resolve;
  assert.equal(element("tag-batch-submit").disabled,true,"ambiguous names require a stock selection");
  assert.ok(element("tag-batch-preview").innerHTML.includes('data-tag-batch-choice="3"'));
  element("tag-batch-preview").listeners.change({target:{closest(){return {dataset:{tagBatchChoice:"3"},value:"600003"};}}});
  assert.equal(element("tag-batch-submit").disabled,false);
  assert.equal(element("tag-batch-submit").textContent,"添加 3 只股票","name/code aliases of the same stock are deduplicated");
  const save=context.saveTagBatch(submit);
  assert.deepEqual(JSON.parse(requests[5].options.body),{tag,codes:["000001","000002","600003"],revision:"r1"});
  context.closeTagBatch(); await context.saveTagBatch(submit);
  assert.equal(element("tag-batch-dialog").open,true,"a saving batch cannot close or submit twice");
  assert.equal(requests.length,6);
  requests[5].resolve({added:2,existing:1,catalog:catalog("r2")}); await save;
  assert.equal(refreshes,1);
  assert.equal(applied.revision,"r2");
  assert.match(element("tag-batch-feedback").textContent,/已添加 2 只股票，1 只已在标签中/);
  assert.equal(element("tag-batch-submit").disabled,true,"a completed batch needs new input before another submission");

  element("tag-batch-input").value="未收录"; context.changeTagBatchInput();
  const unknown=context.resolveTagBatchInput(); requests[6].resolve({rows:[]}); await unknown;
  assert.ok(element("tag-batch-preview").innerHTML.includes("未找到已收录股票"));
  await context.saveTagBatch(submit); assert.equal(requests.length,7,"unmatched items cannot cause a partial write");
  element("tag-batch-input").value=Array.from({length:201},(_,i)=>String(i)).join(" ");
  await context.resolveTagBatchInput(); assert.match(element("tag-batch-error").textContent,/200/);
  assert.equal(requests.length,7);

  element("tag-batch-input").value="000002"; context.changeTagBatchInput();
  const recognized=context.resolveTagBatchInput(); requests[7].resolve({rows:[b]}); await recognized;
  const conflict=context.saveTagBatch(submit); requests[8].reject(new Error("标签或所属股票已发生变化")); await conflict;
  assert.equal(element("tag-batch-input").value,"000002");
  assert.equal(context.tagBatchStocks()[0].code,"000002");
  assert.equal(element("tag-batch-error").hidden,false);
  const reload=context.loadTagBatchCatalog(); requests[9].resolve(catalog("r3")); await reload;
  const retry=context.saveTagBatch(submit); requests[10].resolve({added:0,existing:1,catalog:catalog("r3")}); await retry;
  assert.equal(JSON.parse(requests[10].options.body).revision,"r3");
  context.closeTagBatch(); await context.saveTagBatch(submit); assert.equal(requests.length,11);

  const oldOpen=context.openTagBatch(tag); context.closeTagBatch(); requests[11].resolve(catalog("old")); await oldOpen;
  assert.equal(element("tag-batch-dialog").open,false,"closed dialogs ignore late catalog responses");
  const newOpen=context.openTagBatch(tag); requests[12].resolve(catalog("fresh")); await newOpen;
  element("tag-batch-input").value="旧查询"; context.changeTagBatchInput(); const oldSearch=context.resolveTagBatchInput();
  element("tag-batch-input").value="新查询"; context.changeTagBatchInput(); const newSearch=context.resolveTagBatchInput();
  requests[14].resolve({rows:[b]}); await newSearch; requests[13].resolve({rows:[a]}); await oldSearch;
  assert.equal(context.tagBatchStocks()[0].code,b.code,"late search results cannot overwrite a newer batch");
  context.closeTagBatch(); context.state.meta.capabilities.manage_tags=false;
  await context.openTagBatch(tag); await context.saveTagBatch(submit);
  assert.equal(requests.length,15,"read-only users cannot open or submit the bulk editor");
  assert.deepEqual(Array.from(context.tagBatchTokens("000001，000002;000001\n600003")),["000001","000002","600003"]);
  console.log("Sector tag add dialog: per-label entry, batch matching/deduplication, ambiguity choices, atomic payloads, conflicts, late responses, input retention and read-only guards: passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
