// Temporary read-only public-contract probe; removed before merge.
const ORIGIN = "https://ip.net.coffee";
const IPS = ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"];
function log(x) { console.log(JSON.stringify(x)); }
async function read(path) {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error("origin denied");
  let r;
  try {
    r = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(20000),
      headers: { Accept: "*/*", "User-Agent": "Beatrice-Surge-Modules-public-contract-audit" } });
    const b = await r.text();
    log({path:url.pathname,method:"GET",status:r.status,contentType:r.headers.get("content-type"),retryAfter:r.headers.get("retry-after"),bytes:Buffer.byteLength(b)});
    return b.length <= 250000 ? b : "";
  } catch(e) { log({path:url.pathname,status:r?.status||null,error:e.name}); return ""; }
}
function shape(v, depth=0) {
  if (v === null) return null;
  if (Array.isArray(v)) return {arrayLength:v.length,sample:v.length&&depth<4?shape(v[0],depth+1):null};
  if (typeof v === "object") return depth>4?"object":Object.fromEntries(Object.entries(v).slice(0,70).map(([k,x])=>[k,shape(x,depth+1)]));
  return typeof v;
}
const trace = await read("/cdn-cgi/trace");
log({path:"/cdn-cgi/trace",fields:trace.split("\n").map(l=>l.split("=")[0]).filter(Boolean),hasIP:/^ip=.+$/m.test(trace)});
for (const ip of IPS) for (const endpoint of ["geoip","iprisk"]) {
  const path="/api/"+endpoint+"/"+encodeURIComponent(ip), body=await read(path);
  try {const d=JSON.parse(body); log({path,schema:shape(d),sample:d});} catch { log({path,json:false}); }
}
for (const asset of ["/home-page.js?v=20260916a","/ip/ip-page.js?v=20260910d","/ip/ip-page-v2.js?v=20260917i"]) {
  const s=await read(asset), pattern=/trustScore|trust_score|company_type|residential|is_vpn|is_proxy|is_tor|scoreLabel|scoreText|高风险|高可信/g; let m; const windows=[];
  while((m=pattern.exec(s))&&windows.length<14) if(!windows.some(w=>Math.abs(w.index-m.index)<500)) windows.push({index:m.index,sample:s.slice(Math.max(0,m.index-180),m.index+650).replace(/\s+/g," ")});
  log({path:asset,evidence:windows});
}
