/*
 * Betty-Bilibili-Daily
 * 贝蒂的哔哩哔哩每日签到
 * Version: 1.0.0
 * Runtime: Surge
 *
 * 功能：每日登录/观看/分享/投币经验任务。
 * Cookie 仅从 Surge 本地 $persistentStore 读取，不包含任何自动抓取逻辑。
 */

const NAME = "贝蒂的哔哩哔哩每日签到";
const VERSION = "1.0.0";
const COOKIE_KEY = "betty.bilibili.cookie";
const COOKIE_META_KEY = "betty.bilibili.cookie.meta";
const INVALID_NOTICE_KEY = "betty.bilibili.cookie.invalid_notice";
const MAX_DAILY_COINS = 5;
const MAX_CANDIDATES = 24;

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

main()
  .catch((error) => {
    log(`Fatal: ${error && error.stack ? error.stack : error}`);
    notify("执行失败", String(error && error.message ? error.message : error));
  })
  .finally(() => $done());

async function main() {
  log(`Start v${VERSION}`);

  const cookie = $persistentStore.read(COOKIE_KEY);
  if (!cookie) {
    notify("尚未获取 Cookie", "请先临时安装“贝蒂的哔哩哔哩 Cookie 获取”模块，抓取成功后即可删除该模块。", true);
    return;
  }

  const cookieObj = parseCookie(cookie);
  if (!cookieObj.SESSDATA || !cookieObj.bili_jct) {
    notify("Cookie 信息不完整", "缺少 SESSDATA 或 bili_jct，请重新抓取 Cookie。", true);
    return;
  }

  const nav = await getNav(cookie);
  if (!isLoggedIn(nav)) {
    notifyInvalidCookieOncePerDay(nav && nav.message ? nav.message : "账号未登录");
    return;
  }

  const user = nav.data;
  const uid = String(user.mid || cookieObj.DedeUserID || "");
  const csrf = cookieObj.bili_jct;

  let status = await getDailyStatus(cookie);
  let coinExp = await getTodayCoinExp(cookie);

  if (!status) {
    notify("状态查询失败", "未能读取今日经验任务状态，本次不执行写入操作。", true);
    return;
  }

  const needLoginOrWatch = !status.login || !status.watch;
  const needShare = !status.share;
  const initialCoinExp = coinExp !== null ? coinExp : Number(status.coins || 0);
  const earnedCoinCount = clamp(Math.floor(initialCoinExp / 10), 0, MAX_DAILY_COINS);
  const needCoins = earnedCoinCount < MAX_DAILY_COINS;

  let candidates = [];
  if (needLoginOrWatch || needShare || needCoins) {
    candidates = await getCandidates(uid, cookie);
  }

  if (needLoginOrWatch) {
    const video = await firstUsableVideo(candidates, cookie);
    if (video) {
      await watchVideo(video, csrf, cookie);
      await wait(900);
    } else {
      log("No usable video for watch task");
    }
  } else {
    log("Login/watch already completed");
  }

  if (needShare) {
    await shareOneVideo(candidates, csrf, cookie);
    await wait(700);
  } else {
    log("Share already completed");
  }

  // 使用实时投币经验接口，避免重复投币。
  coinExp = await getTodayCoinExp(cookie);
  const currentCoinExp = coinExp !== null ? coinExp : Number(status.coins || 0);
  const currentCoinCount = clamp(Math.floor(currentCoinExp / 10), 0, MAX_DAILY_COINS);
  const remainingCoinCount = Math.max(0, MAX_DAILY_COINS - currentCoinCount);
  const availableCoins = Math.max(0, Math.floor(Number(user.money || 0)));
  const targetSpend = Math.min(remainingCoinCount, availableCoins);

  let spent = 0;
  if (targetSpend > 0) {
    spent = await spendCoins(candidates, targetSpend, csrf, cookie);
  } else if (remainingCoinCount === 0) {
    log("Coin task already completed");
  } else {
    log("No available coins to spend");
  }

  // 给 B 站一点时间更新任务状态，再做最终验收。
  await wait(1200);
  const finalStatus = (await getDailyStatus(cookie)) || status;
  const finalCoinExpQuery = await getTodayCoinExp(cookie);
  const finalCoinExp = Number(finalCoinExpQuery !== null ? finalCoinExpQuery : (finalStatus.coins || 0));
  const finalNav = (await getNav(cookie)) || nav;

  const finalCoinCount = clamp(Math.floor(finalCoinExp / 10), 0, MAX_DAILY_COINS);
  const dailyExp = (finalStatus.login ? 5 : 0)
    + (finalStatus.watch ? 5 : 0)
    + (finalStatus.share ? 5 : 0)
    + Math.min(50, finalCoinExp);

  const balance = finalNav && finalNav.data ? Math.max(0, Math.floor(Number(finalNav.data.money || 0))) : Math.max(0, availableCoins - spent);
  const coinLimitedByBalance = finalCoinCount < MAX_DAILY_COINS && balance === 0;
  const complete = !!(finalStatus.login && finalStatus.watch && finalStatus.share && (finalCoinCount >= MAX_DAILY_COINS || coinLimitedByBalance));
  const coinSuffix = coinLimitedByBalance ? "（余额不足）" : "";

  const subtitle = complete ? "✅ 今日可执行任务已完成" : "⚠️ 今日任务未完全完成";
  const content = [
    `登录 ${icon(finalStatus.login)}  观看 ${icon(finalStatus.watch)}  分享 ${icon(finalStatus.share)}`,
    `投币 ${finalCoinCount}/${MAX_DAILY_COINS}${coinSuffix}（本次 +${spent}）`,
    `今日经验 ${dailyExp}/65｜硬币余额 ${balance}`
  ].join("\n");

  notify(subtitle, content, false, user.uname ? `[${user.uname}]` : "");
}

async function getNav(cookie) {
  return apiGet("https://api.bilibili.com/x/web-interface/nav", cookie);
}

async function getDailyStatus(cookie) {
  const body = await apiGet("https://api.bilibili.com/x/member/web/exp/reward", cookie);
  if (!body || body.code !== 0 || !body.data) {
    log(`Daily status failed: ${body ? `${body.code} ${body.message}` : "no response"}`);
    return null;
  }
  return body.data;
}

async function getTodayCoinExp(cookie) {
  const body = await apiGet("https://api.bilibili.com/x/web-interface/coin/today/exp", cookie);
  if (!body || body.code !== 0) {
    log(`Coin exp query failed: ${body ? `${body.code} ${body.message}` : "no response"}`);
    return null;
  }
  return Number(body.data || 0);
}

async function getCandidates(uid, cookie) {
  const result = [];
  const seen = new Set();

  // 优先使用关注动态中的视频，让投币尽量落到用户实际关注的 UP 主。
  if (uid) {
    try {
      const url = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/dynamic_new?uid=${encodeURIComponent(uid)}&type_list=8&from=&platform=web`;
      const body = await apiGet(url, cookie);
      const cards = body && body.code === 0 && body.data && Array.isArray(body.data.cards) ? body.data.cards : [];
      for (const item of cards) {
        const bvid = item && item.desc ? item.desc.bvid : "";
        if (bvid && !seen.has(bvid)) {
          seen.add(bvid);
          result.push({ bvid });
          if (result.length >= MAX_CANDIDATES) break;
        }
      }
    } catch (error) {
      log(`Dynamic candidates failed: ${error.message || error}`);
    }
  }

  // 关注动态不足时使用热门视频兜底，避免签到因候选不足而中断。
  if (result.length < 10) {
    try {
      const body = await apiGet("https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all", cookie);
      const list = body && body.code === 0 && body.data && Array.isArray(body.data.list) ? body.data.list : [];
      for (const item of list) {
        const bvid = item && item.bvid;
        if (bvid && !seen.has(bvid)) {
          seen.add(bvid);
          result.push({ bvid });
          if (result.length >= MAX_CANDIDATES) break;
        }
      }
    } catch (error) {
      log(`Ranking candidates failed: ${error.message || error}`);
    }
  }

  shuffle(result);
  log(`Candidates: ${result.length}`);
  return result;
}

async function firstUsableVideo(candidates, cookie) {
  for (const candidate of candidates.slice(0, 8)) {
    const full = await hydrateVideo(candidate.bvid, cookie);
    if (full) return full;
  }
  return null;
}

async function hydrateVideo(bvid, cookie) {
  if (!bvid) return null;
  const body = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, cookie);
  if (!body || body.code !== 0 || !body.data) return null;
  const aid = body.data.aid;
  const cid = body.data.cid || (Array.isArray(body.data.pages) && body.data.pages[0] ? body.data.pages[0].cid : 0);
  if (!aid || !cid) return null;
  return { bvid, aid, cid };
}

async function watchVideo(video, csrf, cookie) {
  log(`Watch: ${video.bvid}`);
  const now = Math.floor(Date.now() / 1000);
  const body = formEncode({
    aid: video.aid,
    bvid: video.bvid,
    cid: video.cid,
    played_time: 30,
    realtime: 30,
    start_ts: now - 30,
    type: 3,
    dt: 2,
    play_type: 0,
    csrf
  });
  const ret = await apiPost("https://api.bilibili.com/x/click-interface/web/heartbeat", body, cookie, `https://www.bilibili.com/video/${video.bvid}`);
  log(`Watch result: ${ret ? `${ret.code} ${ret.message}` : "no response"}`);
  return !!(ret && ret.code === 0);
}

async function shareOneVideo(candidates, csrf, cookie) {
  for (const candidate of candidates.slice(0, 10)) {
    const body = formEncode({ bvid: candidate.bvid, csrf });
    const ret = await apiPost("https://api.bilibili.com/x/web-interface/share/add", body, cookie, `https://www.bilibili.com/video/${candidate.bvid}`);
    if (ret && ret.code === 0) {
      log(`Share success: ${candidate.bvid}`);
      return true;
    }
    // 71000 通常表示该视频重复分享，换下一个候选即可。
    log(`Share failed ${candidate.bvid}: ${ret ? `${ret.code} ${ret.message}` : "no response"}`);
    await wait(250);
  }
  return false;
}

async function spendCoins(candidates, target, csrf, cookie) {
  let spent = 0;
  let attempts = 0;

  for (const candidate of candidates) {
    if (spent >= target || attempts >= MAX_CANDIDATES) break;
    attempts += 1;

    const already = await getVideoCoinCount(candidate.bvid, cookie);
    if (already >= 2) continue;

    let ret = await addCoin(candidate.bvid, csrf, cookie);
    if (ret && ret.code === 34004) {
      // 投币间隔过短，仅做一次温和重试。
      await wait(1200);
      ret = await addCoin(candidate.bvid, csrf, cookie);
    }

    if (ret && ret.code === 0) {
      spent += 1;
      log(`Coin success ${spent}/${target}: ${candidate.bvid}`);
      await wait(750);
      continue;
    }

    if (ret && ret.code === -104) {
      log("Coin balance exhausted");
      break;
    }

    log(`Coin failed ${candidate.bvid}: ${ret ? `${ret.code} ${ret.message}` : "no response"}`);
    await wait(300);
  }

  return spent;
}

async function getVideoCoinCount(bvid, cookie) {
  const body = await apiGet(`https://api.bilibili.com/x/web-interface/archive/coins?bvid=${encodeURIComponent(bvid)}`, cookie);
  if (!body || body.code !== 0 || !body.data) return 0;
  return Number(body.data.multiply || 0);
}

async function addCoin(bvid, csrf, cookie) {
  const body = formEncode({
    bvid,
    multiply: 1,
    select_like: 0,
    csrf
  });
  return apiPost("https://api.bilibili.com/x/web-interface/coin/add", body, cookie, `https://www.bilibili.com/video/${bvid}`);
}

function apiGet(url, cookie) {
  return new Promise((resolve) => {
    $httpClient.get({
      url,
      headers: baseHeaders(cookie)
    }, (error, response, data) => {
      if (error) {
        log(`GET error ${url}: ${error}`);
        resolve(null);
        return;
      }
      resolve(safeJson(data));
    });
  });
}

function apiPost(url, body, cookie, referer) {
  return new Promise((resolve) => {
    const headers = baseHeaders(cookie);
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    if (referer) headers.Referer = referer;

    $httpClient.post({ url, headers, body }, (error, response, data) => {
      if (error) {
        log(`POST error ${url}: ${error}`);
        resolve(null);
        return;
      }
      resolve(safeJson(data));
    });
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
  return !!(body && body.code === 0 && body.data && body.data.isLogin === true);
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

function formEncode(obj) {
  return Object.keys(obj)
    .filter((key) => obj[key] !== undefined && obj[key] !== null)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(obj[key]))}`)
    .join("&");
}

function safeJson(data) {
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (error) {
    log(`JSON parse failed: ${error.message || error}`);
    return null;
  }
}

function notifyInvalidCookieOncePerDay(reason) {
  const today = localDateKey();
  const last = $persistentStore.read(INVALID_NOTICE_KEY);
  if (last !== today) {
    $persistentStore.write(today, INVALID_NOTICE_KEY);
    notify("Cookie 已失效", `原因：${reason}\n请临时安装 Cookie 获取模块重新抓取，成功后删除即可。`, true);
  }
}

function notify(subtitle, content, important, prefix) {
  const title = `${prefix ? `${prefix} ` : ""}${NAME}`;
  $notification.post(title, subtitle, content);
}

function icon(value) {
  return value ? "✅" : "❌";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function log(message) {
  console.log(`[Betty-Bilibili-Daily] ${message}`);
}
