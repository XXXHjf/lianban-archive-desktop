// Parent picker fuzzy matching and keyboard selection never write until submit.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
const elements = new Map(), listeners = new Map(), requests = [];
function $(id) {
  if (!elements.has(id)) {
    const el = {value:'', hidden:false, disabled:false, options:[], classList:{toggle(){}},
      setAttribute(name,value){this[name]=value;}, addEventListener(type,fn){listeners.set(`${id}:${type}`,fn);},
      querySelectorAll(){return this.options;}, querySelector(selector){return this.options.find(o=>selector.includes(`"${o.index}"`));},
      focus(){listeners.get(`${id}:focus`)?.();}};
    let html='';
    Object.defineProperty(el,'innerHTML',{get:()=>html,set(value){
      html=value; el.options=[...value.matchAll(/data-parent-tag-index="([0-9]+)"/g)].map(match=>({index:Number(match[1]),
        setAttribute(name,value){this[name]=value;},scrollIntoView(){this.scrolled=true;}}));
    }});
    elements.set(id,el);
  }
  return elements.get(id);
}
const catalog={revision:'r1',total:7,stocks:700,tags:[{name:'机器人',count:700},{name:'AI应用',count:80},
  {name:'电机',count:30},{name:'伺服系统',count:10},{name:'<传感&>',count:1},{name:'当前标签',count:5},{name:'后代',count:1}],
  hierarchy:[{name:'电机',parent:'机器人'},{name:'伺服系统',parent:'电机'},{name:'<传感&>',parent:'机器人'}, {name:'后代',parent:'当前标签'}]};
const context=vm.createContext({$,URLSearchParams,state:{requests:{},tab:'tags',tagManagerName:'当前标签',tagManagerData:catalog,
  tagManagerMembers:{rows:[],revision:'r1'},meta:{capabilities:{manage_tags:true}}},
  canEditTags:()=>true,debounce:fn=>fn,emptyHTML:()=>'',
  async request(url,channel,options){requests.push({url,body:JSON.parse(options.body)});return {name:'当前标签',catalog};}});
for (const [from,to] of [['function escapeHTML','const RECENT_STOCKS_KEY'], ['function canManageTags','function renderMeta'],
  ['function stockTags','function canEditTags'], ['function matchesExistingTag','function positionTagSuggestions']]) {
  vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to)),context);
}
context.refreshAfterTagWrite=async()=>{};
context.applyTagOrder(catalog); context.bindTagManager(); context.renderTagManagerCatalog();
const input=$('tag-manager-parent'), popup=$('tag-manager-parent-suggestions');
const names=()=>Array.from(context.state.tagParentSuggestionRows,tag=>tag.name);
function type(value){input.value=value; listeners.get('tag-manager-parent:input')();}
function key(value,extra={}){const e={key:value,preventDefault(){this.prevented=true;},...extra};listeners.get('tag-manager-parent:keydown')(e);return e;}
type('机人');
assert.deepEqual(names(),['机器人','电机','伺服系统','<传感&>'], 'subsequence query also finds descendants of a matching ancestor');
assert.ok(popup.innerHTML.includes('机器人 / 电机 / </span>伺服系统'));
assert.ok(popup.innerHTML.includes('&lt;传感&amp;&gt;')&&!popup.innerHTML.includes('<传感&>'));
assert.ok(popup.innerHTML.includes('700 只')&&input['aria-expanded']==='true');
type('ai');assert.deepEqual(names(),['AI应用']);
type('');assert.equal(names()[0],'');assert.ok(!names().includes('当前标签')&&!names().includes('后代'));
type('电机');assert.deepEqual(names(),['电机','伺服系统']);
key('ArrowUp');assert.equal(context.state.tagParentSuggestionIndex,1,'up from no selection selects the final candidate');
assert.equal(input['aria-activedescendant'],'tag-parent-option-1');
assert.ok(key('Enter').prevented);assert.equal(input.value,'伺服系统');assert.equal(popup.hidden,true);
assert.equal(requests.length,0,'selection does not submit the relation');
type('电机');key('ArrowDown');assert.equal(context.state.tagParentSuggestionIndex,0);key('Enter');assert.equal(input.value,'电机');
type('机人');key('Escape');assert.equal(popup.hidden,true);assert.equal(input.value,'机人');
type('ai');key('Enter',{isComposing:true});assert.equal(input.value,'ai');assert.equal(popup.hidden,false);
listeners.get('tag-manager-parent-suggestions:click')({target:{closest:()=>({dataset:{parentTagIndex:'0'}})}});
assert.equal(input.value,'AI应用');assert.equal(popup.hidden,true);
listeners.get('tag-manager-parent:blur')();assert.equal(input['aria-expanded'],'false');
(async()=>{
  type('不存在');assert.equal(names().length,0);assert.ok(popup.innerHTML.includes('没有匹配'));
  await context.saveManagerTagNode({preventDefault(){}},'parent');
  assert.equal(requests.length,0);assert.equal($('tag-manager-error').hidden,false);
  input.value='ai应用';await context.saveManagerTagNode({preventDefault(){}},'parent');
  assert.deepEqual(requests[0],{url:'/api/tag-node',body:{name:'当前标签',parent:'AI应用',action:'parent',revision:'r1'}});
  input.value='';await context.saveManagerTagNode({preventDefault(){}},'parent');assert.equal(requests[1].body.parent,'');
  context.state.meta.capabilities.manage_tags=false;await context.saveManagerTagNode({preventDefault(){}},'parent');assert.equal(requests.length,2);
  console.log('Parent tag search: fuzzy names/ancestor paths, counts, escaping, self/descendant exclusion, click/keyboard/IME, drafts, validation and explicit save passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
