/*
 * 贝蒂的基础面板 - Surge iOS 单 Information Panel
 * Version: 1.5.1
 *
 * 参数：
 * POLICY = 可选；留空时所有联网检测按 Surge 当前规则执行
 * YS=1   = 默认对出口 IP 打码
 * RISK=1 = 开启 HTTPS IP 信誉信号（不计算“综合纯净度”）
 *
 * 安全边界：
 * - 无 MITM、Rewrite、Rule、eval、Function()、远程代码或第三方统计服务。
 * - 所有 $httpClient 请求均关闭 auto-cookie，不发送 Cookie、Authorization 或 Profile 正文。
 * - 仅在 $trigger === "button" 时使用 $httpClient 快速估算下载速度；自动刷新只读
 *   本地测速缓存。自适应采样，全流程 8 秒、128 MiB 请求体积、4 workers 上限。
 * - 当前 Profile 只通过官方 /v1/profiles/current?sensitive=0 读取脱敏文本；不读取敏感版本，
 *   不保存 Profile、Managed URL、订阅 Token 或 subscription-userinfo 原始 Header。
 *
 * 外部 HTTPS 请求清单（服务端必然能看到发起请求的出口 IP）：
 * - www.gstatic.com：DIRECT 延迟；不含其他用户数据。
 * - cp.cloudflare.com：当前规则 / 可选 POLICY 延迟；不含其他用户数据。
 * - ip.net.coffee：唯一第三方 IP 情报源；同站 trace 观测出口，公开 lookup / geoip
 *   接口查询该出口的归属、ASN、网络类型与原始 Trust；无需 Key，不回退到其他提供商。
 * - speed.cloudflare.com：仅手动刷新下载估算，单响应最多 8 MiB。
 * - www.netflix.com、www.youtube.com、www.disneyplus.com、open.spotify.com、
 *   www.tiktok.com、www.primevideo.com：流媒体可用性；不含账号、Cookie 或其他用户数据。
 * - chatgpt.com、claude.ai、gemini.google.com、chat.deepseek.com、grok.com、
 *   www.perplexity.ai：AI 服务可达性；不含账号、Cookie 或其他用户数据。
 * - 当前 Managed Profile 或用户显式提供 SUB_URL 的原始 HTTPS 主机（动态）：仅在本地文本
 *   无法取得流量时请求该 URL；Token 只会发回原主机，不会保存、记录或转发给其他服务。
 */

const PANEL_TITLE = "贝蒂的基础面板";
const ARGS = parseArgs(typeof $argument === "string" ? $argument : "");
const POLICY = clean(ARGS.POLICY);
const MASK_IP = clean(ARGS.YS) !== "0";
const ENABLE_RISK = clean(ARGS.RISK) !== "0";
const SUB_URL = clean(ARGS.SUB_URL);

const HTTP_TIMEOUT = 7;
const PROFILE_TIMEOUT = 10;
const PROXY_LATENCY_TIMEOUT = 3;

const SPEED_REQUEST_TIMEOUT = 4;
const SPEED_TOTAL_TIMEOUT_MS = 8000;
const SPEED_WARMUP_BYTES = 32 * 1024;
// Surge 实机曾验证 60/48/32 KiB 可避开较小的 Response Body 上限；仅作同源安全降级。
const SPEED_SAFE_BLOCK_SIZES = [60 * 1024, 48 * 1024, 32 * 1024];
const SPEED_WORKER_COUNT = 4;
const SPEED_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const SPEED_MIN_SUCCESS_RATIO = 0.5;
const SPEED_MIN_SUCCESS_SAMPLES = 2;
const SPEED_MIN_SUCCESS_BYTES = 128 * 1024;
const SPEED_MIN_SAMPLE_MS = 5;
const SPEED_MIN_MEASURE_MS = 500;
const SPEED_BAR_MAX_MBPS = 500;
const SPEED_BAR_SEGMENTS = 10;

const SPEED_KEY = "betty.basic.speed";
const INTEL_KEY = "betty.basic.intel.v2";
const SOURCE_TTL_MS = 60 * 60 * 1000;

main().catch(function () {
  // 不输出异常正文，避免极端情况下把包含订阅 URL 的错误写入日志。
  try { console.log("Betty panel update failed"); } catch (_) {}
  $done({
    title: PANEL_TITLE,
    content: "暂时无法更新，请稍后重试",
    icon: "exclamationmark.triangle.fill",
    "icon-color": "#FF453A"
  });
});

async function main() {
  const net = getLocalNetwork();
  // At most 16 external requests in flight; speed starts only after these finish.
  const results = await Promise.all([
    getNetworkIntelligence(POLICY), getDNSDelay(),
    latency("https://www.gstatic.com/generate_204", "DIRECT"),
    latency("https://cp.cloudflare.com/generate_204", POLICY, PROXY_LATENCY_TIMEOUT),
    testNetflix(POLICY), testYouTubePremium(POLICY), testDisney(POLICY),
    testServiceReachable("https://open.spotify.com/", POLICY),
    testServiceReachable("https://www.tiktok.com/", POLICY),
    testServiceReachable("https://www.primevideo.com/", POLICY),
    testAIReachable("https://chatgpt.com/", POLICY),
    testAIReachable("https://claude.ai/", POLICY),
    testAIReachable("https://gemini.google.com/", POLICY),
    testAIReachable("https://chat.deepseek.com/", POLICY),
    testAIReachable("https://grok.com/", POLICY),
    testAIReachable("https://www.perplexity.ai/", POLICY),
    getSubscriptionUsage(POLICY)
  ]);
  const intel = results[0], exit = intel.exit, risk = intel.risk;
  const speed = await getSpeedForThisRun(POLICY, exit.ip);
  const media = ["Netflix", "YouTube", "Disney+", "Spotify", "TikTok", "Prime"]
    .map(function (name, i) { return Object.assign({ name: name }, results[i + 4]); });
  const ai = ["GPT", "Claude", "Gemini", "DeepSeek", "Grok", "Perplexity"]
    .map(function (name, i) { return Object.assign({ name: name }, results[i + 10]); });
  const lines = [
    "🌐 " + shortenText(net.name, 22),
    ["IPv4 " + (parseIPv4(net.ipv4) ? "本地" : "未发现"),
      parseIPv4(net.ipv4) ? inferNAT(net.ipv4) : "", formatIPv6(net.ipv6, exit.ip)].filter(Boolean).join(" · "),
    "DNS " + detectDNS(net.dns) + " · " + fmtMs(results[1]),
    "", "🚪 " + formatExitLine(exit.country, exit)
  ];
  const geoLine = formatGeoLine(exit);
  if (geoLine) lines.push(geoLine);
  lines.push("", "⚡ DIRECT " + fmtMs(results[2]) + " · " +
    (POLICY ? "指定策略 " : "当前 ") + fmtMs(results[3]));
  appendSpeedLines(lines, speed);
  appendServiceLines(lines, "🎬 流媒体", media, true);
  appendServiceLines(lines, "✨ AI", ai);
  lines.push("");
  appendUsageLines(lines, results[16]);
  lines.push("");
  appendRiskLines(lines, risk);

  // A WAF rejection on one site is not an overall network failure.
  let color = exit.ip ? "#30D158" : "#0A84FF";
  if (!exit.ip && results[2] === null && results[3] === null) color = "#FF453A";
  else if (results[2] === null && results[3] === null) color = "#FF9F0A";
  $done({ title: PANEL_TITLE, content: lines.join("\n"), icon: "waveform.path.ecg", "icon-color": color });
}

/* ---------- Local Network ---------- */

function getLocalNetwork() {
  const n = typeof $network === "object" && $network ? $network : {};
  const wifi = n.wifi || {};
  const v4 = n.v4 || {};
  const v6 = n.v6 || {};
  const cellular = n["cellular-data"] || {};
  const dns = Array.isArray(n.dns) ? n.dns.filter(Boolean) : [];

  let name = oneLine(wifi.ssid);
  if (!name) {
    name = [oneLine(cellular.carrier), oneLine(cellular.radio)]
      .filter(Boolean)
      .join(" ") || "当前网络";
  }

  return {
    name: name,
    ipv4: clean(v4.primaryAddress),
    router: clean(v4.primaryRouter),
    ipv6: clean(v6.primaryAddress),
    dns: dns
  };
}

/* ---------- Surge HTTP API ---------- */

function httpAPI(method, path, body) {
  return new Promise(function (resolve) {
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      resolve(value === undefined ? null : value);
    }

    setTimeout(function () { finish(null); }, 5000);

    try {
      if (typeof $httpAPI !== "function") {
        finish(null);
        return;
      }
      $httpAPI(method, path, body || {}, function (result) {
        finish(result || null);
      });
    } catch (_) {
      finish(null);
    }
  });
}

async function getDNSDelay() {
  const started = Date.now();
  const result = await httpAPI("POST", "/v1/test/dns_delay", {});
  // The public API does not document the delay field's unit. Measure the complete
  // local API operation instead of guessing seconds vs milliseconds from its value.
  if (!result || result.error || !finiteInRange(result.delay, 0, 60000)) return null;
  return Math.max(1, Date.now() - started);
}

/* ---------- HTTP ---------- */

function http(method, url, policy, options) {
  const extra = options && typeof options === "object" ? options : {};
  const timeout = finiteInRange(extra.timeout, 1, 60) ? Number(extra.timeout) : HTTP_TIMEOUT;

  return new Promise(function (resolve) {
    const started = Date.now();
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    function failed(reason) {
      finish({ ok: false, status: 0, headers: {}, data: "", reason: reason || "transport", ms: Math.max(1, Date.now() - started) });
    }

    setTimeout(function () { failed("timeout"); }, (timeout + 2) * 1000);

    const request = {
      url: url,
      timeout: timeout,
      "auto-cookie": false,
      "auto-redirect": extra.autoRedirect === true,
      headers: extra.headers || {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
        "Accept": "text/html,application/json,text/plain,*/*",
        "Cache-Control": "no-cache"
      }
    };

    if (clean(policy)) request.policy = clean(policy);
    if (extra.binary === true) request["binary-mode"] = true;

    try {
      const client = typeof $httpClient === "object" && $httpClient ? $httpClient : null;
      const fn = client && typeof client[String(method || "get").toLowerCase()] === "function"
        ? client[String(method || "get").toLowerCase()]
        : null;

      if (!fn) {
        failed();
        return;
      }

      fn(request, function (error, response, data) {
        if (settled) return;
        try {
          const status = response
            ? Number(response.status !== undefined ? response.status : response.statusCode)
            : 0;
          const headers = response && response.headers ? response.headers : {};
          let body = "";

          if (!extra.discardBody) {
            if (extra.binary === true) body = data || null;
            else body = typeof data === "string" ? data : "";
          }

          finish({
            ok: !error && !!response,
            reason: error ? (isTimeoutError(error) ? "timeout" : "transport") : "",
            status: Number.isFinite(status) ? status : 0,
            headers: headers,
            data: body,
            ms: Math.max(1, Date.now() - started)
          });
        } catch (_) { failed(); }
      });
    } catch (_) {
      failed();
    }
  });
}

async function latency(url, policy, timeout) {
  const result = await http(
    "get",
    url + "?_=" + Date.now(),
    policy,
    {
      autoRedirect: false,
      timeout: finiteInRange(timeout, 1, 60) ? Number(timeout) : HTTP_TIMEOUT
    }
  );
  return result.ok && (result.status === 200 || result.status === 204) ? result.ms : null;
}

function safeJSON(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

/* ---------- Same-IP Net.Coffee intelligence ---------- */

function isUsableResponse(result) {
  return !!result && result.ok && result.status >= 200 && result.status < 300;
}

function readJSON(key) {
  try { return safeJSON($persistentStore.read(key)); } catch (_) { return null; }
}

function writeJSON(key, value) {
  try { return !!$persistentStore.write(JSON.stringify(value), key); } catch (_) { return false; }
}

function unavailableSource(name, reason) {
  return { source: name, ip: "", reason: reason || "不可用" };
}

async function querySource(name, url, policy, parse, textMode) {
  const key = "betty.basic.backoff." + name;
  const backoff = readJSON(key);
  if (backoff && finiteInRange(backoff.until, Date.now() + 1, Date.now() + 7 * 86400000)) return unavailableSource(name, "限流 / 暂停");
  const response = await http("get", url, policy, {
    timeout: 5, autoRedirect: false,
    headers: { "Accept": textMode ? "text/plain" : "application/json",
      "Cache-Control": "no-cache", "User-Agent": "Surge-Betty-Panel/1.5" }
  });
  if (response.status === 429 || response.status === 403) {
    const retry = getHeader(response.headers, "retry-after");
    const seconds = /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
    // Endpoint cooldowns survive exit changes. Do not evade a quota by changing nodes.
    const wait = Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 24 * 60 * 60 * 1000;
    writeJSON(key, { until: Date.now() + Math.min(Math.max(wait, 60000), 7 * 86400000) });
    return unavailableSource(name, response.status === 429 ? "限流" : "访问受限");
  }
  if (!isUsableResponse(response)) return unavailableSource(name, response.status ? "服务异常" : "超时 / 网络异常");
  // Bounds parsing/cache work; Surge's native response limit still bounds wire buffering.
  if (typeof response.data !== "string" || response.data.length > (textMode ? 4096 : 65536)) return unavailableSource(name, "响应过大");
  try {
    const data = textMode ? response.data : safeJSON(response.data);
    return (data && parse(data)) || unavailableSource(name, "数据不足 / IP 不匹配");
  } catch (_) { return unavailableSource(name, "数据异常"); }
}

function boolSignal(value) { return typeof value === "boolean" ? value : null; }
function sourceScore(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }
function intelText(value) { return typeof value === "string" ? shortenText(oneLine(value), 100) : ""; }

function coffeeGeo(data, ip, countryCode) {
  return { source: "Net.Coffee", ip: ip, country: normalizeCountryCode(countryCode),
    countryName: intelText(data.country), region: intelText(data.region), city: intelText(data.city),
    asn: typeof data.asn === "number" ? positiveASN(data.asn) : null,
    org: intelText(data.asOrganization) || intelText(data.isp) || intelText(data.company_name),
    isp: intelText(data.isp), company: intelText(data.company_name) };
}

function hasGeo(data) {
  return !!(data.country || data.countryName || data.region || data.city || data.asn || data.org);
}

function parseNetCoffeeTrace(text) {
  // This is the same-origin discovery method used by Net.Coffee's public IP page.
  const lines = text.split(/\r?\n/).filter(function (line) { return line.indexOf("ip=") === 0; });
  if (lines.length !== 1 || !isPublicIP(lines[0].slice(3))) return null;
  return { source: "Net.Coffee", ip: normalizeIP(lines[0].slice(3)) };
}

function parseNetCoffeeGeo(data, expected) {
  if (!isPublicIP(expected) || data.error || data.is_bogon === true) return null;
  // The public Geo endpoint does not echo an IP. Bind it to the explicit query path;
  // if a future response adds an IP, it must match, including equivalent IPv6 forms.
  if (Object.prototype.hasOwnProperty.call(data, "ip") &&
      (!isPublicIP(data.ip) || normalizeIP(data.ip) !== expected)) return null;
  const result = coffeeGeo(data, expected, data.country_code);
  return hasGeo(result) ? result : null;
}

function parseNetCoffeeRisk(data, expected) {
  if (data.error || data.is_bogon === true || !isPublicIP(data.ip) || normalizeIP(data.ip) !== expected) return null;
  const result = coffeeGeo(data, expected, data.countryCode);
  result.type = typeof data.company_type === "string" && /^(isp|hosting|business|education|government|banking)$/i.test(data.company_type) ? data.company_type.toLowerCase() : "";
  result.signals = {
    residential: boolSignal(data.isResidential), hosting: boolSignal(data.is_datacenter),
    vpn: boolSignal(data.is_vpn), proxy: boolSignal(data.is_proxy), tor: boolSignal(data.is_tor),
    abuse: boolSignal(data.is_abuser), mobile: boolSignal(data.is_mobile), crawler: boolSignal(data.is_crawler)
  };
  result.trust = sourceScore(data.trust_score);
  return hasGeo(result) || hasRisk(result) ? result : null;
}

function hasRisk(data) {
  return !!data && (sourceScore(data.trust) !== null || !!data.type ||
    !!data.signals && Object.keys(data.signals).some(function (k) { return typeof data.signals[k] === "boolean"; }));
}

function validCachedSource(data, risk, ip) {
  if (!data || data.source !== "Net.Coffee" || data.ip !== ip) return false;
  if (!["country", "countryName", "region", "city", "org", "isp", "company"].every(function (k) {
    return typeof data[k] === "string" && data[k] === intelText(data[k]);
  }) || normalizeCountryCode(data.country) !== data.country ||
      (data.asn !== null && (typeof data.asn !== "number" || positiveASN(data.asn) !== data.asn))) return false;
  if (!risk) return hasGeo(data);
  if (typeof data.type !== "string" || (data.type && !/^(isp|hosting|business|education|government|banking)$/.test(data.type)) ||
      (data.trust !== null && sourceScore(data.trust) === null) ||
      !data.signals || typeof data.signals !== "object" || Array.isArray(data.signals)) return false;
  return ["residential", "hosting", "vpn", "proxy", "tor", "abuse", "mobile", "crawler"].every(function (k) {
    return data.signals[k] === null || typeof data.signals[k] === "boolean";
  }) && (hasGeo(data) || hasRisk(data));
}

async function getNetworkIntelligence(policy) {
  // Fresh discovery is mandatory. Never reuse a previous exit after discovery fails.
  const observed = await querySource("NetCoffeeTrace", "https://ip.net.coffee/cdn-cgi/trace?_=" + Date.now(), policy, parseNetCoffeeTrace, true);
  const ip = observed.ip;
  let exit = coffeeGeo({}, ip, ""), risk = unavailableSource("Net.Coffee", observed.reason);
  if (!ip) return { exit: exit, risk: risk };
  const saved = readJSON(INTEL_KEY);
  const cache = saved && saved.version === 2 && saved.ip === ip && saved.entries &&
    typeof saved.entries === "object" && !Array.isArray(saved.entries) ? saved : { version: 2, ip: ip, entries: {} };
  function cached(name) {
    const entry = cache.entries[name];
    return entry && typeof entry.time === "number" && entry.time <= Date.now() &&
      Date.now() - entry.time < SOURCE_TTL_MS && validCachedSource(entry.data, name === "risk", ip) ? entry.data : null;
  }
  if (ENABLE_RISK) {
    const oldRisk = cached("risk");
    risk = oldRisk || await querySource("NetCoffeeRisk", "https://ip.net.coffee/api/ip/lookup/" + encodeURIComponent(ip), policy,
      function (data) { return parseNetCoffeeRisk(data, ip); });
    if (risk.ip) {
      if (!oldRisk) cache.entries.risk = { time: Date.now(), data: risk };
      if (hasGeo(risk)) exit = risk;
    } else delete cache.entries.risk;
  }
  if (!hasGeo(exit)) {
    const oldGeo = cached("geo");
    exit = oldGeo || await querySource("NetCoffeeGeo", "https://ip.net.coffee/api/geoip/" + encodeURIComponent(ip), policy,
      function (data) { return parseNetCoffeeGeo(data, ip); });
    if (exit.ip) {
      if (!oldGeo) cache.entries.geo = { time: Date.now(), data: exit };
    } else {
      delete cache.entries.geo;
      exit = coffeeGeo({}, ip, "");
    }
  }
  writeJSON(INTEL_KEY, cache);
  return { exit: exit, risk: risk };
}

/* ---------- Website evidence, not account/playback promises ---------- */

function reachableResult(response) {
  const code = response && response.status || 0;
  if (code === 401 || code === 403 || code === 429 || code === 451) return { state: "restricted", label: "受限 " + code, code: code };
  if (code >= 500 && code < 600) return { state: "error", label: "异常 " + code, code: code };
  if (!response || !response.ok || !code) return { state: "unreachable", label: response && response.reason === "timeout" ? "超时" : "不可达" };
  if (code >= 200 && code < 400) return { state: "reachable", label: "可达" };
  return { state: "unknown", label: "未知 " + code, code: code };
}

async function publicPage(url, policy, host) {
  // At most two HTTPS redirects to this public service. No cookies or credentials.
  for (let hop = 0; hop <= 2; hop++) {
    const response = await http("get", url, policy, { autoRedirect: false,
      headers: { "Accept": "text/html", "Accept-Language": "en-US,en;q=0.8", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15" } });
    if (!response.ok || response.status < 300 || response.status >= 400) return response;
    const location = getHeader(response.headers, "location");
    const absolute = location.charAt(0) === "/" && location.charAt(1) !== "/" ? "https://" + host + location : location;
    if (!absolute.startsWith("https://" + host + "/") || /[\s\\]/.test(absolute) || absolute.length > 2048) return response;
    url = absolute;
  }
  return null;
}

async function testNetflix(policy) {
  const first = await publicPage("https://www.netflix.com/title/81280792", policy, "www.netflix.com");
  const result = reachableResult(first);
  if (first && first.ok && first.status === 200) {
    const region = netflixRegion(first.headers, first.data);
    // A regional title page proves catalogue-page access, not authenticated playback.
    if (isNetflixTitle(first.data, "81280792")) {
      result.label = "样片可达" + (region ? " " + countryLabel(region) : "");
      result.catalogue = true; result.region = region;
    }
    return result;
  }
  if (first && first.ok && first.status === 404) {
    const fallback = await publicPage("https://www.netflix.com/title/80018499", policy, "www.netflix.com");
    if (fallback && fallback.status === 200 && isNetflixTitle(fallback.data, "80018499")) {
      return { state: "restricted", label: "样片受限", limited: true };
    }
  }
  return result;
}

function isNetflixTitle(body, id) {
  const text = String(body || "");
  return /Netflix/i.test(text) && (text.indexOf("/title/" + id) >= 0 ||
    new RegExp('"(?:videoId|titleId)"\\s*:\\s*"?' + id + '(?:"|[,}])').test(text));
}

function netflixRegion(headers, body) {
  const originating = getHeader(headers, "x-originating-url");
  let match = clean(originating).match(/^https:\/\/www\.netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\/title\//i);
  if (!match) match = String(body || "").match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
  return match ? match[1].toUpperCase() : "";
}

async function testYouTubePremium(policy) {
  const response = await publicPage("https://www.youtube.com/premium?hl=en", policy, "www.youtube.com");
  const result = reachableResult(response);
  if (!response || !response.ok || response.status !== 200) return result;
  const body = String(response.data || "");
  if (/Premium is not available in your (?:country|region)/i.test(body)) {
    return { state: "reachable", label: "可达 · Premium 受限", premium: false };
  }
  // Missing an error is not proof of eligibility. Only report an actual offer, and
  // even then do not promise that this account can subscribe or use Premium.
  if (/"ypcOffers"\s*:\s*\[\s*\{/.test(body) && /"(?:ypcOfferId|offerId)"\s*:\s*"[^"\s]+"/.test(body)) {
    return { state: "reachable", label: "Premium 报价可见", premium: true };
  }
  return result;
}

function testDisney(policy) { return testServiceReachable("https://www.disneyplus.com/", policy); }

async function testServiceReachable(url, policy) {
  const head = await http("head", url, policy, { autoRedirect: false, discardBody: true });
  const tiktok = url === "https://www.tiktok.com/";
  const prime = url === "https://www.primevideo.com/";
  // Only these two real-device failures justify a method fallback. An explicit
  // restriction must not cause another request, even with a transport error.
  const restricted = head.status === 401 || head.status === 403 || head.status === 429 || head.status === 451;
  const unsupported = head.status === 405 || head.status === 501;
  const fallback = !restricted && (((tiktok || prime) && unsupported) || (tiktok && (!head.ok || !head.status)));
  if (!fallback) return reachableResult(head);

  // One GET to the same public entry only: no login, cookies, redirects or retry.
  // discardBody drops data AFTER receipt, not on the wire. Range was ignored by
  // TikTok in the 2026-09-11 probe; do not claim a byte cap or add a 416 failure path.
  // Native timeout bounds the request; the http() watchdog bounds a missing callback.
  const get = await http("get", url, policy, { timeout: 4, autoRedirect: false, discardBody: true });
  const result = reachableResult(get);
  // Successful method fallback is ordinary reachability; retain only failed evidence.
  if (result.state !== "reachable") {
    const evidence = get.status ? String(get.status) + (get.ok ? "" : "/传输失败") : result.label;
    result.fallback = evidence;
    result.label += " (GET " + evidence + ")";
  }
  return result;
}

function testAIReachable(url, policy) { return testServiceReachable(url, policy); }

/* ---------- Manual-only adaptive download estimate ---------- */

async function getSpeedForThisRun(policy, ip) {
  const previous = readSpeedResult();
  if (previous) {
    previous.otherExit = !previous.ip || !ip || previous.ip !== normalizeIP(ip);
    previous.exitUnknown = !previous.ip || !ip;
    previous.state = "cached";
  }
  if (typeof $trigger !== "string" || $trigger !== "button") return previous;
  // Protect against simultaneous button invocations and rapid repeated taps.
  const lockKey = "betty.basic.speed.lock";
  const lock = readJSON(lockKey);
  if (lock && finiteInRange(lock.until, Date.now() + 1, Date.now() + 30000)) {
    return Object.assign(previous || {}, { state: "cooldown", failure: { reason: "cooldown" } });
  }
  if (!writeJSON(lockKey, { until: Date.now() + 15000 })) {
    return Object.assign(previous || {}, { state: "failed", failure: { reason: "storage" } });
  }
  const fresh = await runDownloadSpeedTest(policy);
  if (!fresh.mbps) return Object.assign(previous || {}, { state: "failed", failure: fresh.failure });
  fresh.ip = normalizeIP(ip);
  fresh.state = "fresh";
  saveSpeedResult(fresh);
  return fresh;
}

async function runDownloadSpeedTest(policy) {
  const budget = { bytes: 0, requests: 0, closed: false, deadline: Date.now() + SPEED_TOTAL_TIMEOUT_MS,
    best: null, partial: null, failure: null };
  // Only one overall watchdog plus one per measurement stage. Per-block timers can
  // exceed Surge's 64 pending timer limit on JSC (which may have no clearTimeout).
  return new Promise(function (resolve) {
    let settled = false;
    function finish(result, reason) {
      if (settled) return;
      settled = true; budget.closed = true;
      const measurement = result || budget.best || budget.partial;
      resolve(measurement ? Object.assign({}, measurement, { requestedBytes: budget.bytes }) :
        { failure: reason || budget.failure || { reason: "insufficient_samples" } });
    }
    setTimeout(function () { finish(null, { reason: "deadline" }); }, SPEED_TOTAL_TIMEOUT_MS);
    adaptiveDownload(policy, budget).then(function (result) { finish(result); },
      function () { finish(null, { reason: "transport" }); });
  });
}

async function adaptiveDownload(policy, budget) {
  const warmup = await downloadSpeedBlock(policy, SPEED_WARMUP_BYTES, budget);
  if (budget.closed || warmup.reason === "http") return null;
  const probe = await downloadSpeedBlock(policy, 512 * 1024, budget);
  let block = probe.ok ? 512 * 1024 : 0;
  // Small blocks help body/transport failures, not explicit HTTP/WAF rejections.
  // At most three fallback probes, then stop; never loop on a failed worker.
  if (!block && (probe.reason === "body_limit" || probe.reason === "body_mismatch" ||
      (warmup.ok && (probe.reason === "transport" || probe.reason === "timeout")))) {
    for (let i = 0; i < SPEED_SAFE_BLOCK_SIZES.length && !budget.closed; i++) {
      const safe = await downloadSpeedBlock(policy, SPEED_SAFE_BLOCK_SIZES[i], budget);
      if (safe.ok) { block = SPEED_SAFE_BLOCK_SIZES[i]; break; }
      if (safe.reason === "http" || safe.reason === "deadline") break;
    }
  }
  if (!block || budget.closed) return null;
  // Timing difference only chooses sample size; it never corrects the displayed rate.
  if (block >= 512 * 1024 && warmup.ok && probe.elapsed - warmup.elapsed < 30) {
    const larger = await downloadSpeedBlock(policy, 2 * 1024 * 1024, budget);
    if (larger.ok) block = 2 * 1024 * 1024;
    else if (larger.reason === "http") return null;
  }
  const pilot = await measureDownload(policy, block, 1500, 16 * 1024 * 1024, budget, false, 100);
  if (!pilot) return null;
  budget.best = speedMeasurementResult(pilot, budget, block < 512 * 1024 ? "小响应降级" : "快速采样");
  const tier = pilot.mbps > 300 ? "high" : pilot.mbps >= 150 ? "medium" : "low";
  if (tier === "low" || block < 512 * 1024) {
    if (block >= 512 * 1024 && pilot.elapsed >= SPEED_MIN_MEASURE_MS && !pilot.partial) budget.best.mode = "低速采样";
    return budget.best;
  }
  // Refinement is optional. Leave room for a useful window and request latency.
  const reserve = Math.max(SPEED_MIN_MEASURE_MS, warmup.elapsed * 2);
  if (budget.deadline - Date.now() < SPEED_MIN_MEASURE_MS + reserve) return budget.best;
  const desired = tier === "high" ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
  const check = await downloadSpeedBlock(policy, desired, budget);
  if (!check.ok || budget.closed) return budget.best;
  block = desired;
  const duration = Math.min(tier === "high" ? 4000 : 3000, budget.deadline - Date.now() - reserve);
  if (duration < SPEED_MIN_MEASURE_MS) return budget.best;
  const result = await measureDownload(policy, block, duration,
    tier === "high" ? SPEED_MAX_TOTAL_BYTES : 64 * 1024 * 1024, budget, tier === "medium", SPEED_MIN_MEASURE_MS);
  return result && !result.partial
    ? speedMeasurementResult(result, budget, result.upgraded || tier === "high" ? "高速采样" : "中速采样")
    : budget.best;
}

function speedMeasurementResult(result, budget, mode) {
  return { mbps: result.mbps, mbPerSecond: result.mbps / 8, time: Date.now(), mode: mode,
    requestedBytes: budget.bytes, elapsed: result.elapsed };
}

function measureDownload(policy, block, duration, cap, budget, adaptive, minimumMS) {
  const started = Date.now();
  const state = { bytes: 0, sent: 0, samples: 0, attempted: 0, lastValid: null,
    block: block, cap: cap, stop: Math.min(budget.deadline, started + duration), active: true, upgraded: false };
  return new Promise(function (resolve) {
    let settled = false;
    function sample() {
      const elapsed = Math.max(1, Math.min(Date.now(), state.stop) - started);
      const good = elapsed >= minimumMS && state.samples >= SPEED_MIN_SUCCESS_SAMPLES &&
        state.bytes >= SPEED_MIN_SUCCESS_BYTES && state.samples / Math.max(1, state.attempted) >= SPEED_MIN_SUCCESS_RATIO;
      return good ? { mbps: state.bytes * 8 / elapsed / 1000, elapsed: elapsed, upgraded: state.upgraded } : null;
    }
    function finish() {
      if (settled) return;
      settled = true; state.active = false;
      const result = sample();
      resolve(result || (state.lastValid ? Object.assign({}, state.lastValid, { partial: true }) : null));
    }
    // Drain existing workers before another stage; resolving early can exceed four.
    // Save qualified completed samples so the overall watchdog cannot discard them.
    setTimeout(function () { state.active = false; }, Math.max(1, Math.min(budget.deadline - started, adaptive ? 4000 : duration)));
    async function worker() {
      while (state.active && !budget.closed && Date.now() < state.stop) {
        const bytes = state.block;
        if (state.sent + bytes > state.cap || budget.bytes + bytes > SPEED_MAX_TOTAL_BYTES || budget.requests >= 256) return;
        state.sent += bytes; state.attempted++;
        const response = await downloadSpeedBlock(policy, bytes, budget);
        if (!state.active || budget.closed) return;
        if (response.ok && Date.now() <= state.stop) { state.bytes += response.bytes; state.samples++; }
        else {
          if (response.reason === "http") state.active = false;
          return;
        }
        const current = sample();
        if (current) {
          state.lastValid = current;
          if (!budget.best) budget.partial = speedMeasurementResult(current, budget, block < 512 * 1024 ? "小响应降级" : "快速采样");
        }
        const elapsed = Date.now() - started;
        if (adaptive && !state.upgraded && elapsed >= 500 && state.bytes * 8 / elapsed / 1000 > 300) {
          state.upgraded = true; state.cap = SPEED_MAX_TOTAL_BYTES;
          state.stop = Math.min(budget.deadline, started + 4000);
        }
      }
    }
    const workers = [];
    for (let i = 0; i < SPEED_WORKER_COUNT; i++) workers.push(worker());
    Promise.all(workers).then(finish, finish);
  });
}

function downloadSpeedBlock(policy, blockBytes, budget) {
  return new Promise(function (resolve) {
    const started = Date.now(), remaining = budget.deadline - started;
    let settled = false;
    function finish(reason, status, bytes) {
      if (settled) return;
      settled = true;
      if (reason) budget.failure = { reason: reason, status: status || 0 };
      resolve({ ok: !reason, bytes: reason ? 0 : bytes, elapsed: Math.max(1, Date.now() - started),
        reason: reason || "", status: status || 0 });
    }
    if (budget.closed || remaining <= 0) { finish("deadline"); return; }
    if (budget.bytes + blockBytes > SPEED_MAX_TOTAL_BYTES || budget.requests >= 256) { finish("insufficient_samples"); return; }
    budget.bytes += blockBytes; budget.requests++;
    const request = {
      url: "https://speed.cloudflare.com/__down?bytes=" + blockBytes + "&_=" + started + "-" + budget.requests,
      timeout: Math.min(SPEED_REQUEST_TIMEOUT, Math.max(0.1, remaining / 1000)),
      "binary-mode": true, "auto-cookie": false, "auto-redirect": false,
      headers: { "User-Agent": "Surge-Betty-Panel/1.5", "Accept": "application/octet-stream", "Accept-Encoding": "identity", "Cache-Control": "no-store" }
    };
    if (clean(policy)) request.policy = clean(policy);
    try {
      $httpClient.get(request, function (error, response, data) {
        if (settled) return;
        try {
          const status = response ? Number(response.status !== undefined ? response.status : response.statusCode) : 0;
          if (budget.closed || Date.now() > budget.deadline) { finish("deadline"); return; }
          if (status >= 300 || (status > 0 && status < 200)) { finish("http", status); return; }
          if (error) { finish(isResponseBodySizeLimitError(error) ? "body_limit" : isTimeoutError(error) ? "timeout" : "transport"); return; }
          if (!(status >= 200 && status < 300)) { finish("transport"); return; }
          const bytes = binaryLength(data);
          if (bytes !== blockBytes) { finish("body_mismatch"); return; }
          if (Date.now() - started < SPEED_MIN_SAMPLE_MS) { finish("insufficient_samples"); return; }
          finish("", status, bytes);
        } catch (_) { finish("transport"); }
      });
    } catch (error) {
      finish(isResponseBodySizeLimitError(error) ? "body_limit" : isTimeoutError(error) ? "timeout" : "transport");
    }
  });
}

function isTimeoutError(error) {
  const text = typeof error === "string" ? error : error && typeof error === "object" ? clean(error.message || error.error || error.localizedDescription) : "";
  return /timed?\s*out|timeout/i.test(text);
}

function isResponseBodySizeLimitError(error) {
  let text = "";
  if (typeof error === "string") {
    text = error;
  } else if (error && typeof error === "object") {
    text = clean(error.message || error.error || error.localizedDescription);
  } else {
    text = clean(error);
  }
  return /response body exceeds size limit/i.test(text);
}

function binaryLength(data) {
  return data && typeof data === "object" && typeof data.byteLength === "number" &&
    Number.isSafeInteger(data.byteLength) && data.byteLength >= 0 ? data.byteLength : 0;
}

function readSpeedResult() {
  const saved = readJSON(SPEED_KEY);
  if (!saved || !finiteInRange(saved.mbps, 0.001, 100000) || !finiteInRange(saved.time, 1, Date.now())) return null;
  return { mbps: Number(saved.mbps), mbPerSecond: Number(saved.mbps) / 8, time: Number(saved.time),
    ip: normalizeIP(saved.ip), mode: ["低速采样", "中速采样", "高速采样", "小响应降级", "快速采样"].indexOf(saved.mode) >= 0 ? saved.mode : "" };
}

function saveSpeedResult(result) {
  if (!result || !finiteInRange(result.mbps, 0.001, 100000) || !finiteInRange(result.time, 1, Date.now())) return false;
  return writeJSON(SPEED_KEY, { mbps: result.mbps, mbPerSecond: result.mbps / 8, time: result.time,
    ip: normalizeIP(result.ip), mode: result.mode });
}

/* ---------- Current Profile subscription usage ---------- */

async function getSubscriptionUsage(policy) {
  const profileResult = await httpAPI("GET", "/v1/profiles/current?sensitive=0", {});
  const profileText = findProfileText(profileResult, 0);
  const profileExpire = parseProfileExpiry(profileText);

  // 前两层完全在本地解析，不上传、记录或持久化 Profile 与匹配行。
  const localUsage = parseLocalProfileUsage(profileText, profileExpire);
  if (localUsage.available) return localUsage;

  // 第三层只识别明确的 #!MANAGED-CONFIG，不扫描配置中的其他 URL。
  const managedURL = extractManagedHTTPSURL(profileText);
  if (managedURL) {
    const managedUsage = await requestSubscriptionUsage(managedURL, policy);
    if (managedUsage.available) return applyUsageExpireFallback(managedUsage, profileExpire);
  }

  // 第四层为高级可选兜底；默认模块不传 SUB_URL，也不会要求用户填写。
  const optionalURL = normalizeSubscriptionHTTPSURL(SUB_URL);
  if (optionalURL && optionalURL !== managedURL) {
    const optionalUsage = await requestSubscriptionUsage(optionalURL, policy);
    if (optionalUsage.available) return applyUsageExpireFallback(optionalUsage, profileExpire);
  }

  return unavailableUsage();
}

async function requestSubscriptionUsage(url, policy) {
  const requestOptions = {
    timeout: PROFILE_TIMEOUT,
    // 不自动跟随重定向，避免订阅 URL 中的 Token 被带往非原始配置主机。
    autoRedirect: false,
    discardBody: true,
    headers: {
      "User-Agent": "Surge",
      "Accept": "text/plain,*/*",
      "Cache-Control": "no-cache"
    }
  };

  // HEAD 优先，避免在网络层下载完整 Profile；失败、未支持或 Header 无效时再 GET。
  const headResponse = await http("head", url, policy, requestOptions);
  if (isUsableResponse(headResponse)) {
    const headHeader = getHeader(headResponse.headers, "subscription-userinfo");
    if (headHeader) {
      const headUsage = parseSubscriptionUserInfo(headHeader);
      if (headUsage.available) return headUsage;
    }
  }

  const response = await http("get", url, policy, requestOptions);
  if (!isUsableResponse(response)) return unavailableUsage();
  return parseSubscriptionUserInfo(getHeader(response.headers, "subscription-userinfo"));
}

function findProfileText(value, depth) {
  const candidates = [];
  collectProfileTextCandidates(value, Number(depth) || 0, 0, candidates);
  if (!candidates.length) return "";

  candidates.sort(function (a, b) { return b.score - a.score; });
  return candidates[0].text;
}

function collectProfileTextCandidates(value, depth, keyBonus, candidates) {
  if (depth > 4 || value === null || value === undefined) return;

  if (typeof value === "string") {
    const text = value;
    if (!text) return;

    let score = text.length + keyBonus;
    if (/\[(?:General|Proxy|Proxy Group|Rule|Host)\]/i.test(text)) score += 1000000;
    if (/#!MANAGED-CONFIG/i.test(text)) score += 750000;
    if (/subscription[-_ ]userinfo|剩余流量|流量剩余|套餐流量|total\s+traffic/i.test(text)) score += 500000;
    if ((text.match(/\r?\n/g) || []).length >= 3) score += 100000;
    candidates.push({ text: text, score: score });
    return;
  }

  if (typeof value !== "object") return;
  const preferred = ["profile", "content", "text", "profileContent", "profile_text"];
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const bonus = preferred.indexOf(key) >= 0 ? 10000 : 0;
    collectProfileTextCandidates(value[key], depth + 1, keyBonus + bonus, candidates);
  }
}

function parseLocalProfileUsage(profileText, profileExpire) {
  if (typeof profileText !== "string" || !profileText) return unavailableUsage();

  /*
   * 本地文本的可信度顺序：明确 subscription-userinfo 语境最高，其次是
   * total+remaining、total+used，最后才是只有明确关键词的 remaining。
   */
  const embedded = parseEmbeddedSubscriptionUserInfo(profileText);
  if (embedded.available) return applyUsageExpireFallback(embedded, profileExpire);

  return parseHumanTrafficUsage(profileText, profileExpire);
}

function parseEmbeddedSubscriptionUserInfo(profileText) {
  const text = String(profileText || "");
  const marker = /subscription[-_ ]userinfo/ig;
  let match;

  while ((match = marker.exec(text)) !== null) {
    const tail = text.slice(match.index, Math.min(text.length, match.index + 1200));
    const lines = tail.split(/\r?\n/);
    const context = [];

    for (let i = 0; i < lines.length && i < 7; i += 1) {
      const line = lines[i];
      if (i > 0 && (!clean(line) || /^\s*\[/.test(line) || /^\s*#!/.test(line))) break;
      context.push(line);
    }

    const block = context.join(";").replace(/^.*?subscription[-_ ]userinfo\s*[:=]?\s*/i, "");
    const usage = parseSubscriptionUserInfo(block);
    if (usage.available) return usage;

    if (marker.lastIndex === match.index) marker.lastIndex += 1;
  }

  return unavailableUsage();
}

function parseHumanTrafficUsage(profileText, profileExpire) {
  const lines = String(profileText || "").split(/\r?\n/);
  let total = null;
  let used = null;
  let remaining = null;

  const totalKeywords = [
    "套餐流量", "总流量", "流量总量", "流量套餐",
    "total\\s+traffic", "traffic\\s+total", "traffic\\s+quota", "data\\s+quota"
  ];
  const usedKeywords = [
    "已用流量", "已使用流量", "流量已用",
    "used\\s+traffic", "traffic\\s+used"
  ];
  const remainingKeywords = [
    "剩余流量", "流量剩余", "可用流量", "(?:^|[^总])剩余",
    "remaining\\s+traffic", "traffic\\s+remaining", "traffic\\s+left"
  ];

  for (let i = 0; i < lines.length; i += 1) {
    const line = oneLine(lines[i]);
    if (!line) continue;

    const pair = parseTrafficUsedTotalPair(line);
    if (pair) {
      if (used === null) used = pair.used;
      if (total === null) total = pair.total;
    }

    if (remaining === null) remaining = extractTrafficAfterKeywords(line, remainingKeywords);
    if (total === null) total = extractTrafficAfterKeywords(line, totalKeywords);
    if (used === null) used = extractTrafficAfterKeywords(line, usedKeywords);
  }

  return buildUsageFromTrafficParts({
    total: total,
    used: used,
    remaining: remaining,
    expireState: profileExpire.state,
    expireValue: profileExpire.value
  });
}

function parseTrafficUsedTotalPair(line) {
  const value = trafficValueRegexSource();
  const pattern = new RegExp("(?:^|[#\\s])(?:traffic|流量)\\s*[:：=]\\s*" + value + "\\s*[/／]\\s*" + value, "i");
  const match = String(line || "").match(pattern);
  if (!match) return null;

  const used = trafficAmountToBytes(match[1], match[2]);
  const total = trafficAmountToBytes(match[3], match[4]);
  if (used === null || total === null || total <= 0 || used > total) return null;
  return { used: used, total: total };
}

function extractTrafficAfterKeywords(line, keywords) {
  const value = trafficValueRegexSource();
  for (let i = 0; i < keywords.length; i += 1) {
    const pattern = new RegExp("(?:" + keywords[i] + ")\\s*(?:[:：=\\-]|是|为)?\\s*" + value, "i");
    const match = String(line || "").match(pattern);
    if (!match) continue;

    const bytes = trafficAmountToBytes(match[1], match[2]);
    if (bytes !== null) return bytes;
  }
  return null;
}

function trafficValueRegexSource() {
  return "([0-9]+(?:\\.[0-9]+)?)\\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\\b";
}

function trafficAmountToBytes(numberText, unitText) {
  const amount = Number(numberText);
  const unit = clean(unitText).toUpperCase();
  if (!Number.isFinite(amount) || amount < 0) return null;

  // 机场流量配额通常按 1024 进位展示；GB 与 GiB 均统一换算为 bytes。
  const powers = { KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 };
  if (!Object.prototype.hasOwnProperty.call(powers, unit)) return null;

  const bytes = amount * Math.pow(1024, powers[unit]);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

function buildUsageFromTrafficParts(parts) {
  const source = parts && typeof parts === "object" ? parts : {};
  const total = positiveTrafficNumber(source.total);
  const used = nonNegativeTrafficNumber(source.used);
  const remaining = nonNegativeTrafficNumber(source.remaining);
  const expireState = source.expireState === "permanent" || source.expireState === "date"
    ? source.expireState
    : "missing";
  const expireValue = expireState === "date" ? source.expireValue : null;

  // total+remaining 的本地文本可信度高于 total+used；若三者因四舍五入不一致，以前者重算 used。
  if (total !== null && remaining !== null && remaining <= total) {
    const derivedUsed = Math.max(0, total - remaining);
    return completeUsage(derivedUsed, total, remaining, expireState, expireValue);
  }

  if (total !== null && used !== null && used <= total) {
    return completeUsage(used, total, Math.max(0, total - used), expireState, expireValue);
  }

  if (total === null && remaining !== null) {
    return {
      available: true,
      used: null,
      total: null,
      remaining: remaining,
      remainingPercent: null,
      expireState: expireState,
      expireValue: expireValue
    };
  }

  return unavailableUsage();
}

function completeUsage(used, total, remaining, expireState, expireValue) {
  return {
    available: true,
    used: Math.max(0, used),
    total: total,
    remaining: Math.max(0, remaining),
    remainingPercent: clamp(remaining / total * 100, 0, 100),
    expireState: expireState,
    expireValue: expireValue
  };
}

function positiveTrafficNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeTrafficNumber(value) {
  if (value === null || value === undefined || clean(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseProfileExpiry(profileText) {
  const lines = String(profileText || "").split(/\r?\n/);
  const keyword = /(?:到期时间|套餐到期|到期日期|有效期(?:至|到)?|expires?|expire\s+date|expiration(?:\s+date)?)/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = oneLine(lines[i]);
    const keyMatch = line.match(keyword);
    if (!keyMatch) continue;

    const scope = line.slice(keyMatch.index);
    if (/(?:永久|不限时|长期有效|never\s+expires?|lifetime)/i.test(scope)) {
      return { state: "permanent", value: null };
    }

    const dateMatch = scope.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (dateMatch) {
      const date = profileCalendarDate(dateMatch[1], dateMatch[2], dateMatch[3]);
      if (date) return { state: "date", value: date };
    }

    // 普通文本中的 0 不代表永久；这里只接受非零的 10～13 位 Unix 秒/毫秒时间戳。
    const timestampMatch = scope.match(/(?:[:：=]\s*)?([1-9][0-9]{9,12})\b/);
    if (timestampMatch) {
      const date = unixTimestampDate(timestampMatch[1]);
      if (date) return { state: "date", value: date };
    }
  }

  return { state: "missing", value: null };
}

function profileCalendarDate(yearText, monthText, dayText) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function unixTimestampDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const milliseconds = timestamp >= 1000000000000 ? timestamp : timestamp * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  return year >= 2000 && year <= 2200 ? date : null;
}

function applyUsageExpireFallback(usage, expireInfo) {
  if (!usage || !usage.available || usage.expireState !== "missing") return usage;
  if (!expireInfo || (expireInfo.state !== "permanent" && expireInfo.state !== "date")) return usage;

  usage.expireState = expireInfo.state;
  usage.expireValue = expireInfo.state === "date" ? expireInfo.value : null;
  return usage;
}

function extractManagedHTTPSURL(profileText) {
  if (typeof profileText !== "string" || !profileText) return "";
  const match = profileText.match(/^\s*#!MANAGED-CONFIG\s+(?:"([^"]+)"|'([^']+)'|(\S+))/im);
  return normalizeSubscriptionHTTPSURL(clean(match && (match[1] || match[2] || match[3])));
}

function normalizeSubscriptionHTTPSURL(value) {
  const url = clean(value);
  if (!/^https:\/\/[^\s/?#]+(?:[/?#]|$)/i.test(url)) return "";
  if (/[\s"'<>*]/.test(url)) return "";
  if (/%2a|redacted|masked|hidden/i.test(url)) return "";
  if (url.length > 4096) return "";

  const authority = url.slice(8).split(/[/?#]/)[0];
  if (!authority || authority.indexOf("@") >= 0) return "";
  return url;
}

function parseSubscriptionUserInfo(header) {
  if (!header) return unavailableUsage();

  const fields = {};
  const pattern = /(?:^|[;,\s])(upload|download|total|expire)\s*=\s*([0-9]+(?:\.[0-9]+)?)(?=$|[;,\s])/ig;
  let match;
  while ((match = pattern.exec(String(header))) !== null) {
    const name = clean(match[1]).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(fields, name)) return unavailableUsage();
    fields[name] = clean(match[2]);
    if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
  }

  const upload = nonNegativeNumber(fields.upload);
  const download = nonNegativeNumber(fields.download);
  const total = nonNegativeNumber(fields.total);
  if (upload === null || download === null || total === null || total <= 0) return unavailableUsage();

  let expireState = "missing";
  let expireValue = null;
  if (Object.prototype.hasOwnProperty.call(fields, "expire")) {
    const expire = nonNegativeNumber(fields.expire);
    if (expire === 0) {
      // 仅在 subscription-userinfo 语义中，明确的 expire=0 才表示永久。
      expireState = "permanent";
    } else if (expire !== null) {
      const date = unixTimestampDate(expire);
      if (date) {
        expireState = "date";
        expireValue = date;
      }
    }
  }

  return buildUsageFromTrafficParts({
    total: total,
    used: upload + download,
    remaining: null,
    expireState: expireState,
    expireValue: expireValue
  });
}

function unavailableUsage() {
  return {
    available: false,
    used: null,
    total: null,
    remaining: null,
    remainingPercent: null,
    expireState: "missing",
    expireValue: null
  };
}

function getHeader(headers, wantedName) {
  if (!headers) return "";
  const wanted = clean(wantedName).toLowerCase();

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 1) {
      const item = headers[i] || {};
      if (clean(item.field).toLowerCase() === wanted) return clean(item.value);
    }
    return "";
  }

  if (typeof headers !== "object") return "";
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === wanted) return clean(headers[keys[i]]);
  }
  return "";
}

/* ---------- DNS / NAT ---------- */

function detectDNS(list) {
  const values = (Array.isArray(list) ? list : []).map(normalizeIP).filter(Boolean);
  if (!values.length) return "未提供";
  const providers = [
    ["Cloudflare", ["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"]],
    ["Google", ["8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844"]],
    ["AliDNS", ["223.5.5.5", "223.6.6.6", "2400:3200::1", "2400:3200:baba::1"]],
    ["DNSPod", ["119.29.29.29", "2402:4e00::"]],
    ["114DNS", ["114.114.114.114", "114.114.115.115"]],
    ["Quad9", ["9.9.9.9", "149.112.112.112"]],
    ["AdGuard", ["94.140.14.14", "94.140.15.15"]]
  ];
  const names = values.map(function (ip) {
    const provider = providers.find(function (p) { return p[1].map(normalizeIP).indexOf(ip) >= 0; });
    if (provider) return provider[0];
    return isPrivateIPv4(ip) || ip === "127.0.0.1" || ip === "::1" ? "本地" : "自定义";
  });
  return Array.from(new Set(names)).join("/");
}

function inferNAT(local) {
  if (!parseIPv4(local)) return "NAT 未测";
  if (isCGNAT(local)) return "CGNAT 候选";
  if (isPrivateIPv4(local)) return "NAT 推断";
  return "NAT 未测";
}

function isPrivateIPv4(ip) {
  const p = parseIPv4(ip);
  return !!p && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168));
}

function isCGNAT(ip) {
  const p = parseIPv4(ip);
  return !!p && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

function parseIPv4(ip) {
  const value = clean(ip);
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const p = value.split(".").map(Number);
  return p.every(function (n) { return n >= 0 && n <= 255; }) ? p : null;
}

function normalizeIP(ip) {
  let value = clean(ip).toLowerCase();
  const v4 = parseIPv4(value);
  if (v4) return v4.join(".");
  if (!value || /[^0-9a-f:.]/.test(value) || value.indexOf(":") < 0) return "";
  if (value.indexOf(".") >= 0) {
    const end = value.lastIndexOf(":");
    const tail = parseIPv4(value.slice(end + 1));
    if (!tail) return "";
    value = value.slice(0, end + 1) + ((tail[0] << 8) + tail[1]).toString(16) + ":" + ((tail[2] << 8) + tail[3]).toString(16);
  }
  const halves = value.split("::");
  if (halves.length > 2) return "";
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (!left.concat(right).every(function (part) { return /^[0-9a-f]{1,4}$/.test(part); })) return "";
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return "";
  const parts = left.concat(Array(missing).fill("0"), right).map(function (part) { return parseInt(part, 16).toString(16); });
  let best = -1, longest = 1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== "0") continue;
    let end = i; while (end < parts.length && parts[end] === "0") end++;
    if (end - i > longest) { best = i; longest = end - i; }
    i = end - 1;
  }
  return best < 0 ? parts.join(":") : parts.slice(0, best).join(":") + "::" + parts.slice(best + longest).join(":");
}

function isPublicIP(value) {
  if (typeof value !== "string") return false;
  const ip = normalizeIP(value), v4 = parseIPv4(ip);
  if (!ip) return false;
  // IANA special-purpose registries: reject non-global source ranges, with the
  // globally reachable PCP/TURN anycast exceptions inside 192.0.0.0/24.
  if (v4) {
    const a = v4[0], b = v4[1], c = v4[2], d = v4[3];
    return !isPrivateIPv4(ip) && !isCGNAT(ip) && a !== 0 && a !== 127 && a < 224 &&
      !(a === 169 && b === 254) &&
      !(a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) &&
      !(a === 192 && b === 0 && c === 2) &&
      !(a === 192 && b === 88 && c === 99) &&
      !(a === 198 && (b === 18 || b === 19)) &&
      !(a === 198 && b === 51 && c === 100) &&
      !(a === 203 && b === 0 && c === 113);
  }
  // Global unicast only; mapped IPv4 is not an IPv6 wire-source address.
  const words = ip.split(":").map(function (part) { return parseInt(part || "0", 16); });
  if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
  if (words[0] === 0x3fff && words[1] < 0x1000) return false; // RFC 9637 documentation /20
  if (words[0] !== 0x2001) return true;
  if (words[1] === 0xdb8) return false; // RFC 3849 documentation /32
  // 2001::/23 protocol assignments are not generally global. Retain assigned
  // Teredo, AMT, AS112 and service anycast exceptions. ORCHID/DETs are identifiers,
  // not public exit locators (RFC 7343/9374), even if usable by overlay APIs.
  if (words[1] >= 0x200) return true;
  return words[1] === 0 || words[1] === 3 ||
    (words[1] === 4 && words[2] === 0x112) || /^2001:1::[123]$/.test(ip);
}

function formatIPv6(local, exitIP) {
  const found = normalizeIP(clean(local).split("%")[0].split("/")[0]);
  const hasLocal = !!found && found.indexOf(":") >= 0 && found !== "::";
  // The public HTTP API exposes profile text, not a merged effective VIF setting.
  // Modules can override that text. No reliable effective-VIF claim is possible here.
  return [hasLocal ? "IPv6 本地" : "", normalizeIP(exitIP).indexOf(":") >= 0 ? "IPv6 出口 ✓" : ""].filter(Boolean).join(" · ");
}

/* ---------- UI ---------- */

function appendSpeedLines(lines, speed) {
  const hasValue = speed && finiteInRange(speed.mbps, 0.001, 100000);
  if (hasValue && speed.state === "fresh") {
    lines.push("测速 " + formatFixed(speed.mbps, 1) + " Mbps · " + formatFixed(speed.mbps / 8, 1) + " MB/s");
    lines.push(speedResultBar(speed.mbps) +
      (speed.mode === "快速采样" || speed.mode === "小响应降级" ? " · " + speed.mode : ""));
    return;
  }
  if (speed && (speed.state === "failed" || speed.state === "cooldown")) {
    let text = speed.state === "cooldown" ? "测速冷却中" : "测速失败 · " + speedFailureLabel(speed.failure);
    if (hasValue) text += " · 上次 " + formatFixed(speed.mbps, 1) + " Mbps（" + speedTimeLabel(speed.time) +
      (speed.otherExit ? speed.exitUnknown ? " · 出口未确认" : " · 旧出口" : " · 同出口") + "）";
    lines.push(text);
    return;
  }
  if (hasValue && !speed.otherExit) {
    lines.push("测速缓存 " + formatFixed(speed.mbps, 1) + " Mbps · " + speedTimeLabel(speed.time));
  } else {
    lines.push(hasValue ? "测速暂无当前出口结果" : "测速未测 · 点刷新");
  }
}

function speedFailureLabel(failure) {
  const reason = failure && failure.reason;
  if (reason === "http" && finiteInRange(failure.status, 100, 599)) return "HTTP " + failure.status;
  return ({ timeout: "超时", deadline: "超时", body_limit: "响应上限", body_mismatch: "响应不完整",
    insufficient_samples: "样本不足", transport: "连接失败", storage: "本地保护不可用", cooldown: "冷却中" })[reason] || "连接失败";
}

function speedTimeLabel(time) {
  const date = new Date(time), now = new Date();
  return (dateLabel(date) === dateLabel(now) ? "" : date.getFullYear() === now.getFullYear()
    ? twoDigits(date.getMonth() + 1) + "/" + twoDigits(date.getDate()) + " " : dateLabel(date) + " ") + timeLabel(date);
}

function speedResultBar(mbps) {
  // Linear display scale only. 500 Mbps fills the bar; the number is never capped.
  const filled = clamp(Math.round(Number(mbps) / SPEED_BAR_MAX_MBPS * SPEED_BAR_SEGMENTS), 0, SPEED_BAR_SEGMENTS);
  return "●".repeat(filled) + "○".repeat(SPEED_BAR_SEGMENTS - filled) + " · 500 Mbps";
}

function appendUsageLines(lines, usage) {
  if (!usage || !usage.available) { lines.push("📦 当前配置未提供流量信息"); return; }
  const remaining = nonNegativeTrafficNumber(usage.remaining);
  if (remaining === null) { lines.push("📦 当前配置未提供流量信息"); return; }
  const total = positiveTrafficNumber(usage.total);
  let left = formatTrafficBytes(remaining), right = total === null ? "总量未提供" : formatTrafficBytes(total);
  if (total !== null && left.split(" ").pop() === right.split(" ").pop()) left = left.split(" ")[0];
  lines.push("📦 剩余 " + left + " / " + right +
    (nonNegativeTrafficNumber(usage.remainingPercent) !== null ? " · " + formatFixed(usage.remainingPercent, 1) + "%" : ""));
  const used = nonNegativeTrafficNumber(usage.used);
  const expiry = usage.expireState === "permanent" ? "永久" :
    usage.expireState === "date" && usage.expireValue ? dateLabel(usage.expireValue) : "未提供";
  const shortExpiry = expiry.indexOf(String(new Date().getFullYear()) + "/") === 0 ? expiry.slice(5) : expiry;
  lines.push((used === null ? "" : "已用 " + formatTrafficBytes(used) + " · ") + "到期 " + shortExpiry);
}

function formatExitLine(countryCode, exit) {
  if (!exit || !exit.ip) return "IP 情报暂不可用";
  const asn = positiveASN(exit.asn);
  return [normalizeCountryCode(countryCode) ? countryLabel(countryCode) : "",
    displayIP(exit.ip), asn ? "AS" + asn : ""].filter(Boolean).join(" · ");
}

function appendServiceLines(lines, title, items) {
  const reachable = items.filter(function (i) { return i.state === "reachable"; }).length;
  let summary = title + " " + reachable + "/" + items.length;
  [["restricted", "受限"], ["error", "异常"], ["unreachable", "不达"], ["unknown", "未知"]].forEach(function (pair) {
    const count = items.filter(function (item) { return item.state === pair[0]; }).length;
    if (count) summary += " · " + pair[1] + " " + count;
  });
  lines.push("", summary);
  for (let i = 0; i < items.length; i += 3) lines.push(items.slice(i, i + 3).map(function (item) {
    let label = item.label;
    if (item.state === "reachable") {
      label = item.catalogue ? "样片" + (item.region ? countryLabel(item.region) : "✓") :
        item.premium === false ? "✓/Premium受限" : item.premium === true ? "✓/报价" : "✓";
    } else if (item.fallback) label = "GET " + item.fallback;
    else if (item.code) label = String(item.code);
    return item.name + " " + label;
  }).join(" · "));
}

function formatGeoLine(exit) {
  if (!exit.ip) return "";
  if (!hasGeo(exit)) return "IP 情报暂不可用";
  const place = [exit.region, exit.city].filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(" / ");
  return [shortenText(shortenISP(exit.org), 20), shortenText(place, 26)].filter(Boolean).join(" · ");
}

function signalState(value) { return value === true ? "✓" : value === false ? "✕" : "?"; }

function appendRiskLines(lines, risk) {
  if (!ENABLE_RISK) { lines.push("🛡 IP 信誉 · 已关闭 · Net.Coffee"); return; }
  if (!risk.ip || !hasRisk(risk)) { lines.push("🛡 IP 情报暂不可用 · Net.Coffee" + (risk.reason ? " · " + risk.reason : "")); return; }
  const s = risk.signals;
  const types = { isp: "ISP", hosting: "托管", business: "商业", education: "教育", government: "政府", banking: "银行" };
  lines.push("🛡 Trust " + (risk.trust === null ? "未知" : risk.trust + "/100") +
    (types[risk.type] ? " · " + types[risk.type] : "") + " · Net.Coffee");
  lines.push("住宅 " + signalState(s.residential) + " · 机房 " + signalState(s.hosting) +
    " · VPN " + signalState(s.vpn) + " · 代理 " + signalState(s.proxy) + " · Tor " + signalState(s.tor));
  const extra = [["abuse", "滥用记录"], ["mobile", "移动网络"], ["crawler", "爬虫"]]
    .filter(function (pair) { return s[pair[0]] === true; }).map(function (pair) { return pair[1]; });
  if (extra.length) lines.push(extra.join(" / "));
}

function displayIP(ip) {
  const value = clean(ip).split("%")[0];
  if (!value) return "";
  if (!MASK_IP) return value;

  const v4 = parseIPv4(value);
  if (v4) return v4[0] + "." + v4[1] + ".*.*";

  if (value.indexOf(":") >= 0) {
    const parts = value.split(":").filter(function (part) { return !!part; });
    if (parts.length >= 2) return parts[0] + ":" + parts[1] + ":****:****";
    if (parts.length === 1) return parts[0] + ":****:****";
    return "****:****";
  }
  return value;
}

function normalizeCountryCode(code) {
  if (typeof code !== "string") return "";
  const value = clean(code).toUpperCase();
  return /^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "ZZ" ? value : "";
}

function countryLabel(code) {
  const names = {
    HK: "香港", TW: "台湾", JP: "日本", SG: "新加坡", US: "美国", KR: "韩国",
    CN: "中国大陆", MO: "澳门", GB: "英国", CA: "加拿大", AU: "澳大利亚",
    DE: "德国", FR: "法国", NL: "荷兰", CH: "瑞士", IT: "意大利", ES: "西班牙",
    RU: "俄罗斯", IN: "印度", TH: "泰国", MY: "马来西亚", PH: "菲律宾",
    VN: "越南", ID: "印度尼西亚", NZ: "新西兰", BR: "巴西", MX: "墨西哥",
    AE: "阿联酋", TR: "土耳其", SE: "瑞典", NO: "挪威", FI: "芬兰",
    DK: "丹麦", PL: "波兰", IE: "爱尔兰", BE: "比利时", AT: "奥地利"
  };
  const value = normalizeCountryCode(code);
  return value ? (names[value] || value) : "未知地区";
}

function shortenISP(value) {
  let text = oneLine(value);
  if (!text) return "";

  text = text.replace(/\s*\([^)]{1,50}\)\s*$/g, "");
  text = text.replace(/[,，]?\s+(?:limited|ltd\.?|llc|inc\.?|incorporated|corp\.?|corporation|company|co\.?|plc|pte\.?\s+ltd\.?|gmbh|s\.?a\.?|b\.?v\.?)$/i, "");
  text = text.replace(/\s+(?:communications?|telecommunications?|network services?|internet services?)$/i, "");
  text = text.replace(/\s{2,}/g, " ").trim();
  return shortenText(text, 28);
}

function formatTrafficBytes(bytes) {
  const value = Math.max(0, Number(bytes));
  if (!Number.isFinite(value)) return "0 MB";

  const MB = 1024 * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;
  if (value >= TB) return formatTrimmed(value / TB, 2) + " TB";
  if (value >= GB) return formatTrimmed(value / GB, 2) + " GB";
  return formatTrimmed(value / MB, 2) + " MB";
}

function formatTrimmed(value, digits) {
  if (!Number.isFinite(Number(value))) return "0";
  return Number(value).toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatFixed(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "0";
}

function fmtMs(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Math.round(Number(value)) + "ms" : "未知";
}

function dateLabel(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "未提供";
  return date.getFullYear() + "/" + twoDigits(date.getMonth() + 1) + "/" + twoDigits(date.getDate());
}

function timeLabel(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "--:--";
  return twoDigits(date.getHours()) + ":" + twoDigits(date.getMinutes());
}

function twoDigits(value) {
  const number = Math.floor(Number(value));
  return number < 10 ? "0" + number : String(number);
}

/* ---------- General helpers ---------- */

function parseArgs(text) {
  const output = {};
  String(text || "").split("&").forEach(function (part) {
    if (!part) return;
    const index = part.indexOf("=");
    const rawKey = index >= 0 ? part.slice(0, index) : part;
    const rawValue = index >= 0 ? part.slice(index + 1) : "";
    try {
      output[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch (_) {
      output[rawKey] = rawValue;
    }
  });
  return output;
}

function clean(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function oneLine(value) {
  return clean(value).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
}

function numberOrNull(value) {
  if (value === undefined || value === null || clean(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveASN(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = clean(value).replace(/^AS/i, "");
  const number = Number(text);
  return Number.isFinite(number) && Number.isInteger(number) && number > 0 && number <= 4294967295 ? number : null;
}

function finiteInRange(value, min, max) {
  if (value === null || value === undefined || typeof value === "boolean" || clean(value) === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function shortenText(value, maxLength) {
  const text = oneLine(value);
  const max = Math.max(2, Number(maxLength) || 2);
  if (text.length <= max) return text;

  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const safe = lastSpace >= Math.floor(max * 0.55) ? slice.slice(0, lastSpace) : slice;
  return safe.replace(/[\s,，.。-]+$/g, "") + "…";
}
