// Verify blacklist mutations, errors, view state, and request concurrency using the real frontend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {value:'', hidden:false, innerHTML:'', textContent:'', disabled:false,
    classList:{toggle(){}}, setAttribute(name,value){this[name]=value;}, removeAttribute(name){delete this[name];},
    querySelectorAll(){return [];}});
  return elements.get(id);
}
const stock = {code:'600802',name:'福建<&水泥',market:'sh',initials:'FJSN',registered_province:'福建省',tags:['水泥','自定义<&标签']};
const row = {...stock,created_at:'2026-10-17T12:30:00+08:00'};
let rows = [], calls = [], fail = false, pending = null, searchRows = [stock], url = '';
const context = vm.createContext({
  document:{documentElement:{classList:{toggle(){}}}},
  state:{tab:'date',requests:{},meta:{capabilities:{edit_blacklist:true}},excludeST:true,grouping:'region',boards:'2'},
  $:element, URLSearchParams, markets:{sh:'沪市主板'}, location:{pathname:'/'}, history:{replaceState(a,b,next){url=next;},pushState(a,b,next){url=next;}},
  hideSuggestions(){}, clearError(){}, loadingHTML:()=>'<loading>', emptyHTML:title=>title,
  request:async (path,channel,options)=>{
    calls.push({path,channel,options});
    if(pending)return pending;
    if(fail)throw Error('offline');
    if(path.startsWith('/api/stocks?'))return {rows:searchRows};
    if(options){const {code,action}=JSON.parse(options.body);const changed=action==='add'?!rows.length:!!rows.length;
      rows=action==='add'?[row]:[];return {rows,total:rows.length,code,action,changed};}
    return {rows,total:rows.length};
  }
});
function load(from,to){vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to)),context);}
load('function escapeHTML','const RECENT_STOCKS_KEY');
load('function marketValue','function latestLimitUp');
load('function updateURL','function renderMeta');
load('function stockTags','function renderStockCard');
element('trade-date').value='2026-10-16';
(async()=>{
  await context.loadBlacklist();
  assert.equal(context.state.tab,'blacklist');
  assert.equal(element('date-view').hidden,true);
  assert.equal(element('blacklist-view').hidden,false);
  assert.ok(url.includes('view=blacklist')&&url.includes('exclude_st=1')&&url.includes('boards=2'));
  assert.equal(element('blacklist-count').textContent,'0');
  element('blacklist-search').value='fjsn';
  await context.changeBlacklist('add');
  assert.equal(context.state.blacklistData.total,1);
  assert.ok(element('blacklist-table-area').innerHTML.includes('福建&lt;&amp;水泥'));
  const listHTML=element('blacklist-table-area').innerHTML;
  assert.ok(listHTML.includes('>注册省份</th>') && listHTML.includes('>行业标签</th>'));
  assert.ok(listHTML.includes('class="blacklist-province">福建</td>'));
  assert.ok(listHTML.includes('>水泥</span>') && listHTML.includes('自定义&lt;&amp;标签'));
  assert.ok(!listHTML.includes('>市场</th>') && !listHTML.includes('>状态</th>') && !listHTML.includes('blacklist-badge'));
  assert.equal((listHTML.match(/<th scope="col">/g)||[]).length,5);
  assert.equal(element('blacklist-search').value,'');
  context.selectBlacklistStock(stock);
  await context.changeBlacklist('add');
  assert.equal(context.state.blacklistData.total,1);
  assert.ok(element('blacklist-feedback').textContent.includes('已在黑名单'));
  fail=true;
  await context.changeBlacklist('remove',stock.code);
  assert.equal(context.state.blacklistData.total,1,'failed remove preserves the row');
  assert.equal(element('blacklist-error').textContent,'offline');
  assert.equal(context.state.blacklistSaving,false);
  assert.equal(element('blacklist-add-button').disabled,false);
  fail=false;
  await context.changeBlacklist('remove',stock.code);
  assert.equal(context.state.blacklistData.total,0);
  searchRows=[stock,{code:'000001',name:'福建测试',initials:'FJCS'}];
  element('blacklist-search').value='福建';
  const before=calls.filter(call=>call.options).length;
  await context.changeBlacklist('add');
  assert.equal(calls.filter(call=>call.options).length,before,'ambiguous searches must not silently add a stock');
  assert.equal(element('blacklist-suggestions').hidden,false);
  assert.ok(element('blacklist-error').textContent.includes('请选择'));
  context.state.meta.capabilities.edit_blacklist=false;
  context.renderBlacklist({rows:[row],total:1});
  assert.equal(element('blacklist-add-panel').hidden,true);
  assert.ok(!element('blacklist-table-area').innerHTML.includes('data-blacklist-remove'));
  assert.equal((element('blacklist-table-area').innerHTML.match(/<th scope="col">/g)||[]).length,4);
  context.renderBlacklist({rows:[{code:'000001',name:'资料缺失',created_at:row.created_at}],total:1});
  assert.ok(element('blacklist-table-area').innerHTML.includes('地区待补充') && element('blacklist-table-area').innerHTML.includes('暂无标签'));
  await context.changeBlacklist('remove',stock.code);
  assert.equal(calls.filter(call=>call.options).length,before,'read-only mode cannot send mutations');
  context.state.meta.capabilities.edit_blacklist=true;
  context.state.blacklistSelected=stock;
  let resolve;
  pending=new Promise(done=>resolve=done);
  const first=context.changeBlacklist('add');
  const during=calls.length;
  await context.changeBlacklist('add');
  assert.equal(calls.length,during,'double clicks must not send concurrent saves');
  resolve({rows:[row],total:1,changed:true});await first;pending=null;
  let resolveOld,resolveNew;
  const oldPromise=new Promise(done=>resolveOld=done);
  pending=oldPromise;const old=context.loadBlacklist();
  pending=new Promise(done=>resolveNew=done);const newer=context.loadBlacklist();
  resolveOld({rows:[],total:0});await old;
  assert.equal(context.state.blacklistLoading,true,'a superseded request must not unlock the current request');
  assert.equal(context.state.blacklistData.total,1);
  resolveNew({rows:[],total:0});await newer;pending=null;
  assert.equal(context.state.blacklistLoading,false);
  console.log('Blacklist persistence UI, add/remove, duplicate handling, failure recovery, escaping, read-only mode, routing and request concurrency: passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
