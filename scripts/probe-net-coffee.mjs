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

const path="/api/ip/lookup/1.1.1.1";
const body=await read(path);
try { const d=JSON.parse(body);log({path,schema:shape(d),sample:{ip:d.ip,countryCode:d.countryCode,asn:d.asn,asOrganization:d.asOrganization,trust_score:d.trust_score,isResidential:d.isResidential,is_datacenter:d.is_datacenter,is_vpn:d.is_vpn,is_proxy:d.is_proxy,is_tor:d.is_tor}}); } catch { log({path,json:false}); }
const home=await read("/");
log({publicPolicyLinks:[...home.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].filter(m=>/terms|privacy|api|使用条款|隐私|限流|服务条款/i.test(m[0])).slice(0,10).map(m=>({href:m[1],label:m[2].replace(/<[^>]*>/g,"").slice(0,100)}))});
const trace=await read("/cdn-cgi/trace");
const ips=trace.split("\n").filter(l=>l.startsWith("ip="));
log({path:"/cdn-cgi/trace",ipFields:ips.length,IPFamily:ips.length===1?(ips[0].includes(":")?6:4):null});
