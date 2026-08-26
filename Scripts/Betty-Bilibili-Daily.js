const NAME = "贝蒂的哔哩哔哩每日签到";
const VERSION = "1.5.0";

const COOKIE_KEY = "betty.bilibili.cookie";
const COOKIE_META_KEY = "betty.bilibili.cookie.meta";
const COOKIE_BAD_KEY = "betty.bilibili.cookie.invalid_notice";
const RUN_LOCK_KEY = "betty.bilibili.daily.run_lock";
const PANEL_STATE_KEY = "betty.bilibili.daily.panel_state";
const SESSION_SCHEMA = "official-qr-home-v3";

const MAX_DAILY_COINS = 5;
const REQUEST_TIMEOUT = 7;
const RUN_LOCK_TTL_MS = 270000;
const COIN_WRITE_MAX_ATTEMPTS = 10;
const SHARE_DELAY_MIN_MS = 8000;
const SHARE_DELAY_MAX_MS = 18000;
const COIN_GAP_MIN_MS = 7000;
const COIN_GAP_MAX_MS = 10000;
const COIN_RATE_LIMIT_MIN_MS = 11000;
const COIN_RATE_LIMIT_MAX_MS = 15000;

const WEB_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const BIG_VIP_REFERER = "https://big.bilibili.com/mobile/bigPoint/task";

const API = {
  nav: "https://api.bilibili.com/x/web-interface/nav",
  daily: "https://api.bilibili.com/x/member/web/exp/reward",
  coinExp: "https://api.bilibili.com/x/web-interface/coin/today/exp",
  dynamic: "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video",
  ranking: "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all",
  view: "https://api.bilibili.com/x/web-interface/view",
  heartbeat: "https://api.bilibili.com/x/click-interface/web/heartbeat",
  share: "https://api.bilibili.com/x/web-interface/share/add",
  archiveCoins: "https://api.bilibili.com/x/web-interface/archive/coins",
  coinAdd: "https://api.bilibili.com/x/web-interface/coin/add",
  vipExperience: "https://api.bilibili.com/x/vip/experience/add"
};

let doneCalled = false;
let lockOwner = "";
let lockHeld = false;
let autoPanelRefresh = false;
let panel = readPanelState() || makePanel("每天 08:00 自动执行｜点击刷新立即运行", "calendar.badge.checkmark", "#8E8E93");

run().finally(() => {
  releaseRunLock();
  if (!autoPanelRefresh) writePanelState(panel);
  finish(panel);
});

async function run() {
  try {
    if (isAutoPanelRefresh()) {
      autoPanelRefresh = true;
      panel = readPanelState() || panel;
      return;
    }

    if (!(await acquireRunLock())) {
      panel = makePanel("⚠️ 任务正在运行｜未启动重复实例", "clock.fill", "#FF9F0A");
      return;
    }

    await runDailyTasks();
  } catch (error) {
    panel = makePanel("❌ 执行失败｜脚本异常", "xmark.circle.fill", "#FF3B30");
    notify("执行失败", safeText(error && error.message ? error.message : error, 180));
  }
}

async function runDailyTasks() {
  const cookie = $persistentStore.read(COOKIE_KEY);
  const meta = readCookieMeta();

  if (!isAcceptedSession(cookie, meta)) {
    panel = makePanel("❌ 无法执行｜请重新获取有效 Cookie", "xmark.circle.fill", "#FF3B30");
    notify("Cookie 会话需要更新", "请刷新 Cookie Panel 重新扫码。");
    return;
  }

  const cookieMap = parseCookie(cookie);
  const missing = ["SESSDATA", "bili_jct", "DedeUserID", "buvid3"].filter(k => !cookieMap[k]);
  if (missing.length) {
    markCookieBad("缺少 " + missing.join("、"));
    return;
  }

  const nav = await getJson(API.nav, cookie, "https://www.bilibili.com/", 1);
  if (!isLoggedIn(nav)) {
    markCookieBad(apiReason(nav, "账号未登录"));
    return;
  }

  const user = nav.data;
  const uid = String(user.mid || cookieMap.DedeUserID || "");
  if (meta.uid && String(meta.uid) !== uid) {
    markCookieBad("Cookie UID 与验证标记不一致");
    return;
  }

  const csrf = cookieMap.bili_jct;
  const initialBalance = integerOrNull(user.money);
  const initialStatus = await getDailyStatus(cookie);
  if (!initialStatus) {
    panel = makePanel("❌ 执行失败｜状态查询失败", "xmark.circle.fill", "#FF3B30");
    notify("状态查询失败", "未执行写操作。");
    return;
  }

  let initialCoinCount = coinCountFromExp(await getCoinExp(cookie));
  if (initialCoinCount === null) initialCoinCount = coinCountFromExp(initialStatus.coins);

  const needsVideo = !initialStatus.watch || !initialStatus.share || (initialCoinCount !== null && initialCoinCount < MAX_DAILY_COINS && initialBalance !== null && initialBalance > 0) || isVipUser(user);
  const candidates = needsVideo ? await getVideoCandidates(cookie) : [];
  const errors = [];

  let watchVideo = null;
  if (!initialStatus.watch) {
    const watchResult = await completeWatch(candidates, uid, csrf, cookie);
    if (watchResult.error && watchResult.error.fatal) {
      stopForFatal(watchResult.error);
      return;
    }
    if (watchResult.error) errors.push(watchResult.error);
    watchVideo = watchResult.video || null;
  }

  if (!initialStatus.share) {
    const shareResult = await completeShare(candidates, watchVideo, uid, csrf, cookie);
    if (shareResult && shareResult.fatal) {
      stopForFatal(shareResult);
      return;
    }
    if (shareResult) errors.push(shareResult);
  }

  const vipResult = await claimVipDailyExperience(candidates, uid, csrf, cookie, user);
  if (vipResult.error && vipResult.error.fatal) {
    stopForFatal(vipResult.error);
    return;
  }
  if (vipResult.error) errors.push(vipResult.error);

  let finalLocalCoinCount = initialCoinCount;
  let localSpent = 0;
  const refreshedCoinCount = coinCountFromExp(await getCoinExp(cookie, 0));
  if (refreshedCoinCount !== null) finalLocalCoinCount = refreshedCoinCount;

  if (finalLocalCoinCount !== null && finalLocalCoinCount < MAX_DAILY_COINS && initialBalance !== null && initialBalance > 0) {
    const targetCount = Math.min(MAX_DAILY_COINS, finalLocalCoinCount + initialBalance);
    if (targetCount > finalLocalCoinCount) {
      const coinResult = await completeCoins(candidates, targetCount, finalLocalCoinCount, uid, csrf, cookie);
      finalLocalCoinCount = coinResult.count;
      localSpent = coinResult.spent;
      if (coinResult.error && coinResult.error.fatal) {
        stopForFatal(coinResult.error);
        return;
      }
      if (coinResult.error) errors.push(coinResult.error);
    }
  }

  await sleep(1800);

  const finalStatus = (await getDailyStatus(cookie, 0)) || initialStatus;
  const finalCoinExp = await getCoinExp(cookie, 0);
  let finalCoinCount = coinCountFromExp(finalCoinExp !== null ? finalCoinExp : finalStatus.coins);
  if (finalCoinCount === null) finalCoinCount = finalLocalCoinCount;
  if (finalCoinCount !== null && finalLocalCoinCount !== null) finalCoinCount = Math.max(finalCoinCount, finalLocalCoinCount);

  const finalNav = await getJson(API.nav, cookie, "https://www.bilibili.com/", 0);
  const finalUser = isLoggedIn(finalNav) ? finalNav.data : user;
  let finalBalance = integerOrNull(finalUser.money);
  if (finalBalance === null && initialBalance !== null) finalBalance = Math.max(0, initialBalance - localSpent);

  const balanceLimited = finalCoinCount !== null && finalCoinCount < MAX_DAILY_COINS && finalBalance === 0;
  const coinsDone = finalCoinCount !== null && (finalCoinCount >= MAX_DAILY_COINS || balanceLimited);
  const levelTasksDone = !!(finalStatus.login && finalStatus.watch && finalStatus.share && coinsDone);

  const levelExp = (finalStatus.login ? 5 : 0) + (finalStatus.watch ? 5 : 0) + (finalStatus.share ? 5 : 0) + (Number.isFinite(Number(finalCoinExp)) ? Math.max(0, Math.min(50, Number(finalCoinExp))) : (finalCoinCount || 0) * 10);
  const coinText = finalCoinCount === null ? "未知/5" : finalCoinCount + "/5";
  const vipText = formatVipPanel(vipResult);

  if (levelTasksDone && vipResult.done !== false) {
    panel = balanceLimited
      ? makePanel("⚠️ 今日任务已完成｜投币 " + coinText + "（余额不足）｜" + vipText, "exclamationmark.triangle.fill", "#FF9F0A")
      : makePanel("✅ 今日任务已完成｜投币 " + coinText + "｜" + vipText, "checkmark.circle.fill", "#34C759");
  } else {
    const parts = ["⚠️ 今日任务部分完成", "投币 " + coinText];
    if (!finalStatus.share) parts.push("分享未完成");
    if (vipResult.done === false) parts.push("大会员+10未完成");
    panel = makePanel(parts.join("｜"), "exclamationmark.triangle.fill", "#FF9F0A");
  }

  const lines = [
    "登录 " + icon(finalStatus.login) + "  观看 " + icon(finalStatus.watch) + "  分享 " + icon(finalStatus.share),
    "投币 " + coinText + (balanceLimited ? "（余额不足）" : ""),
    "大会员经验 " + formatVipNotice(vipResult),
    "等级经验 " + levelExp + "/65｜硬币余额 " + (finalBalance === null ? "未知" : finalBalance),
    "网络：按 Surge 当前策略"
  ];
  if (errors.length) lines.push("异常：" + errors.map(e => e.stage + " code " + (e.code == null ? "未知" : e.code)).join("；"));

  notify(levelTasksDone && vipResult.done !== false ? "✅ 今日可执行任务已完成" : "⚠️ 今日任务部分完成", lines.join("\n"));
}

function isAcceptedSession(cookie, meta) {
  return !!(cookie && meta && meta.verified === true && meta.schema === SESSION_SCHEMA && (meta.buvid3Source === "home" || meta.buvid3Source === "login"));
}

async function getDailyStatus(cookie, retry = 1) {
  const body = await getJson(API.daily, cookie, "https://www.bilibili.com/", retry);
  if (!body || apiCode(body) !== 0 || !body.data) return null;
  const d = body.data;
  if (typeof d.login !== "boolean" || typeof d.watch !== "boolean" || typeof d.share !== "boolean") return null;
  return { login: d.login, watch: d.watch, share: d.share, coins: numberOrNull(d.coins) };
}

async function getCoinExp(cookie, retry = 1) {
  const body = await getJson(API.coinExp, cookie, "https://www.bilibili.com/", retry);
  return body && apiCode(body) === 0 ? numberOrNull(body.data) : null;
}

async function getVideoCandidates(cookie) {
  const result = [];
  const seen = {};

  try {
    const body = await getJson(API.dynamic, cookie, "https://www.bilibili.com/", 0);
    const items = body && apiCode(body) === 0 && body.data && Array.isArray(body.data.items) ? body.data.items : [];
    for (const item of items) {
      const bvid = item && item.modules && item.modules.module_dynamic && item.modules.module_dynamic.major && item.modules.module_dynamic.major.archive && item.modules.module_dynamic.major.archive.bvid;
      addCandidate(result, seen, bvid);
      if (result.length >= 16) break;
    }
  } catch (_) {}

  if (result.length < 10) {
    try {
      const body = await getJson(API.ranking, cookie, "https://www.bilibili.com/", 0);
      const items = body && apiCode(body) === 0 && body.data && Array.isArray(body.data.list) ? body.data.list : [];
      for (const item of items) {
        addCandidate(result, seen, item && item.bvid);
        if (result.length >= 20) break;
      }
    } catch (_) {}
  }

  shuffle(result);
  return result;
}

function addCandidate(result, seen, bvid) {
  if (typeof bvid !== "string" || !/^BV[0-9A-Za-z]{8,20}$/.test(bvid) || seen[bvid]) return false;
  seen[bvid] = true;
  result.push(bvid);
  return true;
}

async function getVideoInfo(bvid, cookie) {
  const url = API.view + "?bvid=" + encodeURIComponent(bvid);
  const body = await getJson(url, cookie, "https://www.bilibili.com/video/" + bvid, 0);
  if (!body || apiCode(body) !== 0 || !body.data) return null;
  const d = body.data;
  const aid = numberOrNull(d.aid);
  const firstPage = Array.isArray(d.pages) && d.pages[0];
  const cid = numberOrNull(d.cid || (firstPage && firstPage.cid));
  const duration = integerOrNull(d.duration);
  const ownerMid = d.owner ? numberOrNull(d.owner.mid) : null;
  const copyright = integerOrNull(d.copyright);
  return aid > 0 && cid > 0 ? { aid, cid, bvid, duration, ownerMid, copyright } : null;
}

async function completeWatch(candidates, uid, csrf, cookie) {
  for (let i = 0; i < Math.min(candidates.length, 4); i++) {
    const video = await getVideoInfo(candidates[i], cookie);
    if (!video) continue;

    let body = await sendHeartbeat(video, uid, csrf, cookie, 0, 0);
    let error = classifyResponse(body, "观看");
    if (error) return { error, video: null };
    if (apiCode(body) !== 0) continue;

    await sleep(1000);
    const maxPlayed = Math.max(1, Math.min(15, video.duration || 15));
    const played = randomInt(1, maxPlayed);
    body = await sendHeartbeat(video, uid, csrf, cookie, played, played);
    error = classifyResponse(body, "观看");
    if (error) return { error, video: null };
    if (apiCode(body) === 0) return { error: null, video };

    if (apiCode(body) === null) {
      await sleep(500);
      const status = await getDailyStatus(cookie, 0);
      if (status && status.watch) return { error: null, video };
    }
  }

  return { error: operationError("观看", null, "未确认观看完成"), video: null };
}

function sendHeartbeat(video, uid, csrf, cookie, playedTime, realtime) {
  const url = API.heartbeat + "?aid=" + encodeURIComponent(video.aid) + "&played_time=" + encodeURIComponent(playedTime);
  const body = formEncode({
    aid: video.aid,
    bvid: video.bvid,
    cid: video.cid,
    mid: uid,
    played_time: playedTime,
    realtime,
    real_played_time: realtime,
    start_ts: Math.floor(Date.now() / 1000) - realtime,
    type: 3,
    dt: 2,
    play_type: 3,
    csrf
  });
  return postJson(url, body, cookie, "https://www.bilibili.com/video/" + video.bvid);
}

async function completeShare(candidates, watchedVideo, uid, csrf, cookie) {
  let video = watchedVideo;
  if (!video) {
    for (let i = 0; i < Math.min(candidates.length, 4); i++) {
      video = await getVideoInfo(candidates[i], cookie);
      if (video) break;
    }
    if (!video) return operationError("分享", null, "没有可用视频");

    const open = await sendHeartbeat(video, uid, csrf, cookie, 0, 0);
    const openError = classifyResponse(open, "分享前打开视频");
    if (openError && openError.fatal) return openError;
  }

  await sleep(randomInt(SHARE_DELAY_MIN_MS, SHARE_DELAY_MAX_MS));

  const body = await postJson(
    API.share,
    formEncode({
      aid: video.aid,
      csrf,
      eab_x: 1,
      ramval: randomInt(3, 19),
      source: "web_normal",
      ga: 1
    }),
    cookie,
    "https://www.bilibili.com/video/" + video.bvid
  );

  const error = classifyResponse(body, "分享");
  if (error) return error;
  if (apiCode(body) === 0) return null;
  if (apiCode(body) === 71000) {
    await sleep(500);
    const status = await getDailyStatus(cookie, 0);
    return status && status.share ? null : operationError("分享", 71000, "重复分享但状态未确认");
  }
  if (apiCode(body) === null) {
    await sleep(500);
    const status = await getDailyStatus(cookie, 0);
    return status && status.share ? null : operationError("分享", null, "分享结果不确定，已停止重复写入");
  }

  return operationError("分享", apiCode(body), safeText(body && (body.message || body.msg) || "分享未完成", 120));
}

async function claimVipDailyExperience(candidates, uid, csrf, cookie, user) {
  if (!isVipUser(user)) return { done: null, label: "非大会员", error: null };

  let body = await postVipExperience(csrf, cookie);
  let code = apiCode(body);
  let error = classifyResponse(body, "大会员+10");
  if (error && error.fatal) return { done: false, label: "认证失败", error };

  if (code === 0) return { done: true, label: "+10", error: null };
  if (code === 69198) return { done: true, label: "已领取", error: null };

  if (code === 6034005) {
    const extraWatch = await completeWatch(candidates, uid, csrf, cookie);
    if (extraWatch.error && extraWatch.error.fatal) return { done: false, label: "认证失败", error: extraWatch.error };
    await sleep(1500);
    body = await postVipExperience(csrf, cookie);
    code = apiCode(body);
    error = classifyResponse(body, "大会员+10");
    if (error && error.fatal) return { done: false, label: "认证失败", error };
    if (code === 0) return { done: true, label: "+10", error: null };
    if (code === 69198) return { done: true, label: "已领取", error: null };
  }

  if (code === 6034005) return { done: false, label: "任务未完成", error: operationError("大会员+10", code, "大会员经验任务未完成") };
  if (code === 6034007) return { done: false, label: "请求频繁", error: operationError("大会员+10", code, "请求频繁，请稍后再试") };

  return { done: false, label: "领取失败", error: error || operationError("大会员+10", code, safeText(body && (body.message || body.msg) || "领取失败", 120)) };
}

function postVipExperience(csrf, cookie) {
  return postJson(
    API.vipExperience,
    formEncode({ csrf }),
    cookie,
    BIG_VIP_REFERER,
    "https://big.bilibili.com"
  );
}

function isVipUser(user) {
  const direct = numberOrNull(user && user.vipStatus);
  if (direct !== null) return direct === 1;
  const nested = numberOrNull(user && user.vip && user.vip.status);
  return nested === 1;
}

async function completeCoins(candidates, goalCount, startCount, uid, csrf, cookie) {
  let current = startCount;
  let spent = 0;
  let writeAttempts = 0;
  let lastError = null;
  const maxCandidates = Math.min(candidates.length, 20);

  for (let i = 0; i < maxCandidates && current < goalCount && writeAttempts < COIN_WRITE_MAX_ATTEMPTS; i++) {
    const live = coinCountFromExp(await getCoinExp(cookie, 0));
    if (live !== null) current = Math.max(current, live);
    if (current >= goalCount || current >= MAX_DAILY_COINS) break;

    const video = await getVideoInfo(candidates[i], cookie);
    if (!video) continue;
    if (video.ownerMid !== null && String(video.ownerMid) === String(uid)) continue;

    const check = await getJson(
      API.archiveCoins + "?aid=" + encodeURIComponent(video.aid),
      cookie,
      "https://www.bilibili.com/video/" + video.bvid,
      0
    );
    const checkError = classifyResponse(check, "投币前检查");
    if (checkError && checkError.fatal) return { count: current, spent, error: checkError };
    if (!check || apiCode(check) !== 0 || !check.data) continue;

    const already = integerOrNull(check.data.multiply);
    if (already === null) continue;
    const perVideoLimit = video.copyright === 1 ? 2 : 1;
    if (already >= perVideoLimit) continue;

    writeAttempts += 1;
    const response = await postJson(
      API.coinAdd,
      formEncode({ aid: video.aid, multiply: 1, select_like: 0, csrf }),
      cookie,
      "https://www.bilibili.com/video/" + video.bvid + "/?spm_id_from=333.1007.tianma.1-1-1.click"
    );

    const fatal = classifyResponse(response, "投币");
    if (fatal && fatal.fatal) return { count: current, spent, error: fatal };

    const code = apiCode(response);
    if (code === 0) {
      spent += 1;
      current = Math.min(MAX_DAILY_COINS, current + 1);
      if (current < goalCount) await sleep(randomInt(COIN_GAP_MIN_MS, COIN_GAP_MAX_MS));
      continue;
    }

    if (code === -104) {
      return { count: current, spent, error: null };
    }

    if (code === 34004) {
      lastError = operationError("投币", code, "投币间隔太短，已等待后换视频继续");
      await sleep(randomInt(COIN_RATE_LIMIT_MIN_MS, COIN_RATE_LIMIT_MAX_MS));
      continue;
    }

    if ([-400, 10003, 34002, 34003, 34005].includes(code)) {
      lastError = operationError("投币", code, safeText(response && (response.message || response.msg) || "当前视频不可投币", 120));
      await sleep(randomInt(1800, 3500));
      continue;
    }

    if (code === -403 || code === 403) {
      return { count: current, spent, error: operationError("投币", code, safeText(response && (response.message || response.msg) || "投币被拒绝", 120)) };
    }

    if (code === null) {
      await sleep(700);
      const verified = coinCountFromExp(await getCoinExp(cookie, 0));
      if (verified !== null && verified > current) {
        spent += Math.min(goalCount - current, verified - current);
        current = Math.max(current, verified);
      }
      return { count: current, spent, error: operationError("投币", null, "投币结果不确定，已停止继续投币") };
    }

    return { count: current, spent, error: lastError || operationError("投币", code, safeText(response && (response.message || response.msg) || "投币发生未知错误", 120)) };
  }

  if (current < goalCount) {
    const finalLive = coinCountFromExp(await getCoinExp(cookie, 0));
    if (finalLive !== null) current = Math.max(current, finalLive);
  }

  return {
    count: current,
    spent,
    error: current < goalCount ? (lastError || operationError("投币", null, "达到候选/重试上限，未能补满目标")) : null
  };
}

function getJson(url, cookie, referer, retry = 0) {
  return requestJson("GET", url, "", cookie, referer, retry);
}

function postJson(url, body, cookie, referer, origin = "https://www.bilibili.com") {
  return requestJson("POST", url, body, cookie, referer, 0, origin);
}

async function requestJson(method, url, body, cookie, referer, retry, origin) {
  let result = null;
  for (let attempt = 0; attempt <= retry; attempt++) {
    result = await rawRequest(method, url, body, cookie, referer, origin);
    if (result.body) return result.body;
    if (!result.retry || attempt === retry) break;
    await sleep(350 * (attempt + 1));
  }
  return null;
}

function rawRequest(method, url, body, cookie, referer, origin) {
  return new Promise(resolve => {
    const headers = {
      "User-Agent": WEB_UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh-Hans;q=0.9,en;q=0.8",
      Cookie: cookie,
      Referer: referer || "https://www.bilibili.com/"
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      if (origin) headers.Origin = origin;
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
      let json = parseJson(data);
      if (json && typeof json === "object" && httpStatus !== null) json.__httpStatus = httpStatus;

      if (httpStatus === null) {
        resolve({ body: json, retry: true });
        return;
      }

      if (httpStatus < 200 || httpStatus >= 300) {
        if (!json || typeof json !== "object") json = { code: httpStatus, message: "HTTP " + httpStatus, __httpStatus: httpStatus };
        else if (apiCode(json) === null) json.code = httpStatus;
        resolve({ body: json, retry: method === "GET" && httpStatus >= 500 });
        return;
      }

      resolve({ body: json, retry: false });
    };

    method === "POST" ? $httpClient.post(options, callback) : $httpClient.get(options, callback);
  });
}

function classifyResponse(body, stage) {
  const code = apiCode(body);
  const message = safeText(body && (body.message || body.msg) || "B站拒绝了请求", 120);
  if (code === -101 || code === -111) return { fatal: true, type: "cookie", stage, code, message };
  if (code === -102) return { fatal: true, type: "account", stage, code, message };
  if (code === -403 || code === 403) return operationError(stage, code, message);
  return null;
}

function operationError(stage, code, message) {
  return { fatal: false, type: "operation", stage, code, message: safeText(message, 120) };
}

function stopForFatal(error) {
  const code = error.code == null ? "未知" : String(error.code);
  const detail = "阶段：" + error.stage + "\ncode：" + code + "\nmessage：" + error.message;
  if (error.type === "cookie") {
    panel = makePanel("❌ " + error.stage + "失败｜code " + code + "，请重新扫码", "xmark.circle.fill", "#FF3B30");
    markCookieBad(detail);
  } else {
    panel = makePanel("❌ " + error.stage + "被拒绝｜code " + code, "xmark.circle.fill", "#FF3B30");
    notify("B站请求被拒绝", detail + "\n已停止后续写入任务。");
  }
}

function markCookieBad(reason) {
  panel = makePanel("❌ Cookie 已失效｜请重新扫码", "xmark.circle.fill", "#FF3B30");
  const today = localDateKey();
  if ($persistentStore.read(COOKIE_BAD_KEY) !== today) {
    $persistentStore.write(today, COOKIE_BAD_KEY);
    notify("❌ Cookie 已失效，请重新扫码", "原因：" + safeText(reason, 160));
  }
}

function formatVipPanel(result) {
  if (result.done === null) return "大会员+10 不适用";
  if (result.done) return "大会员+10 " + (result.label === "已领取" ? "已领取" : "✅");
  return "大会员+10 ⚠️";
}

function formatVipNotice(result) {
  if (result.done === null) return "➖ 非大会员";
  if (result.done) return result.label === "已领取" ? "✅ 今日已领取" : "✅ +10";
  return "⚠️ " + result.label;
}

function readCookieMeta() {
  const raw = $persistentStore.read(COOKIE_META_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
}

function parseCookie(cookie) {
  const result = {};
  String(cookie || "").split(";").forEach(part => {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1);
  });
  return result;
}

function formEncode(object) {
  return Object.keys(object)
    .filter(key => object[key] != null)
    .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(String(object[key])))
    .join("&");
}

function parseJson(value) {
  if (value == null || value === "") return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (_) {
    return null;
  }
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null || number < 0 ? null : Math.floor(number);
}

function apiCode(body) {
  const code = numberOrNull(body && body.code);
  return code !== null ? code : numberOrNull(body && body.__httpStatus);
}

function isLoggedIn(body) {
  return !!(body && apiCode(body) === 0 && body.data && body.data.isLogin === true);
}

function apiReason(body, fallback) {
  if (!body) return fallback;
  const code = apiCode(body);
  const message = safeText(body.message || body.msg || fallback, 120);
  return code === null ? message : code + " " + message;
}

function coinCountFromExp(exp) {
  const number = numberOrNull(exp);
  return number === null || number < 0 ? null : Math.max(0, Math.min(MAX_DAILY_COINS, Math.floor(number / 10)));
}

function icon(value) {
  return value ? "✅" : "❌";
}

function safeText(value, maxLength) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

function notify(subtitle, body) {
  $notification.post(NAME, subtitle, body);
}

function unique(array) {
  return array.filter((value, index) => array.indexOf(value) === index);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
}

async function acquireRunLock() {
  const now = Date.now();
  const current = readRunLock();
  if (current && current.expiresAt > now) return false;

  const owner = now.toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  if (!$persistentStore.write(JSON.stringify({ owner, expiresAt: now + RUN_LOCK_TTL_MS }), RUN_LOCK_KEY)) {
    throw new Error("运行锁创建失败");
  }

  for (let round = 0; round < 2; round++) {
    await sleep(120);
    const verified = readRunLock();
    if (!verified || verified.owner !== owner || verified.expiresAt <= Date.now()) return false;
  }

  lockOwner = owner;
  lockHeld = true;
  return true;
}

function readRunLock() {
  const raw = $persistentStore.read(RUN_LOCK_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || !value.owner || !Number.isFinite(Number(value.expiresAt))) return null;
    return { owner: String(value.owner), expiresAt: Number(value.expiresAt) };
  } catch (_) {
    return null;
  }
}

function releaseRunLock() {
  if (!lockHeld) return;
  const current = readRunLock();
  if (current && current.owner === lockOwner) $persistentStore.write("", RUN_LOCK_KEY);
  lockHeld = false;
  lockOwner = "";
}

function readPanelState() {
  const raw = $persistentStore.read(PANEL_STATE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value.title === "string" && typeof value.content === "string" ? value : null;
  } catch (_) {
    return null;
  }
}

function writePanelState(value) {
  try {
    $persistentStore.write(JSON.stringify(value), PANEL_STATE_KEY);
  } catch (_) {}
}

function localDateKey() {
  const date = new Date();
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function isPanelCall() {
  return typeof $input === "object" && $input && $input.purpose === "panel";
}

function isAutoPanelRefresh() {
  return isPanelCall() && $trigger === "auto-interval";
}

function makePanel(content, iconName, color) {
  return { title: NAME, content, icon: iconName, "icon-color": color };
}

function finish(value) {
  if (doneCalled) return;
  doneCalled = true;
  isPanelCall() ? $done(value) : $done();
}
