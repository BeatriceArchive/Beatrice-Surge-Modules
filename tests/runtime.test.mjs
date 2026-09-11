import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function runtime(name, { store = new Map(), respond = () => ({ code: 0 }), trigger = 'button', failStore = false } = {}) {
  const calls = [], notices = [];
  const context = vm.createContext({
    console: { log() {} }, Date, Math, URL, Uint8Array, ArrayBuffer,
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    $input: { purpose: 'panel' }, $trigger: trigger, $argument: '',
    $persistentStore: { read: k => store.get(k) || '', write: (v, k) => { if (failStore) return false; store.set(k, v); return true; } },
    $notification: { post: (...args) => notices.push(args) }, $done() {},
    $httpClient: Object.fromEntries(['get', 'post'].map(method => [method, (options, cb) => {
      calls.push({ method, ...options });
      const result = respond(options, method, calls.length);
      if (result === null) cb('timeout', null, null);
      else cb(null, { status: 200, headers: {} }, JSON.stringify(result));
    }]))
  });
  // Suppress only the entry invocation; exercise the actual production functions.
  let source = readFileSync(new URL(`../Scripts/${name}.js`, import.meta.url), 'utf8');
  if (name === 'Betty-Basic-Panel') source = source.replace('main().catch(', 'Promise.resolve().catch(');
  else source = source.replace(/main\(\)\.finally\(\(\)=>\{.*?\}\);/, '');
  vm.runInContext(source, context);
  return { context, calls, notices, store, run: code => vm.runInContext(code, context) };
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
  assert.equal(new URLSearchParams(sent.body).get('aid'), '123');
  assert.equal(new URLSearchParams(sent.body).get('csrf'), 'csrf-fixture');
  assert.equal(sent.headers.Origin, 'https://www.bilibili.com');
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
