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
