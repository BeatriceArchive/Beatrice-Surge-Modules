/*
 * Beatrice Surge Modules
 * Copyright (c) 2026 BeatriceArchive. See repository LICENSE.
 */
const N="贝蒂的哔哩哔哩每日签到",V="1.12.2";
const CK="betty.bilibili.cookie",MK="betty.bilibili.cookie.meta",BK="betty.bilibili.cookie.invalid_notice";
const LK="betty.bilibili.daily.run_lock",SK="betty.bilibili.daily.panel_state",SC="official-qr-home-v3";
const SESSION="betty.bilibili.cookie.session";
const SHARE_KEY="betty.bilibili.daily.share_attempt.";
const SHARE_RETRY_MS=60000;
const COIN_KEY="betty.bilibili.daily.coin_budget.";
const MAX=5,TO=7,TTL=360000,RUN_MS=270000,COIN_MAX_WRITES=10,COIN_MAX_34004=3;
const UA="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const HOME="https://www.bilibili.com/",ACC="https://account.bilibili.com/";
const A={
 nav:"https://api.bilibili.com/x/web-interface/nav",
 daily:"https://api.bilibili.com/x/member/web/exp/reward",
 coinExp:"https://api.bilibili.com/x/web-interface/coin/today/exp",
 dyn:"https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video",
 rank:"https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all",
 view:"https://api.bilibili.com/x/web-interface/view",
 hb:"https://api.bilibili.com/x/click-interface/web/heartbeat",
 share:"https://api.bilibili.com/x/web-interface/share/add",
 coins:"https://api.bilibili.com/x/web-interface/archive/coins",
 coinAdd:"https://api.bilibili.com/x/web-interface/coin/add",
 vipExp:"https://api.bilibili.com/x/vip/experience/add"
};
let done=false,owner="",held=false,runDay="",runCookie="",deadline=0;
const videoHints=Object.create(null);
let rankFetched=false;
let panel=readState()||P("每天 08:00 自动执行｜点击刷新立即运行","calendar.badge.checkmark","#8E8E93");
main().finally(()=>{try{if(held)saveState(panel);unlock()}finally{finish(panel)}});

async function main(){
 try{
  if(isAuto()){panel=readState()||panel;return}
  if(!(await lock())){panel=P("⚠️ 任务正在运行｜未启动重复实例","clock.fill","#FF9F0A");return}
  runDay=shareDay();deadline=Date.now()+RUN_MS;
  await run();
 }catch(e){
  if(e&&e.failure){fatal(e.failure);return}
  if(e&&e.stopped){panel=P("⚠️ 本轮已停止｜"+e.message,"exclamationmark.triangle.fill","#FF9F0A");notify("本轮已停止",e.message+"；已提交的投币记录会保留。");return}
  panel=P("❌ 执行失败｜脚本异常","xmark.circle.fill","#FF3B30");
  notify("执行失败","脚本内部异常；未确认的投币不会自动重试。请稍后检查任务状态。");
 }
}

async function run(){
 const savedSession=readSession(),cookie=savedSession.cookie,meta=savedSession.meta;
 if(!cookie||!meta||meta.verified!==true||meta.schema!==SC){
  panel=P("❌ 无法执行｜请重新获取有效 Cookie","xmark.circle.fill","#FF3B30");
  notify("Cookie 会话需要更新","请刷新 Cookie Panel 重新扫码。");return;
 }
 const cm=parseCookie(cookie),miss=["SESSDATA","bili_jct","DedeUserID","buvid3"].filter(k=>!cm[k]);
 if(miss.length){bad("缺少 "+miss.join("、"));return}
 if(/[\x00-\x1f\x7f]/.test(cookie)||!/^\d+$/.test(cm.DedeUserID)||String(meta.uid||"")!==cm.DedeUserID){bad("Cookie 与账号验证标记不一致");return}
 runCookie=cookie;
 const nav=await get(A.nav,cookie,HOME,1);
 const navError=classify(nav,"登录验证");if(navError&&navError.fatal){fatal(navError);return}
 if(!logged(nav)){
  if(code(nav)===0&&nav.data&&nav.data.isLogin===false)bad("账号未登录");
  else{panel=P("⚠️ 登录状态查询失败｜Cookie 未标记失效","exclamationmark.triangle.fill","#FF9F0A");notify("登录状态查询失败",reason(nav,"网络异常或响应不可识别")+"；本轮未执行任务写入。");}return;
 }
 const user=nav.data,uid=String(user.mid||"");
 if(String(meta.uid)!==uid||cm.DedeUserID!==uid){bad("Cookie UID 与验证标记不一致");return}
 $persistentStore.write("",BK);
 const csrf=cm.bili_jct,bal0=int(user.money),levelExp0=currentLevelExp(user);
 const st0=await status(cookie);
 if(!st0){panel=P("❌ 执行失败｜状态查询失败","xmark.circle.fill","#FF3B30");notify("状态查询失败","未执行写操作。");return}
 const fx0=await coinExp(cookie),c0=confirmedCoins(fx0,st0);
 const errs=[];let watchErr=null,shareErr=null,coinErr=null,coinMeta=null;
 const needCoins=c0!==null&&c0<MAX&&bal0!==null&&bal0>0;
 const needVideo=!st0.watch||!st0.share||needCoins,list=needVideo?await videos(cookie):[];

 let watched=null;
 if(!st0.watch){
  const r=await watch(list,uid,csrf,cookie);
  if(r.err&&r.err.fatal){fatal(r.err);return}
  watchErr=r.err||null;if(r.err)errs.push(r.err);watched=r.video;
 }
 const stAfterWatch=(await status(cookie,0))||st0;
 const vipBefore=isVip(user)&&stAfterWatch.watch?await getLevelExp(cookie):null;
 const vip=await vipExperience(csrf,cookie,user,stAfterWatch.watch,vipBefore);
 if(vip.err&&vip.err.fatal){fatal(vip.err);return}
 if(vip.err)errs.push(vip.err);

 let shareConfirmed=st0.share||stAfterWatch.share;
 if(!shareConfirmed){
  const e=await share(list,watched,uid,csrf,cookie);
  if(e&&e.fatal){fatal(e);return}
  shareConfirmed=!e;
  shareErr=e||null;if(e)errs.push(e);
 }

 let spent=0;
 const live=confirmedCoins(await coinExp(cookie,0),stAfterWatch);
 if(live!==null&&live<MAX&&bal0!==null&&bal0>0){
   if(list.length<Math.min(MAX-live,bal0))await moreVideos(list,cookie);
   const r=await coins(list,MAX,Math.max(c0||0,live),uid,csrf,cookie,bal0);
   spent=r.spent;coinMeta=r.meta||null;
   if(r.err&&r.err.fatal){fatal(r.err);return}
   coinErr=r.err||null;if(r.err)errs.push(r.err);
 }

 await sleep(1200);
 const finalStatus=await status(cookie,0),lastStatus=finalStatus||stAfterWatch,st={...lastStatus,share:shareConfirmed||lastStatus.share},fx=await coinExp(cookie,0),fc=confirmedCoins(fx,finalStatus);
 const nav2=await get(A.nav,cookie,HOME,1);checkRead(nav2,"最终账号查询");const nav2ok=logged(nav2)&&String(nav2.data.mid)===uid;
 const bal=nav2ok?int(nav2.data.money):null;
 const levelExp1=nav2ok?currentLevelExp(nav2.data):null;
 const limited=fc!==null&&fc<MAX&&(bal===0||coinMeta&&coinMeta.balanceLimited),coinOK=fc!==null&&fc>=MAX;
 const coreOK=!!(finalStatus&&st.login&&st.watch&&coinOK&&vip.done!==false),shareOK=!!st.share,ct=fc===null?"未知/5":fc+"/5";
 const daily0=taskExp(st0,fx0,c0),daily1=taskExp(finalStatus?st:null,fx,fc),vipShort=vipPanel(vip);
 if(coreOK&&shareOK){
  const lead="✅ 今日任务已完成";
  panel=P(lead+"｜投币 "+ct+"｜"+vipShort,"checkmark.circle.fill","#34C759");
 }else{
  panel=P([finalStatus?"⚠️ 今日任务部分完成":"⚠️ 最终状态未确认","投币 "+ct+(limited?"（余额不足）":""),shareOK?"分享✅":shareErr&&shareErr.pending?"分享待确认":"分享❌",vipShort].join("｜"),"exclamationmark.triangle.fill","#FF9F0A");
 }
 const lines=[
  taskNotice("登录",st0.login,st.login,null),
  taskNotice("观看",st0.watch,st.watch,watchErr),
  vipNotice(vip),
  taskNotice("分享",st0.share,st.share,shareErr),
  coinNotice(c0,fc,limited,coinErr,coinMeta,spent),
  levelExpNotice(levelExp0,levelExp1),
  dailyExpNotice(daily0,daily1),
  "硬币余额 "+(bal===null?"未知":bal)
 ];
 if(!finalStatus)lines.push("最终每日任务查询失败；上列登录/观看/分享为本轮较早状态，不代表最终确认。");
 if(errs.length)lines.push("异常："+errs.map(e=>e.stage+" code "+(e.code==null?"未知":e.code)).join("；"));
 notify(coreOK&&shareOK?"✅ 今日可执行任务已完成":"⚠️ 今日任务部分完成",lines.join("\n"));
}

async function vipExperience(csrf,cookie,user,watchDone,beforeExp){
 if(!isVip(user))return{done:null,label:"非大会员",delta:null,err:null};
 if(!watchDone)return{done:false,label:"前置观看未完成",delta:null,err:op("大会员经验",null,"领取需要先完成观看任务")};
 const r=await postForm(A.vipExp,form({mid:String(user.mid||""),buvid:parseCookie(cookie).buvid3,csrf}),cookie,ACC,"https://account.bilibili.com");
 const e=classify(r,"大会员经验");if(e)return{done:false,label:"领取失败",delta:null,err:e};
 const cd=code(r);
 if(cd!==0&&cd!==69198)return{done:false,label:"领取失败",delta:null,err:op("大会员经验",cd,reason(r,"领取失败"))};
 await sleep(700);
 const afterExp=await getLevelExp(cookie),delta=beforeExp!==null&&afterExp!==null?afterExp-beforeExp:null;
 if(cd===69198)return{done:true,label:"今日已领取",delta:delta,err:null};
 return{done:true,label:delta!==null&&delta>=10?"本次领取 +10":"领取成功，经验待同步",delta:delta,err:null};
}
function isVip(u){const a=num(u&&u.vipStatus);if(a!==null)return a===1;return num(u&&u.vip&&u.vip.status)===1}
async function getLevelExp(cookie){const b=await get(A.nav,cookie,HOME,1);checkRead(b,"等级经验查询");return logged(b)?currentLevelExp(b.data):null}
async function status(cookie,r=1){const b=await get(A.daily,cookie,HOME,r);checkRead(b,"每日任务查询");if(!b||code(b)!==0||!b.data)return null;const d=b.data;if(typeof d.login!=="boolean"||typeof d.watch!=="boolean"||typeof d.share!=="boolean")return null;if(d.share)rememberShare(parseCookie(cookie).DedeUserID);return{login:d.login,watch:d.watch,share:d.share,coins:num(d.coins)}}
function rememberShare(uid){
 if(!/^\d+$/.test(String(uid||"")))return;
 const key=SHARE_KEY+uid,day=shareDay();let saved=null;
 try{saved=JSON.parse($persistentStore.read(key)||"null")}catch(_){}
 if(saved&&saved.day===day&&saved.confirmed===true)return;
 // Official completion may come from another client, without a local POST.
 // Preserve same-day attempt diagnostics; never carry yesterday's evidence.
 const record=saved&&saved.day===day?{...saved,confirmed:true}:{version:4,day,tries:0,requestSucceeded:false,code:null,confirmed:true};
 $persistentStore.write(JSON.stringify(record),key);
}
async function coinExp(cookie,r=1){const b=await get(A.coinExp,cookie,HOME,r);checkRead(b,"投币经验查询");return b&&code(b)===0?num(b.data):null}

async function videos(cookie){
 const out=[],seen={};
 const b=await get(A.dyn,cookie,HOME,0);checkRead(b,"动态视频查询");const it=b&&code(b)===0&&b.data&&Array.isArray(b.data.items)?b.data.items:[];for(const z of it){const archive=z&&z.modules&&z.modules.module_dynamic&&z.modules.module_dynamic.major&&z.modules.module_dynamic.major.archive;if(add(out,seen,archive&&archive.bvid,archive)&&out.length>=16)break}
 if(!out.length)await moreVideos(out,cookie);
 shuffle(out);return out;
}
async function moreVideos(out,cookie){
 if(rankFetched)return;rankFetched=true;const seen=Object.create(null);out.forEach(v=>{seen[v]=1});
 const b=await get(A.rank,cookie,HOME,0);checkRead(b,"候选视频查询");const it=b&&code(b)===0&&b.data&&Array.isArray(b.data.list)?b.data.list:[];
 for(const z of it)if(add(out,seen,z&&z.bvid,z)&&out.length>=20)break;
}
function add(a,s,v,h){if(typeof v!=="string"||!/^BV[0-9A-Za-z]{8,20}$/.test(v)||s[v])return false;s[v]=1;a.push(v);const aid=num(h&&h.aid);if(Number.isSafeInteger(aid)&&aid>0)videoHints[v]={aid,bvid:v};return true}
async function video(bvid,cookie){const b=await get(A.view+"?bvid="+encodeURIComponent(bvid),cookie,HOME+"video/"+bvid,0);checkRead(b,"视频资料查询");if(!b||code(b)!==0||!b.data)return null;const d=b.data,aid=num(d.aid),pg=Array.isArray(d.pages)&&d.pages[0],cid=num(d.cid||(pg&&pg.cid)),duration=int((pg&&pg.duration)||d.duration),ownerMid=d.owner?num(d.owner.mid):null,copyright=int(d.copyright);return aid>0&&cid>0?{aid,cid,bvid,duration,ownerMid,copyright}:null}

async function watch(list,uid,csrf,cookie){
 for(let i=0;i<Math.min(list.length,5);i++){
  const v=await video(list[i],cookie);if(!v)continue;
  let b=await hb(v,uid,csrf,cookie,0,0),e=classify(b,"观看");if(e)return{err:e,video:null};if(code(b)!==0)continue;
  await sleep(800);const t=rand(1,Math.max(1,Math.min(15,v.duration||15)));
  b=await hb(v,uid,csrf,cookie,t,t);e=classify(b,"观看");if(e)return{err:e,video:null};
  if(code(b)===0){await sleep(500);const s=await status(cookie,0);if(s&&s.watch)return{err:null,video:v}}
  if(code(b)===null){await sleep(500);const s=await status(cookie,0);if(s&&s.watch)return{err:null,video:v}}
 }
 return{err:op("观看",null,"未确认观看完成"),video:null};
}
function hb(v,uid,csrf,cookie,t,rt){return postForm(A.hb+"?aid="+encodeURIComponent(v.aid)+"&played_time="+t,form({aid:v.aid,bvid:v.bvid,cid:v.cid,mid:uid,played_time:t,realtime:rt,real_played_time:rt,start_ts:Math.floor(Date.now()/1000)-rt,type:3,dt:2,play_type:3,csrf}),cookie,HOME+"video/"+v.bvid)}

async function share(list,watched,uid,csrf,cookie){
 const before=await get(A.daily,cookie,HOME,0),beforeError=classify(before,"分享状态");
 if(beforeError)return beforeError;
 if(!before||code(before)!==0||!before.data||typeof before.data.share!=="boolean")return op("分享",null,"无法查询任务状态，未执行写入");
 if(before.data.share){
  rememberShare(uid);
  return null;
 }
 const day=shareDay(),key=SHARE_KEY+uid;
 const saved=$persistentStore.read(key);let attempt=null;
 if(saved){
  try{attempt=JSON.parse(saved);if(!attempt||!validShareDay(attempt.day)||attempt.day>day)throw new Error();}
  catch(_){
   // Unknown attempt time: consume today conservatively, but recover tomorrow.
   const quarantined={version:2,day,requestSucceeded:false,code:null,confirmed:false,quarantined:true};
   if(!$persistentStore.write(JSON.stringify(quarantined),key))return op("分享",null,"尝试记录损坏且无法修复，未执行写入");
   return op("分享",null,"尝试记录已修复；今日暂停分享写入，明日起恢复");
  }
 }
 let tries=1,repair=false,priorAttempt=null;
 if(attempt&&attempt.day===day){
  if(attempt.confirmed===true)return null;
  const rejected=shareRejected(attempt),count=shareTries(attempt);
  // Only an explicit API rejection may be retried, once, on a later button
  // press. Cron, ambiguous responses and accepted requests never retry.
  const manual=isPanel()&&typeof $trigger!=="undefined"&&$trigger==="button";
  const cooled=!attempt.submittedAt||Date.now()-attempt.submittedAt>=SHARE_RETRY_MS;
  // One migration recovery is available only for an explicit v3 rejection
  // that exhausted the old flow. It must establish the new video context
  // first, and is durably consumed even if preparation fails or is killed.
  repair=rejected&&manual&&cooled&&attempt.version===3&&count===2&&!attempt.repairUsed;
  if(!rejected||!manual||!cooled||(count>=2&&!repair))return attempt.code===-403||attempt.code===403?shareFailure(attempt,cookie,false):confirmShare(cookie,attempt,key);
  tries=count+1;
  priorAttempt=attempt;
 }
 let v=watched;
 if(!v)for(let i=0;i<Math.min(list.length,4);i++){v=await shareVideo(list[i],cookie);if(v)break}
 if(!v)return op("分享",null,"没有可用视频");
 if(repair){
  checkRun(TO*1000);
  const reserved={...priorAttempt,version:4,repairUsed:true,repairReservedAt:Date.now(),context:"open-video-v1",opened:false,preparationOnly:true};
  if(!$persistentStore.write(JSON.stringify(reserved),key))return op("分享",null,"无法保存恢复记录，未执行准备或分享写入");
 }
 const prepared=await openShareVideo(v,watched,uid,csrf,cookie);
 if(prepared.err&&prepared.err.fatal)return prepared.err;
 if(repair&&!prepared.opened){
  const failure=shareFailure(priorAttempt,cookie,false);
  return{...failure,message:"新视频打开未获确认，本轮未补试分享；今日不再补试",detail:failure.detail+"\n准备结果："+(prepared.err?prepared.err.message:"无法获取播放资料")};
 }
 v=prepared.video||v;
 // Persist before sending: a timeout or killed script must not cause another write.
 if(shareDay()!==day)return op("分享",null,"准备期间已跨日，留待下次正常执行");
 checkRun(TO*1000);
 attempt={version:4,day,tries,submittedAt:Date.now(),requestSucceeded:false,code:null,confirmed:false,httpStatus:null,message:"",context:"open-video-v1",opened:prepared.opened,repairUsed:repair};
 if(!$persistentStore.write(JSON.stringify(attempt),key))return op("分享",null,"无法保存尝试记录，未执行写入");
 // Fixed task-oriented request, aligned with current BLTH. No parameter retries.
 const target=v.aid?{aid:v.aid}:{bvid:v.bvid};
 const b=await postForm(A.share,form({...target,csrf,source:"pc_client_normal",eab_x:2,ramval:0,ga:1}),cookie,HOME+"video/"+v.bvid+"/"),e=classify(b,"分享");
 attempt.code=code(b);attempt.requestSucceeded=attempt.code===0||attempt.code===71000;
 attempt.httpStatus=num(b&&b.__httpStatus);attempt.message=shareMessage(b&&(b.message||b.msg),cookie,csrf);
 if(!$persistentStore.write(JSON.stringify(attempt),key))attempt.tries=2;
 if(e&&e.fatal)return{...e,message:attempt.message||"B站拒绝了分享请求"};
 if(attempt.code===-403||attempt.code===403){
  // A rejection is not completion, but another client may already have
  // completed today's task. Reconcile once before showing the rejection.
  const state=await get(A.daily,cookie,HOME,0),failure=classify(state,"分享确认");
  if(failure&&failure.fatal)return failure;
  if(state&&code(state)===0&&state.data&&state.data.share===true){attempt.confirmed=true;$persistentStore.write(JSON.stringify(attempt),key);return null}
  return shareFailure(attempt,cookie,true);
 }
 return confirmShare(cookie,attempt,key,true);
}
async function openShareVideo(target,watched,uid,csrf,cookie){
 if(watched&&watched.cid)return{opened:true,video:watched,err:null};
 const v=target.cid?target:await video(target.bvid,cookie);
 if(!v)return{opened:false,video:target,err:op("分享准备",null,"视频播放资料不可用")};
 // Match BiliBiliToolPro's OpenVideo even when today's watch task is done.
 // Playback metadata/open failure stays optional for ordinary sharing.
 const response=await hb(v,uid,csrf,cookie,0,0),err=classify(response,"分享准备");
 return{opened:code(response)===0,video:v,err:err||(code(response)===0?null:op("分享准备",code(response),reason(response,"打开视频结果未确认")))};
}
function shareTries(a){return [3,4].includes(a.version)?(Number.isInteger(a.tries)&&a.tries>=1?a.tries:2):1}
function shareRejected(a){return [403,-403].includes(a.code)&&a.requestSucceeded===false&&a.confirmed===false&&!a.quarantined&&([3,4].includes(a.version)?Number.isInteger(a.httpStatus)&&a.httpStatus>=200&&a.httpStatus<300&&Number.isFinite(a.submittedAt)&&a.submittedAt>0:a.code===-403&&(a.version===2||a.version==null))}
function shareMessage(value,cookie,csrf){
 let s=String(value||"");const secrets=[csrf,...Object.values(parseCookie(cookie))].filter(v=>typeof v==="string"&&v.length>0).sort((a,b)=>b.length-a.length);
 for(const v of secrets){const tokens=[v,encodeURIComponent(v)];try{tokens.push(decodeURIComponent(v))}catch(_){}for(const token of tokens)if(token)s=s.split(token).join("[已隐藏]");}
 return txt(s.replace(/https?:\/\/[^\s]+/gi,"[链接已隐藏]").replace(/[A-Za-z0-9_%+\/=.-]{24,}/g,"[已隐藏]"),100);
}
function shareFailure(a,cookie,fresh){
 const migration=shareRejected(a)&&a.version===3&&shareTries(a)===2&&!a.repairUsed;
 const retry=shareRejected(a)&&shareTries(a)<2||migration,remaining=a.submittedAt?Math.max(0,Math.ceil((a.submittedAt+SHARE_RETRY_MS-Date.now())/1000)):0;
 const recovery=retry?(remaining?remaining+" 秒后可手动刷新重试一次":migration?"可手动刷新，补开视频后恢复一次":"可手动刷新重试一次"):"今日不再提交分享";
 const when=Number.isFinite(a.submittedAt)&&a.submittedAt>0?new Date(a.submittedAt+8*3600000).toISOString().slice(11,19):"旧版未记录";
 const message=shareMessage(a.message,cookie,parseCookie(cookie).bili_jct)||"旧版未保留或响应无 message";
 return{...op("分享",a.code,"服务端拒绝分享；"+recovery),detail:(fresh?"本轮已提交":"历史失败，本轮未提交")+"｜请求时间 "+when+"（北京时间）｜HTTP "+(a.httpStatus==null?"未知":a.httpStatus)+"\n服务端信息："+message+(a.context?"\n分享前打开视频："+(a.preparationOnly?"未确认，恢复已停止":a.opened?"已确认":"未确认，已降级直发"):"")};
}
// Sharing needs an archive identifier, not the playback CID/duration. Prefer
// identifiers already returned by the official feed; a view failure must not
// turn an otherwise valid BVID into an unusable share target.
async function shareVideo(bvid,cookie){
 if(typeof bvid!=="string"||!/^BV[0-9A-Za-z]{8,20}$/.test(bvid))return null;
 if(videoHints[bvid])return videoHints[bvid];
 const b=await get(A.view+"?bvid="+encodeURIComponent(bvid),cookie,HOME+"video/"+bvid,0);checkRead(b,"分享视频查询");
 if([-404,62002,62004].includes(code(b)))return null;
 const data=code(b)===0&&b.data?b.data:null,aid=num(data&&data.aid),cid=num(data&&(data.cid||(Array.isArray(data.pages)&&data.pages[0]&&data.pages[0].cid)));
 return Number.isSafeInteger(aid)&&aid>0?{aid,bvid,...(cid>0?{cid}:{})}:{bvid};
}
function shareDay(){return new Date(Date.now()+8*3600000).toISOString().slice(0,10)}
function validShareDay(day){return typeof day==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+"T00:00:00Z"))&&new Date(day+"T00:00:00Z").toISOString().slice(0,10)===day}
async function confirmShare(cookie,attempt,key,fresh=false){
 for(const delay of [0,1200,2500,5000,10000]){
  if(delay)await sleep(delay);
  const b=await get(A.daily,cookie,HOME,0),e=classify(b,"分享确认");
  if(e)return e;
  if(b&&code(b)===0&&b.data&&b.data.share===true){attempt.confirmed=true;$persistentStore.write(JSON.stringify(attempt),key);return null}
 }
 const pending=attempt.requestSucceeded===true||attempt.code==null;
 const failure=shareFailure(attempt,cookie,fresh);
 return{...op("分享",attempt.code,pending?"分享结果未确定，经验待确认；再次刷新仅查询到账，不重复分享":"分享未确认；本地重复提交保护生效，今日不再提交"),pending,...(!pending?{detail:failure.detail}:{})};
}

async function coins(list,goal,start,uid,csrf,cookie,balance=MAX){
 const day=shareDay(),key=COIN_KEY+uid;
 let ledger=readCoinLedger(key,day),cur=Math.max(start,ledger.count),spent=0,writes=0,hit34004=0,last=null;
 if(ledger.pending)return coinResult(cur,spent,writes,hit34004,op("投币",null,"上次结果未确认或记录损坏；今日暂停投币，次日恢复"));
 for(let i=0;i<24&&cur<goal&&spent<balance&&writes<COIN_MAX_WRITES;i++){
  // Feed length does not imply eligibility: deleted, own or already-full
  // archives can exhaust it. Expand at most once, within the same budget.
  if(i>=list.length){await moreVideos(list,cookie);if(i>=list.length)break}
  if(shareDay()!==day)return coinResult(cur,spent,writes,hit34004,op("投币",null,"执行期间已跨日，已停止投币"));
  const live=coinCount(await coinExp(cookie,0));
  if(live===null)return coinResult(cur,spent,writes,hit34004,op("投币",null,"无法确认当前投币经验，未继续写入"));
  cur=Math.max(cur,live);if(cur>=goal||cur>=MAX)break;
  const v=await video(list[i],cookie);if(!v||(v.ownerMid!==null&&String(v.ownerMid)===String(uid)))continue;
  const c=await get(A.coins+"?aid="+v.aid,cookie,HOME+"video/"+v.bvid,0),ce=classify(c,"投币前检查");
  if(ce&&ce.fatal)return coinResult(cur,spent,writes,hit34004,ce);
  if(ce)return coinResult(cur,spent,writes,hit34004,ce);
  if(!c||code(c)!==0||!c.data)continue;
  const already=int(c.data.multiply),limit=v.copyright===1?2:1;if(already===null||already>=limit)continue;
  // Reserve durably BEFORE sending. A killed/ambiguous request remains blocked
  // for this Beijing day, even when EXP is delayed or another run starts.
  if(shareDay()!==day)return coinResult(cur,spent,writes,hit34004,op("投币",null,"准备期间已跨日，未执行写入"));
  checkRun(TO*1000);
  ledger={version:1,day,count:cur+1,pending:true};
  if(!$persistentStore.write(JSON.stringify(ledger),key))return coinResult(cur,spent,writes,hit34004,op("投币",null,"无法保存投币记录，未执行写入"));
  writes++;
  const r=await postForm(A.coinAdd,form({aid:v.aid,multiply:1,select_like:0,cross_domain:"true",csrf,eab_x:2,ramval:3,source:"web_normal",ga:1}),cookie,HOME+"video/"+v.bvid),fe=classify(r,"投币"),cd=code(r),hs=num(r&&r.__httpStatus);
  const rejected=[-101,-111,-102,-104,-403,403,-400,10003,34002,34003,34004,34005].includes(cd);
  if(cd!==0&&!rejected||hs===null||hs<200||hs>=300){
   return coinResult(cur,spent,writes,hit34004,fe&&fe.fatal?fe:op("投币",cd,"结果不确定；今日停止投币，不自动重试"));
  }
  if(cd===0){spent++;cur=Math.min(MAX,cur+1);}
  ledger={version:1,day,count:cur,pending:false};
  if(!$persistentStore.write(JSON.stringify(ledger),key))return coinResult(cur,spent,writes,hit34004,op("投币",null,"投币结果记录保存失败；已停止后续投币"));
  if(fe&&fe.fatal)return coinResult(cur,spent,writes,hit34004,fe);
  if(cd===0){last=null;if(cur<goal&&spent<balance)await sleep(rand(3000,5000));continue}
  if(cd===-104)return coinResult(cur,spent,writes,hit34004,null,true);
  if(cd===34004){hit34004++;last=op("投币",cd,"投币间隔太短，已换视频继续");if(hit34004>=COIN_MAX_34004)return coinResult(cur,spent,writes,hit34004,last);await sleep(rand(5000,8000));continue}
  if(cd===-403||cd===403)return coinResult(cur,spent,writes,hit34004,op("投币",cd,"账号/操作被拒绝，已停止后续投币写入"));
  if([-400,10003,34002,34003,34005].includes(cd)){last=op("投币",cd,reason(r,"当前视频不可投币"));await sleep(rand(1500,3000));continue}
  return coinResult(cur,spent,writes,hit34004,op("投币",cd,reason(r,"未知错误，已停止后续投币")));
 }
 const finalLive=coinCount(await coinExp(cookie,0));if(finalLive!==null)cur=Math.max(cur,finalLive);
 const balanceLimited=cur<goal&&spent>=balance;
 const err=cur<goal&&!balanceLimited?(last||op("投币",null,"达到候选/写入上限，未能补满目标")):null;
 return coinResult(cur,spent,writes,hit34004,err,balanceLimited);
}
function readCoinLedger(key,day){
 const raw=$persistentStore.read(key);if(!raw)return{version:1,day,count:0,pending:false};
 try{const v=JSON.parse(raw);if(!v||v.version!==1||!validShareDay(v.day)||v.day>day||!Number.isInteger(v.count)||v.count<0||v.count>MAX||typeof v.pending!=="boolean")throw new Error();return v.day===day?v:{version:1,day,count:0,pending:false};}
 catch(_){const v={version:1,day,count:MAX,pending:true};$persistentStore.write(JSON.stringify(v),key);return v;}
}
function coinResult(count,spent,writes,hit34004,err,balanceLimited=false){return{count,spent,err,meta:{writes,hit34004,balanceLimited}}}

function get(u,c,r,n=0){return req("GET",u,"",c,r,n,null,null)}
function postForm(u,b,c,r,o="https://www.bilibili.com"){return req("POST",u,b,c,r,0,o,"application/x-www-form-urlencoded; charset=UTF-8")}
async function req(m,u,b,c,r,n,o,ct){let x=null;for(let i=0;i<=n;i++){checkRun(TO*1000);x=await raw(m,u,b,c,r,o,ct);checkRun();if(m!=="GET"||!x.retry||i===n)return x.body;await sleep(300*(i+1))}return null}
function raw(m,u,b,c,r,o,ct){return new Promise(ok=>{const h={"User-Agent":UA,Accept:"application/json, text/plain, */*","Accept-Language":"zh-CN,zh-Hans;q=0.9,en;q=0.8",Cookie:c,Referer:r||HOME};if(m==="POST"){h["Content-Type"]=ct||"application/x-www-form-urlencoded; charset=UTF-8";if(o)h.Origin=o}const q={url:u,headers:h,timeout:TO,"auto-cookie":false,"auto-redirect":false};if(b)q.body=b;const cb=(e,res,data)=>{if(e){ok({body:null,retry:true});return}const hs=num(res&&res.status);let j=parse(data);if(!j||typeof j!=="object"||Array.isArray(j))j=null;if(j&&hs!==null)j.__httpStatus=hs;if(hs===null){ok({body:null,retry:true});return}if(hs<200||hs>=300){if(!j)j={code:hs,message:"HTTP "+hs,__httpStatus:hs};ok({body:j,retry:m==="GET"&&hs>=500});return}ok({body:j,retry:m==="GET"&&!j})};m==="POST"?$httpClient.post(q,cb):$httpClient.get(q,cb)})}
function classify(b,stage){const c=code(b),m=txt(b&&(b.message||b.msg)||"B站拒绝了请求",120);if(c===-101||c===-111)return{fatal:true,type:"cookie",stage,code:c,message:m};if(c===-102)return{fatal:true,type:"account",stage,code:c,message:m};if([-352,-412,412,429,-509,509].includes(c))return{fatal:true,type:"risk",stage,code:c,message:m};if(c===-403||c===403)return op(stage,c,m);return null}
function checkRead(b,stage){let e=classify(b,stage);if(code(b)===0&&b.data&&b.data.isLogin===false)e={fatal:true,type:"cookie",stage,code:-101,message:"账号未登录"};if(e&&e.fatal){const error=new Error(stage);error.failure=e;throw error;}}
function op(stage,code,message){return{fatal:false,type:"operation",stage,code,message:txt(message,120)}}
function fatal(e){const c=e.code==null?"未知":String(e.code),d="阶段："+e.stage+"\ncode："+c+"\nmessage："+e.message;if(e.type==="cookie"){panel=P("❌ "+e.stage+"失败｜code "+c+"，请重新扫码","xmark.circle.fill","#FF3B30");bad(d)}else{panel=P("❌ "+e.stage+"被拒绝｜code "+c,"xmark.circle.fill","#FF3B30");notify("B站请求被拒绝",d+"\n已停止后续写入任务。")}}
function bad(r){panel=P("❌ Cookie 已失效｜请重新扫码","xmark.circle.fill","#FF3B30");const d=shareDay();if($persistentStore.read(BK)!==d){$persistentStore.write(d,BK);notify("❌ Cookie 已失效，请重新扫码","原因："+txt(r,150))}}

function vipPanel(v){return v.done===null?"大会员经验➖":v.done?"大会员经验✅":"大会员经验⚠️"}
function vipNotice(v){if(v.done===null)return"大会员经验 ➖ 非大会员";if(v.done)return"大会员经验 ✅ "+v.label;const c=v.err&&v.err.code!=null?" code "+v.err.code:"";return"大会员经验 ❌ "+v.label+c}
function currentLevelExp(u){return num(u&&u.level_info&&u.level_info.current_exp)}
function taskExp(s,fx,fc){if(!s)return null;const count=fc==null?confirmedCoins(fx,s):fc;if(count===null)return null;return(s.login?5:0)+(s.watch?5:0)+(s.share?5:0)+count*10}
function taskNotice(name,before,after,err){if(after)return name+" ✅ "+(before?"已完成":"本次完成");const c=err&&err.code!=null?" code "+err.code:"";return name+(err&&err.pending?" ⏳ 待确认":" ❌ 未完成")+c+(err&&err.message?"｜"+err.message:"")+(err&&err.detail?"\n"+err.detail:"")}
function coinNotice(before,after,limited,err,meta,spent=0){let s="投币 "+(after==null?"未知/5":after+"/5")+"（官方经验）｜本次明确成功 "+spent+" 枚";if(meta)s+="｜写入 "+meta.writes+" 次"+(meta.hit34004?"｜34004×"+meta.hit34004:"");if(limited)s+="｜余额不足";if(err)s+="｜"+err.message;if(spent&&before!==null&&after!==null&&after-before<spent)s+="｜经验待同步";return s}
function levelExpNotice(a,b){if(a===null||b===null)return"账号等级经验 未能读取前后值";const d=b-a;return"账号等级经验 "+a+" → "+b+"（"+(d>=0?"+":"")+d+"）"}
function dailyExpNotice(a,b){if(a===null||b===null)return"每日普通任务经验 未能读取前后值";const d=b-a;return"每日普通任务经验 "+a+"/65 → "+b+"/65（"+(d>=0?"+":"")+d+"）"}

function readSession(){
 const raw=$persistentStore.read(SESSION);
 if(raw){try{const value=JSON.parse(raw);if(value&&value.version===1&&typeof value.cookie==="string"&&value.meta)return value;}catch(_){}return{cookie:"",meta:null}}
 return{cookie:$persistentStore.read(CK)||"",meta:readMeta()};
}
function readMeta(){const x=$persistentStore.read(MK);if(!x)return null;try{const v=JSON.parse(x);return v&&typeof v==="object"?v:null}catch(_){return null}}
function parseCookie(x){const o={};String(x||"").split(";").forEach(z=>{const i=z.indexOf("=");if(i>0)o[z.slice(0,i).trim()]=z.slice(i+1)});return o}
function form(o){return Object.keys(o).filter(k=>o[k]!=null).map(k=>encodeURIComponent(k)+"="+encodeURIComponent(String(o[k]))).join("&")}
function parse(v){if(v==null||v==="")return null;try{return typeof v==="string"?JSON.parse(v):v}catch(_){return null}}
function num(v){if(typeof v!=="number"&&typeof v!=="string"||typeof v==="string"&&!v.trim())return null;const n=Number(v);return Number.isFinite(n)?n:null}
function int(v){const n=num(v);return n===null||n<0?null:Math.floor(n)}
function code(b){const h=num(b&&b.__httpStatus);if(h!==null&&(h<200||h>=300))return h;const c=num(b&&b.code);return c!==null?c:null}
function logged(b){return!!(b&&code(b)===0&&b.data&&b.data.isLogin===true)}
function reason(b,f){if(!b)return f;const c=code(b),m=txt(b.message||b.msg||f,120);return c===null?m:c+" "+m}
function coinCount(x){const n=num(x);return n===null||n<0||n%10!==0?null:Math.min(MAX,n/10)}
function confirmedCoins(fx,st){const a=coinCount(fx),b=coinCount(st&&st.coins);return a===null?b:b===null?a:Math.max(a,b)}
function txt(v,n){return String(v||"").replace(/[\r\n\t]+/g," ").slice(0,n)}
function notify(a,b){try{$notification.post(N,a,b)}catch(_){}}
async function sleep(ms){checkRun(ms);await new Promise(r=>setTimeout(r,ms));checkRun()}
function checkRun(reserve=0){
 if(!runDay)return;
 let message="";
 if(Date.now()+reserve>=deadline)message="已到本轮运行时间上限，稍后可重试";
 else if(shareDay()!==runDay)message="已跨北京时间日期，请重新运行查询新一天的状态";
 else if(runCookie&&readSession().cookie!==runCookie)message="Cookie 会话已更换，请重新运行";
 else if(held){const l=readLock();if(!l||l.owner!==owner||l.expiresAt<=Date.now())message="运行锁已失效";}
 if(message){const e=new Error(message);e.stopped=true;throw e;}
}
function rand(a,b){return Math.floor(Math.random()*(Math.floor(b)-Math.ceil(a)+1))+Math.ceil(a)}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t}}
async function lock(){const now=Date.now(),x=readLock();if(x&&x.expiresAt>now)return false;const id=now.toString(36)+"-"+Math.random().toString(36).slice(2,12);if(!$persistentStore.write(JSON.stringify({owner:id,expiresAt:now+TTL}),LK))throw new Error("运行锁创建失败");for(let i=0;i<2;i++){await sleep(120);const v=readLock();if(!v||v.owner!==id||v.expiresAt<=Date.now())return false}owner=id;held=true;return true}
function readLock(){const x=$persistentStore.read(LK);if(!x)return null;try{const v=JSON.parse(x);return v&&v.owner&&Number.isFinite(Number(v.expiresAt))?{owner:String(v.owner),expiresAt:Number(v.expiresAt)}:null}catch(_){return null}}
function unlock(){if(!held)return;const x=readLock();if(x&&x.owner===owner)$persistentStore.write("",LK);held=false;owner=""}
function currentUid(){const s=readSession();return String(s.meta&&s.meta.uid||"")}
function readState(){const x=$persistentStore.read(SK);if(!x)return null;try{const v=JSON.parse(x),p=v&&v.panel;return v&&v.day===shareDay()&&v.version===V&&v.uid===currentUid()&&p&&typeof p.title==="string"&&typeof p.content==="string"?p:null}catch(_){return null}}
function saveState(v){try{const l=readLock();if(!held||!l||l.owner!==owner||l.expiresAt<=Date.now())return;$persistentStore.write(JSON.stringify({day:shareDay(),version:V,uid:currentUid(),panel:v}),SK)}catch(_){}}
function isPanel(){return typeof $input==="object"&&$input&&$input.purpose==="panel"}
function isAuto(){return isPanel()&&(typeof $trigger==="undefined"||$trigger!=="button")}
function P(content,icon,color){return{title:N,content:shareDay()+" · v"+V+"\n"+content,icon,"icon-color":color}}
function finish(v){if(done)return;done=true;isPanel()?$done(v):$done()}
