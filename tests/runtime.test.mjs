import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function runtime(name, { store = new Map(), respond = () => ({ code: 0 }), trigger = 'button', input = { purpose: 'panel', panelName: name }, script = { name, type: 'generic' }, failStore = false, now = () => Date.now(), onWrite = () => {} } = {}) {
  const calls = [], notices = [], writes = [], completions = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } }
  const context = vm.createContext({
    console: { log() {} }, Date: Clock, Math, Uint8Array, ArrayBuffer,
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    $input: input, $trigger: trigger, $script: script, $argument: '',
    $persistentStore: { read: k => store.get(k) || '', write: (v, k) => {
      if (typeof failStore === 'function' ? failStore(k, v) : failStore) return false;
      onWrite(k, v); writes.push({ key: k, value: v }); store.set(k, v); return true;
    } },
    $notification: { post: (...args) => notices.push(args) }, $done: value => completions.push(value),
    $httpClient: Object.fromEntries(['get', 'post'].map(method => [method, (options, cb) => {
      calls.push({ method, ...options });
      const result = respond(options, method, calls.length);
      if (result === null) cb('timeout', null, null);
      else if (result.transport) cb(result.transport.error || null, { status: result.transport.status, headers: result.transport.headers || {} }, typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      else cb(null, { status: 200, headers: {} }, JSON.stringify(result));
    }]))
  });
  // Suppress only the entry invocation; exercise the actual production functions.
  let source = readFileSync(new URL(`../Scripts/${name}.js`, import.meta.url), 'utf8');
  let entry = 'main()';
  if (name === 'Betty-Basic-Panel') source = source.replace('main().catch(', 'Promise.resolve().catch(');
  else source = source.replace(/main\(\)\.finally\(\(\)=>\{.*?\}\);/, match => { entry = match; return ''; });
  vm.runInContext(source, context);
  return { context, calls, notices, store, writes, completions, start: () => vm.runInContext(entry, context), run: code => vm.runInContext(code, context) };
}

const video = { aid: 123, cid: 456, bvid: 'BV1234567890' };
function shareRun(rt) { rt.context.fixtureVideo = video; return rt.run("share([],fixtureVideo,'42','csrf-fixture','cookie-fixture')"); }
const state = share => ({ code: 0, data: { login: true, watch: true, share, coins: 50 } });

test('share: API acceptance without task completion is not success', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { respond: (_, method) => method === 'post' ? { code: 0 } : state(false) });
  const result = await shareRun(rt);
  assert.match(result.message, /请求已接受.*未确认/);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 1);
  assert.equal(rt.calls.length, 5);
  await shareRun(rt);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 1, 'same-day reentry never repeats the write');
});

test('share: delayed official completion confirms success with one write', async () => {
  let reads = 0;
  const rt = runtime('Betty-Bilibili-Daily', { respond: (_, method) => method === 'post' ? { code: 0 } : state(++reads >= 3) });
  assert.equal(await shareRun(rt), null);
  const sent = rt.calls.find(x => x.method === 'post');
  assert.equal(new URL(sent.url).pathname, '/x/web-interface/share/add');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(sent.body)), {
    aid: String(video.aid), csrf: 'csrf-fixture', source: 'pc_client_normal', eab_x: '2', ramval: '0', ga: '1'
  });
  assert.equal(sent.headers.Origin, 'https://www.bilibili.com');
  assert.equal(sent.headers.Referer, `https://www.bilibili.com/video/${video.bvid}/`);
  assert.equal(sent['auto-redirect'], false);
});

for (const reply of [null, { code: 71000 }, { code: -400 }]) {
  test(`share: ${JSON.stringify(reply)} cannot succeed without official completion`, async () => {
    const rt = runtime('Betty-Bilibili-Daily', { respond: (_, method) => method === 'post' ? reply : state(false) });
    assert.ok(await shareRun(rt));
    const resumed = runtime('Betty-Bilibili-Daily', { store: rt.store, respond: () => state(false) });
    assert.ok(await shareRun(resumed));
    assert.equal(resumed.calls.filter(x => x.method === 'post').length, 0);
  });
}

test('share: completed task skips writing; unknown preflight also skips writing', async () => {
  for (const response of [state(true), null, { code: 0, data: {} }]) {
    const rt = runtime('Betty-Bilibili-Daily', { respond: () => response });
    await shareRun(rt);
    assert.equal(rt.calls.filter(x => x.method === 'post').length, 0);
  }
});

test('share: auth failure terminates confirmation without more writes', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { respond: (_, method) => method === 'post' ? { code: -111 } : state(false) });
  assert.equal((await shareRun(rt)).fatal, true);
  assert.equal(rt.calls.length, 2);
});

test('share: cannot send if durable local attempt record fails', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { failStore: true, respond: () => state(false) });
  assert.match((await shareRun(rt)).message, /未执行写入/);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 0);
});

test('daily: auto panel refresh does not issue requests', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { trigger: 'auto-interval' });
  await rt.run('main()');
  assert.equal(rt.calls.length, 0);
});

test('daily: existing run lock prevents a second instance and foreign unlock', async () => {
  const store = new Map([['betty.bilibili.daily.run_lock', JSON.stringify({ owner: 'other', expiresAt: Date.now() + 60000 })]]);
  const rt = runtime('Betty-Bilibili-Daily', { store });
  assert.equal(await rt.run('lock()'), false);
  rt.run('unlock()');
  assert.equal(JSON.parse(store.get('betty.bilibili.daily.run_lock')).owner, 'other');
});

test('cookie: auto refresh is local; expired QR is cleared', async () => {
  const rt = runtime('Betty-Bilibili-Cookie', { trigger: 'auto-interval', store: new Map([
    ['betty.bilibili.cookie.pending_qr', JSON.stringify({ url: 'https://passport.bilibili.com/example', expiresAt: 1 })]
  ]) });
  await rt.run('main()');
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.run('readPendingQr()'), null);
});

test('cookie: repeated panel click redisplays the same pending QR without network or clearing session', async () => {
  const rt = runtime('Betty-Bilibili-Cookie', { store: new Map([
    ['betty.bilibili.cookie.pending_qr', JSON.stringify({ url: 'https://passport.bilibili.com/example', expiresAt: Date.now() + 60000 })],
    ['betty.bilibili.cookie', 'fixture']
  ]) });
  await rt.run('main()');
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.notices.length, 1);
  assert.equal(rt.store.get('betty.bilibili.cookie'), 'fixture');
});

test('cookie: parses full header mode and rejects header injection', () => {
  const rt = runtime('Betty-Bilibili-Cookie');
  assert.equal(rt.run("extractCookies([{field:'Set-Cookie',value:'SESSDATA=fixture; Path=/'}],'').SESSDATA"), 'fixture');
  assert.equal(rt.run("safeCookieValue('fixture\\r\\nInjected: yes')"), '');
});

test('panel: automatic refresh reuses speed cache with no download', async () => {
  const rt = runtime('Betty-Basic-Panel', { trigger: 'auto-interval' });
  await rt.run("getSpeedForThisRun('')");
  assert.equal(rt.calls.length, 0);
});

test('panel: speed estimation uses exact byte length, never character/header estimates', () => {
  const rt = runtime('Betty-Basic-Panel');
  rt.context.sample = new Uint8Array(37);
  assert.equal(rt.run('binaryLength(sample)'), 37);
});

test('daily: an HTTP error cannot be overridden by a successful-looking JSON body', () => {
  const rt = runtime('Betty-Bilibili-Daily');
  assert.equal(rt.run('code({code:0,__httpStatus:403})'), 403);
  assert.equal(rt.run('code({code:0,__httpStatus:500})'), 500);
  assert.equal(rt.run('code({__httpStatus:200})'), null);
});

test('cookie: missing API code is unknown and credential requests never follow redirects', async () => {
  const rt = runtime('Betty-Bilibili-Cookie');
  assert.equal(rt.run('apiCode(null)'), null);
  assert.equal(rt.run('apiCode({code:null})'), null);
  await rt.run("request('https://www.bilibili.com/','fixture',true,true,false)");
  assert.equal(rt.calls[0]['auto-redirect'], false);
});

test('coins: timeout without confirmed EXP stops after one write and never likes', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { respond: (o, method) => {
    if (method === 'post') return null;
    if (o.url.includes('/coin/today/exp')) return { code: 0, data: 0 };
    if (o.url.includes('/archive/coins')) return { code: 0, data: { multiply: 0 } };
    return { code: 0, data: { ...video, owner: { mid: 99 }, copyright: 1 } };
  } });
  const result = await rt.run("coins(['BV1234567890','BV0987654321'],5,0,'42','csrf-fixture','cookie-fixture')");
  assert.ok(result.err);
  const writes = rt.calls.filter(x => x.method === 'post');
  assert.equal(writes.length, 1);
  assert.equal(new URLSearchParams(writes[0].body).get('select_like'), '0');
});

test('coins: fatal authentication stops before any coin write', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { respond: o => {
    if (o.url.includes('/coin/today/exp')) return { code: 0, data: 0 };
    if (o.url.includes('/archive/coins')) return { code: -101 };
    return { code: 0, data: { ...video, owner: { mid: 99 }, copyright: 1 } };
  } });
  const result = await rt.run("coins(['BV1234567890'],5,0,'42','csrf-fixture','cookie-fixture')");
  assert.equal(result.err.fatal, true);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 0);
});

const CK = 'betty.bilibili.cookie', META = CK + '.meta', SESSION = CK + '.session';
const oldCookie = 'SESSDATA=old-fixture; bili_jct=old-csrf; DedeUserID=42; buvid3=old-device';
const oldMeta = { verified: true, schema: 'official-qr-home-v3', uid: '42', buvid3Source: 'home' };
function priorSession(envelope = false) {
  const store = new Map([[CK, oldCookie], [META, JSON.stringify(oldMeta)]]);
  if (envelope) store.set(SESSION, JSON.stringify({ version: 1, cookie: oldCookie, meta: oldMeta }));
  return store;
}
const http = (status, body, headers = {}) => ({ transport: { status, headers }, body });
const loginHeaders = ['SESSDATA=new-fixture', 'bili_jct=new-csrf', 'DedeUserID=84'].map(value => ({ field: 'Set-Cookie', value: value + '; Path=/' }));
function loginResponse(url, failure = '') {
  if (url.includes('/qrcode/generate')) return { code: 0, data: { qrcode_key: 'a'.repeat(32), url: 'https://passport.bilibili.com/fixture' } };
  if (url.includes('/qrcode/poll')) return http(200, { code: 0, data: { code: 0 } }, loginHeaders);
  if (url === 'https://www.bilibili.com/') {
    if (failure === 'network') return null;
    return http(302, '', [
      { field: 'Location', value: 'https://m.bilibili.com/' },
      ...(failure === 'missing-buvid3' ? [] : [{ field: 'Set-Cookie', value: 'buvid3=new-device; Path=/; Domain=.bilibili.com' }])
    ]);
  }
  if (url === 'https://m.bilibili.com/') return http(200, '<html>fixture</html>');
  if (url.endsWith('/nav')) return failure === 'nav-network' ? null : { code: 0, data: { isLogin: true, mid: failure === 'uid-mismatch' ? 123 : 84 } };
  throw new Error('Unexpected request path');
}

test('cookie: HOME follows official mobile redirect and merges intermediate Set-Cookie without WebView APIs', async () => {
  const rt = runtime('Betty-Bilibili-Cookie', { respond: q => loginResponse(q.url) });
  const merged = await rt.run("mergeHomeCookies({SESSDATA:'new-fixture',bili_jct:'new-csrf',DedeUserID:'84'})");
  assert.equal(merged.buvid3, 'new-device');
  assert.equal(rt.calls.length, 2);
  assert.equal(rt.calls[1].url, 'https://m.bilibili.com/');
  assert.match(rt.calls[1].headers.Cookie, /buvid3=new-device/);
  assert.ok(rt.calls.every(q => q['auto-redirect'] === false && q['auto-cookie'] === false));
});

for (const url of ['https://outside.example/', 'http://www.bilibili.com/', 'https://www.bilibili.com.evil.example/', 'https://www.bilibili.com@evil.example/', 'https://evil.example@www.bilibili.com/', 'https://www.bilibili.com:444/', '//evil.example/', '\\evil.example/']) {
  test(`cookie: redirect target rejected before forwarding session: ${url}`, async () => {
    const rt = runtime('Betty-Bilibili-Cookie', { respond: () => http(302, '', { location: url }) });
    await assert.rejects(rt.run("mergeHomeCookies({SESSDATA:'fixture'})"));
    assert.equal(rt.calls.length, 1);
  });
}

test('cookie: relative HOME redirects work and loops stop at three followed hops', async () => {
  let calls = 0;
  const rt = runtime('Betty-Bilibili-Cookie', { respond: () => ++calls === 1 ? http(307, '', { Location: '/mobile' }) : http(200, '') });
  assert.equal((await rt.run("request(HOME,'fixture',true,true,false)")).ok, true);
  assert.equal(rt.calls[1].url, 'https://www.bilibili.com/mobile');
  const loop = runtime('Betty-Bilibili-Cookie', { respond: () => http(302, '', { Location: '/' }) });
  await assert.rejects(loop.run('mergeHomeCookies({})'));
  assert.equal(loop.calls.length, 4);
});

test('cookie: QR and nav do not follow redirects even if their body looks successful', async () => {
  for (const url of ['https://passport.bilibili.com/x/passport-login/web/qrcode/generate', 'https://api.bilibili.com/x/web-interface/nav']) {
    const rt = runtime('Betty-Bilibili-Cookie', { respond: () => http(302, { code: 0 }, { Location: 'https://m.bilibili.com/' }) });
    rt.context.endpoint = url;
    await assert.rejects(rt.run("getJson(endpoint,'fixture',true)"));
    assert.equal(rt.calls.length, 1);
  }
});

for (const failure of ['missing-buvid3', 'uid-mismatch', 'network', 'nav-network', 'store']) {
  for (const envelope of [false, true]) {
    test(`cookie: failed ${failure} preserves ${envelope ? 'committed' : 'legacy'} verified session`, async () => {
      const store = priorSession(envelope), before = store.get(SESSION);
      const rt = runtime('Betty-Bilibili-Cookie', { store, failStore: k => failure === 'store' && k === SESSION, respond: q => loginResponse(q.url, failure) });
      await rt.start();
      assert.equal(store.get(CK), oldCookie);
      assert.equal(store.get(META), JSON.stringify(oldMeta));
      assert.equal(store.get(SESSION), before);
      assert.equal(rt.run('hasVerifiedSession()'), true);
      assert.equal(rt.run('readPendingQr()'), null);
      assert.match(rt.completions[0].content, /原已验证会话已保留/);
      assert.equal(rt.completions.length, 1);
    });
  }
}

test('cookie: full QR login publishes cookie and UID metadata together after nav verification', async () => {
  const store = priorSession(true); let verified = false;
  const rt = runtime('Betty-Bilibili-Cookie', {
    store,
    respond(q) {
      assert.equal(JSON.parse(store.get(SESSION)).cookie, oldCookie, 'old session remains authoritative during every request');
      assert.ok(!q.headers.Cookie?.includes('old-fixture'), 'new login cannot inherit old account credentials');
      if (q.url.endsWith('/nav')) verified = true;
      return loginResponse(q.url);
    },
    onWrite(key, value) { if (key === SESSION) { assert.ok(verified); const s = JSON.parse(value); assert.equal(s.meta.uid, '84'); assert.match(s.cookie, /DedeUserID=84/); } }
  });
  await rt.start();
  assert.equal(rt.writes.filter(x => x.key === SESSION).length, 1);
  assert.match(rt.run('readSession().cookie'), /new-fixture/);
  assert.equal(rt.run('readSession().meta.uid'), '84');
  assert.match(rt.completions[0].content, /Cookie 已验证/);
  assert.equal(rt.completions.length, 1);
  const daily = runtime('Betty-Bilibili-Daily', { store });
  assert.equal(daily.run('readSession().cookie'), rt.run('readSession().cookie'));
});

test('cookie: compatibility mirror failure cannot tear the committed session pair', async () => {
  const store = priorSession();
  const rt = runtime('Betty-Bilibili-Cookie', { store, failStore: key => key === CK || key === META, respond: q => loginResponse(q.url) });
  await rt.start();
  assert.equal(store.get(CK), oldCookie);
  assert.equal(rt.run('readSession().meta.uid'), '84');
  const daily = runtime('Betty-Bilibili-Daily', { store });
  assert.match(daily.run('readSession().cookie'), /new-fixture/);
  assert.equal(daily.run('readSession().meta.uid'), '84');
});

test('cookie: explicit reset destroys both committed and legacy sessions without network', async () => {
  const rt = runtime('Betty-Bilibili-Cookie', { store: priorSession(true) });
  rt.context.$intent = { parameter: 'reset' };
  await rt.start();
  assert.equal(rt.run('readSession().cookie'), '');
  assert.equal(rt.store.get(CK), '');
  assert.equal(rt.store.get(META), '');
  assert.equal(rt.calls.length, 0);
});

const SH = 'betty.bilibili.daily.share_attempt.42';
const sept11 = Date.parse('2026-09-11T04:00:00Z');

test('share: real -403 response is rejected, does not invalidate Cookie, and is never retried today', async () => {
  const store = priorSession();
  const rt = runtime('Betty-Bilibili-Daily', { store, respond: (_, method) => method === 'post' ? { code: -403, message: '账号异常，操作失败' } : state(false) });
  const result = await shareRun(rt);
  assert.equal(result.code, -403);
  assert.equal(result.fatal, false);
  assert.match(result.message, /服务端拒绝/);
  await shareRun(rt);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 1);
  assert.equal(store.get(CK), oldCookie);
  assert.equal(store.get(CK + '.invalid_notice'), undefined);
});

test('share: legacy same-day attempt remains consumed after request format upgrade; next Beijing day permits one write', async () => {
  let clock = sept11;
  const store = new Map([[SH, JSON.stringify({ day: '2026-09-11', code: -403, requestSucceeded: false, confirmed: false })]]);
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => clock, respond: (_, method) => method === 'post' ? { code: 0 } : state(false) });
  await shareRun(rt);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 0);
  clock = Date.parse('2026-09-11T16:00:01Z');
  await shareRun(rt);
  await shareRun(rt);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 1);
  assert.equal(JSON.parse(store.get(SH)).day, '2026-09-12');
});

for (const malformed of ['{', 'null', '{}', '{"day":"not-a-date"}', '{"day":"2026-02-30"}', '{"day":"2999-01-01"}']) {
  test(`share: malformed attempt ${malformed} quarantines today and recovers tomorrow`, async () => {
    let clock = sept11;
    const store = new Map([[SH, malformed]]);
    const rt = runtime('Betty-Bilibili-Daily', { store, now: () => clock, respond: (_, method) => method === 'post' ? { code: 0 } : state(false) });
    assert.match((await shareRun(rt)).message, /已修复/);
    await shareRun(rt);
    assert.equal(rt.calls.filter(x => x.method === 'post').length, 0);
    clock += 86400000;
    await shareRun(rt);
    await shareRun(rt);
    assert.equal(rt.calls.filter(x => x.method === 'post').length, 1);
  });
}

for (const status of [302, 403, 500]) {
  test(`share: HTTP ${status} cannot trigger duplicate write even with code zero`, async () => {
    const rt = runtime('Betty-Bilibili-Daily', { respond: (_, method) => method === 'post' ? http(status, { code: 0 }) : state(false) });
    assert.ok(await shareRun(rt));
    await shareRun(rt);
    assert.equal(rt.calls.filter(x => x.method === 'post').length, 1);
  });
}

test('share: missing HTTP status never becomes successful task confirmation', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { respond: () => http(null, state(true)) });
  assert.ok(await shareRun(rt));
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 0);
});

test('share: malformed-record persistence failure sends no write and never clears protection', async () => {
  const store = new Map([[SH, '{']]);
  const rt = runtime('Betty-Bilibili-Daily', { store, failStore: key => key === SH, respond: () => state(false) });
  assert.match((await shareRun(rt)).message, /无法修复/);
  assert.equal(store.get(SH), '{');
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 0);
});

test('cookie: QR generation network failure leaves legacy session untouched', async () => {
  const rt = runtime('Betty-Bilibili-Cookie', { store: priorSession(), respond: () => null });
  await rt.start();
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.store.get(CK), oldCookie);
  assert.equal(rt.store.get(META), JSON.stringify(oldMeta));
  assert.match(rt.completions[0].content, /原已验证会话已保留/);
});

test('cookie: pending and scanned QR statuses continue to login without replacing the previous session early', async () => {
  let polls = 0;
  const rt = runtime('Betty-Bilibili-Cookie', { store: priorSession(), respond: q => {
    if (q.url.includes('/qrcode/poll') && ++polls < 3) return { code: 0, data: { code: polls === 1 ? 86101 : 86090 } };
    return loginResponse(q.url);
  } });
  await rt.start();
  assert.equal(polls, 3);
  assert.equal(rt.run('readSession().meta.uid'), '84');
  assert.equal(rt.run('readPendingQr()'), null);
});

test('cookie: server QR expiry never destroys the previous session', async () => {
  const rt = runtime('Betty-Bilibili-Cookie', { store: priorSession(), respond: q => q.url.includes('/qrcode/poll') ? { code: 0, data: { code: 86038 } } : loginResponse(q.url) });
  await rt.start();
  assert.equal(rt.store.get(CK), oldCookie);
  assert.equal(rt.run('readPendingQr()'), null);
  assert.match(rt.completions[0].content, /二维码已过期/);
});

test('daily: confirmed envelope is used even when stale compatibility mirrors reference a different UID', async () => {
  const store = priorSession();
  const cookie = 'SESSDATA=new-fixture; bili_jct=new-csrf; DedeUserID=84; buvid3=new-device';
  store.set(SESSION, JSON.stringify({ version: 1, cookie, meta: { ...oldMeta, uid: '84' } }));
  const rt = runtime('Betty-Bilibili-Daily', { store, respond: q => {
    assert.equal(q.headers.Cookie, cookie);
    if (q.url.endsWith('/nav')) return { code: 0, data: { isLogin: true, mid: 84, money: 0, vipStatus: 0, level_info: { current_exp: 100 } } };
    if (q.url.endsWith('/exp/reward')) return state(true);
    if (q.url.endsWith('/coin/today/exp')) return { code: 0, data: 50 };
    throw new Error('Unexpected request');
  } });
  await rt.start();
  assert.match(rt.completions[0].content, /今日任务已完成/);
  assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
});

const TEST_ENTRY = 'Betty-Bilibili-Share-Test';
const TEST_DAY = '2026-09-11';
const TEST_NOW = Date.parse(TEST_DAY + 'T13:00:00Z');
const TEST_ATTEMPT = `betty.bilibili.daily.share_test.42.${TEST_DAY}`;
const DAILY_PANEL = 'betty.bilibili.daily.panel_state';
function manualFixture({ reply = { code: 0, message: '0' }, confirmation = false, before = false, store = priorSession(true), ...options } = {}) {
  const dailyAttempt = JSON.stringify({ version: 2, day: TEST_DAY, code: -403, confirmed: false });
  if (!store.has(SH)) store.set(SH, dailyAttempt);
  if (!store.has(DAILY_PANEL)) store.set(DAILY_PANEL, 'unchanged Daily panel');
  let rewardReads = 0;
  return runtime(TEST_ENTRY, { store, now: () => TEST_NOW, respond: (q, method) => {
    assert.equal(new URL(q.url).hostname, 'api.bilibili.com');
    if (method === 'post') {
      assert.equal(new URL(q.url).pathname, '/x/web-interface/share/add', 'only share may write');
      assert.equal(JSON.parse(store.get(TEST_ATTEMPT)).phase, 'reserved', 'reservation exists before POST');
      return reply;
    }
    if (q.url.endsWith('/nav')) return { code: 0, data: { isLogin: true, mid: 42, money: 99, vipStatus: 1 } };
    if (q.url.endsWith('/exp/reward')) {
      rewardReads++;
      const value = rewardReads === 1 ? before : typeof confirmation === 'function' ? confirmation(rewardReads - 1) : confirmation;
      return value === null ? null : state(value);
    }
    if (q.url.includes('/ranking/v2?')) return { code: 0, data: { list: [video] } };
    throw new Error('Unexpected non-share task request: ' + new URL(q.url).pathname);
  }, ...options });
}

for (const scenario of [
  { name: 'cron timer', trigger: null, input: null, script: { name: TEST_ENTRY, type: 'cron' } },
  { name: 'cron masquerading as a button', script: { name: TEST_ENTRY, type: 'cron' } },
  { name: 'automatic panel refresh', trigger: 'auto-interval' },
  { name: 'ordinary Daily panel', input: { purpose: 'panel', panelName: 'Betty-Bilibili-Daily-Panel' } },
  { name: 'ordinary Daily script name', script: { name: 'Betty-Bilibili-Daily-Panel', type: 'generic' } },
  { name: 'script editor', trigger: 'editor' },
  { name: 'HTTP API', trigger: 'http-api' },
  { name: 'Shortcuts automation', trigger: 'intent' },
  { name: 'missing panel context', input: null },
  { name: 'missing script context', script: null }
]) {
  test(`manual share: ${scenario.name} cannot trigger a test or any network request`, async () => {
    const rt = manualFixture(scenario);
    await rt.start();
    assert.equal(rt.calls.length, 0);
    assert.equal(rt.writes.length, 0);
    assert.equal(rt.notices.length, 0);
    assert.equal(rt.completions.length, 1);
  });
}

test('manual share: actual module wiring has only a generic entry and explicit manual panel', async () => {
  const text = readFileSync(new URL('../Modules/Betty-Bilibili-Share-Test.sgmodule', import.meta.url), 'utf8');
  const line = text.split('[Script]')[1].trim();
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /^Betty-Bilibili-Share-Test = type=generic,/);
  const path = line.match(/script-path=([^,]+)/)[1];
  assert.equal(new URL(path).pathname, '/BeatriceArchive/Beatrice-Surge-Modules/main/Scripts/Betty-Bilibili-Share-Test.js');
  const panelLine = text.split('[Panel]')[1].split('[Script]')[0].trim();
  assert.match(panelLine, /^Betty-Bilibili-Share-Test = /);
  assert.match(panelLine, /script-name=Betty-Bilibili-Share-Test$/);
  assert.doesNotMatch(panelLine, /update-interval=/);
  const rt = manualFixture({ script: { name: line.split(' = ')[0], type: 'generic' }, input: { purpose: 'panel', panelName: panelLine.split(' = ')[0] } });
  await rt.start();
  assert.equal(rt.calls.filter(q => q.method === 'post').length, 1);
});

test('manual share: one extra PC-client write; no watch, coin, VIP, Daily attempt or Cookie mutation', async () => {
  const rt = manualFixture();
  const protectedKeys = [SH, CK, META, SESSION, DAILY_PANEL];
  const before = protectedKeys.map(k => rt.store.get(k));
  await rt.start();
  const posts = rt.calls.filter(q => q.method === 'post');
  assert.equal(posts.length, 1);
  const sent = posts[0];
  assert.deepEqual(Object.fromEntries(new URLSearchParams(sent.body)), { aid: '123', csrf: 'old-csrf', source: 'pc_client_normal', eab_x: '2', ramval: '0', ga: '1' });
  assert.equal(sent.headers.Origin, 'https://www.bilibili.com');
  assert.equal(sent.headers.Referer, 'https://www.bilibili.com/video/BV1234567890/');
  assert.equal(sent.headers.Cookie, oldCookie);
  assert.match(sent.headers.Cookie, /buvid3=old-device/);
  assert.equal(sent['auto-redirect'], false);
  assert.equal(sent['auto-cookie'], false);
  assert.equal(Object.keys(sent.headers).some(k => /^sec-/i.test(k)), false);
  assert.deepEqual(protectedKeys.map(k => rt.store.get(k)), before);
  assert.equal(rt.writes.some(w => protectedKeys.includes(w.key)), false);
  assert.deepEqual([...new Set(rt.calls.map(q => new URL(q.url).pathname))].sort(), ['/x/member/web/exp/reward', '/x/web-interface/nav', '/x/web-interface/ranking/v2', '/x/web-interface/share/add']);
  const daily = runtime('Betty-Bilibili-Daily', { now: () => TEST_NOW, respond: (_, method) => method === 'post' ? { code: 0 } : state(false) });
  daily.context.fixtureVideo = video;
  await daily.run("share([],fixtureVideo,'42','old-csrf'," + JSON.stringify(oldCookie) + ')');
  const normal = daily.calls.find(q => q.method === 'post');
  assert.equal(normal.body, sent.body, 'normal and manual use exactly the same form');
  assert.deepEqual({ ...normal.headers }, { ...sent.headers }, 'same UA, Cookie and request context');
});

for (const scenario of [
  { name: 'code 0 and immediate official share=true', reply: { code: 0, message: '0' }, confirmation: true, state: 'true', result: 'CONFIRMED / 官方任务已完成', reads: 2 },
  { name: 'code 0 and delayed share=true', reply: { code: 0, message: '0' }, confirmation: n => n >= 2, state: 'true', result: 'CONFIRMED / 官方任务已完成', reads: 3 },
  { name: 'code 0 but share=false', reply: { code: 0, message: '0' }, confirmation: false, state: 'false', result: 'REQUEST ACCEPTED BUT NOT CREDITED', reads: 4 },
  { name: '-403 and share=false', reply: { code: -403, message: '账号异常,操作失败' }, confirmation: false, state: 'false', result: 'REQUEST REJECTED BY BILIBILI', reads: 4 },
  { name: 'POST network failure', reply: null, confirmation: false, state: 'false', result: 'NOT CONFIRMED / 未确认', reads: 4 },
  { name: 'confirmation network failure', reply: { code: 0, message: '0' }, confirmation: null, state: 'UNKNOWN', result: 'NOT CONFIRMED / 请求接受，官方状态未知', reads: 4 },
  { name: 'HTTP 403 with misleading code 0', reply: http(403, { code: 0 }), confirmation: false, state: 'false', result: 'REQUEST REJECTED BY BILIBILI', reads: 4 },
  { name: 'HTTP 500 with misleading code 0', reply: http(500, { code: 0 }), confirmation: false, state: 'false', result: 'NOT CONFIRMED / 未确认', reads: 4 }
]) {
  test(`manual share: ${scenario.name} preserves request evidence and never repeats POST`, async () => {
    const rt = manualFixture(scenario);
    await rt.start();
    assert.equal(rt.calls.filter(q => q.method === 'post').length, 1);
    assert.equal(rt.calls.filter(q => q.url.endsWith('/exp/reward')).length, scenario.reads);
    const postIndex = rt.calls.findIndex(q => q.method === 'post');
    assert.ok(rt.calls[postIndex + 1].url.endsWith('/exp/reward'), 'confirmation starts immediately after POST');
    const content = rt.completions[0].content;
    assert.ok(content.includes('RESULT: ' + scenario.result));
    assert.ok(content.includes('OFFICIAL SHARE STATE: ' + scenario.state));
    assert.ok(content.includes('REQUEST CODE: '));
    assert.ok(content.includes('REQUEST MESSAGE: '));
    const record = JSON.parse(rt.store.get(TEST_ATTEMPT));
    assert.equal(record.mode, 'manual-share-test');
    assert.equal(record.confirmed, scenario.state === 'true');
    const resumed = manualFixture({ store: rt.store });
    await resumed.start();
    assert.equal(resumed.calls.filter(q => q.method === 'post').length, 0);
    assert.match(resumed.completions[0].content, /本日测试机会已用/);
    assert.equal(resumed.store.get(TEST_ATTEMPT), rt.store.get(TEST_ATTEMPT), 'original evidence remains unchanged');
  });
}

test('manual share: already shared or unknown preflight never consumes a write', async () => {
  for (const before of [true, null]) {
    const rt = manualFixture({ before });
    await rt.start();
    assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
    assert.equal(rt.store.has(TEST_ATTEMPT), false);
    assert.match(rt.completions[0].content, /REQUEST CODE: NOT SENT/);
  }
});

for (const malformed of ['{', 'null', '{}', '[]', 'false', '{"version":1,"mode":"manual-share-test","day":"2026-09-10"}']) {
  test(`manual share: malformed local record ${malformed} blocks writes only for its date`, async () => {
    const store = priorSession();store.set(TEST_ATTEMPT, malformed);
    const rt = manualFixture({ store });await rt.start();
    assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
    assert.equal(store.get(TEST_ATTEMPT), malformed);
    assert.match(rt.completions[0].content, /记录损坏/);
    const next = manualFixture({ store, now: () => TEST_NOW + 86400000, respond: (q, method) => {
      if (method === 'post') return { code: -403, message: '账号异常,操作失败' };
      if (q.url.endsWith('/nav')) return { code: 0, data: { isLogin: true, mid: 42 } };
      if (q.url.endsWith('/exp/reward')) return state(false);
      return { code: 0, data: { list: [video] } };
    } });
    await next.start();
    assert.equal(next.calls.filter(q => q.method === 'post').length, 1);
    assert.equal(store.get(TEST_ATTEMPT), malformed);
  });
}

test('manual share: reserved record survives killed run and cannot be used twice', async () => {
  const rt = manualFixture({ reply: null });await rt.start();
  const reserved = rt.writes.find(w => w.key === TEST_ATTEMPT).value;
  rt.store.set(TEST_ATTEMPT, reserved);
  const next = manualFixture({ store: rt.store });await next.start();
  assert.equal(next.calls.filter(q => q.method === 'post').length, 0);
  assert.match(next.completions[0].content, /REQUEST CODE: UNKNOWN/);
});

test('manual share: failed reservation prevents POST; failed result writes keep reservation', async () => {
  const blocked = manualFixture({ failStore: k => k === TEST_ATTEMPT });await blocked.start();
  assert.equal(blocked.calls.filter(q => q.method === 'post').length, 0);
  const rt = manualFixture({ failStore: (k, v) => k === TEST_ATTEMPT && JSON.parse(v).phase !== 'reserved' });await rt.start();
  assert.equal(rt.calls.filter(q => q.method === 'post').length, 1);
  assert.equal(JSON.parse(rt.store.get(TEST_ATTEMPT)).phase, 'reserved');
  const again = manualFixture({ store: rt.store });await again.start();
  assert.equal(again.calls.filter(q => q.method === 'post').length, 0);
});

test('manual share: missing buvid3, UID mismatch and network auth failure never write or change Cookie', async () => {
  for (const failure of ['missing-buvid3', 'uid-mismatch', 'nav-network']) {
    const store = priorSession(true);
    if (failure === 'missing-buvid3') store.set(SESSION, JSON.stringify({ version: 1, cookie: oldCookie.replace('; buvid3=old-device', ''), meta: oldMeta }));
    const previous = store.get(SESSION);
    const rt = manualFixture({ store, respond: () => failure === 'nav-network' ? null : { code: 0, data: { isLogin: true, mid: 84 } } });
    await rt.start();
    assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
    assert.equal(store.get(SESSION), previous);
    assert.equal(store.has(TEST_ATTEMPT), false);
  }
});

test('manual share: shared Daily lock prevents overlap, including concurrent manual clicks', async () => {
  const store = priorSession();
  store.set('betty.bilibili.daily.run_lock', JSON.stringify({ owner: 'daily', expiresAt: TEST_NOW + 60000 }));
  const rt = manualFixture({ store });await rt.start();
  assert.equal(rt.calls.length, 0);
  assert.equal(JSON.parse(store.get('betty.bilibili.daily.run_lock')).owner, 'daily');
  store.delete('betty.bilibili.daily.run_lock');
  const first = manualFixture({ store }), second = manualFixture({ store });
  await Promise.all([first.start(), second.start()]);
  assert.equal([...first.calls, ...second.calls].filter(q => q.method === 'post').length, 1);
});

test('manual share: Cookie values never enter diagnostics or test records, even if echoed', async () => {
  const rt = manualFixture({ reply: { code: -403, message: oldCookie } });await rt.start();
  const output = JSON.stringify([rt.notices, rt.completions, rt.store.get(TEST_ATTEMPT)]);
  for (const value of ['old-fixture', 'old-csrf', 'old-device', 'DedeUserID=42']) assert.equal(output.includes(value), false);
});

test('normal Daily: same-day guard survives a manual test; only confirmed state completes the task', async () => {
  const rt = manualFixture();await rt.start();
  const daily = runtime('Betty-Bilibili-Daily', { store: rt.store, now: () => TEST_NOW, respond: () => state(false) });
  assert.ok(await shareRun(daily));
  assert.equal(daily.calls.filter(q => q.method === 'post').length, 0);
  const confirmed = runtime('Betty-Bilibili-Daily', { store: rt.store, now: () => TEST_NOW, respond: () => state(true) });
  assert.equal(await shareRun(confirmed), null);
  assert.equal(confirmed.calls.filter(q => q.method === 'post').length, 0);
});

test('manual share: failed recheck preserves the original -403 diagnostic and never says NOT SENT', async () => {
  const first = manualFixture({ reply: { code: -403, message: '账号异常,操作失败' } });await first.start();
  const saved = first.store.get(TEST_ATTEMPT);
  const retry = manualFixture({ store: first.store, before: null });await retry.start();
  const content = retry.completions[0].content;
  assert.match(content, /REQUEST CODE: -403/);
  assert.match(content, /REQUEST MESSAGE: 账号异常,操作失败/);
  assert.match(content, /OFFICIAL SHARE STATE: UNKNOWN/);
  assert.doesNotMatch(content, /REQUEST CODE: NOT SENT/);
  assert.equal(retry.calls.filter(q => q.method === 'post').length, 0);
  assert.equal(retry.store.get(TEST_ATTEMPT), saved);
});

test('manual share: malformed or redirected official responses never confirm completion', async () => {
  for (const response of [
    { code: false, data: { share: true } }, { code: ' ', data: { share: true } },
    { code: 0, data: { share: 'true' } }, http(302, state(true)), http(null, state(true))
  ]) {
    const rt = manualFixture({ respond: q => q.url.endsWith('/nav') ? { code: 0, data: { isLogin: true, mid: 42 } } : response });
    await rt.start();
    assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
    assert.match(rt.completions[0].content, /OFFICIAL SHARE STATE: UNKNOWN/);
    assert.match(rt.completions[0].content, /NOT CONFIRMED/);
  }
});

for (const rollover of ['before POST', 'after POST']) {
  test(`manual share: Beijing day rollover ${rollover} cannot spend or confirm the wrong day`, async () => {
    let clock = TEST_NOW;
    const rt = manualFixture({ now: () => clock, respond: (q, method) => {
      if (q.url.endsWith('/nav')) return { code: 0, data: { isLogin: true, mid: 42 } };
      if (q.url.endsWith('/exp/reward')) return state(clock !== TEST_NOW);
      if (q.url.includes('/ranking/v2?')) { if (rollover === 'before POST') clock += 86400000; return { code: 0, data: { list: [video] } }; }
      if (method === 'post') { clock += 86400000; return { code: 0, message: '0' }; }
      throw new Error('Unexpected request');
    } });
    await rt.start();
    assert.equal(rt.calls.filter(q => q.method === 'post').length, rollover === 'before POST' ? 0 : 1);
    assert.match(rt.completions[0].content, /OFFICIAL SHARE STATE: UNKNOWN/);
    assert.match(rt.completions[0].content, /NOT CONFIRMED/);
  });
}

test('normal Daily: actual main entry respects existing daily share attempt with task still false', async () => {
  const store = priorSession(true);store.set(SH, JSON.stringify({ day: TEST_DAY, code: -403, confirmed: false }));
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => TEST_NOW, respond: (q, method) => {
    assert.equal(method, 'get', 'no duplicate share or other task write');
    if (q.url.endsWith('/nav')) return { code: 0, data: { isLogin: true, mid: 42, money: 0, vipStatus: 0 } };
    if (q.url.endsWith('/exp/reward')) return state(false);
    if (q.url.endsWith('/coin/today/exp')) return { code: 0, data: 50 };
    return { code: 0, data: { items: [], list: [] } };
  } });
  await rt.start();
  assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
  assert.match(rt.completions[0].content, /分享❌/);
});
