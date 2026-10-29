const { install } = require('./frontend-harness.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const elements=new Map(),requests=[];
function $(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,open:false,
  classList:{toggle(){}},setAttribute(){},querySelectorAll:()=>[],focus(){},showModal(){this.open=true;},close(){this.open=false;}});return elements.get(id);}
const catalog={tags:[{name:'父<&>',count:2},{name:'子',count:1},{name:'孙',count:1}],total:3,stocks:2,revision:'r1',hierarchy:[{name:'父<&>',parent:''},{name:'子',parent:'父<&>'},{name:'孙',parent:'子'}]};
let refreshes=0;
const context=vm.createContext({$,URLSearchParams,state:{tab:'tags',requests:{},tagManagerName:'子',tagManagerMembers:{rows:[],revision:'r1'},tagManagerData:catalog,meta:{capabilities:{manage_tags:true}}},
  canEditTags:()=>true,emptyHTML:()=>'',regionLabel:()=>'',
  request:(url,channel,options)=>new Promise((resolve,reject)=>requests.push({url,channel,body:JSON.parse(options.body),resolve,reject})),updateURL(){}});
install(context, ["escapeHTML","textValue","numberValue"], []);
install(context, ["canManageTags","tagManagerError","updateTagManagerControls","renderTagManagerCatalog","hideManagerParentSuggestions","renderManagerParentSuggestions","chooseManagerParentTag","selectManagerTag","loadTagManager","hideManagerSuggestions","showManagerSuggestions","searchManagerStocks","refreshAfterTagWrite","removeManagerStock","addManagerStock","cancelManagerMerge","renameManagerTag","cancelManagerDelete","deleteManagerTag","openTagNodeDialog","saveManagerTagNode","openManagerTagBatch","bindTagManager","tagBatchError","tagBatchTokens","tagBatchStocks","updateTagBatchControls","renderTagBatchPreview","cancelTagBatchSearch","loadTagBatchCatalog","openTagBatch","closeTagBatch","resolveTagBatchInput","changeTagBatchInput","saveTagBatch","bindTagBatch"], []);
install(context, ["stockTags","allStockTags","tagHierarchy","tagAncestors","tagRoot","renderHierarchyStockGroups","tagRanks","compareTags","sortedTags","applyTagOrder","refreshTagOrder"], []);
install(context, ["matchesExistingTag"], []);
context.refreshAfterTagWrite=async()=>{refreshes++;};
context.applyTagOrder(catalog);context.renderTagManagerCatalog();
assert.ok($('tag-manager-list').innerHTML.includes('tag-manager-tree-children')&&$('tag-manager-list').innerHTML.includes('父&lt;&amp;&gt;'));
assert.equal($('tag-manager-parent').value,'父<&>');
$('tag-manager-parent').value='';context.renderManagerParentSuggestions();
assert.deepEqual(Array.from(context.state.tagParentSuggestionRows,tag=>tag.name),['','父<&>'],'self and descendants are unavailable as parents');
$('tag-manager-parent').value='父<&>';context.hideManagerParentSuggestions();
(async()=>{
  context.openTagNodeDialog('子');assert.equal($('tag-node-dialog').open,true);assert.equal($('tag-node-parent').value,'子');
  $('tag-node-name').value='新子级';const create=context.saveManagerTagNode({preventDefault(){}});
  assert.deepEqual(requests[0].body,{name:'新子级',parent:'子',action:'create',revision:'r1'});
  assert.equal($('tag-node-close').disabled,true);
  const updated={...catalog,revision:'r2',tags:[...catalog.tags,{name:'新子级',count:0}],hierarchy:[...catalog.hierarchy,{name:'新子级',parent:'子'}]};
  requests[0].resolve({name:'新子级',parent:'子',catalog:updated});await create;
  assert.equal($('tag-node-dialog').open,false);assert.equal(context.state.tagManagerName,'子');assert.equal(refreshes,1);
  context.state.tagManagerData=updated;$('tag-manager-parent').value='';
  const detach=context.saveManagerTagNode({preventDefault(){}},'parent');assert.equal(requests[1].body.parent,'');assert.equal(requests[1].body.revision,'r2');
  requests[1].reject(new Error('版本冲突'));await detach;assert.equal($('tag-manager-error').hidden,false);assert.equal($('tag-manager-parent').value,'');
  context.openTagNodeDialog();$('tag-node-name').value='保留草稿';const failure=context.saveManagerTagNode({preventDefault(){}});requests[2].reject(new Error('已有同名标签'));await failure;
  assert.equal($('tag-node-name').value,'保留草稿');assert.equal($('tag-node-dialog').open,true);assert.equal($('tag-node-error').hidden,false);
  context.state.meta.capabilities.manage_tags=false;context.updateTagManagerControls();
  assert.equal($('tag-manager-create').hidden,true);assert.equal($('tag-manager-parent-form').hidden,true);assert.equal($('tag-manager-child').hidden,true);
  await context.saveManagerTagNode({preventDefault(){}});assert.equal(requests.length,3);
  console.log('Tag tree manager: nested catalog, escaped names, valid parent choices, create/detach payloads, conflicts/draft retention, refresh and read-only controls passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
