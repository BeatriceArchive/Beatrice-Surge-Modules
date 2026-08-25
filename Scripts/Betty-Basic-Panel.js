/*
 * 贝蒂的基础面板 - Surge iOS 单 Information Panel
 * Version: 1.3.0
 *
 * 参数：
 * POLICY = 可选；留空时所有联网检测按 Surge 当前规则执行
 * YS=1   = 默认对出口 IP 打码
 * RISK=1 = 开启 HTTPS IP 风险 / 纯净估算
 *
 * 安全边界：
 * - 无 MITM、Rewrite、Rule、eval、Function()、远程代码或第三方统计服务。
 * - 所有 $httpClient 请求均关闭 auto-cookie，不发送 Cookie、Authorization 或 Profile 正文。
 * - 仅在 $trigger === "button" 时使用 $httpClient 快速估算下载速度；自动刷新只读
 *   本地测速缓存。测速约 3 秒，整个测速流程受 4.8 秒硬保护限制。
 * - 当前 Profile 只通过官方 /v1/profiles/current?sensitive=0 读取脱敏文本；不读取敏感版本，
 *   不保存 Profile、Managed URL、订阅 Token 或 subscription-userinfo 原始 Header。
 *
 * 外部 HTTPS 请求清单（服务端必然能看到发起请求的出口 IP）：
 * - www.gstatic.com：DIRECT 延迟；不含其他用户数据。
 * - cp.cloudflare.com：当前规则 / 可选 POLICY 延迟；不含其他用户数据。
 * - speed.cloudflare.com：出口元数据；仅手动刷新时执行快速下载速度估算，单响应最多
 *   3 MiB、4 workers、正式阶段最多约 64 MiB；不含其他用户数据。
 * - ipwho.is：出口元数据第二 fallback；不含其他用户数据。
 * - api.ipify.org：仅出口 IPv4 的最后 fallback；不含其他用户数据。
 * - www.netflix.com、www.youtube.com、www.disneyplus.com、open.spotify.com、
 *   www.tiktok.com、www.primevideo.com：流媒体可用性；不含账号、Cookie 或其他用户数据。
 * - chatgpt.com、claude.ai、gemini.google.com、chat.deepseek.com、grok.com、
 *   www.perplexity.ai：AI 服务可达性；不含账号、Cookie 或其他用户数据。
 * - api.ipapi.is、proxycheck.io：仅查询当前出口 IP 的风险信息；不含其他用户数据。
 * - 当前 Managed Profile 或用户显式提供 SUB_URL 的原始 HTTPS 主机（动态）：仅在本地文本
 *   无法取得流量时请求该 URL；Token 只会发回原主机，不会保存、记录或转发给其他服务。
 */

const PANEL_TITLE = "贝蒂的基础面板";
const ARGS = parseArgs(typeof $argument === "string" ? $argument : "");
const POLICY = clean(ARGS.POLICY);
const MASK_IP = clean(ARGS.YS) === "1";
const ENABLE_RISK = clean(ARGS.RISK) !== "0";
const SUB_URL = clean(ARGS.SUB_URL);

const HTTP_TIMEOUT = 7;
const PROFILE_TIMEOUT = 10;
const PROXY_LATENCY_TIMEOUT = 3;

const SPEED_REQUEST_TIMEOUT = 4;
const SPEED_TOTAL_TIMEOUT_MS = 4800;
const SPEED_TARGET_DURATION_MS = 3000;
const SPEED_WARMUP_BYTES = 32 * 1024;
const SPEED_PREFERRED_BLOCK_SIZES = [512 * 1024, 1024 * 1024, 2 * 1024 * 1024, 3 * 1024 * 1024];
// Surge 实机曾验证 60/48/32 KiB 可避开较小的 Response Body 上限；仅作同源安全降级。
const SPEED_SAFE_BLOCK_SIZES = [60 * 1024, 48 * 1024, 32 * 1024];
const SPEED_WORKER_COUNT = 4;
const SPEED_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SPEED_MIN_SUCCESS_RATIO = 0.5;
const SPEED_MIN_SUCCESS_SAMPLES = 2;
const SPEED_MIN_SUCCESS_BYTES = 128 * 1024;
const SPEED_MIN_SAMPLE_MS = 5;
const SPEED_MIN_MEASURE_MS = 500;
const SPEED_BAR_MAX_MBPS = 1000;
const SPEED_BAR_SEGMENTS = 10;

const SPEED_KEY = "betty.basic.speed";

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

  const results = await Promise.all([
    getDNSDelay(),
    latency("https://www.gstatic.com/generate_204", "DIRECT"),
    latency("https://cp.cloudflare.com/generate_204", POLICY, PROXY_LATENCY_TIMEOUT),
    getExit(POLICY),

    testNetflix(POLICY),
    testYouTubePremium(POLICY),
    testDisney(POLICY),
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

  const dnsDelay = results[0];
  const directLatency = results[1];
  const proxyLatency = results[2];
  const exit = results[3];

  const netflix = results[4];
  const youtube = results[5];
  const disney = results[6];
  const spotify = results[7];
  const tiktok = results[8];
  const prime = results[9];

  const chatgpt = results[10];
  const claude = results[11];
  const gemini = results[12];
  const deepseek = results[13];
  const grok = results[14];
  const perplexity = results[15];

  const usage = results[16];

  let riskInfo = unavailableRisk();
  if (ENABLE_RISK && exit.ip) {
    riskInfo = await getRisk(exit.ip, POLICY);
  }

  // 正常面板检测全部结束后才处理测速；自动刷新在这里仅读取缓存。
  const speed = await getSpeedForThisRun(POLICY);

  const nat = inferNAT(net.ipv4, exit.ip);
  const dns = detectDNS(net.dns);
  const countryCode = normalizeCountryCode(exit.country || netflix.region);

  const media = [
    { name: "Netflix", ok: netflix.ok, suffix: netflix.region ? " " + flag(netflix.region) : "" },
    { name: "YouTube", ok: youtube.ok, suffix: "" },
    { name: "Disney+", ok: disney.ok, suffix: "" },
    { name: "Spotify", ok: spotify.ok, suffix: "" },
    { name: "TikTok", ok: tiktok.ok, suffix: "" },
    { name: "Prime", ok: prime.ok, suffix: "" }
  ];

  const ai = [
    { name: "ChatGPT", ok: chatgpt.ok },
    { name: "Claude", ok: claude.ok },
    { name: "Gemini", ok: gemini.ok },
    { name: "DeepSeek", ok: deepseek.ok },
    { name: "Grok", ok: grok.ok },
    { name: "Perplexity", ok: perplexity.ok }
  ];

  const mediaOK = countOK(media);
  const aiOK = countOK(ai);
  const lines = [];

  lines.push(
    "🌐 " + shortenText(net.name || "当前网络", 22) +
    " · IPv4 " + mark(!!net.ipv4) +
    " · IPv6 " + mark(!!net.ipv6)
  );
  lines.push(
    "DNS " + dns +
    (dnsDelay !== null ? " " + dnsDelay + "ms" : "") +
    " · " + nat
  );
  lines.push(formatExitLine(countryCode, exit));
  lines.push(formatOrganizationLine(exit));
  lines.push("延迟  直连 " + fmtMs(directLatency) + " · 代理 " + fmtMs(proxyLatency));

  lines.push("");
  appendSpeedLines(lines, speed);

  lines.push("");
  lines.push("🎬 流媒体 " + mediaOK + "/6");
  lines.push(formatChecks(media.slice(0, 3)));
  lines.push(formatChecks(media.slice(3, 6)));

  lines.push("");
  lines.push("✨ AI " + aiOK + "/6");
  lines.push(formatChecks(ai.slice(0, 3)));
  lines.push(formatChecks(ai.slice(3, 6)));

  lines.push("");
  appendUsageLines(lines, usage);

  lines.push("");
  if (!ENABLE_RISK) {
    lines.push("🛡 风险检测已关闭");
  } else if (!riskInfo.available) {
    lines.push("🛡 风险未检测");
  } else {
    lines.push(
      "🛡 " + riskInfo.networkType +
      " · " + riskInfo.score + "/100" +
      " · " + riskInfo.level +
      " · " + timeLabel(new Date(riskInfo.time))
    );
  }

  let iconColor = "#0A84FF";
  if (riskInfo.available && riskInfo.level === "高风险") {
    iconColor = "#FF453A";
  } else if (mediaOK < 4 || aiOK < 4) {
    iconColor = "#FF9F0A";
  } else if (mediaOK === 6 && aiOK === 6) {
    iconColor = "#30D158";
  }

  $done({
    title: PANEL_TITLE,
    content: lines.join("\n"),
    icon: "waveform.path.ecg",
    "icon-color": iconColor
  });
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
  const result = await httpAPI("POST", "/v1/test/dns_delay", {});
  if (!result || typeof result !== "object") return null;

  let delay = Number(result.delay);
  if (!Number.isFinite(delay) || delay < 0) return null;
  if (delay > 0 && delay < 10) delay *= 1000;
  return Math.round(delay);
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

    function failed() {
      finish({ ok: false, status: 0, headers: {}, data: "", ms: Math.max(1, Date.now() - started) });
    }

    setTimeout(failed, (timeout + 2) * 1000);

    const request = {
      url: url,
      timeout: timeout,
      "auto-cookie": false,
      "auto-redirect": extra.autoRedirect !== false,
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
          status: Number.isFinite(status) ? status : 0,
          headers: headers,
          data: body,
          ms: Math.max(1, Date.now() - started)
        });
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
  return result.ok && result.status > 0 && result.status < 500 ? result.ms : null;
}

function safeJSON(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
}

/* ---------- Exit IP: HTTPS multi-source fallback ---------- */

async function getExit(policy) {
  const sources = [
    async function () {
      const result = await http(
        "get",
        "https://speed.cloudflare.com/meta?_=" + Date.now(),
        policy
      );
      if (!isUsableResponse(result)) return null;
      const data = safeJSON(result.data);
      if (!data) return null;
      return {
        ip: clean(data.clientIp),
        country: clean(data.country),
        city: clean(data.city),
        region: clean(data.region),
        asn: positiveASN(data.asn),
        org: clean(data.asOrganization)
      };
    },
    async function () {
      const result = await http(
        "get",
        "https://ipwho.is/?_=" + Date.now(),
        policy
      );
      if (!isUsableResponse(result)) return null;
      const data = safeJSON(result.data);
      if (!data || data.success === false) return null;
      return {
        ip: clean(data.ip),
        country: clean(data.country_code),
        city: clean(data.city),
        region: clean(data.region),
        asn: positiveASN(data.connection && data.connection.asn),
        org: clean(data.connection && (data.connection.org || data.connection.isp))
      };
    },
    async function () {
      const result = await http(
        "get",
        "https://api.ipify.org?format=json&_=" + Date.now(),
        policy
      );
      if (!isUsableResponse(result)) return null;
      const data = safeJSON(result.data);
      return data ? { ip: clean(data.ip), country: "", city: "", region: "", asn: null, org: "" } : null;
    }
  ];

  for (let i = 0; i < sources.length; i += 1) {
    try {
      const value = await sources[i]();
      if (value && isIPAddress(value.ip)) return enrichExitWithSurge(value);
    } catch (_) {}
  }

  return { ip: "", country: "", city: "", region: "", asn: null, org: "" };
}

function enrichExitWithSurge(value) {
  if (!value || !value.ip) return value;

  try {
    if (!value.country && typeof $utils === "object" && $utils && typeof $utils.geoip === "function") {
      value.country = clean($utils.geoip(value.ip));
    }
  } catch (_) {}

  try {
    if (!value.asn && typeof $utils === "object" && $utils && typeof $utils.ipasn === "function") {
      value.asn = positiveASN($utils.ipasn(value.ip));
    }
  } catch (_) {}

  try {
    if (!value.org && typeof $utils === "object" && $utils && typeof $utils.ipaso === "function") {
      value.org = clean($utils.ipaso(value.ip));
    }
  } catch (_) {}

  return value;
}

function isUsableResponse(result) {
  return !!result && result.ok && result.status >= 200 && result.status < 400;
}

/* ---------- Risk: api.ipapi.is -> proxycheck.io fallback ---------- */

async function getRisk(ip, policy) {
  const primary = await getIPAPIRisk(ip, policy);
  if (primary.available) return primary;
  return getProxyCheckRisk(ip, policy);
}

async function getIPAPIRisk(ip, policy) {
  const result = await http(
    "get",
    "https://api.ipapi.is/?q=" + encodeURIComponent(ip) + "&_=" + Date.now(),
    policy
  );
  if (!isUsableResponse(result)) return unavailableRisk();

  const data = safeJSON(result.data);
  if (!hasIPAPIRiskSignals(data)) return unavailableRisk();

  return summarizeIPAPIRisk(data);
}

function hasIPAPIRiskSignals(data) {
  if (!data || typeof data !== "object") return false;
  const directKeys = [
    "is_datacenter", "is_hosting", "is_tor", "is_proxy", "is_vpn",
    "is_abuser", "is_abuse", "is_mobile", "mobile", "is_residential"
  ];
  for (let i = 0; i < directKeys.length; i += 1) {
    if (Object.prototype.hasOwnProperty.call(data, directKeys[i])) return true;
  }

  const security = data.security && typeof data.security === "object" ? data.security : null;
  if (!security) return false;

  const securityKeys = [
    "is_datacenter", "is_hosting", "is_tor", "tor",
    "is_proxy", "proxy", "is_vpn", "vpn", "is_abuser", "abuse",
    "is_mobile", "is_residential"
  ];
  for (let i = 0; i < securityKeys.length; i += 1) {
    if (Object.prototype.hasOwnProperty.call(security, securityKeys[i])) return true;
  }
  return false;
}

function summarizeIPAPIRisk(data) {
  const security = data.security && typeof data.security === "object" ? data.security : {};
  const company = data.company && typeof data.company === "object" ? data.company : {};
  const asn = data.asn && typeof data.asn === "object" ? data.asn : {};

  const vpn = anyTruthy([data.is_vpn, security.is_vpn, security.vpn]);
  const proxy = anyTruthy([data.is_proxy, security.is_proxy, security.proxy]);
  const tor = anyTruthy([data.is_tor, security.is_tor, security.tor]);
  const abuse = anyTruthy([data.is_abuser, data.is_abuse, security.is_abuser, security.abuse]);
  const datacenter = anyTruthy([
    data.is_datacenter, data.is_hosting, security.is_datacenter,
    security.is_hosting, company.is_datacenter
  ]);
  const mobile = anyTruthy([data.is_mobile, data.mobile, security.is_mobile]);
  const residential = anyTruthy([data.is_residential, security.is_residential]);

  /*
   * 本地透明“纯净估算”，不是 IPQualityScore、Scamalytics 或任何商业官方评分：
   * 100 分起；TOR -55、滥用 -35、VPN -22、代理 -18、机房/托管 -10；
   * 明确住宅且未命中 VPN/代理时 +2；最后四舍五入并限制在 0～100。
   */
  let score = 100;
  if (tor) score -= 55;
  if (abuse) score -= 35;
  if (vpn) score -= 22;
  if (proxy) score -= 18;
  if (datacenter) score -= 10;
  if (residential && !vpn && !proxy && !tor) score += 2;
  score = clamp(Math.round(score), 0, 100);

  const typeText = clean(company.type || asn.type).toLowerCase();
  let type = "未知网络";
  if (vpn || proxy || tor) type = "VPN / 代理";
  else if (mobile) type = "移动网络";
  else if (residential && !datacenter) type = "住宅 IP";
  else if (datacenter) type = "商业机房";
  else if (typeText.indexOf("isp") >= 0 || typeText.indexOf("business") >= 0) type = "ISP 网络";

  return {
    available: true,
    score: score,
    networkType: type,
    level: riskLevel(score),
    time: Date.now(),
    source: "ipapi-local-estimate"
  };
}

async function getProxyCheckRisk(ip, policy) {
  const result = await http(
    "get",
    "https://proxycheck.io/v3/" + encodeURIComponent(ip) + "?p=0&tag=0&_=" + Date.now(),
    policy
  );
  if (!isUsableResponse(result)) return unavailableRisk();

  const data = safeJSON(result.data);
  if (!data || (clean(data.status) !== "ok" && clean(data.status) !== "warning")) {
    return unavailableRisk();
  }

  const item = getProxyCheckItem(data, ip);
  if (!item) return unavailableRisk();

  const detections = item.detections && typeof item.detections === "object" ? item.detections : {};
  const rawRisk = numberOrNull(detections.risk !== undefined ? detections.risk : item.risk);
  if (rawRisk === null || rawRisk < 0 || rawRisk > 100) return unavailableRisk();

  // ProxyCheck 的 risk 越高越危险；Panel 显示纯净估算，所以使用 100 - risk。
  const score = clamp(Math.round(100 - rawRisk), 0, 100);
  const network = item.network && typeof item.network === "object" ? item.network : {};
  const networkType = clean(network.type || item.type).toLowerCase();

  let type = "未知网络";
  if (truthy(detections.vpn) || truthy(detections.proxy) || truthy(detections.tor) || truthy(detections.anonymous)) {
    type = "VPN / 代理";
  } else if (networkType === "residential") {
    type = "住宅 IP";
  } else if (networkType === "wireless") {
    type = "移动网络";
  } else if (networkType === "hosting") {
    type = "商业机房";
  } else if (networkType === "business") {
    type = "ISP 网络";
  }

  return {
    available: true,
    score: score,
    networkType: type,
    level: riskLevel(score),
    time: Date.now(),
    source: "proxycheck"
  };
}

function getProxyCheckItem(data, ip) {
  if (data[ip] && typeof data[ip] === "object") return data[ip];
  const keys = Object.keys(data);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key === "status" || key === "query_time" || key === "node" || key === "message") continue;
    if (isIPAddress(key) && data[key] && typeof data[key] === "object") return data[key];
  }
  return null;
}

function unavailableRisk() {
  return {
    available: false,
    score: null,
    networkType: "未知网络",
    level: "未知",
    time: 0,
    source: ""
  };
}

function riskLevel(score) {
  return score >= 75 ? "低风险" : score >= 45 ? "中风险" : "高风险";
}

/* ---------- Media ---------- */

async function testNetflix(policy) {
  const first = await http(
    "get",
    "https://www.netflix.com/title/81280792?_=" + Date.now(),
    policy
  );
  if (first.ok && first.status === 200) {
    return { ok: true, region: netflixRegion(first.headers, first.data) };
  }

  if (first.ok && first.status === 404) {
    const second = await http(
      "get",
      "https://www.netflix.com/title/80018499?_=" + Date.now(),
      policy
    );
    if (second.ok && second.status === 200) {
      return { ok: true, region: netflixRegion(second.headers, second.data), limited: true };
    }
  }

  return { ok: false, region: "" };
}

function netflixRegion(headers, body) {
  const originating = getHeader(headers, "x-originating-url");
  let match = clean(originating).match(/netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\/title/i);
  if (match) return match[1].toUpperCase();

  match = String(body || "").match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
  return match ? match[1].toUpperCase() : "";
}

async function testYouTubePremium(policy) {
  const result = await http(
    "get",
    "https://www.youtube.com/premium?_=" + Date.now(),
    policy
  );
  if (!result.ok || result.status !== 200) return { ok: false, region: "" };

  const body = result.data || "";
  if (/Premium is not available in your (?:country|region)/i.test(body)) {
    return { ok: false, region: "" };
  }

  let match = body.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
  if (!match) match = body.match(/"GL"\s*:\s*"([A-Z]{2})"/i);
  return { ok: true, region: match ? match[1].toUpperCase() : "" };
}

async function testDisney(policy) {
  const result = await http(
    "get",
    "https://www.disneyplus.com/?_=" + Date.now(),
    policy
  );
  if (!result.ok || !result.status || result.status >= 500) return { ok: false };
  if (/not available in your (?:region|country)/i.test(result.data || "")) return { ok: false };
  return { ok: isReachableStatus(result.status) };
}

/*
 * Spotify / TikTok / Prime Video 这里只判断服务可达性，不代表账号级完整解锁。
 * 2xx、3xx、401、403 表示目标站点或其 WAF 已可达；网络错误、超时和 5xx 判失败。
 */
async function testServiceReachable(url, policy) {
  const result = await http(
    "get",
    appendTimestamp(url),
    policy,
    { autoRedirect: false }
  );
  return { ok: result.ok && isReachableStatus(result.status) };
}

/*
 * AI 区仅表示网站 / WAF 可达，不代表账号可登录、可订阅或模型完整可用。
 * Panel 不展示 HTTP 状态码。
 */
async function testAIReachable(url, policy) {
  const result = await http(
    "get",
    appendTimestamp(url),
    policy,
    { autoRedirect: false }
  );
  return { ok: result.ok && isReachableStatus(result.status) };
}

function isReachableStatus(status) {
  const code = Number(status);
  return (code >= 200 && code < 400) || code === 401 || code === 403;
}

function appendTimestamp(url) {
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now();
}

/* ---------- Manual-only download speed ---------- */

/*
 * Surge Panel 快速下载速度估算：
 * - 只在手动 button 刷新时运行；自动刷新仅读取上次成功缓存。
 * - 先以小样本预热，再从 512 KiB、1/2/3 MiB 中选择本次最大的安全响应块；
 *   若 Surge 的 Response Body 上限更小，则降级到已验证的 60/48/32 KiB。
 * - 正式阶段最多 4 workers、约 3 秒、64 MiB；最终速度只使用在有效窗口内
 *   完整成功接收的总 bytes / 实际 wall-clock，不使用倍率或经验修正。
 * - 这不是 Ookla、Fast.com 或 Cloudflare 官方完整 Speedtest。
 */
async function getSpeedForThisRun(policy) {
  const previous = readSpeedResult();
  const trigger = typeof $trigger === "string" ? $trigger : "";

  if (trigger !== "button") return previous;

  const fresh = await runDownloadSpeedTest(policy);
  if (!fresh) return previous;

  saveSpeedResult(fresh);
  return fresh;
}

async function runDownloadSpeedTest(policy) {
  const testStarted = Date.now();
  const hardDeadline = testStarted + SPEED_TOTAL_TIMEOUT_MS;
  const discoveryDeadline = Math.min(
    hardDeadline - SPEED_MIN_MEASURE_MS,
    testStarted + 1800
  );

  await warmUpDownloadSpeed(policy, discoveryDeadline);

  const blockBytes = await selectSpeedBlockSize(policy, discoveryDeadline);
  if (!blockBytes || Date.now() >= hardDeadline) return null;

  const result = await runQuickSpeedTest(policy, blockBytes, hardDeadline);
  if (!result || !result.success) return null;

  const mbps = Number(result.mbps);
  const mbPerSecond = Number(result.mbPerSecond);
  if (!Number.isFinite(mbps) || mbps <= 0 ||
      !Number.isFinite(mbPerSecond) || mbPerSecond <= 0) {
    return null;
  }

  return { mbps: mbps, mbPerSecond: mbPerSecond, time: Date.now() };
}

async function warmUpDownloadSpeed(policy, deadline) {
  if (!Number.isFinite(Number(deadline)) || Date.now() >= Number(deadline)) return;
  await downloadSpeedBlock(policy, SPEED_WARMUP_BYTES, "warmup", 0, Number(deadline));
}

async function selectSpeedBlockSize(policy, deadline) {
  let largestSafe = 0;
  let allowSafeFallback = false;

  // 由小到大探测，前一档成功才继续；probe bytes 不计入最终成绩。
  for (let i = 0; i < SPEED_PREFERRED_BLOCK_SIZES.length; i += 1) {
    if (Date.now() >= deadline) break;
    const blockBytes = SPEED_PREFERRED_BLOCK_SIZES[i];
    const result = await downloadSpeedBlock(policy, blockBytes, "probe", i, deadline);
    if (!result.ok) {
      allowSafeFallback = !!result.sizeLimitDetected || !!result.incompleteBody;
      break;
    }
    largestSafe = blockBytes;
  }

  if (largestSafe > 0) return largestSafe;
  if (!allowSafeFallback) return 0;

  // 当前 Surge 环境若仍受约 68 KiB Body 上限约束，回退到既有实机安全档。
  for (let i = 0; i < SPEED_SAFE_BLOCK_SIZES.length; i += 1) {
    if (Date.now() >= deadline) break;
    const blockBytes = SPEED_SAFE_BLOCK_SIZES[i];
    const result = await downloadSpeedBlock(policy, blockBytes, "safe-probe", i, deadline);
    if (result.ok) return blockBytes;
  }

  return 0;
}

async function runQuickSpeedTest(policy, blockBytes, hardDeadline) {
  const started = Date.now();
  const measurementDeadline = Math.min(started + SPEED_TARGET_DURATION_MS, hardDeadline);
  if (measurementDeadline - started < SPEED_MIN_MEASURE_MS) {
    return failedQuickSpeedResult(0, 0, 0, 0, 0);
  }

  const totalBlocks = Math.max(1, Math.floor(SPEED_MAX_TOTAL_BYTES / blockBytes));
  const state = {
    nextBlockIndex: 0,
    attemptedSamples: 0,
    successfulSamples: 0,
    failedSamples: 0,
    successfulBytes: 0
  };

  const workerCount = Math.min(SPEED_WORKER_COUNT, totalBlocks);
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(
      runQuickSpeedWorker(
        policy,
        blockBytes,
        totalBlocks,
        measurementDeadline,
        state,
        i
      )
    );
  }

  await Promise.all(workers);

  const endedAt = Math.min(Date.now(), measurementDeadline);
  const elapsed = Math.max(1, endedAt - started);
  const successRatio = state.attemptedSamples > 0
    ? state.successfulSamples / state.attemptedSamples
    : 0;
  const success = elapsed >= SPEED_MIN_MEASURE_MS &&
    state.successfulSamples >= SPEED_MIN_SUCCESS_SAMPLES &&
    state.successfulBytes >= SPEED_MIN_SUCCESS_BYTES &&
    successRatio >= SPEED_MIN_SUCCESS_RATIO;

  if (!success) {
    return failedQuickSpeedResult(
      state.attemptedSamples,
      state.successfulSamples,
      state.failedSamples,
      state.successfulBytes,
      elapsed
    );
  }

  const seconds = elapsed / 1000;
  const mbps = state.successfulBytes * 8 / seconds / 1000000;
  const mbPerSecond = state.successfulBytes / seconds / 1000000;
  const valid = Number.isFinite(mbps) && mbps > 0 &&
    Number.isFinite(mbPerSecond) && mbPerSecond > 0;

  return {
    success: valid,
    mbps: valid ? mbps : 0,
    mbPerSecond: valid ? mbPerSecond : 0,
    attemptedSamples: state.attemptedSamples,
    successfulSamples: state.successfulSamples,
    failedSamples: state.failedSamples,
    successfulBytes: state.successfulBytes,
    elapsed: elapsed,
    blockBytes: blockBytes
  };
}

async function runQuickSpeedWorker(policy, blockBytes, totalBlocks, deadline, state, workerIndex) {
  while (Date.now() < deadline) {
    // 分配与递增之间没有 await；4 个 worker 不会领取同一个任务编号。
    const blockIndex = state.nextBlockIndex;
    if (blockIndex >= totalBlocks) return;
    state.nextBlockIndex += 1;
    state.attemptedSamples += 1;

    const result = await downloadSpeedBlock(
      policy,
      blockBytes,
      "measure-" + workerIndex,
      blockIndex,
      deadline
    );

    if (result.ok && result.completedAt <= deadline) {
      state.successfulSamples += 1;
      state.successfulBytes += result.bytes;
    } else {
      state.failedSamples += 1;
    }
  }
}

function failedQuickSpeedResult(attempted, successful, failed, bytes, elapsed) {
  return {
    success: false,
    mbps: 0,
    mbPerSecond: 0,
    attemptedSamples: Number(attempted) || 0,
    successfulSamples: Number(successful) || 0,
    failedSamples: Number(failed) || 0,
    successfulBytes: Number(bytes) || 0,
    elapsed: Number(elapsed) || 0,
    blockBytes: 0
  };
}

function downloadSpeedBlock(policy, blockBytes, requestTag, index, deadline) {
  return new Promise(function (resolve) {
    const started = Date.now();
    const stopAt = Number(deadline);
    const remaining = Number.isFinite(stopAt) ? stopAt - started : 0;
    let settled = false;
    let watchdog = null;

    function finish(value) {
      if (settled) return;
      settled = true;
      if (watchdog !== null && typeof clearTimeout === "function") clearTimeout(watchdog);
      resolve(value || {
        ok: false,
        bytes: 0,
        elapsed: Math.max(1, Date.now() - started),
        completedAt: Date.now(),
        sizeLimitDetected: false,
        incompleteBody: false
      });
    }

    if (!Number.isFinite(Number(blockBytes)) || Number(blockBytes) <= 0 || remaining <= 0) {
      finish(null);
      return;
    }

    watchdog = setTimeout(function () {
      finish({
        ok: false,
        bytes: 0,
        elapsed: Math.max(1, Date.now() - started),
        completedAt: Date.now(),
        sizeLimitDetected: false,
        incompleteBody: false
      });
    }, Math.max(1, remaining));

    const cacheKey = Date.now() + "-" + requestTag + "-" + index + "-" +
      Math.floor(Math.random() * 1000000000);
    const requestTimeout = Math.max(
      1,
      Math.min(SPEED_REQUEST_TIMEOUT, Math.ceil(remaining / 1000))
    );
    const request = {
      url: "https://speed.cloudflare.com/__down?bytes=" + blockBytes + "&_=" + cacheKey,
      timeout: requestTimeout,
      "binary-mode": true,
      "auto-cookie": false,
      "auto-redirect": true,
      headers: {
        "User-Agent": "Surge-Betty-Panel/1.0",
        "Accept": "application/octet-stream",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-store"
      }
    };
    if (clean(policy)) request.policy = clean(policy);

    try {
      const client = typeof $httpClient === "object" && $httpClient ? $httpClient : null;
      if (!client || typeof client.get !== "function") {
        finish(null);
        return;
      }

      client.get(request, function (error, response, data) {
        const completedAt = Date.now();
        const elapsed = Math.max(1, completedAt - started);
        const status = response
          ? Number(response.status !== undefined ? response.status : response.statusCode)
          : 0;
        const bytes = binaryLength(data);
        const sizeLimitDetected = isResponseBodySizeLimitError(error);
        const completeBody = bytes === Number(blockBytes);
        const incompleteBody = !error && !!response && status >= 200 && status < 300 &&
          bytes > 0 && bytes < Number(blockBytes);
        const ok = !error && !!response && status >= 200 && status < 300 &&
          completeBody && elapsed >= SPEED_MIN_SAMPLE_MS && completedAt <= stopAt;

        finish({
          ok: ok,
          bytes: ok ? bytes : 0,
          elapsed: elapsed,
          completedAt: completedAt,
          sizeLimitDetected: sizeLimitDetected,
          incompleteBody: incompleteBody
        });
      });
    } catch (error) {
      finish({
        ok: false,
        bytes: 0,
        elapsed: Math.max(1, Date.now() - started),
        completedAt: Date.now(),
        sizeLimitDetected: isResponseBodySizeLimitError(error),
        incompleteBody: false
      });
    }
  });
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
  if (!data) return 0;
  if (Number.isFinite(Number(data.byteLength))) return Number(data.byteLength);
  if (Number.isFinite(Number(data.length))) return Number(data.length);
  return 0;
}

function readSpeedResult() {
  try {
    if (typeof $persistentStore !== "object" || !$persistentStore || typeof $persistentStore.read !== "function") {
      return null;
    }

    const raw = $persistentStore.read(SPEED_KEY);
    if (typeof raw !== "string" || !raw) return null;

    let saved;
    try {
      saved = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    if (!saved || typeof saved !== "object") return null;

    const mbps = Number(saved.mbps);
    const mbPerSecond = Number(saved.mbPerSecond);
    const time = Number(saved.time);

    if (!Number.isFinite(mbps) || mbps <= 0) return null;
    if (!Number.isFinite(mbPerSecond) || mbPerSecond <= 0) return null;
    if (!Number.isFinite(time) || time <= 0) return null;

    return { mbps: mbps, mbPerSecond: mbPerSecond, time: time };
  } catch (_) {
    return null;
  }
}

function saveSpeedResult(result) {
  if (!result) return false;
  try {
    if (typeof $persistentStore !== "object" || !$persistentStore || typeof $persistentStore.write !== "function") {
      return false;
    }

    const mbps = Number(result.mbps);
    const mbPerSecond = Number(result.mbPerSecond);
    const time = Number(result.time);
    if (!Number.isFinite(mbps) || mbps <= 0) return false;
    if (!Number.isFinite(mbPerSecond) || mbPerSecond <= 0) return false;
    if (!Number.isFinite(time) || time <= 0) return false;

    const value = JSON.stringify({
      mbps: mbps,
      mbPerSecond: mbPerSecond,
      time: time
    });
    return !!$persistentStore.write(value, SPEED_KEY);
  } catch (_) {
    return false;
  }
}

/* ---------- Current Profile subscription usage ---------- */

async function getSubscriptionUsage(policy) {
  const profileResult = await httpAPI("GET", "/v1/profiles/current", { sensitive: 0 });
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
  if (headResponse.ok) {
    const headHeader = getHeader(headResponse.headers, "subscription-userinfo");
    if (headHeader) {
      const headUsage = parseSubscriptionUserInfo(headHeader);
      if (headUsage.available) return headUsage;
    }
  }

  const response = await http("get", url, policy, requestOptions);
  if (!response.ok) return unavailableUsage();
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
  const pattern = /(?:^|[;,\s])(upload|download|total|expire)\s*=\s*([0-9]+(?:\.[0-9]+)?)/ig;
  let match;
  while ((match = pattern.exec(String(header))) !== null) {
    fields[clean(match[1]).toLowerCase()] = clean(match[2]);
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
  const values = Array.isArray(list) ? list : [];
  const text = values.join(",").toLowerCase();
  if (!text) return "系统";
  if (text.indexOf("1.1.1.1") >= 0 || text.indexOf("1.0.0.1") >= 0 || text.indexOf("2606:4700:4700") >= 0) return "Cloudflare";
  if (text.indexOf("8.8.8.8") >= 0 || text.indexOf("8.8.4.4") >= 0 || text.indexOf("2001:4860:4860") >= 0) return "Google";
  if (text.indexOf("223.5.5.5") >= 0 || text.indexOf("223.6.6.6") >= 0 || text.indexOf("2400:3200") >= 0) return "AliDNS";
  if (text.indexOf("119.29.29.29") >= 0 || text.indexOf("2402:4e00") >= 0) return "DNSPod";
  if (text.indexOf("114.114.114.114") >= 0 || text.indexOf("114.114.115.115") >= 0 || text.indexOf("240c::6666") >= 0) return "114DNS";
  if (text.indexOf("9.9.9.9") >= 0 || text.indexOf("149.112.112.112") >= 0) return "Quad9";
  if (text.indexOf("94.140.14.14") >= 0 || text.indexOf("94.140.15.15") >= 0) return "AdGuard";
  if (text.indexOf("45.90.28.") >= 0 || text.indexOf("45.90.30.") >= 0) return "NextDNS";
  if (text.indexOf("127.0.0.1") >= 0 || text.indexOf("::1") >= 0) return "Surge";
  return shortenText(values.join("/"), 18) || "自定义";
}

function inferNAT(local, publicIP) {
  const localParts = parseIPv4(local);
  const publicParts = parseIPv4(publicIP);
  if (!localParts) return "未知";
  if (isCGNAT(local)) return "CGNAT";
  if (isPrivateIPv4(local) && publicParts) return "NAT";
  if (publicParts && normalizeIPv4(local) === normalizeIPv4(publicIP)) return "公网";
  return "未知";
}

function isPrivateIPv4(ip) {
  const parts = parseIPv4(ip);
  return !!parts && (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function isCGNAT(ip) {
  const parts = parseIPv4(ip);
  return !!parts && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function parseIPv4(ip) {
  const value = clean(ip).split("/")[0];
  const parts = value.split(".").map(Number);
  if (parts.length !== 4) return null;
  for (let i = 0; i < parts.length; i += 1) {
    if (!Number.isInteger(parts[i]) || parts[i] < 0 || parts[i] > 255) return null;
  }
  return parts;
}

function normalizeIPv4(ip) {
  const parts = parseIPv4(ip);
  return parts ? parts.join(".") : "";
}

function isIPAddress(value) {
  const text = clean(value).split("%")[0];
  return !!parseIPv4(text) || (/^[0-9a-f:]+$/i.test(text) && text.indexOf(":") >= 0);
}

/* ---------- UI ---------- */

function appendSpeedLines(lines, speed) {
  if (!speed) {
    lines.push("⚡ 下载 未测试");
    return;
  }

  lines.push(
    "⚡ 下载 " + formatFixed(speed.mbps, 1) + " Mbps" +
    " · " + formatFixed(speed.mbPerSecond, 2) + " MB/s"
  );
  lines.push(speedResultBar(speed.mbps));
  lines.push("上次测速 " + timeLabel(new Date(speed.time)));
}

function speedResultBar(mbps) {
  /*
   * speedPercent 是最终速度相对于 1 Gbps 显示上限的“速度等级百分比”，
   * 不是实时测速完成进度、网络利用率或套餐利用率。Information Panel 只会在
   * 脚本 $done 后显示最终结果；真实 Mbps 不会被 1 Gbps 显示上限截断。
   */
  const speedPercent = speedLevelPercent(mbps);
  const filled = clamp(Math.round(speedPercent / 10), 0, SPEED_BAR_SEGMENTS);

  let bar = "";
  for (let i = 0; i < SPEED_BAR_SEGMENTS; i += 1) {
    bar += i < filled ? "●" : "○";
  }
  return bar + " " + formatFixed(speedPercent, 1) + "% · " + speedGrade(mbps) + "级";
}

function speedLevelPercent(mbps) {
  const speed = Number(mbps);
  if (!Number.isFinite(speed) || speed < 0) return 0;
  return clamp(speed / SPEED_BAR_MAX_MBPS * 100, 0, 100);
}

function speedGrade(mbps) {
  const speed = Number(mbps);
  if (!Number.isFinite(speed) || speed < 0) return "";
  if (speed >= 500) return "A";
  if (speed >= 300) return "B";
  if (speed >= 100) return "C";
  return "D";
}

function appendUsageLines(lines, usage) {
  lines.push("📦 剩余流量");
  if (!usage || !usage.available) {
    lines.push("当前配置未提供流量信息");
    return;
  }

  const hasCompleteData = nonNegativeTrafficNumber(usage.used) !== null &&
    positiveTrafficNumber(usage.total) !== null &&
    nonNegativeTrafficNumber(usage.remaining) !== null &&
    nonNegativeTrafficNumber(usage.remainingPercent) !== null;

  if (hasCompleteData) {
    lines.push("已用 " + formatTrafficBytes(usage.used) + " / " + formatTrafficBytes(usage.total));
    lines.push(
      "剩余 " + formatTrafficBytes(usage.remaining) +
      " · " + formatFixed(usage.remainingPercent, 1) + "%"
    );
  } else if (nonNegativeTrafficNumber(usage.remaining) !== null) {
    lines.push("剩余 " + formatTrafficBytes(usage.remaining));
    lines.push(
      "总量 " + (positiveTrafficNumber(usage.total) !== null
        ? formatTrafficBytes(usage.total)
        : "未提供")
    );
  } else {
    lines.push("当前配置未提供流量信息");
    return;
  }

  if (usage.expireState === "permanent") {
    lines.push("到期 永久");
  } else if (usage.expireState === "date" && usage.expireValue) {
    lines.push("到期 " + dateLabel(usage.expireValue));
  } else {
    lines.push("到期 未提供");
  }
}

function formatExitLine(countryCode, exit) {
  const place = locationSuffix(countryCode, exit && (exit.city || exit.region));
  const ipText = displayIP(exit && exit.ip) || "出口 IP 未识别";
  return flag(countryCode) + " " + countryLabel(countryCode) + " · " + ipText + (place ? " · " + place : "");
}

function formatOrganizationLine(exit) {
  const org = shortenISP(exit && exit.org) || "ISP 未知";
  const asn = positiveASN(exit && exit.asn);
  return org + (asn ? " · AS" + asn : "");
}

function locationSuffix(countryCode, value) {
  const place = oneLine(value);
  if (!place) return "";
  const lower = place.toLowerCase();
  if (countryCode === "HK" && lower === "hong kong") return "";
  if (countryCode === "SG" && lower === "singapore") return "";
  if (countryCode === "MO" && (lower === "macao" || lower === "macau")) return "";
  return shortenText(place, 14);
}

function formatChecks(items) {
  return items.map(function (item) {
    return item.name + " " + mark(item.ok) + (item.suffix || "");
  }).join("   ");
}

function countOK(items) {
  return items.filter(function (item) { return !!item.ok; }).length;
}

function mark(ok) {
  return ok ? "✓" : "×";
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
  const value = clean(code).toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : "";
}

function flag(code) {
  const value = normalizeCountryCode(code);
  if (!value) return "🌐";
  return String.fromCodePoint(value.charCodeAt(0) + 127397) +
         String.fromCodePoint(value.charCodeAt(1) + 127397);
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
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) + "ms" : "失败";
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

function truthy(value) {
  if (value === true || value === 1) return true;
  const text = clean(value).toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "y";
}

function anyTruthy(values) {
  for (let i = 0; i < values.length; i += 1) {
    if (truthy(values[i])) return true;
  }
  return false;
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
  const text = clean(value).replace(/^AS/i, "");
  const number = Number(text);
  return Number.isFinite(number) && Number.isInteger(number) && number > 0 ? number : null;
}

function finiteInRange(value, min, max) {
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
