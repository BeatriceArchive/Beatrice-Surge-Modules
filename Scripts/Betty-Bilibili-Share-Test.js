/*
 * Beatrice Surge Modules
 * Copyright (c) 2026 BeatriceArchive. See repository LICENSE.
 * Temporary, standalone share-only entry: never loads/evaluates cached Daily code.
 */
const N="贝蒂的 B 站分享单次测试",V="1.0.0",ENTRY="Betty-Bilibili-Share-Test";
const CK="betty.bilibili.cookie",SESSION=CK+".session",SC="official-qr-home-v3";
const LK="betty.bilibili.daily.run_lock",SK="betty.bilibili.daily.share_test.panel";
const TEST_KEY="betty.bilibili.daily.share_test.",TTL=360000;
const HOME="https://www.bilibili.com/",API="https://api.bilibili.com";
const NAV=API+"/x/web-interface/nav",REWARD=API+"/x/member/web/exp/reward";
const RANK=API+"/x/web-interface/ranking/v2?rid=0&type=all",SHARE=API+"/x/web-interface/share/add";
const UA="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
let done=false,owner="",held=false,manual=false;
let panel=readPanel()||P("点击本测试面板右侧刷新：仅分享一次｜不会观看或投币");
main().finally(()=>{unlock();if(manual)savePanel();finish(panel)});

async function main(){
 // All four context checks are required. Cron/editor/Shortcuts/HTTP API are not test entries.
 if(!isManualTest())return;
 manual=true;
 try{
  if(!(await lock())){report(null,"Daily 或测试正在运行；未发送请求");return}
  await runTest();
 }catch(_){report(null,"测试异常；不会自动重试，也不会清除已保存的写入保护")}
}

async function runTest(){
 const session=readSession(),cookie=session&&session.cookie,meta=session&&session.meta;
 if(!cookie||!meta||meta.verified!==true||meta.schema!==SC){report(null,"没有已验证会话；未发送请求");return}
 const cm=parseCookie(cookie),missing=["SESSDATA","bili_jct","DedeUserID","buvid3"].filter(k=>!cm[k]);
 if(missing.length){report(null,"缺少 "+missing.join("、")+"；未发送请求");return}
 const nav=await request("GET",NAV,cookie);
 const uid=String(nav.data&&nav.data.mid||"");
 if(!nav.ok||!nav.data||nav.data.isLogin!==true||!/^\d+$/.test(uid)||uid!==cm.DedeUserID||uid!==String(meta.uid||"")){
  report(null,"登录或 UID 验证失败；未发送请求；原 Cookie 保留");return;
 }
 const day=shareDay(),key=TEST_KEY+uid+"."+day;
 const saved=$persistentStore.read(key),old=saved?parse(saved):null;
 const before=await request("GET",REWARD,cookie),beforeShare=officialShare(before);
 if(saved){
  if(!validRecord(old,day)){report({code:null,httpStatus:null,message:"原请求结果未知"},"本日测试记录损坏；已阻止再次写入",beforeShare);return}
  report(old,beforeShare===null?"官方状态不可读；保留原请求结果，本日测试机会已用，未再次 POST":"本日测试机会已用；仅重新读取官方状态，未再次 POST",beforeShare);return;
 }
 if(beforeShare===null){report(null,"官方任务状态不可读；未发送请求");return}
 if(beforeShare){report(null,"官方任务已经完成；无需分享，未消耗测试机会",true);return}
 const rank=await request("GET",RANK,cookie);
 const list=rank.ok&&rank.data&&Array.isArray(rank.data.list)?rank.data.list:[];
 const video=list.find(v=>v&&Number.isSafeInteger(v.aid)&&v.aid>0&&typeof v.bvid==="string"&&/^BV[0-9A-Za-z]{8,20}$/.test(v.bvid));
 if(!video){report(null,"没有可用视频；未发送请求",false);return}
 if(shareDay()!==day||!ownsLock()){report(null,"准备期间已跨日或失去运行锁；未发送请求");return}
 // Consume only this independent test key BEFORE sending. Never touch share_attempt.*.
 const record={version:1,mode:"manual-share-test",day,shape:"pc-client-v1",phase:"reserved",code:null,httpStatus:null,message:"请求结果尚未记录（运行可能中断）",officialShare:null,confirmed:false};
 if(!$persistentStore.write(JSON.stringify(record),key)){report(null,"无法持久化测试保护；未发送请求");return}
 const body=form({aid:video.aid,csrf:cm.bili_jct,source:"pc_client_normal",eab_x:2,ramval:0,ga:1});
 const response=await request("POST",SHARE,cookie,HOME+"video/"+video.bvid+"/",body);
 record.phase="responded";record.code=response.code;record.httpStatus=response.httpStatus;
 record.message=safeMessage(response.message,cm);
 $persistentStore.write(JSON.stringify(record),key);
 // Even rejection or timeout is followed by bounded read-only confirmation. Never repeat POST.
 for(const delay of [0,1200,2500]){
  if(delay)await sleep(delay);
  if(shareDay()!==day)break;
  const state=officialShare(await request("GET",REWARD,cookie));
  if(shareDay()!==day){record.officialShare=null;break}
  if(state!==null)record.officialShare=state;
  if(state===true)break;
 }
 record.phase="finished";record.confirmed=record.officialShare===true;
 const stored=$persistentStore.write(JSON.stringify(record),key);
 report(record,stored?"本日测试机会已用；不会再次写入":"结果保存失败；先前写入保护仍保留，不会再次写入");
}

function isManualTest(){return typeof $script==="object"&&$script&&$script.type==="generic"&&$script.name===ENTRY&&typeof $trigger!=="undefined"&&$trigger==="button"&&isPanel()&&$input.panelName===ENTRY}
function isPanel(){return typeof $input==="object"&&$input&&$input.purpose==="panel"}
function officialShare(r){return r.ok&&r.data&&typeof r.data.share==="boolean"?r.data.share:null}
function validRecord(r,day){return r&&r.version===1&&r.mode==="manual-share-test"&&r.day===day&&["reserved","responded","finished"].includes(r.phase)&&(r.code===null||Number.isFinite(r.code))&&(r.httpStatus===null||Number.isFinite(r.httpStatus))&&typeof r.message==="string"&&(r.officialShare===null||typeof r.officialShare==="boolean")}
function readSession(){const raw=$persistentStore.read(SESSION);if(raw){const s=parse(raw);return s&&s.version===1&&typeof s.cookie==="string"?s:null}return{cookie:$persistentStore.read(CK)||"",meta:parse($persistentStore.read(CK+".meta"))}}
function parseCookie(value){const cm={};String(value||"").split(";").forEach(x=>{const i=x.indexOf("=");if(i>0)cm[x.slice(0,i).trim()]=x.slice(i+1).trim()});return cm}
function shareDay(){return new Date(Date.now()+8*3600000).toISOString().slice(0,10)}
function form(fields){return Object.keys(fields).map(k=>encodeURIComponent(k)+"="+encodeURIComponent(String(fields[k]))).join("&")}
function safeMessage(value,cm){let s=String(value||"");for(const v of Object.values(cm))if(v)s=s.split(v).join("[redacted]");return s.replace(/[\r\n\t]+/g," ").slice(0,160)}
function parse(value){try{return JSON.parse(value)}catch(_){return null}}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

function request(method,url,cookie,referer=HOME,body=""){
 return new Promise(resolve=>{
  const headers={"User-Agent":UA,Accept:"application/json, text/plain, */*","Accept-Language":"zh-CN,zh-Hans;q=0.9,en;q=0.8",Cookie:cookie,Referer:referer};
  if(method==="POST"){headers.Origin="https://www.bilibili.com";headers["Content-Type"]="application/x-www-form-urlencoded; charset=UTF-8"}
  const options={url,headers,timeout:7,"auto-cookie":false,"auto-redirect":false};if(body)options.body=body;
  const callback=(error,response,data)=>{
   const httpStatus=response&&response.status!=null?Number(response.status):null;
   if(error||httpStatus===null||!Number.isFinite(httpStatus)){resolve({ok:false,code:null,httpStatus:null,message:"NETWORK ERROR / 未收到有效 HTTP 响应",data:null});return}
   const json=typeof data==="string"?parse(data):data;
   const rawCode=json&&json.code;
   const code=(typeof rawCode==="number"||typeof rawCode==="string"&&/^-?\d+$/.test(rawCode))&&Number.isFinite(Number(rawCode))?Number(rawCode):null;
   const message=json&&json.message!=null?json.message:json&&json.msg!=null?json.msg:"HTTP "+httpStatus;
   resolve({ok:httpStatus>=200&&httpStatus<300&&code===0,code,httpStatus,message:String(message),data:json&&json.data});
  };
  try{method==="POST"?$httpClient.post(options,callback):$httpClient.get(options,callback)}catch(_){callback(true,null,null)}
 });
}

function report(record,note,state=record?record.officialShare:null){
 const accepted=record&&record.code===0&&record.httpStatus>=200&&record.httpStatus<300;
 let outcome=state===true?"CONFIRMED / 官方任务已完成":"NOT CONFIRMED / 未确认";
 if(state!==true&&accepted)outcome=state===false?"REQUEST ACCEPTED BUT NOT CREDITED / 请求接受但未记账":"NOT CONFIRMED / 请求接受，官方状态未知";
 if(state!==true&&record&&(record.code===-403||record.code===403||record.httpStatus===403))outcome="REQUEST REJECTED BY BILIBILI / 服务端拒绝";
 const content=[
  "REQUEST CODE: "+(record?(record.code===null?"UNKNOWN":record.code):"NOT SENT"),
  "REQUEST MESSAGE: "+(record?record.message:"未发送分享请求"),
  "HTTP STATUS: "+(record&&record.httpStatus!==null?record.httpStatus:"UNKNOWN"),
  "OFFICIAL SHARE STATE: "+(state===null?"UNKNOWN":String(state)),
  "RESULT: "+outcome,
  state===true?"CONFIRMED":"NOT CONFIRMED",
  note
 ].join("\n");
 panel=P(content,state===true);$notification.post(N,"单次分享测试结果",content);
}
function P(content,success=false){return{title:N,content,icon:success?"checkmark.circle.fill":"paperplane","icon-color":success?"#34C759":"#FF9F0A"}}
function readPanel(){const p=parse($persistentStore.read(SK));return p&&typeof p.content==="string"?P(p.content):null}
function savePanel(){try{$persistentStore.write(JSON.stringify(panel),SK)}catch(_){}}
function finish(value){if(done)return;done=true;isPanel()?$done(value):$done()}

// Same ownership/TTL contract as Daily, so a manual test cannot overlap the 08:00 job.
async function lock(){const now=Date.now(),current=readLock();if(current&&current.expiresAt>now)return false;owner=now.toString(36)+"-"+Math.random().toString(36).slice(2,12);if(!$persistentStore.write(JSON.stringify({owner,expiresAt:now+TTL}),LK))return false;for(let i=0;i<2;i++){await sleep(120);if(!ownsLock())return false}held=true;return true}
function readLock(){const r=parse($persistentStore.read(LK));return r&&r.owner&&Number.isFinite(Number(r.expiresAt))?{owner:String(r.owner),expiresAt:Number(r.expiresAt)}:null}
function ownsLock(){const r=readLock();return!!(r&&r.owner===owner&&r.expiresAt>Date.now())}
function unlock(){if(held&&ownsLock())$persistentStore.write("",LK);held=false;owner=""}
