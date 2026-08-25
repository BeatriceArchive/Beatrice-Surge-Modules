/*
 * Betty-Bilibili-Cookie
 * 贝蒂的哔哩哔哩 Cookie 获取
 * Version: 1.0.0
 * Runtime: Surge HTTP Request Script
 *
 * 临时使用：捕获一次有效 B 站 Cookie 并写入 Surge 本地持久化存储。
 * 抓取成功后应删除/停用 Cookie 获取模块，日常签到模块不需要 MITM。
 */

const NAME = "贝蒂的哔哩哔哩 Cookie 获取";
const VERSION = "1.0.0";
const COOKIE_KEY = "betty.bilibili.cookie";
const COOKIE_META_KEY = "betty.bilibili.cookie.meta";
const INVALID_NOTICE_KEY = "betty.bilibili.cookie.invalid_notice";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

capture()
  .catch((error) => {
    console.log(`[Betty-Bilibili-Cookie] ${error && error.stack ? error.stack : error}`);
  })
  .finally(() => $done({}));

async function capture() {
  const headers = ($request && $request.headers) || {};
  const incoming = headers.Cookie || headers.cookie || "";
  if (!incoming) return;

  const parsed = parseCookie(incoming);
  if (!parsed.SESSDATA || !parsed.bili_jct || !parsed.DedeUserID) {
    console.log("[Betty-Bilibili-Cookie] Ignore incomplete cookie");
    return;
  }

  const current = $persistentStore.read(COOKIE_KEY) || "";
  const currentParsed = parseCookie(current);
  const sameCredential = currentParsed.SESSDATA === parsed.SESSDATA && currentParsed.bili_jct === parsed.bili_jct;
  if (sameCredential) {
    console.log("[Betty-Bilibili-Cookie] Cookie unchanged; ignore");
    return;
  }

  const nav = await validateCookie(incoming);
  if (!nav || nav.code !== 0 || !nav.data || nav.data.isLogin !== true) {
    $notification.post(NAME, "❌ 未保存", "捕获到了 Cookie，但登录校验失败。请确认 B 站 App 已登录后重试。");
    return;
  }

  const saved = $persistentStore.write(incoming, COOKIE_KEY);
  if (!saved) {
    $notification.post(NAME, "❌ 保存失败", "Surge 本地持久化存储写入失败。");
    return;
  }

  const meta = {
    version: VERSION,
    uid: String(nav.data.mid || parsed.DedeUserID || ""),
    uname: nav.data.uname || "",
    updatedAt: new Date().toISOString()
  };
  $persistentStore.write(JSON.stringify(meta), COOKIE_META_KEY);
  $persistentStore.write("", INVALID_NOTICE_KEY);

  const action = current ? "Cookie 已手动更新" : "首次 Cookie 已保存";
  $notification.post(NAME, `✅ ${action}`, `${nav.data.uname ? `账号：${nav.data.uname}\n` : ""}现在可以删除/停用 Cookie 获取模块；每日签到模块会继续使用本地 Cookie。`);
}

function validateCookie(cookie) {
  return new Promise((resolve) => {
    $httpClient.get({
      url: "https://api.bilibili.com/x/web-interface/nav",
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Cookie": cookie,
        "Referer": "https://www.bilibili.com/"
      }
    }, (error, response, data) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (_) {
        resolve(null);
      }
    });
  });
}

function parseCookie(cookie) {
  const result = {};
  String(cookie || "").split(";").forEach((part) => {
    const item = part.trim();
    if (!item) return;
    const idx = item.indexOf("=");
    if (idx <= 0) return;
    result[item.slice(0, idx)] = item.slice(idx + 1);
  });
  return result;
}
