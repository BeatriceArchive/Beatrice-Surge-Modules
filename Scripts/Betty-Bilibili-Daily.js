/*
 * Betty-Bilibili-Daily
 * 贝蒂的哔哩哔哩每日签到
 * Version: 1.2.0
 * Runtime: Surge
 *
 * 功能：每日登录/观看/分享/投币经验任务。
 * Cookie 仅从 Surge 本地 $persistentStore 读取，不包含任何自动抓取逻辑。
 */

const NAME = "贝蒂的哔哩哔哩每日签到";
const VERSION = "1.2.0";
const COOKIE_KEY = "betty.bilibili.cookie";
const INVALID_NOTICE_KEY = "betty.bilibili.cookie.invalid_notice";
const RUN_LOCK_KEY = "betty.bilibili.daily.run_lock";
const MAX_DAILY_COINS = 5;
const MAX_CANDIDATES = 16;
const MAX_WATCH_ATTEMPTS = 3;
const MAX_SHARE_ATTEMPTS = 4;
const MAX_COIN_ATTEMPTS = 8;
const REQUEST_TIMEOUT = 6;
const READ_RETRY_DELAY = 300;
const RUN_LOCK_TTL_MS = 120000;
const LOCK_CONFIRM_DELAY_MS = 120;
const LOCK_CONFIRM_ROUNDS = 2;

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let doneCalled = false;
let runLockOwner = "";
let runLockHeld = false;
let finalPanelResult = makePanelResult(
  "每天 08:00 自动执行｜点击刷新立即运行",
  "calendar.badge.checkmark",
  "#8E8E93"
);

run();

async function run() {
  try {
    if (isAutomaticPanelInvocation()) {
      log("Automatic panel invocation ignored");
      return;
    }

    const acquired = await acquireRunLock();
    if (!acquired) {
      finalPanelResult = makePanelResult(
        "⚠️ 任务正在运行｜未启动重复实例",
        "clock.fill",
        "#FF9F0A"
      );
      log("Another Daily instance is already running");
      return;
    }

    await main();
  } catch (error) {
    const message = errorMessage(error);
    log("Fatal: " + message);
    finalPanelResult = makePanelResult(
      "❌ 执行失败｜脚本遇到未预期错误",
      "xmark.circle.fill",
      "#FF3B30"
    );
    notify("执行失败", message);
  } finally {
    releaseRunLock();
    doneOnce(finalPanelResult);
  }
}

async function main() {
  log("Start v" + VERSION);

  const cookie = $persistentStore.read(COOKIE_KEY);
  if (!cookie) {
    finalPanelResult = makePanelResult(
      "❌ 无法执行｜请先获取 Cookie",
      "xmark.circle.fill",
      "#FF3B30"
    );
    notify("尚未获取 Cookie", "请先通过“贝蒂的哔哩哔哩 Cookie 获取”Panel 完成官方登录。");
    return;
  }

  const cookieObj = parseCookie(cookie);
  const requiredCookieFields = ["SESSDATA", "bili_jct", "DedeUserID", "buvid3"];
  const missingFields = requiredCookieFields.filter(function (field) {
    return !cookieObj[field];
  });
  if (missingFields.length > 0) {
    finalPanelResult = makePanelResult(
      "❌ 无法执行｜Cookie 信息不完整",
      "xmark.circle.fill",
      "#FF3B30"
    );
    notify("Cookie 信息不完整", "缺少 " + missingFields.join("、") + "，请重新获取 Cookie。");
    return;
  }

  const nav = await getNav(cookie);
  if (!isLoggedIn(nav)) {
    finalPanelResult = makePanelResult(
      "❌ 无法执行｜Cookie 已失效，请先重新获取",
      "xmark.circle.fill",
      "#FF3B30"
    );
    notifyInvalidCookieOncePerDay(apiReason(nav, "账号未登录"));
    return;
  }

  const user = nav.data;
  const uid = String(user.mid || cookieObj.DedeUserID || "");
  const csrf = cookieObj.bili_jct;
  const availableCoins = toNonNegativeInteger(user.money);

  const status = await getDailyStatus(cookie);
  if (!status) {
    finalPanelResult = makePanelResult(
      "❌ 执行失败｜状态查询失败",
      "xmark.circle.fill",
      "#FF3B30"
    );
    notify("状态查询失败", "未能可靠读取今日经验任务状态，本次不执行写入操作。");
    return;
  }

  const initialCoinExpQuery = await getTodayCoinExp(cookie);
  const initialCoinExp = initialCoinExpQuery !== null ? initialCoinExpQuery : status.coins;
  const initialCoinCount = coinCountFromExp(initialCoinExp);

  const needWatch = !status.watch;
  const needShare = !status.share;
  const mayNeedCoins = initialCoinCount !== null
    && initialCoinCount < MAX_DAILY_COINS
    && availableCoins !== null
    && availableCoins > 0;

  let candidates = [];
  if (needWatch || needShare || mayNeedCoins) {
    candidates = await getCandidates(cookie);
  }

  if (needWatch) {
    const watchResult = await completeWatch(candidates, uid, csrf, cookie);
    if (watchResult.stopReason) {
      notifyStopReason(watchResult.stopReason);
      return;
    }
  } else {
    log("Watch already completed");
  }

  if (needShare) {
    const shareResult = await shareOneVideo(candidates, csrf, cookie);
    if (shareResult.stopReason) {
      notifyStopReason(shareResult.stopReason);
      return;
    }
  } else {
    log("Share already completed");
  }

  let knownCoinCount = initialCoinCount;
  let coinResult = {
    accountedSpend: 0,
    coinCount: knownCoinCount,
    stopReason: ""
  };

  const liveCoinExp = await getTodayCoinExp(cookie);
  const liveCoinCount = coinCountFromExp(liveCoinExp);
  if (liveCoinCount !== null) {
    knownCoinCount = liveCoinCount;
    const remainingCoinCount = Math.max(0, MAX_DAILY_COINS - liveCoinCount);
    const targetSpend = availableCoins === null
      ? 0
      : Math.min(remainingCoinCount, availableCoins);

    if (targetSpend > 0) {
      coinResult = await spendCoins(candidates, targetSpend, liveCoinCount, csrf, cookie);
      knownCoinCount = coinResult.coinCount;
      if (coinResult.stopReason) {
        notifyStopReason(coinResult.stopReason);
        return;
      }
    } else if (remainingCoinCount === 0) {
      log("Coin task already completed");
    } else if (availableCoins === 0) {
      log("No available coins to spend");
    }
  } else if (initialCoinCount !== null && initialCoinCount < MAX_DAILY_COINS && availableCoins !== 0) {
    log("Live coin status unavailable; skip coin writes");
  }

  await wait(1200);
  const queriedFinalStatus = await getDailyStatus(cookie, 0);
  const finalStatus = queriedFinalStatus || status;
  const finalCoinExpQuery = await getTodayCoinExp(cookie, 0);
  const finalCoinExp = finalCoinExpQuery !== null ? finalCoinExpQuery : finalStatus.coins;
  let finalCoinCount = coinCountFromExp(finalCoinExp);
  if (finalCoinCount === null) {
    finalCoinCount = knownCoinCount;
  }

  const refreshedNav = await getNav(cookie, 0);
  if (refreshedNav && !isLoggedIn(refreshedNav) && responseCode(refreshedNav) === -101) {
    finalPanelResult = makePanelResult(
      "❌ 无法执行｜Cookie 已失效，请先重新获取",
      "xmark.circle.fill",
      "#FF3B30"
    );
    notifyInvalidCookieOncePerDay(apiReason(refreshedNav, "账号未登录"));
    return;
  }

  const finalUser = isLoggedIn(refreshedNav) ? refreshedNav.data : user;
  let balance = toNonNegativeInteger(finalUser.money);
  if (balance === null && availableCoins !== null) {
    balance = Math.max(0, availableCoins - coinResult.accountedSpend);
  }

  const coinLimitedByBalance = finalCoinCount !== null
    && finalCoinCount < MAX_DAILY_COINS
    && balance === 0;
  const coinComplete = finalCoinCount !== null
    && (finalCoinCount >= MAX_DAILY_COINS || coinLimitedByBalance);
  const complete = !!(finalStatus.login && finalStatus.watch && finalStatus.share && coinComplete);

  const safeCoinExp = toFiniteNumber(finalCoinExp);
  const coinExperience = safeCoinExp === null
    ? (finalCoinCount === null ? 0 : finalCoinCount * 10)
    : clamp(safeCoinExp, 0, 50);
  const dailyExp = (finalStatus.login ? 5 : 0)
    + (finalStatus.watch ? 5 : 0)
    + (finalStatus.share ? 5 : 0)
    + coinExperience;

  const coinText = finalCoinCount === null
    ? "未知/" + MAX_DAILY_COINS
    : finalCoinCount + "/" + MAX_DAILY_COINS;
  const coinSuffix = coinLimitedByBalance ? "（余额不足）" : "";
  const balanceText = balance === null ? "未知" : String(balance);
  const subtitle = complete ? "✅ 今日可执行任务已完成" : "⚠️ 今日任务未完全完成";
  const content = [
    "登录 " + icon(finalStatus.login) + "  观看 " + icon(finalStatus.watch) + "  分享 " + icon(finalStatus.share),
    "投币 " + coinText + coinSuffix,
    "今日经验 " + dailyExp + "/65｜硬币余额 " + balanceText
  ].join("\n");

  if (complete && coinLimitedByBalance) {
    finalPanelResult = makePanelResult(
      "⚠️ 今日任务已完成｜投币 " + coinText + "（余额不足）",
      "exclamationmark.triangle.fill",
      "#FF9F0A"
    );
  } else if (complete) {
    finalPanelResult = makePanelResult(
      "✅ 今日任务已完成｜登录 / 观看 / 分享 / 投币 " + coinText,
      "checkmark.circle.fill",
      "#34C759"
    );
  } else {
    finalPanelResult = makePanelResult(
      "⚠️ 今日任务未完全完成｜投币 " + coinText,
      "exclamationmark.triangle.fill",
      "#FF9F0A"
    );
  }

  notify(subtitle, content);
}

async function getNav(cookie, retries) {
  return apiGet(
    "https://api.bilibili.com/x/web-interface/nav",
    cookie,
    retries === undefined ? 1 : retries
  );
}

async function getDailyStatus(cookie, retries) {
  const body = await apiGet(
    "https://api.bilibili.com/x/member/web/exp/reward",
    cookie,
    retries === undefined ? 1 : retries
  );
  if (!body || responseCode(body) !== 0 || !body.data) {
    log("Daily status failed: " + apiReason(body, "no response"));
    return null;
  }

  const data = body.data;
  if (typeof data.login !== "boolean"
    || typeof data.watch !== "boolean"
    || typeof data.share !== "boolean") {
    log("Daily status has unexpected fields");
    return null;
  }

  const coins = toFiniteNumber(data.coins);
  return {
    login: data.login,
    watch: data.watch,
    share: data.share,
    coins: coins !== null && coins >= 0 ? coins : null
  };
}

async function getTodayCoinExp(cookie, retries) {
  const body = await apiGet(
    "https://api.bilibili.com/x/web-interface/coin/today/exp",
    cookie,
    retries === undefined ? 1 : retries
  );
  if (!body || responseCode(body) !== 0) {
    log("Coin exp query failed: " + apiReason(body, "no response"));
    return null;
  }

  const value = toFiniteNumber(body.data);
  if (value === null || value < 0) {
    log("Coin exp query returned unexpected data");
    return null;
  }
  return value;
}

async function getCandidates(cookie) {
  const followed = [];
  const fallback = [];
  const seen = new Set();

  try {
    const body = await apiGet("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video", cookie, 0);
    const items = body && responseCode(body) === 0 && body.data && Array.isArray(body.data.items)
      ? body.data.items
      : [];
    for (const item of items) {
      const modules = item && item.modules;
      const dynamic = modules && modules.module_dynamic;
      const major = dynamic && dynamic.major;
      const archive = major && major.archive;
      addCandidate(followed, seen, archive && archive.bvid);
      if (followed.length >= MAX_CANDIDATES) break;
    }
  } catch (error) {
    log("Dynamic candidates failed: " + errorMessage(error));
  }

  shuffle(followed);

  if (followed.length < 8) {
    try {
      const body = await apiGet("https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all", cookie, 0);
      const list = body && responseCode(body) === 0 && body.data && Array.isArray(body.data.list)
        ? body.data.list
        : [];
      for (const item of list) {
        addCandidate(fallback, seen, item && item.bvid);
        if (followed.length + fallback.length >= MAX_CANDIDATES) break;
      }
    } catch (error) {
      log("Ranking candidates failed: " + errorMessage(error));
    }
  }

  shuffle(fallback);
  const result = followed.concat(fallback).slice(0, MAX_CANDIDATES);
  log("Candidates: " + result.length + " (followed " + followed.length + ")");
  return result;
}

function addCandidate(list, seen, bvid) {
  if (typeof bvid !== "string" || !/^BV[0-9A-Za-z]{8,20}$/.test(bvid) || seen.has(bvid)) {
    return;
  }
  seen.add(bvid);
  list.push({ bvid: bvid });
}

async function completeWatch(candidates, uid, csrf, cookie) {
  const limit = Math.min(candidates.length, MAX_WATCH_ATTEMPTS);
  for (let index = 0; index < limit; index += 1) {
    const video = await hydrateVideo(candidates[index].bvid, cookie);
    if (!video) continue;

    const ret = await watchVideo(video, uid, csrf, cookie);
    const stopReason = classifyStopReason(ret);
    if (stopReason) return { success: false, stopReason: stopReason };

    if (responseCode(ret) === 0) {
      return { success: true, stopReason: "" };
    }

    if (responseCode(ret) === null) {
      await wait(350);
      const status = await getDailyStatus(cookie, 0);
      if (status && status.watch) {
        return { success: true, stopReason: "" };
      }
      if (!status) {
        log("Watch outcome could not be reconciled; stop watch retries");
        return { success: false, stopReason: "" };
      }
    }

    log("Watch failed " + video.bvid + ": " + apiReason(ret, "no response"));
    await wait(250);
  }
  return { success: false, stopReason: "" };
}

async function hydrateVideo(bvid, cookie) {
  if (!bvid) return null;
  const body = await apiGet("https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid), cookie, 0);
  if (!body || responseCode(body) !== 0 || !body.data) return null;

  const aid = toFiniteNumber(body.data.aid);
  const firstPage = Array.isArray(body.data.pages) && body.data.pages[0] ? body.data.pages[0] : null;
  const cid = toFiniteNumber(body.data.cid || (firstPage && firstPage.cid));
  if (aid === null || aid <= 0 || cid === null || cid <= 0) return null;
  return { bvid: bvid, aid: aid, cid: cid };
}

async function watchVideo(video, uid, csrf, cookie) {
  log("Watch: " + video.bvid);
  const now = Math.floor(Date.now() / 1000);
  const body = formEncode({
    aid: video.aid,
    bvid: video.bvid,
    cid: video.cid,
    mid: uid || undefined,
    played_time: 30,
    realtime: 30,
    start_ts: now - 30,
    type: 3,
    dt: 2,
    play_type: 0,
    csrf: csrf
  });
  return apiPost(
    "https://api.bilibili.com/x/click-interface/web/heartbeat",
    body,
    cookie,
    "https://www.bilibili.com/video/" + video.bvid
  );
}

async function shareOneVideo(candidates, csrf, cookie) {
  const limit = Math.min(candidates.length, MAX_SHARE_ATTEMPTS);
  for (let index = 0; index < limit; index += 1) {
    const candidate = candidates[index];
    const body = formEncode({ bvid: candidate.bvid, csrf: csrf });
    const ret = await apiPost(
      "https://api.bilibili.com/x/web-interface/share/add",
      body,
      cookie,
      "https://www.bilibili.com/video/" + candidate.bvid
    );
    const stopReason = classifyStopReason(ret);
    if (stopReason) return { success: false, stopReason: stopReason };

    if (responseCode(ret) === 0) {
      log("Share success: " + candidate.bvid);
      return { success: true, stopReason: "" };
    }

    if (responseCode(ret) === null) {
      await wait(350);
      const status = await getDailyStatus(cookie, 0);
      if (status && status.share) {
        return { success: true, stopReason: "" };
      }
      if (!status) {
        log("Share outcome could not be reconciled; stop share retries");
        return { success: false, stopReason: "" };
      }
    }

    log("Share failed " + candidate.bvid + ": " + apiReason(ret, "no response"));
    await wait(250);
  }
  return { success: false, stopReason: "" };
}

async function spendCoins(candidates, target, startCoinCount, csrf, cookie) {
  let accountedSpend = 0;
  let coinCount = startCoinCount;
  let attempts = 0;

  for (const candidate of candidates) {
    if (accountedSpend >= target
      || coinCount >= MAX_DAILY_COINS
      || attempts >= MAX_COIN_ATTEMPTS) {
      break;
    }
    attempts += 1;

    const coinState = await getVideoCoinCount(candidate.bvid, cookie);
    if (coinState.stopReason) {
      return {
        accountedSpend: accountedSpend,
        coinCount: coinCount,
        stopReason: coinState.stopReason
      };
    }
    if (coinState.count === null || coinState.count >= 2) continue;

    const liveExp = await getTodayCoinExp(cookie, 0);
    const liveCount = coinCountFromExp(liveExp);
    if (liveCount === null || liveCount < coinCount) {
      log("Coin status unavailable or inconsistent; stop coin writes");
      break;
    }
    if (liveCount > coinCount) {
      accountedSpend += Math.min(target - accountedSpend, liveCount - coinCount);
      coinCount = liveCount;
    }
    if (accountedSpend >= target || coinCount >= MAX_DAILY_COINS) break;

    let ret = await addCoin(candidate.bvid, csrf, cookie);
    let stopReason = classifyStopReason(ret);
    if (stopReason) {
      return {
        accountedSpend: accountedSpend,
        coinCount: coinCount,
        stopReason: stopReason
      };
    }

    if (responseCode(ret) === 34004) {
      await wait(1000);
      ret = await addCoin(candidate.bvid, csrf, cookie);
      stopReason = classifyStopReason(ret);
      if (stopReason) {
        return {
          accountedSpend: accountedSpend,
          coinCount: coinCount,
          stopReason: stopReason
        };
      }
    }

    const code = responseCode(ret);
    if (code === 0) {
      accountedSpend += 1;
      coinCount = Math.min(MAX_DAILY_COINS, coinCount + 1);
      log("Coin success " + accountedSpend + "/" + target + ": " + candidate.bvid);
    } else if (code === null) {
      await wait(400);
      const reconciledExp = await getTodayCoinExp(cookie, 0);
      const reconciledCount = coinCountFromExp(reconciledExp);
      if (reconciledCount !== null && reconciledCount > coinCount) {
        accountedSpend += Math.min(target - accountedSpend, reconciledCount - coinCount);
        coinCount = reconciledCount;
      }
      log("Coin response ambiguous; stop further coin writes");
      break;
    } else if (code === -104) {
      log("Coin balance exhausted");
      break;
    } else {
      log("Coin failed " + candidate.bvid + ": " + apiReason(ret, "unknown error"));
    }

    await wait(350);
  }

  return {
    accountedSpend: accountedSpend,
    coinCount: coinCount,
    stopReason: ""
  };
}

async function getVideoCoinCount(bvid, cookie) {
  const body = await apiGet(
    "https://api.bilibili.com/x/web-interface/archive/coins?bvid=" + encodeURIComponent(bvid),
    cookie,
    0
  );
  const stopReason = classifyStopReason(body);
  if (stopReason) return { count: null, stopReason: stopReason };
  if (!body || responseCode(body) !== 0 || !body.data) {
    return { count: null, stopReason: "" };
  }

  const count = toFiniteNumber(body.data.multiply);
  if (count === null || count < 0) {
    return { count: null, stopReason: "" };
  }
  return { count: Math.floor(count), stopReason: "" };
}

async function addCoin(bvid, csrf, cookie) {
  const body = formEncode({
    bvid: bvid,
    multiply: 1,
    select_like: 0,
    csrf: csrf
  });
  return apiPost(
    "https://api.bilibili.com/x/web-interface/coin/add",
    body,
    cookie,
    "https://www.bilibili.com/video/" + bvid
  );
}

function apiGet(url, cookie, retries) {
  return requestJson("GET", url, "", cookie, "", retries || 0);
}

function apiPost(url, body, cookie, referer) {
  return requestJson("POST", url, body, cookie, referer, 0);
}

async function requestJson(method, url, body, cookie, referer, retries) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await rawRequest(method, url, body, cookie, referer);
    if (result.ok) {
      return safeJson(result.data);
    }
    if (!result.retryable || attempt >= retries) {
      return null;
    }
    await wait(READ_RETRY_DELAY * (attempt + 1));
  }
  return null;
}

function rawRequest(method, url, body, cookie, referer) {
  return new Promise(function (resolve) {
    const headers = baseHeaders(cookie);
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    }
    if (referer) headers.Referer = referer;

    const options = {
      url: url,
      headers: headers,
      timeout: REQUEST_TIMEOUT,
      "auto-cookie": false,
      "auto-redirect": false
    };
    if (method === "POST") options.body = body;

    const callback = function (error, response, data) {
      if (error) {
        log(method + " transport error " + url + ": " + cleanText(error, 160));
        resolve({ ok: false, retryable: true, data: null });
        return;
      }

      const status = response ? toFiniteNumber(response.status) : null;
      if (status === null) {
        log(method + " response missing status " + url);
        resolve({ ok: false, retryable: true, data: data });
        return;
      }
      if (status < 200 || status >= 300) {
        log(method + " HTTP " + status + " " + url);
        resolve({ ok: false, retryable: status >= 500, data: data });
        return;
      }
      resolve({ ok: true, retryable: false, data: data });
    };

    if (method === "POST") {
      $httpClient.post(options, callback);
    } else {
      $httpClient.get(options, callback);
    }
  });
}

function baseHeaders(cookie) {
  return {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Cookie": cookie,
    "Referer": "https://www.bilibili.com/"
  };
}

function isLoggedIn(body) {
  return !!(body && responseCode(body) === 0 && body.data && body.data.isLogin === true);
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

function formEncode(obj) {
  return Object.keys(obj)
    .filter(function (key) {
      return obj[key] !== undefined && obj[key] !== null;
    })
    .map(function (key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(String(obj[key]));
    })
    .join("&");
}

function safeJson(data) {
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (error) {
    log("JSON parse failed: " + errorMessage(error));
    return null;
  }
}

function responseCode(body) {
  if (!body) return null;
  const code = toFiniteNumber(body.code);
  return code === null ? null : code;
}

function classifyStopReason(body) {
  const code = responseCode(body);
  if (code === -101 || code === -111) return "cookie";
  if (code === -102 || code === -403 || code === 403) return "account";
  return "";
}

function notifyStopReason(reason) {
  if (reason === "cookie") {
    finalPanelResult = makePanelResult(
      "❌ 无法执行｜Cookie 已失效，请先重新获取",
      "xmark.circle.fill",
      "#FF3B30"
    );
    notifyInvalidCookieOncePerDay("任务接口返回未登录或 CSRF 校验失败");
    return;
  }
  finalPanelResult = makePanelResult(
    "❌ 执行失败｜账号状态异常",
    "xmark.circle.fill",
    "#FF3B30"
  );
  notify("账号状态异常", "B站拒绝了账号操作，本次已停止后续写入任务。");
}

function notifyInvalidCookieOncePerDay(reason) {
  const today = localDateKey();
  const last = $persistentStore.read(INVALID_NOTICE_KEY);
  if (last !== today) {
    $persistentStore.write(today, INVALID_NOTICE_KEY);
    notify("❌ Cookie 已失效，请重新获取", "原因：" + cleanText(reason, 120));
  }
}

function notify(subtitle, content) {
  $notification.post(NAME, subtitle, content);
}

function apiReason(body, fallback) {
  if (!body) return fallback;
  const code = responseCode(body);
  const message = cleanText(body.message || body.msg || fallback, 120);
  return code === null ? message : code + " " + message;
}

function errorMessage(error) {
  if (!error) return "未知错误";
  return cleanText(error.message || String(error), 180);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, maxLength);
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toNonNegativeInteger(value) {
  const number = toFiniteNumber(value);
  if (number === null || number < 0) return null;
  return Math.floor(number);
}

function coinCountFromExp(exp) {
  const number = toFiniteNumber(exp);
  if (number === null || number < 0) return null;
  return clamp(Math.floor(number / 10), 0, MAX_DAILY_COINS);
}

function icon(value) {
  return value ? "✅" : "❌";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shuffle(arr) {
  for (let index = arr.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    const value = arr[index];
    arr[index] = arr[other];
    arr[other] = value;
  }
  return arr;
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function localDateKey() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

async function acquireRunLock() {
  const now = Date.now();
  const existing = readRunLock();
  if (existing && existing.expiresAt > now) {
    return false;
  }

  const owner = createRunLockOwner();
  const value = JSON.stringify({
    owner: owner,
    expiresAt: now + RUN_LOCK_TTL_MS
  });
  if (!$persistentStore.write(value, RUN_LOCK_KEY)) {
    throw new Error("Daily 本地运行锁创建失败");
  }

  for (let round = 0; round < LOCK_CONFIRM_ROUNDS; round += 1) {
    await wait(LOCK_CONFIRM_DELAY_MS);
    const confirmed = readRunLock();
    if (!confirmed || confirmed.owner !== owner || confirmed.expiresAt <= Date.now()) {
      return false;
    }
  }

  runLockOwner = owner;
  runLockHeld = true;
  return true;
}

function releaseRunLock() {
  if (!runLockHeld || !runLockOwner) return;

  const current = readRunLock();
  if (current && current.owner === runLockOwner) {
    let released = $persistentStore.write(null, RUN_LOCK_KEY);
    if (!released) {
      released = $persistentStore.write("", RUN_LOCK_KEY);
    }
  }

  runLockHeld = false;
  runLockOwner = "";
}

function readRunLock() {
  const stored = $persistentStore.read(RUN_LOCK_KEY);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    const owner = parsed && typeof parsed.owner === "string" ? parsed.owner : "";
    const expiresAt = parsed ? Number(parsed.expiresAt) : NaN;
    if (!owner || owner.length > 80 || !Number.isFinite(expiresAt)) return null;
    return { owner: owner, expiresAt: expiresAt };
  } catch (_) {
    return null;
  }
}

function createRunLockOwner() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 14);
}

function isPanelInvocation() {
  return typeof $input === "object"
    && $input
    && $input.purpose === "panel";
}

function isAutomaticPanelInvocation() {
  return isPanelInvocation()
    && typeof $trigger === "string"
    && $trigger === "auto-interval";
}

function makePanelResult(content, iconName, iconColor) {
  return {
    title: NAME,
    content: content,
    icon: iconName,
    "icon-color": iconColor
  };
}

function doneOnce(panelResult) {
  if (doneCalled) return;
  doneCalled = true;
  if (isPanelInvocation()) {
    $done(panelResult);
  } else {
    $done();
  }
}

function log(message) {
  console.log("[Betty-Bilibili-Daily] " + message);
}
