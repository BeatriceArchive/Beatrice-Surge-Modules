/*
 * Beatrice Surge Modules
 * Copyright (c) 2026 BeatriceArchive. See repository LICENSE.
 */
// Run in Safari through Shortcuts' "Run JavaScript on Web Page" action.
// Send the result directly to Surge's Run Script action (Cookie tool parameter).
// Read only device identifiers. Never export SESSDATA, bili_jct or account IDs.
// Refusals are also JSON text with a fixed reason code, so the Cookie tool can
// show the specific cause instead of a generic "invalid input" message.
(() => {
  if (location.protocol !== 'https:' || !/^(www\.|m\.)?bilibili\.com$/.test(location.hostname)) {
    completion(JSON.stringify({ action: 'import-device-error', version: 1, reason: 'foreign-origin' }));
    return;
  }
  const allowed = ['buvid3', 'buvid4', 'b_nut', '_uuid', 'buvid_fp', 'b_lsid'];
  const cookies = {};
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (allowed.includes(key)) cookies[key] = part.slice(index + 1).trim();
  }
  if (['buvid3', 'buvid4', 'b_nut'].some(key => !cookies[key])) {
    completion(JSON.stringify({ action: 'import-device-error', version: 1, reason: 'incomplete-device' }));
    return;
  }
  completion(JSON.stringify({
    action: 'import-device', version: 1, origin: location.origin,
    userAgent: navigator.userAgent, cookies
  }));
})();
