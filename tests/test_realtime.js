const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const elements = new Map(), listeners = new Map(), board = {scrollLeft:120};
function $(id) {
  if (!elements.has(id)) elements.set(id,{value:'2026-10-27',textContent:'',max:'2026-10-26',disabled:false,
    querySelector:()=>board,addEventListener(type,callback,capture){listeners.set(id,{callback,capture});}});
  return elements.get(id);
}
let rendered, restored, updates=0;
const state={tab:'date',meta:{latest_date:'2026-10-26',dates:['2026-10-23','2026-10-26'],archive_updated_at:'confirmed',
  live:{enabled:true,date:'2026-10-27',dates:['2026-10-27'],fetched_at:'2026-10-27T10:00:00+08:00',note:'暂定'}},latestLimitUps:new Map([['600001',2]])};
const context=vm.createContext({$,state,URLSearchParams,Map,Date,
  location:{pathname:'/',search:''},history:{replaceState(_a,_b,url){context.location.search=url.slice(url.indexOf('?'));}},
  window:{scrollX:0,scrollY:420,scrollTo(position){assert.equal(position.top,420);}},
  renderMeta(){},refreshMeta:async()=>{},restoreFromURL:async options=>{restored=options;},
  renderDate(data){rendered={data,highlight:state.latestLimitUps.size,priority:context.latestPriorityNote()};board.scrollLeft=0;},
  latestPriorityNote:()=> '10.26 涨停股票高亮置顶',updateDateNavigation(){},changeQueryDate(){updates++;},
  dateLabel:value=>value,getDateQuery:()=>new URLSearchParams({date:$('trade-date').value}),
  request:async()=>({date:'2026-10-27',provisional:true,fetched_at:'2026-10-27T10:01:00+08:00'}),updateURL(){},
});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/realtime.js'),'utf8'),context);
(async()=>{
  context.renderMeta(state.meta);
  assert.equal($('trade-date').max,'2026-10-27');
  await context.restoreFromURL({remember:true});
  assert.equal(context.location.search,'?date=2026-10-27');
  assert.equal(restored.remember,true);
  context.renderDate({date:'2026-10-27',provisional:true,fetched_at:'2026-10-27T10:00:00+08:00'});
  assert.equal(rendered.highlight,0);assert.equal(rendered.priority,'');
  assert.equal(state.latestLimitUps.size,1,'historical highlighting map is restored after provisional render');
  assert.match($('date-subtitle').textContent,/盘中暂定.*10:00:00.*每分钟/);
  context.renderDate({date:'2026-10-23'});
  assert.equal(rendered.highlight,1);assert.match(rendered.priority,/10.26/);
  assert.equal(state.meta.latest_date,'2026-10-26','query navigation does not change confirmed metadata');
  const event={stopImmediatePropagation(){}};
  listeners.get('prev-date').callback(event);assert.equal($('trade-date').value,'2026-10-26');
  listeners.get('next-date').callback(event);assert.equal($('trade-date').value,'2026-10-27');
  assert.equal(listeners.get('latest-date').capture,true);
  console.log('Realtime extension: provisional badges suppressed, historical highlights preserved, latest/date navigation and confirmed metadata isolation: passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
