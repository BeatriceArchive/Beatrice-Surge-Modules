// Run in Safari through Shortcuts' "Run JavaScript on Web Page" action.
// Send the result directly to Surge's Run Script action (Cookie tool parameter).
// Read only device identifiers. Never export SESSDATA, bili_jct or account IDs.
(() => {
  if (location.protocol !== 'https:' || !/^(www\.|m\.)?bilibili\.com$/.test(location.hostname)) {
    completion({ error: '请在本人 Bilibili 官方网页运行' });
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
    completion({ error: '设备信息尚未完整，请正常打开 Bilibili 主站、等待页面加载后再试' });
    return;
  }
  completion(JSON.stringify({
    action: 'import-device', version: 1, origin: location.origin,
    userAgent: navigator.userAgent, cookies
  }));
})();
