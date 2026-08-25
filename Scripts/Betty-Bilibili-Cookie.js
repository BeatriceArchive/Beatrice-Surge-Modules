/*
 * Betty-Bilibili-Cookie
 * 贝蒂的哔哩哔哩 Cookie 获取
 * Version: 1.1.0
 * Runtime: Surge HTTP Request Script
 *
 * 临时使用：捕获一次有效 B 站 Cookie 并写入 Surge 本地持久化存储。
 * 抓取成功后应删除/停用 Cookie 获取模块，日常签到模块不需要 MITM。
 */

const NAME = "贝蒂的哔哩哔哩 Cookie 获取";
const VERSION = "1.1.0";
const COOKIE_KEY = "betty.bilibili.cookie";
const INVALID_NOTICE_KEY = "betty.bilibili.cookie.invalid_notice";
const CAPTURE_GATE_KEY = "betty.bilibili.cookie.capture_gate";
const CAPTURE_GATE_TTL_MS = 60000;
const REQUEST_TIMEOUT = 6;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let doneCalled = false;

run();

async function run() {
  try {
    await capture();
  } catch (error) {
    console.log("[Betty-Bilibili-Cookie] " + errorMessage(error));
  } finally {
    doneOnce();
  }
}

async function capture() {
  if (typeof $request !== "object" || !$request) return;

  const requestUrl = String($request.url || "");
  if (!/^https:\/\/app\.bilibili\.com\/x\/resource\/fingerprint(?:\?|$)/.test(requestUrl)) {
    return;
  }

  const headers = $request.headers || {};
  const incoming = String(headers.Cookie || headers.cookie || "");
  if (!incoming) return;

  const parsed = parseCookie(incoming);
  const requiredFields = ["SESSDATA", "bili_jct", "DedeUserID", "buvid3"];
  const complete = requiredFields.every(function (field) {
    return !!parsed[field];
  });
  if (!complete) return;

  const signature = credentialSignature(parsed);
  const current = $persistentStore.read(COOKIE_KEY) || "";
  if (current && credentialSignature(parseCookie(current)) === signature) {
    return;
  }

  const fingerprint = hashString(signature);
  const gate = readCaptureGate();
  const now = Date.now();
  if (gate
    && gate.fingerprint === fingerprint
    && now - gate.timestamp >= 0
    && now - gate.timestamp < CAPTURE_GATE_TTL_MS) {
    return;
  }

  $persistentStore.write(JSON.stringify({
    fingerprint: fingerprint,
    timestamp: now
  }), CAPTURE_GATE_KEY);

  const nav = await validateCookie(incoming);
  if (!nav || responseCode(nav) !== 0 || !nav.data || nav.data.isLogin !== true) {
    console.log("[Betty-Bilibili-Cookie] Captured credential failed login validation");
    return;
  }

  const saved = $persistentStore.write(incoming, COOKIE_KEY);
  if (!saved) {
    $notification.post(NAME, "❌ 保存失败", "Surge 本地持久化存储写入失败。");
    return;
  }

  $persistentStore.write("", INVALID_NOTICE_KEY);
  const action = current ? "Cookie 已更新" : "首次 Cookie 已保存";
  $notification.post(
    NAME,
    "✅ " + action,
    "现在可以删除/停用 Cookie 获取模块；每日签到模块会继续使用 Surge 本地 Cookie。"
  );
}

function validateCookie(cookie) {
  return new Promise(function (resolve) {
    $httpClient.get({
      url: "https://api.bilibili.com/x/web-interface/nav",
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Cookie": cookie,
        "Referer": "https://www.bilibili.com/"
      },
      timeout: REQUEST_TIMEOUT,
      "auto-cookie": false,
      "auto-redirect": false
    }, function (error, response, data) {
      if (error) {
        resolve(null);
        return;
      }

      const status = response ? Number(response.status) : NaN;
      if (!Number.isFinite(status) || status < 200 || status >= 300) {
        resolve(null);
        return;
      }

      try {
        resolve(typeof data === "string" ? JSON.parse(data) : data);
      } catch (_) {
        resolve(null);
      }
    });
  });
}

function parseCookie(cookie) {
  const result = Object.create(null);
  String(cookie || "").split(";").forEach(function (part) {
    const item = part.trim();
    if (!item) return;
    const index = item.indexOf("=");
    if (index <= 0) return;
    result[item.slice(0, index)] = item.slice(index + 1);
  });
  return result;
}

function credentialSignature(cookieObj) {
  const fields = [
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "buvid3",
    "buvid4"
  ];
  return fields.map(function (field) {
    return field + "=" + String(cookieObj[field] || "");
  }).join("&");
}

function hashString(value) {
  let first = 2166136261;
  let second = 2654435769;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 2246822519);
  }
  return (first >>> 0).toString(16) + "-" + (second >>> 0).toString(16);
}

function readCaptureGate() {
  const raw = $persistentStore.read(CAPTURE_GATE_KEY);
  if (!raw) return null;
  try {
    const gate = JSON.parse(raw);
    if (!gate || typeof gate.fingerprint !== "string") return null;
    const timestamp = Number(gate.timestamp);
    if (!Number.isFinite(timestamp)) return null;
    return {
      fingerprint: gate.fingerprint,
      timestamp: timestamp
    };
  } catch (_) {
    return null;
  }
}

function responseCode(body) {
  if (!body) return null;
  const code = Number(body.code);
  return Number.isFinite(code) ? code : null;
}

function errorMessage(error) {
  if (!error) return "未知错误";
  return String(error.message || error)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 180);
}

function doneOnce() {
  if (doneCalled) return;
  doneCalled = true;
  $done({});
}
