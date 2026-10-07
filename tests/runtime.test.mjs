import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('share recovery: positive API 403 permits one cooled manual retry, HTTP 403 does not', async () => {
  let clock = sept11;
  const first = runtime('Betty-Bilibili-Daily', { now: () => clock, respond: (_, m) => m === 'post' ? { code: 403, message: '账号异常,操作失败' } : state(false) });
  assert.match((await shareRun(first)).message, /手动刷新重试/);
  clock += 60001;
  const again = runtime('Betty-Bilibili-Daily', { now: () => clock, store: first.store, respond: (_, m) => m === 'post' ? { code: 403 } : state(false) });
  await shareRun(again);
  assert.equal(again.calls.filter(q => q.method === 'post').length, 1);
  const blocked = runtime('Betty-Bilibili-Daily', { now: () => clock, respond: (_, m) => m === 'post' ? http(403, { code: 403 }) : state(false) });
  await shareRun(blocked);clock += 60001;
  const later = runtime('Betty-Bilibili-Daily', { now: () => clock, store: blocked.store, respond: () => state(false) });
  await shareRun(later);assert.equal(later.calls.filter(q => q.method === 'post').length, 0);
});

test('share: API rejection is reconciled with concurrent official completion', async () => {
  let posted = false;
  const rt = runtime('Betty-Bilibili-Daily', { respond: (_, m) => {
    if (m === 'post') { posted = true;return { code: -403 }; }
    return state(posted);
  } });
  assert.equal(await shareRun(rt), null);
  assert.equal(JSON.parse(rt.store.get(SH)).confirmed, true);
});

test('share: preflight completion persists over a later stale false response', async () => {
  const store = new Map([[SH, JSON.stringify({ version: 3, day: '2026-09-11', code: -403, requestSucceeded: false, confirmed: false, tries: 2 })]]);
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: () => state(true) });
  assert.equal(await shareRun(rt), null);
  const stale = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: () => state(false) });
  assert.equal(await shareRun(stale), null);
  assert.equal(stale.calls.filter(q => q.method === 'post').length, 0);
});

test('share: other rejected responses retain redacted HTTP and API diagnostics', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { respond: (_, m) => m === 'post' ? { code: -400, message: 'invalid archive' } : state(false) });
  const result = await shareRun(rt);
  assert.match(result.detail, /本轮已提交.*HTTP 200/);
  assert.match(result.detail, /invalid archive/);
});

test('cookie: invalid notice overrides an old verified panel without network requests', async () => {
  const store = priorSession(true);
  store.set(CK + '.invalid_notice', '2026-10-07');
  store.set(CK + '.panel_state', JSON.stringify({ title: 'old', content: 'Cookie 已验证' }));
  const rt = runtime('Betty-Bilibili-Cookie', { store, trigger: 'auto-interval' });
  await rt.start();assert.equal(rt.calls.length, 0);
  assert.match(rt.completions[0].content, /已标记失效/);
});

test('cookie: a replaced login lock cannot commit session or clear the new QR/panel', async () => {
  const store = priorSession(true);
  const lock = CK + '.run_lock', pending = CK + '.pending_qr', panelKey = CK + '.panel_state';
  const original = store.get(SESSION);
  const rt = runtime('Betty-Bilibili-Cookie', { store, respond: q => {
    if (q.url.endsWith('/nav')) {
      store.set(lock, JSON.stringify({ owner: 'new-login', expiresAt: Date.now() + 60000 }));
      store.set(pending, 'new-qr');store.set(panelKey, 'new-panel');
    }
    return loginResponse(q.url);
  } });
  await rt.start();
  assert.equal(store.get(SESSION), original);
  assert.equal(store.get(pending), 'new-qr');assert.equal(store.get(panelKey), 'new-panel');
  assert.equal(JSON.parse(store.get(lock)).owner, 'new-login');
  assert.match(rt.completions[0].content, /登录事务已失效/);
});

function runtime(name, { store = new Map(), respond = () => ({ code: 0 }), trigger = 'button', failStore = false, now = () => Date.now(), onWrite = () => {}, onSleep = () => {} } = {}) {
  const calls = [], notices = [], writes = [], completions = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } }
  const context = vm.createContext({
    console: { log() {} }, Date: Clock, Math, Uint8Array, ArrayBuffer,
    setTimeout: (fn, ms) => { queueMicrotask(() => { onSleep(ms); fn(); }); return 1; }, clearTimeout() {},
    $input: { purpose: 'panel' }, $trigger: trigger, $argument: '',
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
  assert.match(result.message, /经验待确认/);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 1);
  assert.equal(rt.calls.length, 7);
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

test('share: real -403 response is rejected, does not invalidate Cookie, and cannot immediately retry', async () => {
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

test('share: cron preserves legacy same-day rejection; next Beijing day permits one write', async () => {
  let clock = sept11;
  const store = new Map([[SH, JSON.stringify({ day: '2026-09-11', code: -403, requestSucceeded: false, confirmed: false })]]);
  const rt = runtime('Betty-Bilibili-Daily', { store, trigger: undefined, now: () => clock, respond: (_, method) => method === 'post' ? { code: 0 } : state(false) });
  rt.run('delete globalThis.$input; delete globalThis.$trigger');
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

test('normal Daily: actual main entry respects existing daily share attempt with task still false', async () => {
  const store = priorSession(true);store.set(SH, JSON.stringify({ day: '2026-09-11', code: -403, confirmed: false }));
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: (q, method) => {
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

test('daily: verified session sends the device-confirmed PC-client form and completes only on official share state', async () => {
  const store = priorSession(true), previousSession = store.get(SESSION);
  let shared = false;
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: (q, method) => {
    assert.equal(q.headers.Cookie, oldCookie);
    if (method === 'post') {
      assert.equal(new URL(q.url).pathname, '/x/web-interface/share/add');
      assert.equal(JSON.parse(store.get(SH)).day, '2026-09-11', 'formal guard must precede POST');
      shared = true;return { code: 0, message: '0' };
    }
    if (q.url.endsWith('/nav')) return { code: 0, data: { isLogin: true, mid: 42, money: 0, vipStatus: 0 } };
    if (q.url.endsWith('/exp/reward')) return state(shared);
    if (q.url.endsWith('/coin/today/exp')) return { code: 0, data: 50 };
    if (q.url.includes('/view?')) return { code: 0, data: video };
    return { code: 0, data: { items: [], list: [video] } };
  } });
  await rt.start();
  const posts = rt.calls.filter(q => q.method === 'post');
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(posts[0].body)), {
    aid: '123', csrf: 'old-csrf', source: 'pc_client_normal', eab_x: '2', ramval: '0', ga: '1'
  });
  assert.equal(posts[0].headers.Origin, 'https://www.bilibili.com');
  assert.equal(posts[0].headers.Referer, 'https://www.bilibili.com/video/BV1234567890/');
  assert.match(posts[0].headers.Cookie, /buvid3=old-device/);
  assert.equal(posts[0]['auto-redirect'], false);
  assert.equal(posts[0]['auto-cookie'], false);
  assert.equal(store.get(SESSION), previousSession);
  assert.equal(JSON.parse(store.get(SH)).confirmed, true);
  assert.match(rt.completions[0].content, /今日任务已完成/);
});

// Audit regressions: exercise real entry/HTTP/persistence paths, never real accounts.
const COIN = 'betty.bilibili.daily.coin_budget.42';
const DAILY_STATE = 'betty.bilibili.daily.panel_state';
const DAILY_LOCK = 'betty.bilibili.daily.run_lock';
const navOK = (money = 10, vipStatus = 0) => ({ code: 0, data: { isLogin: true, mid: 42, money, vipStatus, level_info: { current_exp: 100 } } });
function dailyResponse(q, method, { exp = 0, money = 10, vip = 0, post = { code: 0 }, watch = true, share = true } = {}) {
  if (method === 'post') return post;
  if (q.url.endsWith('/nav')) return navOK(money, vip);
  if (q.url.endsWith('/exp/reward')) return { code: 0, data: { login: true, watch, share, coins: exp } };
  if (q.url.endsWith('/coin/today/exp')) return { code: 0, data: exp };
  if (q.url.includes('/archive/coins')) return { code: 0, data: { multiply: 0 } };
  if (q.url.includes('/view?')) return { code: 0, data: { ...video, owner: { mid: 99 }, copyright: 1 } };
  return { code: 0, data: { items: [], list: Array.from({ length: 8 }, (_, i) => ({ bvid: 'BV123456789' + i })) } };
}
const coinPosts = rt => rt.calls.filter(q => q.method === 'post' && q.url.endsWith('/coin/add'));
const coinRun = rt => rt.run("coins(['BV1234567890','BV1234567891','BV1234567892','BV1234567893','BV1234567894','BV1234567895'],5,0,'42','csrf-fixture','cookie-fixture')");

for (const response of [null, http(503, { code: 0 }), http(403, ''), { code: -403 }, { code: 0, data: {} }, { code: false, data: { isLogin: true } }]) {
  test(`daily: transient/malformed nav ${JSON.stringify(response)} does not invalidate session`, async () => {
    const store = priorSession(true), before = store.get(SESSION);
    const rt = runtime('Betty-Bilibili-Daily', { store, respond: () => response });
    await rt.start();
    assert.match(rt.completions[0].content, /登录状态查询失败/);
    assert.equal(store.get(CK + '.invalid_notice'), undefined);
    assert.equal(store.get(SESSION), before);
    assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
    assert.equal(rt.completions.length, 1);
    assert.equal(store.get(DAILY_LOCK), '');
  });
}

for (const response of [{ code: -101 }, { code: -111 }, { code: 0, data: { isLogin: false } }]) {
  test(`daily: explicit auth failure ${JSON.stringify(response)} marks session without deleting it`, async () => {
    const store = priorSession(true), before = store.get(SESSION);
    const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: () => response });
    await rt.start();
    assert.match(rt.completions[0].content, /Cookie 已失效/);
    assert.equal(store.get(CK + '.invalid_notice'), '2026-09-11');
    assert.equal(store.get(SESSION), before);
  });
}

test('daily: successful validation clears a stale invalid marker', async () => {
  const store = priorSession(true);store.set(CK + '.invalid_notice', '2026-09-10');
  const rt = runtime('Betty-Bilibili-Daily', { store, respond: (q, m) => dailyResponse(q, m, { exp: 50 }) });
  await rt.start();
  assert.equal(store.get(CK + '.invalid_notice'), '');
});

test('daily: verifies cookie UID, metadata UID and live UID before writes', async () => {
  for (const mismatch of ['cookie', 'meta', 'live', 'header']) {
    const store = priorSession(true), s = JSON.parse(store.get(SESSION));
    if (mismatch === 'cookie') s.cookie = s.cookie.replace('DedeUserID=42', 'DedeUserID=99');
    if (mismatch === 'meta') delete s.meta.uid;
    if (mismatch === 'header') s.cookie += '\r\nInjected: value';
    store.set(SESSION, JSON.stringify(s));
    const rt = runtime('Betty-Bilibili-Daily', { store, respond: () => ({ code: 0, data: { ...navOK().data, mid: 99 } }) });
    await rt.start();
    assert.match(rt.completions[0].content, /Cookie 已失效/);
    assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
    if (mismatch !== 'live') assert.equal(rt.calls.length, 0);
  }
});

for (const [path, code] of [['/exp/reward', -101], ['/coin/today/exp', -111], ['/feed/all', -412], ['/view?', -102], ['/exp/reward', -352], ['/coin/today/exp', 429]]) {
  test(`daily: fatal read ${path} code ${code} stops before task writes`, async () => {
    const store = priorSession(true);
    const rt = runtime('Betty-Bilibili-Daily', { store, respond: (q, m) => q.url.includes(path) ? { code } : dailyResponse(q, m, { watch: false }) });
    await rt.start();
    assert.equal(rt.calls.filter(q => q.method === 'post').length, 0);
    assert.equal(rt.completions.length, 1);
    assert.match(rt.completions[0].content, /失效|被拒绝/);
    if (![-101, -111].includes(code)) assert.notEqual(store.get(CK + '.invalid_notice'), '2026-09-11');
  });
}

test('daily: GET retries a 503 once, POST never retries', async () => {
  let calls = 0;
  const rt = runtime('Betty-Bilibili-Daily', { respond: () => ++calls === 1 ? http(503, { code: 0 }) : navOK() });
  assert.equal((await rt.run("get(A.nav,'cookie',HOME,1)")).code, 0);
  assert.equal(rt.calls.length, 2);
  const post = runtime('Betty-Bilibili-Daily', { respond: () => http(503, { code: 0 }) });
  assert.equal((await post.run("postForm(A.coinAdd,'body','cookie',HOME)")).__httpStatus, 503);
  assert.equal(post.calls.length, 1);
});

for (const reply of [null, http(500, { code: 0 }), http(302, { code: 0 }), { code: -500 }, { code: 99999 }]) {
  test(`coins: ambiguous ${JSON.stringify(reply)} blocks every same-day reentry`, async () => {
    const rt = runtime('Betty-Bilibili-Daily', { now: () => sept11, respond: (q, m) => dailyResponse(q, m, { post: reply }) });
    assert.ok((await coinRun(rt)).err);
    assert.equal(coinPosts(rt).length, 1);
    assert.equal(JSON.parse(rt.store.get(COIN)).pending, true);
    const again = runtime('Betty-Bilibili-Daily', { store: rt.store, now: () => sept11, respond: dailyResponse });
    assert.match((await coinRun(again)).err.message, /今日暂停/);
    assert.equal(coinPosts(again).length, 0);
    const tomorrow = runtime('Betty-Bilibili-Daily', { store: rt.store, now: () => sept11 + 86400000, respond: dailyResponse });
    assert.equal((await coinRun(tomorrow)).spent, 5);
    assert.equal(coinPosts(tomorrow).length, 5);
  });
}

test('coins: delayed EXP cannot cause more than five accepted coins across runs', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { now: () => sept11, respond: dailyResponse });
  assert.equal((await coinRun(rt)).spent, 5);
  const again = runtime('Betty-Bilibili-Daily', { store: rt.store, now: () => sept11, respond: dailyResponse });
  assert.equal((await coinRun(again)).spent, 0);
  assert.equal(coinPosts(again).length, 0);
  assert.equal(JSON.parse(rt.store.get(COIN)).count, 5);
});

test('coins: failed reservation never spends; failed commit retains the reservation', async () => {
  for (const failAt of [1, 2]) {
    let coinWrites = 0;
    const rt = runtime('Betty-Bilibili-Daily', { now: () => sept11, respond: dailyResponse, failStore: key => key === COIN && ++coinWrites === failAt });
    assert.ok((await coinRun(rt)).err);
    assert.equal(coinPosts(rt).length, failAt - 1);
    if (failAt === 2) {
      assert.equal(JSON.parse(rt.store.get(COIN)).pending, true);
      const again = runtime('Betty-Bilibili-Daily', { store: rt.store, now: () => sept11, respond: dailyResponse });
      await coinRun(again);assert.equal(coinPosts(again).length, 0);
    }
  }
});

test('coins: malformed/future records quarantine today then recover tomorrow', async () => {
  for (const value of ['{', 'null', '{"version":1,"day":"2999-01-01","count":0,"pending":false}', '{"version":1,"day":"2026-09-11","count":-1,"pending":false}']) {
    const store = new Map([[COIN, value]]);
    const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: dailyResponse });
    assert.ok((await coinRun(rt)).err);assert.equal(coinPosts(rt).length, 0);
    const next = runtime('Betty-Bilibili-Daily', { store, now: () => sept11 + 86400000, respond: dailyResponse });
    assert.equal((await coinRun(next)).spent, 5);
  }
});

test('coins: reservations are per UID and stop on missing live EXP', async () => {
  const store = new Map([[COIN, JSON.stringify({ version: 1, day: '2026-09-11', count: 5, pending: true })]]);
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: dailyResponse });
  const other = await rt.run("coins(['BV1234567890'],1,0,'84','csrf','cookie')");
  assert.equal(other.spent, 1);
  const unknown = runtime('Betty-Bilibili-Daily', { respond: (q, m) => q.url.includes('/coin/today/exp') ? null : dailyResponse(q, m) });
  assert.ok((await coinRun(unknown)).err);assert.equal(coinPosts(unknown).length, 0);
});

test('coins: balance and already-donated video limits remain enforced', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { respond: dailyResponse });
  const result = await rt.run("coins(['BV1234567890','BV1234567891','BV1234567892'],5,0,'42','csrf','cookie',2)");
  assert.equal(result.spent, 2);assert.equal(result.err.code, -104);
  for (const data of [{ multiply: 2 }, { multiply: null }, { multiply: false }]) {
    const capped = runtime('Betty-Bilibili-Daily', { respond: (q, m) => q.url.includes('/archive/coins') ? { code: 0, data } : dailyResponse(q, m) });
    await coinRun(capped);assert.equal(coinPosts(capped).length, 0);
  }
});

test('coins: known 34004 failures remain bounded and do not consume a successful slot', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { respond: (q, m) => dailyResponse(q, m, { post: { code: 34004 } }) });
  const result = await coinRun(rt);
  assert.equal(coinPosts(rt).length, 3);assert.equal(result.spent, 0);
  assert.equal(JSON.parse(rt.store.get(COIN)).count, 0);
  assert.equal(JSON.parse(rt.store.get(COIN)).pending, false);
});

test('daily: accepted coin writes with delayed EXP never claim task completion', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: dailyResponse });
  await rt.start();
  assert.equal(coinPosts(rt).length, 5);
  assert.match(rt.completions[0].content, /投币 0\/5/);
  assert.doesNotMatch(rt.completions[0].content, /今日任务已完成/);
  assert.match(rt.notices.at(-1)[2], /明确成功 5 枚.*经验待同步/);
  assert.match(rt.notices.at(-1)[2], /15\/65 → 15\/65/);
});

test('daily: zero balance is partial, and failed final nav never reuses the old balance', async () => {
  const empty = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => dailyResponse(q, m, { money: 0 }) });
  await empty.start();assert.match(empty.completions[0].content, /部分完成.*余额不足/);
  assert.equal(coinPosts(empty).length, 0);
  let navReads = 0;
  const final = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => q.url.endsWith('/nav') && ++navReads > 1 ? null : dailyResponse(q, m) });
  await final.start();assert.match(final.notices.at(-1)[2], /硬币余额 未知/);
});

test('daily: final daily-state failure cannot claim completion from an old snapshot', async () => {
  let reads = 0;
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => q.url.endsWith('/exp/reward') && ++reads > 2 ? null : dailyResponse(q, m, { exp: 50 }) });
  await rt.start();assert.match(rt.completions[0].content, /最终状态未确认/);
  assert.match(rt.notices.at(-1)[2], /不代表最终确认/);
});

test('daily: two official EXP sources use the higher confirmed count, not the stale lower one', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => q.url.includes('/coin/today/exp') ? { code: 0, data: 0 } : dailyResponse(q, m, { exp: 50 }) });
  await rt.start();assert.equal(coinPosts(rt).length, 0);
  assert.match(rt.completions[0].content, /投币 5\/5/);
  assert.match(rt.notices.at(-1)[2], /65\/65 → 65\/65/);
});

test('daily: VIP form carries the current device cookie; non-VIP avoids extra nav calls', async () => {
  for (const vip of [0, 1]) {
    const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => dailyResponse(q, m, { exp: 50, vip }) });
    await rt.start();
    const posts = rt.calls.filter(q => q.method === 'post');
    assert.equal(posts.length, vip);
    if (vip) assert.equal(new URLSearchParams(posts[0].body).get('buvid'), 'old-device');
    else assert.equal(rt.calls.filter(q => q.url.endsWith('/nav')).length, 2);
  }
});

for (const event of ['day', 'timeout', 'session', 'lock']) {
  test(`daily: ${event} change during requests stops subsequent writes and completes once`, async () => {
    let clock = sept11;
    const store = priorSession(true);
    const rt = runtime('Betty-Bilibili-Daily', { store, now: () => clock, respond: (q, m) => {
      if (q.url.includes('/view?')) {
        if (event === 'day') clock += 86400000;
        if (event === 'timeout') clock += 269000;
        if (event === 'session') store.set(SESSION, JSON.stringify({ version: 1, cookie: 'changed', meta: oldMeta }));
        if (event === 'lock') store.set(DAILY_LOCK, JSON.stringify({ owner: 'new-owner', expiresAt: clock + 60000 }));
      }
      return dailyResponse(q, m);
    } });
    await rt.start();assert.equal(coinPosts(rt).length, 0);
    assert.equal(rt.completions.length, 1);assert.match(rt.completions[0].content, /本轮已停止/);
    if (event === 'lock') { assert.equal(JSON.parse(store.get(DAILY_LOCK)).owner, 'new-owner');assert.equal(store.get(DAILY_STATE), undefined); }
    else assert.equal(store.get(DAILY_LOCK), '');
  });
}

test('daily: actual cron entry works without panel or trigger globals', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => dailyResponse(q, m, { exp: 50 }) });
  delete rt.context.$input;delete rt.context.$trigger;
  await rt.start();assert.equal(rt.completions.length, 1);assert.equal(rt.completions[0], undefined);
  assert.match(rt.store.get(DAILY_STATE), /今日任务已完成/);
});

test('daily: unknown panel trigger is local and a duplicate click cannot overwrite the saved result', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => dailyResponse(q, m, { exp: 50 }) });
  await rt.start();const saved = rt.store.get(DAILY_STATE);
  rt.store.set(DAILY_LOCK, JSON.stringify({ owner: 'other', expiresAt: Date.now() + 60000 }));
  const busy = runtime('Betty-Bilibili-Daily', { store: rt.store });await busy.start();
  assert.equal(rt.store.get(DAILY_STATE), saved);assert.equal(busy.calls.length, 0);
  const automatic = runtime('Betty-Bilibili-Daily', { store: rt.store });delete automatic.context.$trigger;
  await automatic.start();assert.equal(automatic.calls.length, 0);assert.equal(rt.store.get(DAILY_STATE), saved);
});

test('daily: yesterday cache expires at Beijing midnight with no automatic network traffic', async () => {
  const store = priorSession(true);
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: (q, m) => dailyResponse(q, m, { exp: 50 }) });
  await rt.start();assert.match(store.get(DAILY_STATE), /今日任务已完成/);
  const next = runtime('Betty-Bilibili-Daily', { store, now: () => sept11 + 86400000, trigger: 'auto-interval' });
  await next.start();assert.equal(next.calls.length, 0);
  assert.doesNotMatch(next.completions[0].content, /今日任务已完成/);
  assert.match(next.completions[0].content, /2026-09-12/);
});

test('daily: malformed numeric API values cannot masquerade as valid zero', () => {
  const rt = runtime('Betty-Bilibili-Daily');
  for (const value of ['false', 'true', '[]', '{}', '" "', 'null']) assert.equal(rt.run(`num(${value})`), null);
  assert.equal(rt.run('coinCount(5)'), null);
});

test('daily: full watch/VIP/share/coin run completes only after official accounting', async () => {
  let heartbeats = 0, watched = false, shared = false, vipClaimed = false, exp = 0;
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), now: () => sept11, respond: (q, m) => {
    if (m === 'post') {
      if (q.url.includes('/heartbeat')) watched = ++heartbeats >= 2;
      else if (q.url.endsWith('/experience/add')) { assert.ok(watched);vipClaimed = true; }
      else if (q.url.endsWith('/share/add')) shared = true;
      else if (q.url.endsWith('/coin/add')) { assert.equal(JSON.parse(rt.store.get(COIN)).pending, true);exp += 10; }
      else assert.fail('Unexpected task write');
      return { code: 0 };
    }
    if (q.url.endsWith('/nav')) return { code: 0, data: { ...navOK(10 - exp / 10, 1).data, level_info: { current_exp: 100 + exp + (watched ? 5 : 0) + (shared ? 5 : 0) + (vipClaimed ? 10 : 0) } } };
    return dailyResponse(q, m, { exp, watch: watched, share: shared });
  } });
  await rt.start();
  assert.equal(coinPosts(rt).length, 5);assert.equal(heartbeats, 2);
  assert.match(rt.completions[0].content, /今日任务已完成.*投币 5\/5.*大会员经验✅/);
  assert.match(rt.notices.at(-1)[2], /账号等级经验 100 → 170/);
  assert.match(rt.notices.at(-1)[2], /硬币余额 5/);
  assert.ok(rt.calls.every(q => q['auto-cookie'] === false && q['auto-redirect'] === false && !q.policy));
});

test('daily: cached completion is invalidated when the login tool changes accounts', async () => {
  const store = priorSession(true);
  const rt = runtime('Betty-Bilibili-Daily', { store, respond: (q, m) => dailyResponse(q, m, { exp: 50 }) });
  await rt.start();
  store.set(SESSION, JSON.stringify({ version: 1, cookie: oldCookie.replace('DedeUserID=42', 'DedeUserID=84'), meta: { ...oldMeta, uid: '84' } }));
  const auto = runtime('Betty-Bilibili-Daily', { store, trigger: 'auto-interval' });
  await auto.start();assert.equal(auto.calls.length, 0);
  assert.doesNotMatch(auto.completions[0].content, /今日任务已完成/);
});

test('daily: exhausted time budget before coin POST does not reserve an unsent coin', async () => {
  let clock = sept11;
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), now: () => clock, respond: (q, m) => {
    if (q.url.includes('/archive/coins')) clock += 269000;
    return dailyResponse(q, m);
  } });
  await rt.start();assert.equal(coinPosts(rt).length, 0);assert.equal(rt.store.has(COIN), false);
  assert.match(rt.completions[0].content, /运行时间上限/);
});

test('share: a feed archive is shared directly without playback details or ranking', async () => {
  let shared = false;
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => {
    if (q.url.includes('/ranking/') || q.url.includes('/view?')) assert.fail('Sharing must not require ranking or playback details');
    if (m === 'post') { assert.ok(q.url.endsWith('/share/add'));shared = true;return { code: 0 }; }
    if (q.url.includes('/feed/all')) return { code: 0, data: { items: [{ modules: { module_dynamic: { major: { archive: { bvid: video.bvid, aid: '123' } } } } }] } };
    return dailyResponse(q, m, { exp: 50, money: 0, share: shared });
  } });
  await rt.start();assert.match(rt.completions[0].content, /今日任务已完成/);
  const posts = rt.calls.filter(q => q.method === 'post');assert.equal(posts.length, 1);
  assert.equal(new URLSearchParams(posts[0].body).get('aid'), '123');
});

test('share: coin candidate expansion cannot prevent an earlier eligible share', async () => {
  let shared = false;
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => {
    if (q.url.includes('/ranking/')) { assert.ok(shared);return { code: -412 }; }
    if (m === 'post') { assert.ok(q.url.endsWith('/share/add'));shared = true;return { code: 0 }; }
    if (q.url.includes('/feed/all')) return { code: 0, data: { items: [{ modules: { module_dynamic: { major: { archive: { bvid: video.bvid, aid: '123' } } } } }] } };
    return dailyResponse(q, m, { share: shared });
  } });
  await rt.start();assert.ok(shared);assert.equal(coinPosts(rt).length, 0);
  assert.equal(JSON.parse(rt.store.get(SH)).confirmed, true);
});

for (const viewReply of [{ code: 0, data: { aid: 123 } }, null, { code: -403 }, http(503, '')]) {
  test(`share: missing CID or unavailable view does not block a valid archive: ${JSON.stringify(viewReply)}`, async () => {
    let shared = false;
    const rt = runtime('Betty-Bilibili-Daily', { respond: (q, m) => {
      if (q.url.includes('/view?')) return viewReply;
      if (m === 'post') { shared = true;return { code: 0 }; }
      return state(shared);
    } });
    assert.equal(await rt.run("share(['BV1234567890'],null,'42','csrf-fixture','cookie-fixture')"), null);
    const posts = rt.calls.filter(q => q.method === 'post');assert.equal(posts.length, 1);
    const form = new URLSearchParams(posts[0].body);
    assert.equal(form.get('source'), 'pc_client_normal');assert.equal(form.has('cid'), false);
    if (viewReply?.code === 0) assert.equal(form.get('aid'), '123');
    else { assert.equal(form.get('bvid'), video.bvid);assert.equal(form.has('aid'), false); }
  });
}

test('share: deleted archive is skipped before consuming the daily POST', async () => {
  let shared = false;
  const rt = runtime('Betty-Bilibili-Daily', { respond: (q, m) => {
    if (q.url.includes('/view?')) return q.url.includes('BV1234567890') ? { code: -404 } : { code: 0, data: { aid: 987 } };
    if (m === 'post') { assert.equal(new URLSearchParams(q.body).get('aid'), '987');shared = true;return { code: 0 }; }
    return state(shared);
  } });
  assert.equal(await rt.run("share(['BV1234567890','BV0987654321'],null,'42','csrf','cookie')"), null);
  assert.equal(rt.calls.filter(q => q.method === 'post').length, 1);
});

test('share: delayed accounting after twelve seconds succeeds without repeating POST', async () => {
  let clock = sept11, postedAt = null;
  const rt = runtime('Betty-Bilibili-Daily', { now: () => clock, onSleep: ms => { clock += ms; }, respond: (q, m) => {
    if (m === 'post') { postedAt = clock;return { code: 0 }; }
    return state(postedAt !== null && clock - postedAt >= 12000);
  } });
  assert.equal(await shareRun(rt), null);
  assert.equal(rt.calls.filter(q => q.method === 'post').length, 1);
  assert.equal(JSON.parse(rt.store.get(SH)).confirmed, true);
  assert.ok(clock - postedAt < 20000);
});

test('share: 71000 waits for official completion; it is never success by itself', async () => {
  const noCredit = runtime('Betty-Bilibili-Daily', { respond: (q, m) => m === 'post' ? { code: 71000 } : state(false) });
  const pending = await shareRun(noCredit);assert.equal(pending.pending, true);
  let reads = 0;
  const credited = runtime('Betty-Bilibili-Daily', { respond: (q, m) => m === 'post' ? { code: 71000 } : state(++reads >= 4) });
  assert.equal(await shareRun(credited), null);
  assert.equal(credited.calls.filter(q => q.method === 'post').length, 1);
});

test('share: a confirmed official state is not erased by a later stale false response', async () => {
  let reads = 0;
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => {
    if (q.url.endsWith('/exp/reward')) return state(++reads === 4);
    return dailyResponse(q, m, { exp: 50, share: false });
  } });
  await rt.start();assert.match(rt.completions[0].content, /今日任务已完成/);
  assert.equal(JSON.parse(rt.store.get(SH)).confirmed, true);
  const again = runtime('Betty-Bilibili-Daily', { store: rt.store, respond: () => state(false) });
  assert.equal(await shareRun(again), null);assert.equal(again.calls.filter(q => q.method === 'post').length, 0);
});

test('share: pending delivery is visible and later refresh only confirms the existing attempt', async () => {
  const rt = runtime('Betty-Bilibili-Daily', { store: priorSession(true), respond: (q, m) => dailyResponse(q, m, { exp: 50, share: false }) });
  await rt.start();assert.match(rt.completions[0].content, /分享待确认/);
  assert.match(rt.notices.at(-1)[2], /分享 ⏳ 待确认/);
  const again = runtime('Betty-Bilibili-Daily', { store: rt.store, respond: () => state(true) });
  assert.equal(await shareRun(again), null);assert.equal(again.calls.filter(q => q.method === 'post').length, 0);
});

test('share recovery: screenshot-era explicit rejection permits one manual retry and confirms real state', async () => {
  const store = new Map([[SH, JSON.stringify({ version: 2, day: '2026-09-11', code: -403, requestSucceeded: false, confirmed: false })]]);
  let shared = false;
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: (_, method) => {
    if (method === 'post') { assert.equal(JSON.parse(store.get(SH)).tries, 2);shared = true;return { code: 0 }; }
    return state(shared);
  } });
  assert.equal(await shareRun(rt), null);
  await shareRun(rt);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 1);
  assert.equal(JSON.parse(store.get(SH)).confirmed, true);
});

test('share recovery: one minute cooldown and durable two-request limit survive restarts', async () => {
  let clock = sept11;
  const store = new Map();
  const options = { store, now: () => clock, respond: (_, method) => method === 'post' ? { code: -403, message: '账号异常,操作失败' } : state(false) };
  const first = runtime('Betty-Bilibili-Daily', options);
  assert.match((await shareRun(first)).detail, /本轮已提交.*HTTP 200/);
  const early = runtime('Betty-Bilibili-Daily', options);
  assert.match((await shareRun(early)).detail, /历史失败，本轮未提交/);
  assert.equal(early.calls.filter(x => x.method === 'post').length, 0);
  clock += 60001;
  const retry = runtime('Betty-Bilibili-Daily', options);
  assert.match((await shareRun(retry)).message, /今日不再提交/);
  assert.equal(retry.calls.filter(x => x.method === 'post').length, 1);
  clock += 60001;
  const exhausted = runtime('Betty-Bilibili-Daily', options);
  const result = await shareRun(exhausted);
  assert.match(result.detail, /历史失败，本轮未提交.*12:01:00.*HTTP 200/);
  assert.match(result.detail, /账号异常,操作失败/);
  assert.equal(exhausted.calls.filter(x => x.method === 'post').length, 0);
  assert.equal(JSON.parse(store.get(SH)).tries, 2);
});

for (const reply of [null, { code: 0 }, { code: 71000 }, http(403, { code: -403 }), http(500, { code: -403 }), { code: -412 }]) {
  test(`share recovery: no manual retry for uncertain, accepted, HTTP or risk response ${JSON.stringify(reply)}`, async () => {
    let clock = sept11;
    const first = runtime('Betty-Bilibili-Daily', { now: () => clock, respond: (_, method) => method === 'post' ? reply : state(false) });
    await shareRun(first);clock += 60001;
    const later = runtime('Betty-Bilibili-Daily', { store: first.store, now: () => clock, respond: () => state(false) });
    await shareRun(later);
    assert.equal(later.calls.filter(x => x.method === 'post').length, 0);
  });
}

test('share recovery: response persistence failure leaves an uncertain reservation, never a retryable rejection', async () => {
  let records = 0, clock = sept11;
  const first = runtime('Betty-Bilibili-Daily', { now: () => clock, failStore: key => key === SH && ++records === 2, respond: (_, m) => m === 'post' ? { code: -403 } : state(false) });
  await shareRun(first);clock += 60001;
  const next = runtime('Betty-Bilibili-Daily', { store: first.store, now: () => clock, respond: () => state(false) });
  await shareRun(next);assert.equal(next.calls.filter(x => x.method === 'post').length, 0);
});

test('share recovery: manual retry reservation failure never sends a second request', async () => {
  const store = new Map([[SH, JSON.stringify({ version: 2, day: '2026-09-11', code: -403, requestSucceeded: false, confirmed: false })]]);
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, failStore: true, respond: () => state(false) });
  assert.match((await shareRun(rt)).message, /无法保存/);
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 0);
});

test('share recovery: diagnostic message hides credentials before persistence and notification', async () => {
  const cookie = 'SESSDATA=private-session-value; bili_jct=private-csrf-value; DedeUserID=42; buvid3=private-device-value';
  const rt = runtime('Betty-Bilibili-Daily', { now: () => sept11, respond: (_, m) => m === 'post' ? { code: -403, message: `拒绝 ${cookie} https://example.com/?key=hidden` } : state(false) });
  rt.context.fixtureVideo = video;rt.context.fixtureCookie = cookie;
  const result = await rt.run("share([],fixtureVideo,'42','private-csrf-value',fixtureCookie)");
  const serialized = JSON.stringify(result) + rt.store.get(SH);
  for (const secret of ['private-session-value', 'private-csrf-value', 'private-device-value', 'example.com']) assert.ok(!serialized.includes(secret));
  assert.match(result.detail, /HTTP 200/);
  assert.match(result.detail, /已隐藏/);
});

test('share recovery: normal entry migrates saved -403 and surfaces a new rejection instead of the old count message', async () => {
  const store = priorSession(true);
  store.set(SH, JSON.stringify({ version: 2, day: '2026-09-11', code: -403, requestSucceeded: false, confirmed: false }));
  const rt = runtime('Betty-Bilibili-Daily', { store, now: () => sept11, respond: (q, m) => dailyResponse(q, m, { exp: 10, money: 0, share: false, post: { code: -403, message: '访问权限不足' } }) });
  await rt.start();
  assert.equal(rt.calls.filter(x => x.method === 'post').length, 1);
  assert.equal(coinPosts(rt).length, 0);
  assert.match(rt.notices[0][2], /本轮已提交.*HTTP 200/);
  assert.match(rt.notices[0][2], /服务端信息：访问权限不足/);
  assert.ok(!rt.notices[0][2].includes('写入次数已用尽'));
  assert.equal(store.get(CK), oldCookie);
});
