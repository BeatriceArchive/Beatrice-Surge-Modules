/* Betty-Bilibili-Daily v1.4.0 | Surge */
const NAME = "贝蒂的哔哩哔哩每日签到";
const VER = "1.4.0";

const CK = "betty.bilibili.cookie";
const META = "betty.bilibili.cookie.meta";
const BAD = "betty.bilibili.cookie.invalid_notice";
const LOCK = "betty.bilibili.daily.run_lock";
const STATE = "betty.bilibili.daily.panel_state";
const SESSION_SCHEMA = "official-qr-home-v2";

const MAX_COINS = 5;
const CANDIDATE_LIMIT = 12;
const WATCH_TRIES = 3;
const SHARE_TRIES = 2;
const COIN_TRIES = 8;
const REQUEST_TIMEOUT = 7;
const LOCK_TTL_MS = 120000;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let doneCalled = false;
let lockOwner = "";
let lockHeld = false;
let autoPanelOnly = false;
let panel = readPanelState() || P("每天 08:00 自动执行｜点击刷新立即运行", "calendar.badge.checkmark", "#8E8E93");

run().finally(() => {
  releaseLock();
  if (!autoPanelOnly) savePanelState(panel);
  finish(panel);
});

async function run() {
  try {
    if (isAutoPanelRefresh()) {
      autoPanelOnly = true;
      panel = readPanelState() || panel;
      return;
    }

    if (!(await acquireLock())) {
      panel = P("⚠️ 任务正在运行｜未启动重复实例", "clock.fill", "#FF9F0A");
      return;
    }

    await executeDailyTasks();
  } catch (error) {
    panel = P("❌ 执行失败｜脚本遇到未预期错误", "xmark.circle.fill", "#FF3B30");
    notify("执行失败", clean(error && error.message ? error.message : error, 160));
  }
}

async function executeDailyTasks() {
  const cookie = $persistentStore.read(CK);
  const meta = readCookieMeta();

  // 只接受 Cookie 工具当前 schema 明确验证过的新会话，避免旧缓存参与写操作。
  if (!cookie || !meta || meta.verified !== true || meta.schema !== SESSION_SCHEMA) {
    panel = P("❌ 无法执行｜请先重新获取并验证 Cookie", "xmark.circle.fill", "#FF3B30");
    notify("Cookie 未验证", "请先刷新 Cookie Panel，完成全新的 Bilibili 官方二维码登录。");
    return;
  }

  const cookieMap = parseCookie(cookie);
  const missing = ["SESSDATA", "bili_jct", "DedeUserID", "buvid3"].filter((name) => !cookieMap[name]);
  if (missing.length) {
    panel = P("❌ 无法执行｜Cookie 信息不完整", "xmark.circle.fill", "#FF3B30");
    markCookieBad("缺少 " + missing.join("、"));
    return;
  }

  const nav = await get("https://api.bilibili.com/x/web-interface/nav", cookie, "https://www.bilibili.com/", 1);
  if (!isLoggedIn(nav)) {
    panel = P("❌ 无法执行｜Cookie 已失效，请重新扫码", "xmark.circle.fill", "#FF3B30");
    markCookieBad(apiReason(nav, "账号未登录"));
    return;
  }

  const user = nav.data;
  const uid = String(user.mid || cookieMap.DedeUserID || "");
  if (meta.uid && String(meta.uid) !== uid) {
    panel = P("❌ 无法执行｜Cookie 账号校验不一致", "xmark.circle.fill", "#FF3B30");
    markCookieBad("Cookie UID 与验证标记不一致");
    return;
  }

  const csrf = cookieMap.bili_jct;
  const initialBalance = toInt(user.money);
  const status = await getDailyStatus(cookie);
  if (!status) {
    panel = P("❌ 执行失败｜状态查询失败", "xmark.circle.fill", "#FF3B30");
    notify("状态查询失败", "无法可靠读取今日等级任务状态，本次不执行写操作。");
    return;
  }

  const initialCoinExp = await getTodayCoinExp(cookie);
  const initialCoinCount = coinCount(initialCoinExp !== null ? initialCoinExp : status.coins);
  const needsWatch = !status.watch;
  const needsShare = !status.share;
  const mayCoin = initialCoinCount !== null && initialCoinCount < MAX_COINS && initialBalance !== null && initialBalance > 0;

  let candidates = [];
  if (needsWatch || needsShare || mayCoin) candidates = await getCandidates(cookie);

  if (needsWatch) {
    const stop = await completeWatch(candidates, uid, csrf, cookie);
    if (stop) {
      stopForFailure(stop);
      return;
    }
  }

  if (needsShare) {
    const stop = await completeShare(candidates, csrf, cookie);
    if (stop) {
      stopForFailure(stop);
      return;
    }
  }

  let knownCoinCount = initialCoinCount;
  let spent = 0;
  const latestCoinCount = coinCount(await getTodayCoinExp(cookie));
  if (latestCoinCount !== null) {
    knownCoinCount = latestCoinCount;
    const target = initialBalance === null ? 0 : Math.min(Math.max(0, MAX_COINS - latestCoinCount), initialBalance);
    if (target > 0) {
      const result = await completeCoins(candidates, target, latestCoinCount, csrf, cookie);
      knownCoinCount = result.count;
      spent = result.spent;
      if (result.stop) {
        stopForFailure(result.stop);
        return;
      }
    }
  }

  await sleep(1200);
  const finalStatus = (await getDailyStatus(cookie, 0)) || status;
  const finalCoinExp = await getTodayCoinExp(cookie, 0);
  let finalCoinCount = coinCount(finalCoinExp !== null ? finalCoinExp : finalStatus.coins);
  if (finalCoinCount === null) finalCoinCount = knownCoinCount;

  const finalNav = await get("https://api.bilibili.com/x/web-interface/nav", cookie, "https://www.bilibili.com/", 0);
  const finalUser = isLoggedIn(finalNav) ? finalNav.data : user;
  let finalBalance = toInt(finalUser.money);
  if (finalBalance === null && initialBalance !== null) finalBalance = Math.max(0, initialBalance - spent);

  const limitedByBalance = finalCoinCount !== null && finalCoinCount < MAX_COINS && finalBalance === 0;
  const coinDone = finalCoinCount !== null && (finalCoinCount >= MAX_COINS || limitedByBalance);
  const allDone = !!(finalStatus.login && finalStatus.watch && finalStatus.share && coinDone);
  const exp =
    (finalStatus.login ? 5 : 0) +
    (finalStatus.watch ? 5 : 0) +
    (finalStatus.share ? 5 : 0) +
    (Number.isFinite(Number(finalCoinExp)) ? Math.max(0, Math.min(50, Number(finalCoinExp))) : (finalCoinCount || 0) * 10);
  const coinText = finalCoinCount === null ? "未知/5" : finalCoinCount + "/5";

  if (allDone) {
    panel = limitedByBalance
      ? P("⚠️ 今日任务已完成｜投币 " + coinText + "（余额不足）", "exclamationmark.triangle.fill", "#FF9F0A")
      : P("✅ 今日任务已完成｜登录 / 观看 / 分享 / 投币 " + coinText, "checkmark.circle.fill", "#34C759");
  } else {
    panel = P("⚠️ 今日任务未完全完成｜投币 " + coinText, "exclamationmark.triangle.fill", "#FF9F0A");
  }

  notify(
    allDone ? "✅ 今日可执行任务已完成" : "⚠️ 今日任务未完全完成",
    "登录 " + icon(finalStatus.login) + "  观看 " + icon(finalStatus.watch) + "  分享 " + icon(finalStatus.share) +
      "\n投币 " + coinText + (limitedByBalance ? "（余额不足）" : "") +
      "\n今日经验 " + exp + "/65｜硬币余额 " + (finalBalance === null ? "未知" : finalBalance)
  );
}

async function getDailyStatus(cookie, retry = 1) {
  const body = await get("https://api.bilibili.com/x/member/web/exp/reward", cookie, "https://www.bilibili.com/", retry);
  if (!body || apiCode(body) !== 0 || !body.data) return null;
  const data = body.data;
  if (typeof data.login !== "boolean" || typeof data.watch !== "boolean" || typeof data.share !== "boolean") return null;
  const coins = toNumber(data.coins);
  return { login: data.login, watch: data.watch, share: data.share, coins: coins !== null && coins >= 0 ? coins : null };
}

async function getTodayCoinExp(cookie, retry = 1) {
  const body = await get("https://api.bilibili.com/x/web-interface/coin/today/exp", cookie, "https://www.bilibili.com/", retry);
  if (!body || apiCode(body) !== 0) return null;
  const value = toNumber(body.data);
  return value !== null && value >= 0 ? value : null;
}

async function getCandidates(cookie) {
  const primary = [];
  const fallback = [];
  const seen = {};

  try {
    const body = await get("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video", cookie, "https://www.bilibili.com/", 0);
    const items = body && apiCode(body) === 0 && body.data && Array.isArray(body.data.items) ? body.data.items : [];
    for (const item of items) {
      const archive = item && item.modules && item.modules.module_dynamic && item.modules.module_dynamic.major && item.modules.module_dynamic.major.archive;
      if (archive && addCandidate(primary, seen, archive.bvid) && primary.length >= CANDIDATE_LIMIT) break;
    }
  } catch (_) {}

  if (primary.length < 6) {
    try {
      const body = await get("https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all", cookie, "https://www.bilibili.com/", 0);
      const items = body && apiCode(body) === 0 && body.data && Array.isArray(body.data.list) ? body.data.list : [];
      for (const item of items) {
        if (addCandidate(fallback, seen, item && item.bvid) && primary.length + fallback.length >= CANDIDATE_LIMIT) break;
      }
    } catch (_) {}
  }

  shuffle(primary);
  shuffle(fallback);
  return primary.concat(fallback).slice(0, CANDIDATE_LIMIT);
}

function addCandidate(list, seen, bvid) {
  if (typeof bvid !== "string" || !/^BV[0-9A-Za-z]{8,20}$/.test(bvid) || seen[bvid]) return false;
  seen[bvid] = true;
  list.push({ bvid });
  return true;
}

async function getVideo(bvid, cookie) {
  const body = await get(
    "https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid),
    cookie,
    "https://www.bilibili.com/video/" + bvid,
    0
  );
  if (!body || apiCode(body) !== 0 || !body.data) return null;
  const aid = toNumber(body.data.aid);
  const page = Array.isArray(body.data.pages) && body.data.pages[0];
  const cid = toNumber(body.data.cid || (page && page.cid));
  const duration = toInt(body.data.duration);
  return aid > 0 && cid > 0 ? { aid, cid, bvid, duration } : null;
}

async function completeWatch(candidates, uid, csrf, cookie) {
  for (let index = 0; index < Math.min(candidates.length, WATCH_TRIES); index += 1) {
    const video = await getVideo(candidates[index].bvid, cookie);
    if (!video) continue;

    let response = await heartbeat(video, uid, csrf, cookie, 0, 0);
    let failure = classifyFailure(response, "观看-打开视频");
    if (failure) return failure;
    if (apiCode(response) !== 0) continue;

    await sleep(800);
    const played = Math.max(1, Math.min(8, video.duration || 8));
    response = await heartbeat(video, uid, csrf, cookie, played, played);
    failure = classifyFailure(response, "观看-heartbeat");
    if (failure) return failure;
    if (apiCode(response) === 0) return "";

    if (apiCode(response) === null) {
      await sleep(350);
      const status = await getDailyStatus(cookie, 0);
      if (status && status.watch) return "";
    }
  }
  return "";
}

function heartbeat(video, uid, csrf, cookie, played, realtime) {
  const body = form({
    aid: video.aid,
    bvid: video.bvid,
    cid: video.cid,
    mid: uid,
    played_time: played,
    realtime,
    real_played_time: realtime,
    start_ts: Math.floor(Date.now() / 1000) - realtime,
    type: 3,
    dt: 2,
    play_type: 3,
    csrf
  });
  const url = "https://api.bilibili.com/x/click-interface/web/heartbeat?aid=" + encodeURIComponent(video.aid) + "&played_time=" + encodeURIComponent(played);
  return post(url, body, cookie, "https://www.bilibili.com/video/" + video.bvid);
}

async function completeShare(candidates, csrf, cookie) {
  for (let index = 0; index < Math.min(candidates.length, SHARE_TRIES); index += 1) {
    const video = await getVideo(candidates[index].bvid, cookie);
    if (!video) continue;

    // 对齐 BiliBiliToolPro 当前 Web 分享请求，补齐其使用的风控上下文字段。
    const body = form({
      aid: video.aid,
      csrf,
      eab_x: 1,
      ramval: 3 + Math.floor(Math.random() * 17),
      source: "web_normal",
      ga: 1
    });

    const response = await post(
      "https://api.bilibili.com/x/web-interface/share/add",
      body,
      cookie,
      "https://www.bilibili.com/video/" + video.bvid
    );
    const failure = classifyFailure(response, "分享");
    if (failure) return failure;
    if (apiCode(response) === 0) return "";

    // 71000 为重复分享；只核对一次今日状态，不再向其他视频连续发送分享写请求。
    if (apiCode(response) === 71000) {
      await sleep(350);
      const status = await getDailyStatus(cookie, 0);
      return status && status.share ? "" : "";
    }

    if (apiCode(response) === null) {
      await sleep(350);
      const status = await getDailyStatus(cookie, 0);
      if (status && status.share) return "";
    }
  }
  return "";
}

async function completeCoins(candidates, target, startCount, csrf, cookie) {
  let spent = 0;
  let count = startCount;
  let tries = 0;

  for (const candidate of candidates) {
    if (spent >= target || count >= MAX_COINS || tries >= COIN_TRIES) break;
    tries += 1;

    const video = await getVideo(candidate.bvid, cookie);
    if (!video) continue;

    const existing = await get(
      "https://api.bilibili.com/x/web-interface/archive/coins?aid=" + encodeURIComponent(video.aid),
      cookie,
      "https://www.bilibili.com/video/" + video.bvid,
      0
    );
    const precheckFailure = classifyFailure(existing, "投币前检查");
    if (precheckFailure) return { spent, count, stop: precheckFailure };

    const already = existing && apiCode(existing) === 0 && existing.data ? toInt(existing.data.multiply) : null;
    if (already === null || already >= 2) continue;

    const live = coinCount(await getTodayCoinExp(cookie, 0));
    if (live === null || live < count) break;
    if (live > count) {
      spent += Math.min(target - spent, live - count);
      count = live;
    }
    if (spent >= target || count >= MAX_COINS) break;

    const response = await post(
      "https://api.bilibili.com/x/web-interface/coin/add",
      form({ aid: video.aid, multiply: 1, select_like: 0, csrf }),
      cookie,
      "https://www.bilibili.com/video/" + video.bvid + "/?spm_id_from=333.1007.tianma.1-1-1.click"
    );
    const failure = classifyFailure(response, "投币");
    if (failure) return { spent, count, stop: failure };

    if (apiCode(response) === 0) {
      spent += 1;
      count = Math.min(MAX_COINS, count + 1);
    } else if (apiCode(response) === null) {
      // 结果不确定时只核对一次，然后停止本轮继续投币，避免超投。
      await sleep(400);
      const verified = coinCount(await getTodayCoinExp(cookie, 0));
      if (verified !== null && verified > count) {
        spent += Math.min(target - spent, verified - count);
        count = verified;
      }
      break;
    } else if (apiCode(response) === -104) {
      break;
    }

    await sleep(350);
  }

  return { spent, count, stop: "" };
}

function get(url, cookie, referer, retry = 0) {
  return request("GET", url, "", cookie, referer, retry);
}

function post(url, body, cookie, referer) {
  return request("POST", url, body, cookie, referer, 0);
}

async function request(method, url, body, cookie, referer, retry) {
  let last = null;
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    last = await rawRequest(method, url, body, cookie, referer);
    if (last.body) return last.body;
    if (!last.retry || attempt === retry) break;
    await sleep(350 * (attempt + 1));
  }
  return null;
}

function rawRequest(method, url, body, cookie, referer) {
  return new Promise((resolve) => {
    const headers = {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh-Hans;q=0.9,en;q=0.8",
      Cookie: cookie,
      Referer: referer || "https://www.bilibili.com/"
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      headers.Origin = "https://www.bilibili.com";
    }

    const options = {
      url,
      headers,
      timeout: REQUEST_TIMEOUT,
      "auto-cookie": false,
      "auto-redirect": false
    };
    if (body) options.body = body;

    const callback = (error, response, data) => {
      if (error) {
        resolve({ body: null, retry: true });
        return;
      }

      const httpStatus = response && Number.isFinite(Number(response.status)) ? Number(response.status) : null;
      let parsed = parseJson(data);
      if (parsed && typeof parsed === "object" && httpStatus !== null) parsed.__httpStatus = httpStatus;

      if (httpStatus === null) {
        resolve({ body: parsed, retry: true });
        return;
      }

      if (httpStatus < 200 || httpStatus >= 300) {
        if (!parsed || typeof parsed !== "object") {
          parsed = { code: httpStatus, message: "HTTP " + httpStatus, __httpStatus: httpStatus };
        } else if (apiCode(parsed) === null) {
          parsed.code = httpStatus;
        }
        resolve({ body: parsed, retry: method === "GET" && httpStatus >= 500 });
        return;
      }

      resolve({ body: parsed, retry: false });
    };

    method === "POST" ? $httpClient.post(options, callback) : $httpClient.get(options, callback);
  });
}

function classifyFailure(body, stage) {
  const code = apiCode(body);
  const message = clean(body && (body.message || body.msg) || "B站拒绝了请求", 120);
  if (code === -101 || code === -111) return { type: "cookie", stage, code, message };
  if (code === -102 || code === -403 || code === 403) return { type: "account", stage, code, message };
  if (code === -352) return { type: "risk", stage, code, message };
  return "";
}

function stopForFailure(result) {
  const stage = clean(result.stage || "未知阶段", 40);
  const code = result.code == null ? "未知" : String(result.code);
  const detail = "阶段：" + stage + "\ncode：" + code + "\nmessage：" + clean(result.message || "B站拒绝了请求", 120);

  if (result.type === "cookie") {
    panel = P("❌ " + stage + "失败｜code " + code + "，请重新扫码", "xmark.circle.fill", "#FF3B30");
    markCookieBad(detail);
  } else if (result.type === "risk") {
    panel = P("❌ " + stage + "触发风控｜code " + code, "xmark.shield.fill", "#FF3B30");
    notify("B站风控拒绝", detail + "\n已停止后续写入任务。");
  } else {
    panel = P("❌ " + stage + "被拒绝｜code " + code, "xmark.circle.fill", "#FF3B30");
    notify("B站请求被拒绝", detail + "\n已停止后续写入任务。");
  }
}

function markCookieBad(reason) {
  const day = dateKey();
  if ($persistentStore.read(BAD) !== day) {
    $persistentStore.write(day, BAD);
    notify("❌ Cookie 已失效，请重新扫码", "原因：" + clean(reason, 140));
  }
}

function readCookieMeta() {
  const raw = $persistentStore.read(META);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
}

function parseCookie(cookie) {
  const out = {};
  String(cookie || "").split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1);
  });
  return out;
}

function form(object) {
  return Object.keys(object)
    .filter((key) => object[key] != null)
    .map((key) => encodeURIComponent(key) + "=" + encodeURIComponent(String(object[key])))
    .join("&");
}

function parseJson(data) {
  if (data == null || data === "") return null;
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (_) {
    return null;
  }
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toInt(value) {
  const number = toNumber(value);
  return number === null || number < 0 ? null : Math.floor(number);
}

function apiCode(body) {
  const code = toNumber(body && body.code);
  if (code !== null) return code;
  return toNumber(body && body.__httpStatus);
}

function isLoggedIn(body) {
  return !!(body && apiCode(body) === 0 && body.data && body.data.isLogin === true);
}

function apiReason(body, fallback) {
  if (!body) return fallback;
  const code = apiCode(body);
  const message = clean(body.message || body.msg || fallback, 120);
  return code === null ? message : code + " " + message;
}

function coinCount(exp) {
  const value = toNumber(exp);
  return value === null || value < 0 ? null : Math.max(0, Math.min(MAX_COINS, Math.floor(value / 10)));
}

function icon(value) {
  return value ? "✅" : "❌";
}

function clean(value, maxLength) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

function notify(subtitle, content) {
  $notification.post(NAME, subtitle, content);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle(array) {
  for (let index = array.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    const tmp = array[index];
    array[index] = array[target];
    array[target] = tmp;
  }
}

async function acquireLock() {
  const now = Date.now();
  const existing = readLock();
  if (existing && existing.expiresAt > now) return false;

  const id = now.toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  if (!$persistentStore.write(JSON.stringify({ owner: id, expiresAt: now + LOCK_TTL_MS }), LOCK)) {
    throw new Error("Daily 本地运行锁创建失败");
  }

  for (let round = 0; round < 2; round += 1) {
    await sleep(120);
    const current = readLock();
    if (!current || current.owner !== id || current.expiresAt <= Date.now()) return false;
  }

  lockOwner = id;
  lockHeld = true;
  return true;
}

function readLock() {
  const raw = $persistentStore.read(LOCK);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || !value.owner || !Number.isFinite(Number(value.expiresAt))) return null;
    return { owner: String(value.owner), expiresAt: Number(value.expiresAt) };
  } catch (_) {
    return null;
  }
}

function releaseLock() {
  if (!lockHeld) return;
  const current = readLock();
  if (current && current.owner === lockOwner) $persistentStore.write("", LOCK);
  lockHeld = false;
  lockOwner = "";
}

function readPanelState() {
  const raw = $persistentStore.read(STATE);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value.title === "string" && typeof value.content === "string" ? value : null;
  } catch (_) {
    return null;
  }
}

function savePanelState(value) {
  try {
    $persistentStore.write(JSON.stringify(value), STATE);
  } catch (_) {}
}

function dateKey() {
  const date = new Date();
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function isPanelCall() {
  return typeof $input === "object" && $input && $input.purpose === "panel";
}

function isAutoPanelRefresh() {
  return isPanelCall() && $trigger === "auto-interval";
}

function P(content, iconName, color) {
  return { title: NAME, content, icon: iconName, "icon-color": color };
}

function finish(value) {
  if (doneCalled) return;
  doneCalled = true;
  isPanelCall() ? $done(value) : $done();
}
