const { install } = require('./frontend-harness.cjs');
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");

const elements=new Map(),requests=[];
function element(id){
  if(!elements.has(id))elements.set(id,{open:false,hidden:false,textContent:"",classList:{remove(){},toggle(){}},showModal(){this.open=true;}});
  return elements.get(id);
}
const context=vm.createContext({$:element,state:{requests:{}},request:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))});
install(context, ["openAnnouncement"], []);
(async()=>{
  const empty=context.openAnnouncement();requests[0].resolve({announcement:{enabled:false,content:"private draft"}});await empty;
  assert.equal(element("announcement-dialog").open,true);
  assert.equal(element("announcement-content").textContent,"暂无公告");
  const published=context.openAnnouncement();requests[1].resolve({announcement:{enabled:true,title:"维护通知",content:"第一行\n<script>not executable</script>",updated_at:"2026-10-18T23:55:00+08:00"}});await published;
  assert.equal(element("announcement-title").textContent,"维护通知");
  assert.equal(element("announcement-content").textContent,"第一行\n<script>not executable</script>");
  assert.equal(element("announcement-content").innerHTML,undefined,"announcement content is assigned as text only");
  assert.equal(element("announcement-updated").hidden,false);
  const failure=context.openAnnouncement();requests[2].reject(new Error("offline"));await failure;
  assert.equal(element("retry-announcement").hidden,false);
  const stale=context.openAnnouncement(),latest=context.openAnnouncement();
  requests[4].resolve({announcement:{enabled:true,title:"新公告",content:"new"}});await latest;
  requests[3].resolve({announcement:{enabled:true,title:"旧公告",content:"old"}});await stale;
  assert.equal(element("announcement-content").textContent,"new","stale requests cannot overwrite the newest announcement");
  const closed=context.openAnnouncement();element("announcement-dialog").open=false;
  requests[5].resolve({announcement:{enabled:true,content:"closed response"}});await closed;
  assert.notEqual(element("announcement-content").textContent,"closed response");
  console.log("Announcement empty/published states, text-only rendering, errors, retries and stale/closed responses: passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
