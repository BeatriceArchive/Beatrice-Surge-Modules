/*
 * Betty-Bilibili-Cookie
 * 贝蒂的哔哩哔哩 Cookie 获取
 * Version: 1.2.0
 * Runtime: Surge Generic Script
 *
 * 仅在用户手动运行时，通过 Bilibili 官方登录接口创建一次登录事务。
 * 登录确认、状态轮询、Cookie 验证与本地保存均不依赖 MITM 或 HTTPS 解密。
 */

const NAME = "贝蒂的哔哩哔哩 Cookie 获取";
const COOKIE_KEY = "betty.bilibili.cookie";
const INVALID_NOTICE_KEY = "betty.bilibili.cookie.invalid_notice";

const QR_GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const QR_POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const DEVICE_ID_URL = "https://api.bilibili.com/x/frontend/finger/spi";
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";

const REQUEST_TIMEOUT = 6;
const READ_RETRIES = 2;
const RETRY_DELAY_MS = 1200;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_DURATION_MS = 110000;
const MAX_POLL_REQUESTS = 38;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const REQUIRED_ACCOUNT_COOKIES = ["SESSDATA", "bili_jct", "DedeUserID"];
const COOKIE_ORDER = [
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "DedeUserID__ckMd5",
  "sid",
  "buvid3",
  "buvid4"
];
const ALLOWED_COOKIE_NAMES = Object.create(null);

COOKIE_ORDER.forEach(function (name) {
  ALLOWED_COOKIE_NAMES[name] = true;
});

let doneCalled = false;

run();

async function run() {
  try {
    console.log("[Betty-Bilibili-Cookie] Official login started");

    const transaction = await createLoginTransaction();
    notifyLoginConfirmation(transaction.loginUrl);

    const accountCookies = await waitForLogin(transaction.qrcodeKey);
    const deviceCookies = await getDeviceCookies();
    const cookieMap = mergeCookieMaps(accountCookies, deviceCookies);
    const missing = REQUIRED_ACCOUNT_COOKIES.concat(["buvid3"]).filter(function (name) {
      return !cookieMap[name];
    });

    if (missing.length > 0) {
      throw failure(
        "Cookie 不完整",
        "Bilibili 官方响应缺少必要字段，请重新手动执行脚本。",
        "cookie_incomplete"
      );
    }

    const cookieHeader = serializeCookie(cookieMap);
    const valid = await validateCookie(cookieHeader, cookieMap.DedeUserID);
    if (!valid) {
      throw failure(
        "Cookie 验证失败",
        "新 Cookie 未能通过 Bilibili 登录验证，原有 Cookie 已保留。",
        "cookie_validation_failed"
      );
    }

    const hadExistingCookie = !!$persistentStore.read(COOKIE_KEY);
    const saved = $persistentStore.write(cookieHeader, COOKIE_KEY);
    if (!saved) {
      throw failure(
        "保存失败",
        "Surge 本地持久化存储写入失败，原有 Cookie 未被主动删除。",
        "cookie_store_failed"
      );
    }

    let noticeReset = $persistentStore.write("", INVALID_NOTICE_KEY);
    if (!noticeReset) {
      noticeReset = $persistentStore.write(null, INVALID_NOTICE_KEY);
    }

    const resultText = hadExistingCookie
      ? "本次手动登录已更新本地 Cookie。"
      : "Cookie 已保存到 Surge 本地，可供每日签到模块使用。";
    const resetText = noticeReset ? "" : " Cookie 已保存，但失效提醒状态重置失败。";

    $notification.post(NAME, "✅ Cookie 已保存", resultText + resetText);
    console.log("[Betty-Bilibili-Cookie] Official login completed");
  } catch (error) {
    const safeError = normalizeFailure(error);
    console.log("[Betty-Bilibili-Cookie] Failed: " + safeError.logCode);
    $notification.post(NAME, "❌ " + safeError.title, safeError.body);
  } finally {
    doneOnce();
  }
}

async function createLoginTransaction() {
  const result = await readJsonWithRetry({
    url: QR_GENERATE_URL,
    headers: commonHeaders(),
    timeout: REQUEST_TIMEOUT,
    "auto-cookie": false,
    "auto-redirect": false
  }, "二维码申请");

  const body = result.body;
  if (responseCode(body) !== 0 || !body.data) {
    throw failure("登录请求失败", "Bilibili 未能创建登录事务，请稍后重试。", "qr_generate_api_error");
  }

  const qrcodeKey = String(body.data.qrcode_key || "");
  const loginUrl = String(body.data.url || "");
  if (!/^[a-f0-9]{32}$/i.test(qrcodeKey)) {
    throw failure("登录请求失败", "Bilibili 返回的登录事务格式无效。", "qr_key_invalid");
  }
  if (!isAllowedLoginUrl(loginUrl, qrcodeKey)) {
    throw failure("登录请求失败", "Bilibili 返回的登录确认地址不符合安全要求。", "qr_url_rejected");
  }

  return {
    qrcodeKey: qrcodeKey,
    loginUrl: loginUrl
  };
}

function notifyLoginConfirmation(loginUrl) {
  $notification.post(
    NAME,
    "请确认 Bilibili 登录",
    "轻触此通知打开 Bilibili 官方确认页面，并在 110 秒内完成登录确认。",
    {
      action: "open-url",
      url: loginUrl,
      sound: true
    }
  );
}

async function waitForLogin(qrcodeKey) {
  const startedAt = Date.now();
  let consecutiveErrors = 0;

  for (let index = 0; index < MAX_POLL_REQUESTS; index += 1) {
    if (index > 0) {
      await delay(POLL_INTERVAL_MS);
    }
    if (Date.now() - startedAt >= MAX_POLL_DURATION_MS) {
      break;
    }

    const result = await requestJson({
      url: QR_POLL_URL + "?qrcode_key=" + encodeURIComponent(qrcodeKey),
      headers: commonHeaders(),
      timeout: REQUEST_TIMEOUT,
      "auto-cookie": false,
      "auto-redirect": false,
      "full-header-mode": true
    });

    if (!result.ok) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw failure(
          "网络连接失败",
          "连续多次无法查询 Bilibili 登录状态，请检查网络后重新执行。",
          "qr_poll_network_error"
        );
      }
      continue;
    }

    consecutiveErrors = 0;
    const body = result.body;
    if (responseCode(body) !== 0 || !body.data) {
      throw failure("登录状态异常", "Bilibili 返回了无法识别的登录状态。", "qr_poll_api_error");
    }

    const status = Number(body.data.code);
    if (status === 86101 || status === 86090) {
      continue;
    }
    if (status === 86038) {
      throw failure("二维码已过期", "请重新手动执行 Cookie 获取脚本。", "qr_expired");
    }
    if (status !== 0) {
      throw failure(
        "登录状态异常",
        "Bilibili 返回了未支持的状态码：" + safeStatusCode(status) + "。",
        "qr_status_unsupported"
      );
    }

    const cookies = extractResponseCookies(result.headers, body.data.url);
    const missing = REQUIRED_ACCOUNT_COOKIES.filter(function (name) {
      return !cookies[name];
    });
    if (missing.length > 0) {
      throw failure(
        "Cookie 不完整",
        "登录成功，但 Bilibili 响应未包含完整账号 Cookie，请重新执行。",
        "login_cookie_missing"
      );
    }
    return cookies;
  }

  throw failure(
    "登录等待超时",
    "在等待时间内未完成确认，请重新手动执行脚本。",
    "qr_wait_timeout"
  );
}

async function getDeviceCookies() {
  const result = await readJsonWithRetry({
    url: DEVICE_ID_URL,
    headers: commonHeaders(),
    timeout: REQUEST_TIMEOUT,
    "auto-cookie": false,
    "auto-redirect": false
  }, "设备标识获取");

  const body = result.body;
  const buvid3 = body && body.data ? safeCookieValue(body.data.b_3) : "";
  const buvid4 = body && body.data ? safeCookieValue(body.data.b_4) : "";
  if (responseCode(body) !== 0 || !buvid3) {
    throw failure(
      "设备标识获取失败",
      "Bilibili 未返回 Daily 所需的设备标识，原有 Cookie 已保留。",
      "device_id_missing"
    );
  }

  const resultCookies = Object.create(null);
  resultCookies.buvid3 = buvid3;
  if (buvid4) resultCookies.buvid4 = buvid4;
  return resultCookies;
}

async function validateCookie(cookieHeader, expectedUserId) {
  const result = await readJsonWithRetry({
    url: NAV_URL,
    headers: Object.assign(commonHeaders(), {
      "Cookie": cookieHeader,
      "Referer": "https://www.bilibili.com/"
    }),
    timeout: REQUEST_TIMEOUT,
    "auto-cookie": false,
    "auto-redirect": false
  }, "Cookie 验证");

  const body = result.body;
  if (responseCode(body) !== 0 || !body.data || body.data.isLogin !== true) {
    return false;
  }

  const actualUserId = String(body.data.mid || "");
  return !!actualUserId && actualUserId === String(expectedUserId || "");
}

async function readJsonWithRetry(options, stage) {
  let lastResult = null;
  for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
    lastResult = await requestJson(options);
    if (lastResult.ok) return lastResult;

    const retryable = lastResult.kind === "network"
      || lastResult.kind === "json"
      || (lastResult.kind === "http" && lastResult.status >= 500);
    if (!retryable || attempt + 1 >= READ_RETRIES) break;
    await delay(RETRY_DELAY_MS);
  }

  const statusText = lastResult && lastResult.kind === "http"
    ? "（HTTP " + safeStatusCode(lastResult.status) + "）"
    : "";
  throw failure(
    stage + "失败",
    "无法完成 Bilibili 官方接口请求" + statusText + "，请稍后重试。",
    "read_request_failed"
  );
}

function requestJson(options) {
  return new Promise(function (resolve) {
    $httpClient.get(options, function (error, response, data) {
      if (error) {
        resolve({ ok: false, kind: "network", status: null, headers: null, body: null });
        return;
      }

      const status = response ? Number(response.status) : NaN;
      if (!Number.isFinite(status) || status < 200 || status >= 300) {
        resolve({
          ok: false,
          kind: "http",
          status: Number.isFinite(status) ? status : null,
          headers: response ? response.headers : null,
          body: null
        });
        return;
      }

      try {
        const body = typeof data === "string" ? JSON.parse(data) : data;
        if (!body || typeof body !== "object") throw new Error("invalid_json");
        resolve({
          ok: true,
          kind: "ok",
          status: status,
          headers: response ? response.headers : null,
          body: body
        });
      } catch (_) {
        resolve({
          ok: false,
          kind: "json",
          status: status,
          headers: response ? response.headers : null,
          body: null
        });
      }
    });
  });
}

function extractResponseCookies(headers, fallbackUrl) {
  const result = Object.create(null);
  const setCookieValues = collectSetCookieValues(headers);

  setCookieValues.forEach(function (headerValue) {
    const pair = String(headerValue || "").split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) return;
    const name = pair.slice(0, separator).trim();
    const value = safeCookieValue(pair.slice(separator + 1));
    if (ALLOWED_COOKIE_NAMES[name] && value) {
      assignCookieValue(result, name, value);
    }
  });

  const fallback = extractCookiesFromUrl(fallbackUrl);
  COOKIE_ORDER.forEach(function (name) {
    if (!fallback[name]) return;
    assignCookieValue(result, name, fallback[name]);
  });
  return result;
}

function collectSetCookieValues(headers) {
  const values = [];
  if (Array.isArray(headers)) {
    headers.forEach(function (item) {
      if (!item || String(item.field || item.name || "").toLowerCase() !== "set-cookie") return;
      values.push(String(item.value || ""));
    });
    return values;
  }

  if (!headers || typeof headers !== "object") return values;
  Object.keys(headers).forEach(function (key) {
    if (String(key).toLowerCase() !== "set-cookie") return;
    const value = headers[key];
    if (Array.isArray(value)) {
      value.forEach(function (item) { values.push(String(item || "")); });
    } else {
      values.push(String(value || ""));
    }
  });
  return values;
}

function extractCookiesFromUrl(url) {
  const result = Object.create(null);
  const text = String(url || "");
  const queryIndex = text.indexOf("?");
  if (queryIndex < 0) return result;

  text.slice(queryIndex + 1).split("&").forEach(function (part) {
    const separator = part.indexOf("=");
    if (separator <= 0) return;
    const name = safeDecode(part.slice(0, separator));
    if (!ALLOWED_COOKIE_NAMES[name]) return;
    const value = safeCookieValue(safeDecode(part.slice(separator + 1)));
    if (value) assignCookieValue(result, name, value);
  });
  return result;
}

function assignCookieValue(target, name, value) {
  if (target[name] && target[name] !== value) {
    throw failure(
      "Cookie 响应异常",
      "Bilibili 返回了相互冲突的 Cookie 字段，原有 Cookie 已保留。",
      "cookie_value_conflict"
    );
  }
  target[name] = value;
}

function mergeCookieMaps(primary, secondary) {
  const result = Object.create(null);
  COOKIE_ORDER.forEach(function (name) {
    const value = safeCookieValue((primary && primary[name]) || (secondary && secondary[name]) || "");
    if (value) result[name] = value;
  });
  return result;
}

function serializeCookie(cookieMap) {
  return COOKIE_ORDER.filter(function (name) {
    return !!cookieMap[name];
  }).map(function (name) {
    return name + "=" + cookieMap[name];
  }).join("; ");
}

function commonHeaders() {
  return {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Cache-Control": "no-cache"
  };
}

function isAllowedLoginUrl(url, qrcodeKey) {
  const text = String(url || "");
  if (!/^https:\/\/(?:account|passport)\.bilibili\.com\//i.test(text)) return false;
  if (/[\r\n\s]/.test(text)) return false;
  return text.indexOf("qrcode_key=" + qrcodeKey) >= 0
    || text.indexOf("qrcode_key=" + encodeURIComponent(qrcodeKey)) >= 0;
}

function safeCookieValue(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 2048 || /[;\r\n]/.test(text)) return "";
  return text;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (_) {
    return "";
  }
}

function safeStatusCode(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : "未知";
}

function responseCode(body) {
  if (!body) return null;
  const code = Number(body.code);
  return Number.isFinite(code) ? code : null;
}

function delay(milliseconds) {
  return new Promise(function (resolve) {
    setTimeout(resolve, milliseconds);
  });
}

function failure(title, body, logCode) {
  const error = new Error(String(logCode || "unknown_failure"));
  error.userTitle = String(title || "操作失败");
  error.userBody = String(body || "请稍后重试。");
  error.logCode = String(logCode || "unknown_failure");
  return error;
}

function normalizeFailure(error) {
  if (error && error.userTitle && error.userBody && error.logCode) {
    return {
      title: String(error.userTitle).slice(0, 40),
      body: String(error.userBody).replace(/[\r\n\t]+/g, " ").slice(0, 180),
      logCode: String(error.logCode).replace(/[^a-z0-9_-]/gi, "_").slice(0, 60)
    };
  }
  return {
    title: "执行失败",
    body: "脚本遇到未预期错误，请稍后重新手动执行。",
    logCode: "unexpected_error"
  };
}

function doneOnce() {
  if (doneCalled) return;
  doneCalled = true;
  $done();
}
