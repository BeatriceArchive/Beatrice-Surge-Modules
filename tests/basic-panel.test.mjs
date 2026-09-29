import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../Scripts/Betty-Basic-Panel.js', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 8, 11, 12);
const IP = '8.8.4.4', OTHER = '1.1.1.1';
const INTEL = 'betty.basic.intel.v2', SPEED = 'betty.basic.speed';
const trace = (ip = IP) => 'fl=fixture\nip=' + ip + '\nloc=HK\n';
const geo = () => ({ country: 'Hong Kong', country_code: 'hk', region: 'Hong Kong', city: 'Kowloon', isp: 'Example Networks' });
const lookup = (ip = IP, fields = {}) => ({ ip, country: 'Hong Kong', countryCode: 'hk', region: 'Hong Kong', city: 'Kowloon',
  asn: 15169, asOrganization: 'Example Networks', isp: 'Example ISP', company_name: 'Example Company',
  company_type: 'hosting', trust_score: 85, isResidential: false, is_datacenter: true,
  is_vpn: true, is_proxy: false, is_tor: false, is_abuser: false, is_mobile: false, is_crawler: false, ...fields });
const reply = (body, status = 200, headers = {}, delay = 10) => ({ body, status, headers, delay });

function defaultReply(q) {
  const u = new URL(q.url);
  if (u.hostname === 'ip.net.coffee') {
    if (u.pathname === '/cdn-cgi/trace') return reply(trace());
    if (u.pathname.startsWith('/api/ip/lookup/')) return reply(lookup(decodeURIComponent(u.pathname.slice('/api/ip/lookup/'.length))));
    if (u.pathname.startsWith('/api/geoip/')) return reply(geo());
    throw new Error('unexpected intelligence endpoint');
  }
  if (u.hostname === 'www.netflix.com') return reply('<title>Netflix</title><link href="https://www.netflix.com/hk/title/81280792"><script>{"countryCode":"HK"}</script>');
  if (u.hostname === 'www.youtube.com') return reply('<title>YouTube Premium</title>');
  if (u.pathname === '/generate_204') return reply('', 204);
  return reply('');
}

// Deterministic wall clock; preserves overlapping requests and the JSC timer limit.
// There is deliberately no clearTimeout, browser URL, fetch, eval wrapper or Function
// in the production runtime. The runner itself evaluates trusted local source with vm.
function runtime({ respond = defaultReply, trigger = 'auto-interval', argument = '', store = new Map(),
  network = { wifi: { ssid: 'Test Wi-Fi' }, v4: { primaryAddress: '192.168.1.8' }, dns: ['1.1.1.1'] },
  apiReply = () => ({ profile: '[General]\nipv6=false\nipv6-vif=disabled' }),
  speedMbps = 100, streamMbps = Infinity, latency = 20, callbackDelay = 0, bodyLimit = Infinity, failSpeed = false, clockStart = NOW, failStore = false, speedReply = () => undefined } = {}) {
  let clock = clockStart, sequence = 0, wireFree = clock, active = 0, activeSpeed = 0;
  const events = [], calls = [], apiCalls = [], writes = [], logs = [], done = [];
  const stats = { peak: 0, peakSpeed: 0, peakTimers: 0 };
  function schedule(fn, delay, type) {
    events.push({ id: ++sequence, at: clock + Math.max(0, delay), fn, type });
    stats.peakTimers = Math.max(stats.peakTimers, events.filter(e => e.type === 'timer').length);
    assert.ok(stats.peakTimers <= 64, 'JSC has a 64 pending timer limit');
    return sequence;
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const client = Object.fromEntries(['get', 'head', 'post'].map(method => [method, (options, callback) => {
    const q = { method, ...options, time: clock }; calls.push(q);
    const u = new URL(q.url), speed = u.pathname === '/__down';
    active++; stats.peak = Math.max(stats.peak, active);
    if (speed) { activeSpeed++; stats.peakSpeed = Math.max(stats.peakSpeed, activeSpeed); }
    let r;
    if (speed) {
      const size = Number(u.searchParams.get('bytes'));
      r = speedReply(q, size);
      if (r !== undefined) { /* targeted transport fixtures */ }
      else if (failSpeed === 'hang') return;
      else if (failSpeed) r = { error: 'fixture failure', delay: 10 };
      else if (size > bodyLimit) r = { error: 'Response body exceeds size limit', delay: latency };
      else {
        wireFree = Math.max(clock + latency, wireFree) + size * 8 / speedMbps / 1000;
        r = { body: { byteLength: size }, status: 200, delay: Math.max(wireFree - clock, latency + size * 8 / streamMbps / 1000) + callbackDelay };
      }
    } else r = respond(q);
    if (r === 'hang') return;
    if (r === null) r = { error: 'network timeout', delay: 10 };
    schedule(() => {
      active--; if (speed) activeSpeed--;
      callback(r.error || null, r.error && !r.responseOnError ? null : { status: r.status ?? 200, headers: r.headers || {} },
        speed ? r.body : typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
      if (r.duplicate) callback('private duplicate failure', { status: 503, headers: {} }, null);
    }, r.delay ?? 10, 'network');
  }]));
  const context = vm.createContext({
    Date: Clock, Math, Uint8Array, ArrayBuffer, console: { log: (...args) => logs.push(args) },
    setTimeout: (fn, ms) => schedule(fn, ms, 'timer'),
    $network: network, $trigger: trigger, $input: { purpose: 'panel', panelName: '贝蒂的基础面板' }, $argument: argument,
    $persistentStore: { read: k => { if (failStore === 'throw') throw new Error('store unavailable'); return store.get(k) || ''; }, write: (v, k) => {
      if (failStore === 'throw') throw new Error('store unavailable');
      if (failStore) return false; store.set(k, v); writes.push({ key: k, value: v }); return true;
    } },
    $httpClient: client,
    $httpAPI: (method, path, body, cb) => {
      apiCalls.push({ method, path, body }); const response = apiReply(path, body);
      if (response !== 'hang') schedule(() => cb(response), 25, 'api');
    },
    $utils: { geoip: () => '', ipasn: () => null, ipaso: () => '' },
    $done: value => done.push(value), $notification: { post: (...args) => logs.push(args) }
  });
  vm.runInContext(SOURCE.replace('main().catch(', 'Promise.resolve().catch('), context);
  async function run(code) {
    let result, error, finished = false;
    Promise.resolve(vm.runInContext(code, context)).then(v => { result = v; finished = true; }, e => { error = e; finished = true; });
    for (let i = 0; i < 20000 && !finished; i++) {
      for (let n = 0; n < 25; n++) await Promise.resolve();
      if (finished) break;
      events.sort((a, b) => a.at - b.at || a.id - b.id);
      assert.ok(events.length, 'unresolved operation must have a callback or watchdog');
      const event = events.shift(); clock = event.at; event.fn();
    }
    assert.ok(finished, 'operation terminates'); if (error) throw error; return result;
  }
  return { context, run, calls, apiCalls, store, writes, logs, done, stats, now: () => clock };
}

for (const [status, state] of [[200, 'reachable'], [302, 'reachable'], [401, 'restricted'], [403, 'restricted'], [429, 'restricted'], [405, 'unknown'], [500, 'error']]) test(`AI/site: HTTP ${status} means ${state}, not full availability`, async () => {
  const rt = runtime({ respond: () => reply('', status) });
  const result = await rt.run("testAIReachable('https://chatgpt.com/','')");
  assert.equal(result.state, state); assert.doesNotMatch(result.label, /✓|完整|解锁/);
  assert.equal(rt.calls.length, 1); assert.equal(rt.calls[0].method, 'head'); assert.equal(rt.calls[0]['auto-redirect'], false);
});

test('AI/site: network timeout is unreachable', async () => {
  const rt = runtime({ respond: () => null }); assert.equal((await rt.run("testAIReachable('https://claude.ai/','')")).state, 'unreachable');
});

const METHOD_FALLBACK_SITES = ['www.primevideo.com', 'www.tiktok.com'];
for (const host of METHOD_FALLBACK_SITES) {
  for (const status of [200, 301, 401, 403, 429, 451, 500]) test(`${host}: HEAD ${status} needs no GET`, async () => {
    const rt = runtime({ respond: () => reply('', status, { location: 'https://other.invalid/login' }) });
    const result = await rt.run(`testServiceReachable('https://${host}/','')`);
    assert.equal(rt.calls.length, 1); assert.equal(rt.calls[0].method, 'head');
    assert.equal(result.state, status < 400 ? 'reachable' : status === 500 ? 'error' : 'restricted');
    assert.doesNotMatch(result.label, /GET|地区受限|解锁/);
  });
  for (const status of [405, 501]) test(`${host}: HEAD ${status} gets exactly one same-entry GET`, async () => {
    const rt = runtime({ respond: q => reply('', q.method === 'head' ? status : 200) });
    const result = await rt.run(`testServiceReachable('https://${host}/','Test Policy')`);
    assert.equal(result.label, '可达');
    assert.deepEqual(rt.calls.map(q => q.method), ['head', 'get']);
    assert.ok(rt.calls.every(q => q.url === `https://${host}/` && q.policy === 'Test Policy'));
    assert.equal(rt.calls[1].timeout, 4);
  });
  for (const [status, state] of [[200, 'reachable'], [307, 'reachable'], [403, 'restricted'], [451, 'restricted'], [405, 'unknown'], [501, 'error'], [503, 'error']]) test(`${host}: fallback GET ${status} uses actual evidence without retry or redirect`, async () => {
    const rt = runtime({ respond: q => reply('', q.method === 'head' ? 405 : status, { location: '/region/fe/', 'Set-Cookie': 'session=must-not-send' }) });
    const result = await rt.run(`testServiceReachable('https://${host}/','')`);
    assert.equal(result.state, state);
    if (state === 'reachable') assert.doesNotMatch(result.label, /GET/);
    else assert.match(result.label, new RegExp(`GET ${status}`));
    if (state === 'restricted') assert.match(result.label, new RegExp(`受限 ${status}`));
    assert.equal(rt.calls.length, 2);
    assert.ok(rt.calls.every(q => q['auto-redirect'] === false && q['auto-cookie'] === false));
    for (const q of rt.calls) assert.ok(Object.keys(q.headers).every(k => !/^(cookie|authorization)$/i.test(k)));
    assert.doesNotMatch(result.label, /地区受限|解锁|✓/);
  });
  for (const failure of [null, 'hang', { status: 200, error: 'fixture transport failure', responseOnError: true }]) test(`${host}: GET ${failure === 'hang' ? 'missing callback' : failure ? 'partial 200 with error' : 'network failure'} cannot be green`, async () => {
    const rt = runtime({ respond: q => q.method === 'head' ? reply('', 405) : failure });
    const result = await rt.run(`testServiceReachable('https://${host}/','')`);
    assert.equal(result.state, 'unreachable'); assert.equal(rt.calls.length, 2);
    assert.match(result.label, failure && failure !== 'hang' ? /GET 200\/传输失败/ : /GET 超时/);
    assert.ok(rt.now() - NOW <= 6010, 'GET fallback callback/watchdog is bounded');
  });
}

for (const failure of [reply('', 0), null, 'hang', { error: 'HEAD unsupported', status: 200, responseOnError: true }]) test(`TikTok: HEAD ${failure === 'hang' ? 'missing callback' : failure?.status === 0 ? 'status zero' : 'transport failure'} may use one GET`, async () => {
  const rt = runtime({ respond: q => q.method === 'head' ? failure : reply('', 200) });
  assert.equal((await rt.run("testServiceReachable('https://www.tiktok.com/','')")).label, '可达');
  assert.deepEqual(rt.calls.map(q => q.method), ['head', 'get']);
});

test('TikTok: an explicit restriction with a transport error must not trigger another request', async () => {
  const rt = runtime({ respond: () => ({ status: 403, error: 'fixture failure', responseOnError: true }) });
  const result = await rt.run("testServiceReachable('https://www.tiktok.com/','')");
  assert.notEqual(result.state, 'reachable'); assert.equal(rt.calls.length, 1);
});

test('website fallback: other services remain HEAD-only including method errors and network failure', async () => {
  const urls = ['https://www.disneyplus.com/', 'https://open.spotify.com/', 'https://chatgpt.com/',
    'https://claude.ai/', 'https://gemini.google.com/', 'https://chat.deepseek.com/', 'https://grok.com/', 'https://www.perplexity.ai/'];
  for (const response of [reply('', 405), reply('', 501), null]) {
    const rt = runtime({ respond: () => response });
    await rt.run(`Promise.all(${JSON.stringify(urls)}.map(function (url) { return testServiceReachable(url, ''); }))`);
    assert.equal(rt.calls.length, urls.length); assert.ok(rt.calls.every(q => q.method === 'head'));
  }
  const prime = runtime({ respond: () => null });
  await prime.run("testServiceReachable('https://www.primevideo.com/','')");
  assert.equal(prime.calls.length, 1, 'Prime transport errors alone do not broaden its fallback');
});

test('website fallback: default routing stays optional and raw body/errors never leak', async () => {
  const secret = 'https://private.invalid/sub?token=SECRET Cookie=SECRET Authorization=SECRET';
  const rt = runtime({ respond: q => q.method === 'head' ? reply('', 405, { 'Set-Cookie': secret }) :
    { body: secret, error: secret, status: 200, responseOnError: true } });
  const result = await rt.run("testServiceReachable('https://www.tiktok.com/','')");
  assert.ok(rt.calls.every(q => !('policy' in q) && !('body' in q)));
  assert.doesNotMatch(JSON.stringify([result, rt.logs, rt.writes, rt.calls]), /SECRET|private\.invalid/);
});

for (const state of ['reachable', 'restricted', 'unreachable', 'unknown', 'error']) test(`streaming summary: ${state} is counted without hiding failed checks`, async () => {
  const rt = runtime();
  const items = Array.from({ length: 6 }, (_, i) => ({ name: `Service ${i}`, state: i < 4 ? 'reachable' : state, label: state }));
  const lines = await rt.run(`(function () { const lines = []; appendServiceLines(lines, '🎬 流媒体', ${JSON.stringify(items)}); return lines; })()`);
  assert.match(lines[1], new RegExp(`流媒体 ${state === 'reachable' ? 6 : 4}/6`));
  if (state !== 'reachable') assert.match(lines[1], new RegExp(`${{ restricted: '受限', unreachable: '不达', unknown: '未知', error: '异常' }[state]} 2`));
  assert.doesNotMatch(lines[1], /受限 0|不达 0|未知 0/);
  assert.equal(lines.length, 4, 'one summary and two rows of three services');
});

test('website fallback: auto refresh adds at most two GETs, does not speed test or change Geo/reputation', async () => {
  const store = new Map();
  const rt = runtime({ store, respond: q => METHOD_FALLBACK_SITES.some(host => q.url === `https://${host}/`) ? reply('', q.method === 'head' ? 405 : 403) : defaultReply(q) });
  await rt.run('main()');
  assert.equal(rt.calls.length, 18); assert.ok(rt.stats.peak <= 16);
  assert.equal(rt.calls.filter(q => q.url.includes('/__down')).length, 0);
  assert.match(rt.done[0].content, /流媒体 4\/6 · 受限 2/);
  assert.match(rt.done[0].content, /Net\.Coffee/);
  assert.match(rt.done[0].content, /Trust 85\/100/);
  assert.match(rt.done[0].content, /TikTok GET 403/);
  assert.doesNotMatch(rt.done[0].content, /地区受限/);
  const next = runtime({ store, clockStart: NOW + 60000, respond: q => METHOD_FALLBACK_SITES.some(host => q.url === `https://${host}/`) ? reply('', q.method === 'head' ? 405 : 200) : defaultReply(q) });
  await next.run('main()'); assert.equal(next.calls.length, 17);
  assert.match(next.done[0].content, /TikTok ✓/, 'HK Geo alone must not force restriction');
});

test('Netflix: full regional title-page evidence still does not claim playback unlock', async () => {
  const rt = runtime(); const result = await rt.run("testNetflix('')");
  assert.equal(result.label, '样片可达 香港'); assert.doesNotMatch(result.label, /解锁|完整/);
});

test('Netflix: only fallback title available is limited, not full', async () => {
  const rt = runtime({ respond: q => q.url.includes('81280792') ? reply('', 404) : reply('<title>Netflix</title><a href="/title/80018499">Title</a>') });
  const result = await rt.run("testNetflix('')"); assert.equal(result.limited, true); assert.equal(result.state, 'restricted');
});

test('Netflix: redirects are bounded and an external login/WAF page is never full evidence', async () => {
  const rt = runtime({ respond: () => reply('', 302, { location: 'https://other.invalid/title/81280792' }) });
  assert.equal((await rt.run("testNetflix('')")).label, '可达'); assert.equal(rt.calls.length, 1);
  const loop = runtime({ respond: () => reply('', 302, { location: '/hk/title/81280792' }) });
  await loop.run("testNetflix('')"); assert.equal(loop.calls.length, 3);
});

for (const [body, label] of [
  ['Premium is not available in your country', '可达 · Premium 受限'],
  ['<title>YouTube Premium</title>', '可达'],
  ['{"ypcOffers":[{"ypcOfferId":"fixture-offer"}]}', 'Premium 报价可见']
]) test(`YouTube: ${label} requires the corresponding content`, async () => {
  const rt = runtime({ respond: () => reply(body) });
  assert.equal((await rt.run("testYouTubePremium('')")).label, label);
});

test('IPv6: local address and profile declaration never imply effective VIF or IPv6 egress', async () => {
  const rt = runtime({ network: { v4: { primaryAddress: IP }, v6: { primaryAddress: '2001:db8::1' } } });
  await rt.run('main()'); const text = rt.done[0].content;
  assert.match(text, /IPv6 本地/); assert.doesNotMatch(text, /VIF|出口未测|IPv6 出口 ✓/);
  assert.doesNotMatch(text, /IPv6 ✓|VIF 关闭|IPv6 已启用/);
  assert.match(await rt.run("formatIPv6('','2001:4860:4860::8888')"), /IPv6 出口 ✓/);
});

test('IP validation: equivalent IPv6 matches; malformed IP, loopback and local addresses cannot be sent as public queries', async () => {
  const rt = runtime();
  for (const ip of [':::', '1::2::3', '999.1.1.1', '1..2.3', '8.8.8.8/24', 'token.example', '127.0.0.1', '192.168.1.1', '100.64.1.1', 'fe80::1']) assert.equal(await rt.run(`isPublicIP(${JSON.stringify(ip)})`), false, ip);
  assert.equal(await rt.run("normalizeIP('2001:0db8:0:0:0:0:0:1')"), '2001:db8::1');
});

test('DNS/NAT: exact resolver identity and inference only; unknown delay is not 0ms', async () => {
  const rt = runtime();
  assert.equal(await rt.run("detectDNS(['11.1.1.10'])"), '自定义');
  assert.equal(await rt.run("detectDNS(['1.1.1.1','8.8.8.8'])"), 'Cloudflare/Google');
  assert.equal(await rt.run("inferNAT('100.64.2.3')"), 'CGNAT 候选');
  assert.equal(await rt.run("inferNAT('192.168.1.3')"), 'NAT 推断');
  assert.equal(await rt.run("inferNAT('')"), 'NAT 未测');
  assert.equal(await rt.run('fmtMs(null)'), '未知');
  for (const delay of [0.002, 5, 25]) {
    const r = runtime({ apiReply: () => ({ delay }) }); assert.equal(await r.run('getDNSDelay()'), 25, 'observed API wall time, no guessed unit');
  }
});

for (const trigger of ['auto-interval', 'editor', 'http-api', 'intent', '', undefined]) test(`speed: ${String(trigger)} cannot download`, async () => {
  const rt = runtime({ trigger }); await rt.run("getSpeedForThisRun('', '8.8.4.4')"); assert.equal(rt.calls.length, 0);
});

for (const [speedMbps, mode] of [[25, '多流采样'], [200, '多流采样'], [500, '多流采样']]) test(`speed: adaptive ${speedMbps} Mbps path is bounded and never exceeds link capacity`, async () => {
  const rt = runtime({ trigger: 'button', speedMbps });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.ok(result && result.mbps > 0, JSON.stringify(result)); assert.equal(result.mode, mode);
  assert.ok(result.mbps <= speedMbps * 1.001); assert.ok(result.mbps > speedMbps * 0.5, 'avoid gross underestimate on controlled link');
  assert.ok(rt.now() - NOW <= 8000); assert.ok(rt.stats.peakSpeed <= 3);
  const downloads = rt.calls.filter(q => q.url.includes('/__down'));
  const total = downloads.reduce((n, q) => n + Number(new URL(q.url).searchParams.get('bytes')), 0);
  assert.ok(total <= 64 * 1024 * 1024); assert.ok(downloads.length <= 16);
  if (speedMbps < 150) assert.ok(total < 20 * 1024 * 1024);
  assert.ok(rt.store.has(SPEED));
});

test('speed: legacy small body limits use bounded safe fallback and label its limitation', async () => {
  const rt = runtime({ trigger: 'button', speedMbps: 20, bodyLimit: 64 * 1024 });
  const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(value.mode, '小响应降级'); assert.ok(rt.stats.peakSpeed <= 3);
});

test('speed: network failure and hung callback preserve last success and its timestamp', async () => {
  for (const failSpeed of [true, 'hang']) {
    const saved = JSON.stringify({ mbps: 300, mbPerSecond: 37.5, time: NOW - 3600000, ip: IP });
    const rt = runtime({ trigger: 'button', failSpeed, store: new Map([[SPEED, saved]]) });
    const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
    assert.equal(value.mbps, 300); assert.equal(value.time, NOW - 3600000); assert.equal(value.state, 'failed'); assert.ok(value.failure.reason);
    assert.equal(rt.store.get(SPEED), saved); assert.ok(rt.now() - NOW <= 8000);
  }
});

test('speed: rapid second button press cannot add downloads; cache from another exit is marked', async () => {
  const rt = runtime({ trigger: 'button', speedMbps: 25 });
  await rt.run("getSpeedForThisRun('', '8.8.4.4')"); const count = rt.calls.length;
  const again = await rt.run("getSpeedForThisRun('', '1.1.1.1')");
  assert.equal(rt.calls.length, count); assert.equal(again.otherExit, true); assert.equal(again.state, 'cooldown');
});

test('speed: bytes never come from string length or Content-Length, bar is labelled 500 Mbps', async () => {
  const rt = runtime();
  assert.equal(await rt.run("binaryLength('x'.repeat(8192))"), 0);
  assert.equal(await rt.run("binaryLength(new Uint8Array(37))"), 37);
  assert.match(await rt.run('speedResultBar(500)'), /^●{10} · 500 Mbps$/);
  assert.match(await rt.run('speedResultBar(200)'), /^●{4}○{6}/);
});

test('profile: explicit redacted endpoint; HEAD/GET fallback only to the original HTTPS host', async () => {
  const secret = 'fixture-managed-token', url = `https://subscription.invalid/feed?token=${secret}`;
  const rt = runtime({ apiReply: () => ({ profile: `#!MANAGED-CONFIG ${url}\n[General]\nipv6=false` }),
    respond: q => reply('', q.method === 'head' ? 405 : 200, q.method === 'get' ? { 'Subscription-Userinfo': 'upload=1; download=2; total=100; expire=0' } : {}) });
  const usage = await rt.run("getSubscriptionUsage('')"); assert.equal(usage.remaining, 97);
  assert.deepEqual(rt.calls.map(q => q.method), ['head', 'get']); assert.ok(rt.calls.every(q => q.url === url && q['auto-redirect'] === false && q['auto-cookie'] === false));
  assert.equal(rt.apiCalls[0].path, '/v1/profiles/current?sensitive=0');
  assert.equal(JSON.stringify([rt.logs, rt.writes, rt.done]).includes(secret), false);
});

test('profile: local traffic avoids network; redirect/error headers cannot fabricate usage', async () => {
  const local = runtime({ apiReply: () => ({ profile: '[General]\n# subscription-userinfo: upload=10; download=20; total=100' }) });
  assert.equal((await local.run("getSubscriptionUsage('')")).remaining, 70); assert.equal(local.calls.length, 0);
  const invalid = runtime({ apiReply: () => ({ profile: '#!MANAGED-CONFIG https://subscription.invalid/private\n[General]' }), respond: () => reply('', 302, { 'subscription-userinfo': 'upload=1; download=2; total=100', location: 'https://other.invalid/' }) });
  assert.equal((await invalid.run("getSubscriptionUsage('')")).available, false);
  assert.equal(invalid.calls.length, 2); assert.ok(invalid.calls.every(q => new URL(q.url).hostname === 'subscription.invalid'));
});

test('main: request budget, no auto speed, masked IP, optional policy, no credentials or unrelated mutations', async () => {
  const rt = runtime(); await rt.run('main()');
  assert.equal(rt.done.length, 1); assert.equal(rt.calls.length, 16); assert.ok(rt.stats.peak <= 16);
  assert.equal(rt.calls.some(q => q.url.includes('/__down')), false);
  assert.match(rt.done[0].content, /8\.8\.\*\.\*/); assert.equal(rt.done[0].content.includes(IP), false);
  assert.ok(rt.calls.every(q => q['auto-cookie'] === false && q['auto-redirect'] === false));
  assert.ok(rt.calls.every(q => !Object.keys(q.headers).some(k => /cookie|authorization|token|key/i.test(k))));
  assert.ok(rt.calls.filter(q => !q.url.includes('gstatic.com')).every(q => !('policy' in q)));
  assert.ok(rt.writes.every(w => w.key.startsWith('betty.basic.'))); assert.equal(rt.logs.length, 0);
  assert.equal(rt.apiCalls.some(q => /requests|policies|modules|sensitive=1/.test(q.path)), false);
});

test('main: one AI 403 does not turn a healthy network orange; IPv4-only is explicit', async () => {
  const rt = runtime({ respond: q => q.url.includes('chatgpt.com') ? reply('', 403) : defaultReply(q) });
  await rt.run('main()'); assert.equal(rt.done[0]['icon-color'], '#30D158');
  assert.match(rt.done[0].content, /GPT 403/); assert.doesNotMatch(rt.done[0].content, /IPv6 未测|VIF|IPv6 本地未发现/);
});

test('main: all sources failing still renders local information without leaking original error bodies', async () => {
  const secret = 'fixture-token-cookie-authorization';
  const rt = runtime({ respond: () => ({ error: `failed URL ${secret}`, delay: 10 }) });
  await rt.run('main()'); assert.equal(rt.done.length, 1); assert.match(rt.done[0].content, /IP 情报暂不可用/);
  assert.equal(JSON.stringify([rt.done, rt.logs, rt.writes]).includes(secret), false); assert.equal(rt.done[0]['icon-color'], '#FF453A');
});

test('module: exactly one panel, privacy defaults and no extra interception or forced policy', () => {
  const module = readFileSync(new URL('../Modules/Betty-Basic-Panel.sgmodule', import.meta.url), 'utf8');
  assert.equal((module.match(/^\[Panel\]$/gm) || []).length, 1);
  assert.match(module, /^贝蒂的基础面板 = script-name=Betty-Basic-Panel, update-interval=1800$/m);
  assert.match(module, /argument="YS=1&RISK=1"/);
  assert.doesNotMatch(module, /\[(?:MITM|Rule|URL Rewrite|Header Rewrite)\]|POLICY=/);
});

test('profile: malformed numeric suffixes and contradictory duplicate fields are not traffic data', async () => {
  const rt = runtime();
  for (const header of ['upload=1e9; download=2; total=100', 'upload=1; download=2; total=100junk', 'upload=1; download=2; total=100; total=200']) {
    rt.context.header = header; assert.equal((await rt.run('parseSubscriptionUserInfo(header)')).available, false);
  }
});

for (const [speedMbps, latency] of [[100, 5], [300, 80], [500, 150], [800, 50]]) test(`speed: ${speedMbps} Mbps / ${latency}ms RTT never exceeds three concurrent speed requests`, async () => {
  const rt = runtime({ trigger: 'button', speedMbps, latency });
  const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.ok(value && value.mbps > 0); assert.ok(value.mbps <= speedMbps * 1.001);
  assert.ok(value.mbps >= speedMbps * 0.5, 'controlled network should avoid >50% underestimation');
  assert.ok(rt.stats.peakSpeed <= 3); assert.ok(rt.now() - NOW <= 8000);
  assert.ok(rt.calls.reduce((n, q) => n + Number(new URL(q.url).searchParams.get('bytes')), 0) <= 64 * 1024 * 1024);
});

test('main: button performs bounded adaptive test, explicit policy stays out of diagnostics', async () => {
  const policy = 'fixture-private-policy';
  const rt = runtime({ trigger: 'button', speedMbps: 500, argument: 'YS=1&RISK=1&POLICY=' + policy });
  await rt.run('main()'); assert.equal(rt.done.length, 1); assert.ok(rt.stats.peakSpeed <= 3);
  assert.match(rt.done[0].content, /测速.*Mbps/); assert.match(rt.done[0].content, /[●○]{10} · 500 Mbps/);
  assert.equal(JSON.stringify([rt.logs, rt.writes, rt.done]).includes(policy), false);
  assert.ok(rt.calls.filter(q => !q.url.includes('gstatic.com')).every(q => q.policy === policy));
  assert.ok(rt.done[0].content.split('\n').length <= 24, 'single panel is compact on mobile');
});

test('parameters: RISK=0 makes no reputation query; YS=0 deliberately reveals IP', async () => {
  const rt = runtime({ argument: 'RISK=0&YS=0' }); await rt.run('main()');
  assert.equal(rt.calls.some(q => /\/api\/ip\/lookup\/|\/api\/iprisk\//.test(q.url)), false);
  assert.match(rt.done[0].content, /IP 信誉 · 已关闭/); assert.ok(rt.done[0].content.includes(IP));
});

test('media: transport error with partial HTTP 200 body cannot establish catalogue or Premium evidence', async () => {
  for (const fn of ['testNetflix', 'testYouTubePremium']) {
    const rt = runtime({ respond: () => ({ error: 'truncated response', responseOnError: true, status: 200,
      body: '<title>Netflix</title>/title/81280792 {"ypcOffers":[{"ypcOfferId":"fixture"}]}' }) });
    const value = await rt.run(fn + "('')"); assert.equal(value.state, 'unreachable'); assert.equal(value.label, '不可达');
  }
});

for (const ip of [IP, '2606:4700:4700::1111']) test('Net.Coffee: current IP and combined Geo/ASN/Trust ' + ip, async () => {
  const rt = runtime({ respond: q => q.url.includes('/cdn-cgi/trace') ? reply(trace(ip)) : defaultReply(q) });
  const { exit, risk } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.ip, ip); assert.equal(exit.country, 'HK'); assert.equal(exit.region, 'Hong Kong'); assert.equal(exit.city, 'Kowloon');
  assert.equal(exit.asn, 15169); assert.equal(exit.org, 'Example Networks'); assert.equal(exit.isp, 'Example ISP'); assert.equal(exit.company, 'Example Company');
  assert.equal(risk.trust, 85); assert.equal(risk.signals.hosting, true); assert.equal(risk.signals.residential, false);
  assert.equal(rt.calls.length, 2); assert.ok(rt.calls.every(q => new URL(q.url).hostname === 'ip.net.coffee'));
  assert.ok(rt.calls[1].url.endsWith(encodeURIComponent(ip)));
});

test('Net.Coffee: equivalent IPv6 responses and cache keys refer to the same address', async () => {
  const ip = '2606:4700:4700::1111', expanded = '2606:4700:4700:0000:0000:0000:0000:1111', store = new Map();
  const first = runtime({ store, respond: q => q.url.includes('/cdn-cgi/trace') ? reply(trace(expanded)) : reply(lookup(ip)) });
  assert.equal((await first.run("getNetworkIntelligence('')")).risk.ip, ip);
  const next = runtime({ store, clockStart: NOW + 1000, respond: () => reply(trace(ip)) });
  assert.equal((await next.run("getNetworkIntelligence('')")).risk.trust, 85); assert.equal(next.calls.length, 1);
});

for (const trust of [0, 0.5, 100, -1, 101, null, '85', true, {}, undefined]) test('Net.Coffee: Trust numeric boundaries ' + JSON.stringify(trust), async () => {
  const rt = runtime({ respond: q => q.url.includes('/api/ip/lookup/') ? reply(lookup(IP, { trust_score: trust })) : defaultReply(q) });
  const { risk } = await rt.run("getNetworkIntelligence('')");
  const expected = typeof trust === 'number' && trust >= 0 && trust <= 100 ? trust : null;
  assert.equal(risk.trust, expected);
  rt.context.risk = risk;
  const text = await rt.run('(()=>{const a=[];appendRiskLines(a,risk);return a.join("\\n")})()');
  assert.match(text, expected === null ? /Trust 未知/ : new RegExp('Trust ' + expected + '/100'));
  assert.doesNotMatch(text, /纯净|综合|共识|Risk \d|交叉/);
});

test('Net.Coffee: independent residential/hosting/business/proxy/VPN/Tor signals preserve null', async () => {
  const rt = runtime(); rt.context.input = lookup(IP, { company_type: 'business', isResidential: true, is_datacenter: true,
    is_vpn: null, is_proxy: false, is_tor: true, is_mobile: 'false', is_abuser: 0 });
  const risk = await rt.run("parseNetCoffeeRisk(input,'8.8.4.4')");
  assert.equal(risk.signals.residential, true); assert.equal(risk.signals.hosting, true); assert.equal(risk.type, 'business');
  assert.equal(risk.signals.vpn, null); assert.equal(risk.signals.proxy, false); assert.equal(risk.signals.tor, true);
  assert.equal(risk.signals.mobile, null); assert.equal(risk.signals.abuse, null);
  rt.context.risk = risk;
  const text = await rt.run('(()=>{const a=[];appendRiskLines(a,risk);return a.join("\\n")})()');
  assert.match(text, /Trust 85\/100 · 商业/); assert.match(text, /住宅✓ · 机房✓/); assert.match(text, /VPN\? · 代理✕ · Tor✓/);
});

test('Net.Coffee: missing/wrong-type metadata never coerces objects into labels', async () => {
  const rt = runtime();
  rt.context.input = { ip: IP, countryCode: 'XX', country: {}, region: [], city: 123, asn: 'AS15169',
    asOrganization: {}, company_name: [], isp: false, company_type: {}, trust_score: null, is_vpn: 'false' };
  assert.equal(await rt.run("parseNetCoffeeRisk(input,'8.8.4.4')"), null);
  rt.context.input.trust_score = 0;
  const value = await rt.run("parseNetCoffeeRisk(input,'8.8.4.4')");
  assert.equal(value.country, ''); assert.equal(value.asn, null); assert.equal(value.org, ''); assert.equal(value.type, '');
  assert.ok(Object.values(value.signals).every(x => x === null));
});

for (const body of ['{', '[]', 'null', {}, { ip: IP }, lookup(OTHER), lookup(IP, { is_bogon: true }),
  lookup(IP, { error: 'fixture-secret' }), 'x'.repeat(65537)]) test('Net.Coffee: invalid or mismatched lookup degrades to same-IP Geo ' + (typeof body === 'string' ? body.slice(0,8) : JSON.stringify(body).slice(0,30)), async () => {
  const rt = runtime({ respond: q => q.url.includes('/api/ip/lookup/') ? reply(body) : defaultReply(q) });
  const { exit, risk } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.ip, IP); assert.equal(exit.country, 'HK'); assert.equal(risk.ip, '');
  assert.equal(exit.asn, null, 'Geo does not provide ASN'); assert.equal(rt.calls.length, 3);
  assert.ok(rt.calls[2].url.endsWith(IP)); assert.equal(JSON.stringify(rt.writes).includes('fixture-secret'), false);
});

for (const body of [geo(), { ...geo(), ip: IP }, { ...geo(), ip: OTHER }, { ...geo(), ip: null }, { country_code: 'ZZ', asn: 1e20 }, '{}', '{']) test('Net.Coffee: Geo query binding and partial schema ' + JSON.stringify(body), async () => {
  const rt = runtime({ argument: 'RISK=0', respond: q => q.url.includes('/api/geoip/') ? reply(body) : defaultReply(q) });
  const { exit } = await rt.run("getNetworkIntelligence('')");
  const valid = typeof body === 'object' && body.country_code === 'hk' && (!('ip' in body) || body.ip === IP);
  assert.equal(exit.country, valid ? 'HK' : ''); assert.equal(exit.ip, IP);
  assert.equal(rt.calls.length, 2); assert.ok(rt.calls.every(q => !q.url.includes('/api/ip/lookup/')));
});

test('Net.Coffee: Geo fallback accepts equivalent IPv6 text, never an unrelated IP', async () => {
  const rt = runtime(); rt.context.data = { ...geo(), ip: '2606:4700:4700:0:0:0:0:1111' };
  assert.equal((await rt.run("parseNetCoffeeGeo(data,'2606:4700:4700::1111')")).ip, '2606:4700:4700::1111');
  assert.equal(await rt.run("parseNetCoffeeGeo(data,'2001:4860:4860::8888')"), null);
});

for (const body of ['ip=192.0.2.1\n', 'ip=2001:db8::1\n', 'ip=' + IP + '\nip=' + OTHER, '{"ip":"' + IP + '"}', '<html>WAF</html>', 'x'.repeat(4097)]) test('Net.Coffee: invalid trace stops intelligence without sending an explicit query ' + body.slice(0,35), async () => {
  const rt = runtime({ respond: () => reply(body) });
  const { exit, risk } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.ip, ''); assert.equal(risk.ip, ''); assert.equal(rt.calls.length, 1);
});

test('cache: fresh observation, same-IP hits, expiry, and exit switches', async () => {
  const store = new Map(); const first = runtime({ store }); await first.run("getNetworkIntelligence('')");
  const same = runtime({ store, clockStart: NOW + 1000 }); await same.run("getNetworkIntelligence('')"); assert.equal(same.calls.length, 1);
  const next = runtime({ store, clockStart: NOW + 2000, respond: q => q.url.includes('/cdn-cgi/trace') ? reply(trace(OTHER)) : defaultReply(q) });
  const { exit } = await next.run("getNetworkIntelligence('')"); assert.equal(exit.ip, OTHER); assert.equal(next.calls.length, 2);
  assert.equal(JSON.parse(store.get(INTEL)).ip, OTHER); assert.ok(next.calls[1].url.endsWith(OTHER));
  const expired = runtime({ store, clockStart: NOW + 7200000 }); await expired.run("getNetworkIntelligence('')"); assert.equal(expired.calls.length, 2);
});

test('cache: expired data and failed fresh discovery never become stale fallback', async () => {
  const store = new Map(); await runtime({ store }).run("getNetworkIntelligence('')");
  const missing = runtime({ store, clockStart: NOW + 1000, respond: () => null });
  const result = await missing.run("getNetworkIntelligence('')"); assert.equal(result.exit.ip, ''); assert.equal(result.risk.ip, ''); assert.equal(missing.calls.length, 1);
  const expires = JSON.parse(store.get(INTEL)).entries.risk.time + 3600000;
  const expired = runtime({ store, clockStart: expires + 1, respond: q => q.url.includes('/cdn-cgi/trace') ? defaultReply(q) : null });
  const value = await expired.run("getNetworkIntelligence('')");
  assert.equal(value.exit.ip, IP); assert.equal(value.exit.country, ''); assert.equal(value.risk.ip, '');
  assert.deepEqual(Object.keys(JSON.parse(store.get(INTEL)).entries), []);
});

for (const record of ['{', '[]', '{}', 'null', '{"version":1,"ip":"8.8.4.4","entries":{}}', '{"version":2,"ip":"8.8.4.4","entries":null}']) test('cache: malformed and old schemas ' + record, async () => {
  const rt = runtime({ store: new Map([[INTEL, record], ['betty.basic.intel.v1', '{"version":1,"ip":"1.1.1.1"}']]) });
  const { exit } = await rt.run("getNetworkIntelligence('')"); assert.equal(exit.country, 'HK'); assert.equal(rt.calls.length, 2);
});

for (const field of ['signals', 'trust', 'countryName', 'time']) test('cache: invalid nested ' + field + ' is refetched', async () => {
  const store = new Map(); await runtime({ store }).run("getNetworkIntelligence('')");
  const cache = JSON.parse(store.get(INTEL));
  if (field === 'time') cache.entries.risk.time = NOW + 60000;
  else cache.entries.risk.data[field] = field === 'trust' ? '100' : {};
  store.set(INTEL, JSON.stringify(cache));
  const rt = runtime({ store, clockStart: NOW + 1000 }); await rt.run("getNetworkIntelligence('')"); assert.equal(rt.calls.length, 2);
});

for (const [header, wait] of [['120', 120000], ['0', 60000], ['1', 60000], ['999999999', 7 * 86400000],
  [new Date(NOW - 1000).toUTCString(), 60000], [new Date(NOW + 300000).toUTCString(), 300000], ['', 86400000], ['nonsense', 86400000]]) test('Net.Coffee: 429 Retry-After ' + header, async () => {
  const store = new Map();
  const first = runtime({ store, respond: q => q.url.includes('/api/ip/lookup/') ? reply({}, 429, { 'Retry-After': header }) : defaultReply(q) });
  await first.run("getNetworkIntelligence('')");
  const until = JSON.parse(store.get('betty.basic.backoff.NetCoffeeRisk')).until;
  assert.ok(Math.abs(until - (NOW + wait)) <= 30);
  assert.equal(first.calls.filter(q => q.url.includes('/api/ip/lookup/')).length, 1);
  const next = runtime({ store, clockStart: NOW + 1000, respond: q => q.url.includes('/cdn-cgi/trace') ? reply(trace(OTHER)) : defaultReply(q) });
  await next.run("getNetworkIntelligence('')"); assert.ok(next.calls.every(q => !q.url.includes('/api/ip/lookup/')));
  const later = runtime({ store, clockStart: until + 1 }); await later.run("getNetworkIntelligence('')");
  assert.equal(later.calls.filter(q => q.url.includes('/api/ip/lookup/')).length, 1);
});

for (const failure of [reply({}, 403), reply({}, 500), reply('{}', 302, { location: 'https://other.invalid/' }), null, 'hang',
  { status: 200, error: 'partial response', responseOnError: true, body: lookup() }]) test('Net.Coffee: lookup failure has bounded same-site Geo fallback ' + (failure === 'hang' ? 'watchdog' : failure?.status || 'network'), async () => {
  const rt = runtime({ respond: q => q.url.includes('/api/ip/lookup/') ? failure : defaultReply(q) });
  const { exit, risk } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.ip, IP); assert.equal(risk.ip, ''); assert.equal(rt.calls.length, 3); assert.ok(rt.now() - NOW < 7100);
  assert.equal(!!rt.store.get('betty.basic.backoff.NetCoffeeRisk'), failure?.status === 403);
});

test('Net.Coffee: full outage isolates intelligence while every other panel section runs', async () => {
  const rt = runtime({ respond: q => q.url.includes('ip.net.coffee') ? null : defaultReply(q) });
  await rt.run('main()'); assert.equal(rt.done.length, 1);
  assert.match(rt.done[0].content, /IP 情报暂不可用/); assert.match(rt.done[0].content, /Test Wi-Fi/);
  assert.match(rt.done[0].content, /DNS/); assert.match(rt.done[0].content, /⚡ DIRECT/);
  assert.match(rt.done[0].content, /流媒体 6\/6/); assert.match(rt.done[0].content, /AI 6\/6/);
  assert.match(rt.done[0].content, /📦/); assert.match(rt.done[0].content, /测速/);
  assert.equal(rt.calls.filter(q => q.url.includes('ip.net.coffee')).length, 1); assert.equal(rt.calls.length, 15);
});

for (const failStore of [true, 'throw']) test('Net.Coffee: persistent store failure ' + failStore, async () => {
  const rt = runtime({ failStore }); await rt.run('main()'); assert.equal(rt.done.length, 1); assert.match(rt.done[0].content, /Trust 85\/100/);
  assert.equal(rt.calls.length, 16); assert.equal(rt.logs.length, 0);
});

test('RISK=0 ignores a warm risk cache, uses only Geo, and caches it without TTL renewal', async () => {
  const store = new Map(); await runtime({ store }).run("getNetworkIntelligence('')");
  const off = runtime({ store, clockStart: NOW + 1000, argument: 'RISK=0' }); await off.run('main()');
  assert.equal(off.calls.length, 16); assert.ok(off.calls.every(q => !/\/api\/ip\/lookup\/|\/api\/iprisk\//.test(q.url)));
  assert.doesNotMatch(off.done[0].content, /Trust|VPN 是/);
  const time = JSON.parse(store.get(INTEL)).entries.geo.time;
  const warm = runtime({ store, clockStart: NOW + 2000, argument: 'RISK=0' }); await warm.run('main()');
  assert.equal(warm.calls.length, 15); assert.equal(JSON.parse(store.get(INTEL)).entries.geo.time, time);
});

test('request budget: warm auto refresh is 15, lookup+Geo failure path is at most 17', async () => {
  const store = new Map(); await runtime({ store }).run('main()');
  const warm = runtime({ store, clockStart: NOW + 1000 }); await warm.run('main()'); assert.equal(warm.calls.length, 15);
  const fallback = runtime({ respond: q => /\/api\//.test(q.url) ? null : defaultReply(q) });
  await fallback.run('main()'); assert.equal(fallback.calls.length, 17); assert.ok(fallback.stats.peak <= 16);
  assert.ok(fallback.calls.every(q => !q.url.includes('/__down')));
});

test('HTTP: asynchronous malformed callback settles safely, duplicate completion is ignored', async () => {
  const broken = runtime();
  broken.context.$httpClient.get = (q, cb) => broken.context.setTimeout(() => cb(null, { get status() { throw new Error('private error body'); } }, ''), 10);
  const bad = await broken.run("http('get','https://ip.net.coffee/cdn-cgi/trace','')");
  assert.equal(bad.ok, false); assert.equal(broken.logs.length, 0);
  const duplicate = runtime();
  duplicate.context.$httpClient.get = (q, cb) => duplicate.context.setTimeout(() => {
    cb(null, { status: 200 }, 'ok');
    cb(null, { get status() { throw new Error('late callback'); } }, '');
  }, 10);
  const good = await duplicate.run("http('get','https://ip.net.coffee/cdn-cgi/trace','')");
  assert.equal(good.ok, true); assert.equal(good.data, 'ok');
});

const NON_PUBLIC = [
  '0.0.0.0', '0.255.255.255', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1',
  '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.0.0.0', '192.0.0.8', '192.0.0.11', '192.0.0.255',
  '192.0.2.0', '192.0.2.1', '192.0.2.255', '192.88.99.1', '192.88.99.2', '192.168.1.1',
  '198.18.0.0', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  '::', '::1', '2::1', '3::1', '20::1', '300::1', '1fff:ffff::1', '4000::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd00::1', 'ff02::1', '100::1',
  '::ffff:192.168.1.1', '::ffff:c000:201', '::ffff:8.8.8.8', '::ffff:0808:0808',
  '2001:db8::1', '2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff', '2001:2::1', '2001:2:0:ffff::1',
  '2001:10::1', '2001:1f:ffff::1', '2001:20::1', '2001:30::1', '2001:100::1', '2001:1ff:ffff::1',
  '3fff::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '5f00::1',
  '008.008.008.008', '0x08080808', '8.8.8.8:443', '2606:4700::1%en0'
];
test('public IP: special-purpose ranges and mapped addresses cannot become explicit intelligence queries', async () => {
  for (const ip of NON_PUBLIC) {
    const rt = runtime({ respond: () => reply(trace(ip)) });
    assert.equal(await rt.run('isPublicIP(' + JSON.stringify(ip) + ')'), false, ip);
    const result = await rt.run("getNetworkIntelligence('')");
    assert.equal(result.exit.ip, '', ip); assert.equal(rt.calls.length, 1, ip);
  }
});
test('public IP: ordinary addresses and neighboring range boundaries stay accepted', async () => {
  const rt = runtime();
  for (const ip of ['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0',
    '192.0.0.9', '192.0.0.10', '192.0.1.1', '192.0.3.1', '192.31.196.1', '192.52.193.1', '192.175.48.1',
    '198.17.255.255', '198.20.0.0', '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0',
    '2001:4860:4860::8888', '2606:4700:4700::1111', '240e:1::1', '2a00:1450::1', '2001:200::1',
    '2001:1::1', '2001:1::2', '2001:1::3', '2001:3::1', '2001:4:112::1', '2001:db7::1', '2001:db9::1',
    '3ffe:ffff::1', '3fff:1000::1', '2002:808:808::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2']) {
    assert.equal(await rt.run('isPublicIP(' + JSON.stringify(ip) + ')'), true, ip);
  }
});

test('release: module, script, README and technical documentation agree on 1.5.3', () => {
  for (const path of ['../Modules/Betty-Basic-Panel.sgmodule', '../README.md', '../docs/basic-panel.md']) {
    assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /1\.5\.3/);
  }
  assert.match(SOURCE, /Version: 1\.5\.3/);
  assert.doesNotMatch(SOURCE, /countryVote|consensusGeo|function vote/);
  const intelligence = SOURCE.slice(SOURCE.indexOf('/* ---------- Same-IP'), SOURCE.indexOf('/* ---------- Website'));
  assert.deepEqual([...new Set([...intelligence.matchAll(/https:\/\/([^/"]+)/g)].map(m => m[1]))], ['ip.net.coffee']);
});

for (const [endpoint, argument] of [['/cdn-cgi/trace', ''], ['/api/geoip/', 'RISK=0']]) {
  for (const status of [403, 429, 500]) test('Net.Coffee: ' + endpoint + ' HTTP ' + status + ' fails independently', async () => {
    const store = new Map();
    const rt = runtime({ store, argument, respond: q => q.url.includes(endpoint) ? reply('private failure body', status, { 'Retry-After': '120' }) : defaultReply(q) });
    await rt.run('main()'); assert.equal(rt.done.length, 1); assert.match(rt.done[0].content, /IP 情报暂不可用/);
    assert.equal(JSON.stringify([rt.done, rt.logs, rt.writes]).includes('private failure body'), false);
    const next = runtime({ store, argument, clockStart: NOW + 1000 }); await next.run("getNetworkIntelligence('')");
    assert.equal(next.calls.some(q => q.url.includes(endpoint)), status === 500);
  });
}

test('cache: reading a risk hit does not extend its original expiry', async () => {
  const store = new Map(); await runtime({ store }).run("getNetworkIntelligence('')");
  const time = JSON.parse(store.get(INTEL)).entries.risk.time;
  const warm = runtime({ store, clockStart: time + 3590000 }); await warm.run("getNetworkIntelligence('')");
  assert.equal(warm.calls.length, 1); assert.equal(JSON.parse(store.get(INTEL)).entries.risk.time, time);
  const stale = runtime({ store, clockStart: time + 3600000 }); await stale.run("getNetworkIntelligence('')");
  assert.equal(stale.calls.length, 2);
});

for (const status of [403, 429, 500, 503]) test('speed: explicit HTTP ' + status + ' stops without shrinking or retry storms', async () => {
  const rt = runtime({ speedReply: () => reply({ byteLength: 0 }, status) });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.mbps, undefined); assert.equal(result.failure.reason, 'http'); assert.equal(result.failure.status, status);
  assert.equal(rt.calls.length, 1);
});

for (const failure of ['timeout', 'transport', 'body_limit', 'body_mismatch', 'insufficient_samples']) test('speed: no valid measurement reports safe reason ' + failure, async () => {
  const secret = 'https://private.invalid/?token=SECRET';
  const rt = runtime({ speedReply: (q, bytes) => failure === 'timeout' ? { error: 'timed out ' + secret } :
    failure === 'transport' ? { error: secret } :
    failure === 'body_limit' ? { error: 'Response body exceeds size limit ' + secret } :
    failure === 'body_mismatch' ? reply({ byteLength: 0 }) : reply({ byteLength: bytes }, 200, {}, 1) });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.mbps, undefined); assert.equal(result.failure.reason, failure);
  assert.ok(rt.calls.length <= 9); assert.equal(rt.store.has(SPEED), false);
  assert.doesNotMatch(JSON.stringify([result, rt.logs, rt.writes]), /SECRET|private.invalid/);
});

for (const failure of ['body_mismatch', 'transport', 'timeout']) test('speed: bounded small-block fallback recovers ' + failure + ' after successful warmup', async () => {
  const rt = runtime({ speedMbps: 20, speedReply: (q, bytes) => bytes <= 64 * 1024 ? undefined :
    failure === 'body_mismatch' ? reply({ byteLength: 0 }) : { error: failure === 'timeout' ? 'timeout' : 'connection failed' } });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.ok(result.mbps > 0); assert.equal(result.mode, '小响应降级');
  assert.equal(rt.calls.filter(q => Number(new URL(q.url).searchParams.get('bytes')) > 64 * 1024).length, 1);
  assert.ok(rt.stats.peakSpeed <= 3);
});

test('speed block: binary views/buffers, exact byte lengths, duplicate callbacks and callback exceptions', async () => {
  const bodies = [new Uint8Array(32768), new ArrayBuffer(32768), new Uint8Array(new ArrayBuffer(65536), 0, 32768),
    new DataView(new ArrayBuffer(65536), 0, 32768), 'x'.repeat(32768), { byteLength: 32767 }, { byteLength: 32769 },
    { get byteLength() { throw new Error('SECRET'); } }];
  for (let i = 0; i < bodies.length; i++) {
    const rt = runtime({ speedReply: () => ({ body: bodies[i], status: 200, delay: 10, duplicate: true }) });
    const value = await rt.run("(async()=>{const b={bytes:0,requests:0,closed:false,deadline:Date.now()+8000}; const r=await downloadSpeedBlock('',32768,b);return {r,b};})()");
    assert.equal(value.r.ok, i < 4); assert.equal(value.r.bytes, i < 4 ? 32768 : 0);
    assert.notEqual(value.b.failure?.status, 503, 'duplicate callback must not mutate the outcome');
    assert.doesNotMatch(JSON.stringify([value, rt.logs]), /SECRET|duplicate/);
  }
});

test('speed: late callback after total deadline cannot save or change a result', async () => {
  const rt = runtime({ trigger: 'button', speedReply: (q, bytes) => reply({ byteLength: bytes }, 200, {}, 9000) });
  const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(value.state, 'failed'); assert.equal(value.failure.reason, 'deadline');
  assert.equal(rt.now() - NOW, 8000); assert.equal(rt.store.has(SPEED), false);
  await rt.run('new Promise(resolve => setTimeout(resolve, 2000))');
  assert.equal(rt.store.has(SPEED), false); assert.equal(rt.calls.length, 1);
});

for (const failStore of [true, 'throw']) test('speed: unavailable persistent protection prevents downloads', async () => {
  const rt = runtime({ trigger: 'button', failStore });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.failure.reason, 'storage'); assert.equal(rt.calls.length, 0);
});

for (const cacheIP of [IP, OTHER, '']) test('speed UI: failed fresh attempt shows historical reference without a bar: ' + (cacheIP || 'unknown exit'), async () => {
  const rt = runtime({ trigger: 'button', failSpeed: true,
    store: new Map([[SPEED, JSON.stringify({ mbps: 11.2, time: NOW - 60000, ip: cacheIP })]]) });
  const text = await rt.run("(async()=>{const a=[];appendSpeedLines(a,await getSpeedForThisRun('', '8.8.4.4'));return a.join('\\n');})()");
  assert.match(text, /测速失败 · 连接失败 · 上次 11.2 Mbps/);
  assert.match(text, new RegExp(cacheIP === IP ? '同出口' : cacheIP ? '旧出口' : '出口未确认'));
  assert.doesNotMatch(text, /[●○]|MB\/s|测速缓存/);
});

for (const cacheIP of [IP, OTHER]) test('speed UI: automatic refresh only labels cache matched to observed exit ' + cacheIP, async () => {
  const rt = runtime({ store: new Map([[SPEED, JSON.stringify({ mbps: 312, time: NOW - 60000, ip: cacheIP })]]) });
  const text = await rt.run("(async()=>{const a=[];appendSpeedLines(a,await getSpeedForThisRun('', '8.8.4.4'));return a.join('\\n');})()");
  assert.equal(rt.calls.length, 0);
  assert.match(text, cacheIP === IP ? /测速缓存 312.0 Mbps/ : /测速暂无当前出口结果/);
  assert.doesNotMatch(text, /[●○]|MB\/s/); if (cacheIP !== IP) assert.doesNotMatch(text, /312/);
});

test('speed UI: uncached failure is concise; fresh success alone has a bar; cooldown is not fresh', async () => {
  const failed = runtime({ trigger: 'button', speedReply: () => reply({ byteLength: 0 }, 403) });
  const text = await failed.run("(async()=>{const a=[];appendSpeedLines(a,await getSpeedForThisRun('', '8.8.4.4'));return a.join('\\n');})()");
  assert.equal(text, '测速失败 · HTTP 403');
  const success = runtime({ trigger: 'button', speedMbps: 500 });
  const first = await success.run("(async()=>{const a=[];appendSpeedLines(a,await getSpeedForThisRun('', '8.8.4.4'));return a.join('\\n');})()");
  assert.match(first, /^测速 \d+\.\d Mbps · \d+\.\d MB\/s\n[●○]{10} · 500 Mbps · 多流采样$/);
  const next = await success.run("(async()=>{const a=[];appendSpeedLines(a,await getSpeedForThisRun('', '8.8.4.4'));return a.join('\\n');})()");
  assert.match(next, /测速冷却中/); assert.doesNotMatch(next, /[●○]/);
});

test('speed cache: equivalent IPv6 remains matched and old quick samples become labelled history', async () => {
  const rt = runtime({ store: new Map([[SPEED, JSON.stringify({ mbps: 12, time: NOW - 60000,
    ip: '2606:4700:4700::1111', mode: '快速采样' })]]) });
  const value = await rt.run("getSpeedForThisRun('', '2606:4700:4700:0:0:0:0:1111')");
  assert.equal(value.otherExit, false); assert.equal(value.mode, '历史采样'); assert.equal(value.time, NOW - 60000);
});

test('compact panel: 500 is abnormal, successful GET is quiet, Taiwan uses text, traffic means remaining', async () => {
  const rt = runtime({ network: { wifi: { ssid: '6-1904' }, v4: { primaryAddress: '192.168.1.8' }, v6: { primaryAddress: 'fe80::1' }, dns: ['192.168.1.1'] },
    apiReply: path => path.includes('dns_delay') ? { delay: 0.024 } :
      { profile: '# subscription-userinfo: upload=0; download=1535450808; total=322122547200; expire=1798502400' },
    respond: q => q.url.includes('/api/ip/lookup/') ? reply(lookup(IP, { countryCode: 'TW', region: 'New Taipei City', city: 'New Taipei City', company_type: 'business' })) :
      q.url.includes('netflix.com') ? reply('<title>Netflix</title>/title/81280792 {"countryCode":"TW"}') :
      q.url.includes('grok.com') ? reply('', 500) :
      q.url.includes('deepseek.com') ? reply('', 403) :
      METHOD_FALLBACK_SITES.some(host => new URL(q.url).hostname === host) ? reply('', q.method === 'head' ? 405 : 302) : defaultReply(q) });
  await rt.run('main()'); const text = rt.done[0].content;
  assert.match(text, /IPv4 本地 · NAT 推断 · IPv6 本地/);
  assert.match(text, /🚪 台湾 · 8.8.\*.\* · AS15169/);
  assert.match(text, /Netflix 样片台湾/);
  assert.match(text, /✨ AI 4\/6 · 受限 1 · 异常 1/); assert.match(text, /Grok 500/);
  assert.match(text, /TikTok ✓ · Prime ✓/); assert.doesNotMatch(text, /GET 200|GET 302|未知 500|VIF|出口未测|越高越可信|单源/);
  assert.doesNotMatch(text, /[\u{1F1E6}-\u{1F1FF}]/u);
  assert.match(text, /📦 剩余 298.57 \/ 300 GB · 99.5%/);
  assert.match(text, /已用 1.43 GB · 到期 12\/29/);
  assert.equal((text.match(/Net\.Coffee/g) || []).length, 1);
  assert.ok(text.split('\n').length <= 24);
});

test('compact panel: unknown organization/ASN is omitted and tri-state signals stay distinct', async () => {
  const rt = runtime({ respond: q => q.url.includes('/api/ip/lookup/') ? reply(lookup(IP, {
    asn: null, asOrganization: null, isp: null, company_name: null, region: null, city: null,
    trust_score: null, company_type: null, isResidential: true, is_datacenter: false, is_vpn: null })) : defaultReply(q) });
  await rt.run('main()'); const text = rt.done[0].content;
  assert.match(text, /Trust 未知/); assert.match(text, /住宅✓ · 机房✕ · VPN\?/);
  assert.doesNotMatch(text, /机构未知|AS未知|类型未知|越高越可信/);
});


test('speed UI: cache from a previous day retains its date', async () => {
  const rt = runtime();
  assert.match(await rt.run('speedTimeLabel(Date.now()-86400000)'), /^09\/10 \d{2}:\d{2}$/);
  assert.match(await rt.run('speedTimeLabel(Date.now())'), /^\d{2}:\d{2}$/);
});


const MiB = 1024 * 1024;
const speedBytes = rt => rt.calls.filter(q => q.url.includes('/__down'))
  .reduce((sum, q) => sum + Number(new URL(q.url).searchParams.get('bytes')), 0);
const budgetCode = '{bytes:0,requests:0,closed:false,deadline:Date.now()+8000,best:null}';
const MATRIX = [20, 50, 100, 200, 300, 500].flatMap(mbps => [50, 100, 150, 300, 500].map(rtt => [mbps, rtt]))
  .concat([[10, 50], [10, 150], [10, 300], [100, 900]]);
for (const [speedMbps, latency] of MATRIX) test('aggregate matrix: ' + speedMbps + ' Mbps / ' + latency + 'ms', async t => {
  const rt = runtime({ trigger: 'button', speedMbps, latency });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.state, 'fresh', JSON.stringify(result)); assert.equal(result.mode, '多流采样');
  assert.equal(rt.stats.peakSpeed, 3, 'final batch actually executes');
  assert.ok(result.mbps <= speedMbps * 1.001, 'no RTT subtraction or byte inflation');
  assert.ok(result.mbps >= speedMbps * (latency >= 500 ? 0.50 : 0.68), JSON.stringify(result));
  if (speedMbps >= 300 && latency <= 300) {
    // At 500 Mbps / 300ms even 48 MiB needs ~805ms transfer + 300ms RTT:
    // ~364 Mbps is honest, not a reason to subtract RTT or raise the byte budget.
    assert.ok(result.mbps >= speedMbps * (speedMbps === 500 && latency === 300 ? 0.70 : 0.75));
  }
  assert.ok(result.elapsed >= 700); assert.equal(result.streams, 3);
  assert.ok(rt.now() - NOW <= 8000); assert.ok(rt.stats.peakTimers <= 1);
  assert.ok(rt.calls.length <= 9, 'two probes and at most two fixed batches after warmup');
  assert.ok(speedBytes(rt) <= 64 * MiB);
  assert.ok(rt.calls.every(q => !('policy' in q) && q.timeout > 0 && q.timeout <= 4 &&
    q['binary-mode'] === true && !q['auto-cookie'] && !q['auto-redirect']));
  t.diagnostic(JSON.stringify({ link: speedMbps, RTT: latency, estimate: +result.mbps.toFixed(1),
    milliseconds: Math.round(rt.now() - NOW), MiB: +(speedBytes(rt) / MiB).toFixed(3), mode: result.mode }));
});

for (const streamMbps of [20, 50, 100]) test('aggregate: per-stream ' + streamMbps + ' Mbps ceiling is not the shared 300 Mbps link', async () => {
  const rt = runtime({ trigger: 'button', speedMbps: 300, streamMbps, latency: 100 });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.mode, '多流采样'); assert.equal(rt.stats.peakSpeed, 3);
  assert.ok(result.mbps > streamMbps * 2 && result.mbps <= Math.min(300, streamMbps * 3));
  assert.ok(speedBytes(rt) <= 64 * MiB && rt.now() - NOW <= 8000);
});

test('aggregate math: three 4 MiB bodies in 400ms use total bytes, not mean stream speed', async () => {
  const rt = runtime();
  const value = await rt.run('summarizeSpeedBatch({started:3,successful:3,bytes:12*1024*1024,elapsed:400,time:Date.now()})');
  assert.equal(value.mbps, 12 * MiB * 8 / 400 / 1000);
  assert.equal(value.mbPerSecond, 12 * MiB / 400 / 1000);
});
test('aggregate math: three of four complete 8 MiB bodies use the last accepted 900ms completion', async () => {
  const rt = runtime();
  const value = await rt.run('summarizeSpeedBatch({started:4,completed:4,successful:3,failed:1,bytes:24*1024*1024,elapsed:900,time:Date.now()})');
  assert.equal(value.mbps, 24 * MiB * 8 / 900 / 1000);
  assert.equal(value.streams, 3); assert.equal(value.started, 4);
});
test('aggregate math: one of four successes is never a multi-stream result', async () => {
  assert.equal(await runtime().run('summarizeSpeedBatch({started:4,successful:1,bytes:8388608,elapsed:900})'), null);
});
test('aggregate math: 500ms and 800ms completions share one 800ms denominator', async () => {
  let n = 0;
  const rt = runtime({ speedReply: (q, bytes) => ++n <= 2
    ? reply({ byteLength: bytes }, 200, {}, n === 1 ? 500 : 800) : reply('', 503, {}, 1400) });
  const value = await rt.run('(async()=>{const b=' + budgetCode + ";const state=await measureDownload('',4*1024*1024,b);return {state,result:b.best};})()");
  assert.equal(value.result.mbps, 8 * MiB * 8 / 800 / 1000);
  assert.equal(value.result.elapsed, 800); assert.equal(value.result.time, NOW + 800);
  assert.equal(rt.now(), NOW + 1400, 'late failed peer is drained but contributes neither bytes nor accepted end time');
  assert.equal(value.state.completed, 3); assert.equal(value.state.failed, 1);
});
test('stream-count comparison: a fixed three-stream batch exercises more capacity without requiring a fourth', async () => {
  const rt = runtime(), rates = [];
  // Ideal shared 300 Mbps link with a 100 Mbps per-request ceiling. A model,
  // not evidence that Surge creates independent TCP connections.
  for (const count of [2, 3, 4]) {
    const bytes = count * 8 * MiB;
    const elapsed = 100 + Math.max(bytes * 8 / 300 / 1000, 8 * MiB * 8 / 100 / 1000);
    const v = await rt.run('summarizeSpeedBatch(' + JSON.stringify({ started: count, successful: count, bytes, elapsed, time: NOW }) + ')');
    rates.push(v.mbps);
  }
  assert.ok(rates[1] / rates[0] > 1.49);
  assert.ok(rates[2] / rates[1] < 1.05, 'fourth stream has modest benefit in this controlled case');
});

test('aggregate: callbacks after the old 1500ms window count with their real completion time', async () => {
  const rt = runtime({ speedReply: (q, bytes) => reply({ byteLength: bytes }, 200, {}, 1800) });
  const value = await rt.run('(async()=>{const b=' + budgetCode + ";const state=await measureDownload('',512*1024,b);return {state,result:b.best};})()");
  assert.equal(value.result.elapsed, 1800);
  assert.equal(value.result.mbps, 1.5 * MiB * 8 / 1800 / 1000);
  assert.equal(value.state.completed, 3); assert.equal(rt.calls.length, 3);
});
test('aggregate: in-flight peer is not a failure and a later success updates both bytes and denominator', async () => {
  let n = 0;
  const rt = runtime({ speedReply: (q, bytes) => reply({ byteLength: bytes }, 200, {}, [200, 800, 1800][n++]) });
  const value = await rt.run('(async()=>{const b=' + budgetCode + ";let first,mid;setTimeout(()=>{first={...b.batch,result:{...b.best}};},500);setTimeout(()=>{mid={...b.batch,result:{...b.best}};},1000);await measureDownload('',512*1024,b);return {first,mid,result:b.best};})()");
  assert.equal(value.first.successful, 1); assert.equal(value.first.completed, 1); assert.equal(value.first.failed, 0);
  assert.equal(value.first.result.mode, '单流估算');
  assert.equal(value.mid.completed, 2); assert.equal(value.mid.failed, 0); assert.equal(value.mid.result.streams, 2);
  assert.equal(value.mid.result.mbps, MiB * 8 / 800 / 1000);
  assert.equal(value.result.streams, 3);
  assert.equal(value.result.mbps, 1.5 * MiB * 8 / 1800 / 1000, 'do not cherry-pick the earlier higher two-stream rate');
});
test('aggregate: two successful peers survive a missing callback at the global deadline', async () => {
  let n = 0;
  const rt = runtime({ speedReply: (q, bytes) => ++n <= 2 ? reply({ byteLength: bytes }, 200, {}, n * 400) : 'hang' });
  const value = await rt.run("(async()=>{let b;adaptiveDownload=async(policy,budget)=>{b=budget;await measureDownload(policy,512*1024,budget);return budget.best;};const result=await runDownloadSpeedTest('');return {result,state:b.batch};})()");
  assert.equal(value.result.mode, '多流采样'); assert.equal(value.result.streams, 2);
  assert.equal(value.result.mbps, MiB * 8 / 800 / 1000);
  assert.equal(value.state.completed, 2); assert.equal(value.state.failed, 0); assert.equal(rt.now() - NOW, 8000);
  const text = await rt.run('(()=>{const a=[];appendSpeedLines(a,' + JSON.stringify({ ...value.result, state: 'fresh' }) + ");return a.join('\\n');})()");
  assert.match(text, /多流采样 2\/3/);
});
test('aggregate: one complete peer survives missing peers only as a single-stream fallback', async () => {
  let n = 0;
  const rt = runtime({ speedReply: (q, bytes) => ++n === 1 ? reply({ byteLength: bytes }, 200, {}, 300) : 'hang' });
  const result = await rt.run("(async()=>{adaptiveDownload=async(policy,budget)=>{await measureDownload(policy,512*1024,budget);return budget.best;};return runDownloadSpeedTest('');})()");
  assert.equal(result.mode, '单流估算'); assert.equal(result.mbps, 512 * 1024 * 8 / 300 / 1000);
  assert.equal(rt.now() - NOW, 8000); assert.equal(rt.calls.length, 3);
});
test('aggregate: duplicate callbacks never double-count bytes or create new requests', async () => {
  const rt = runtime({ speedReply: (q, bytes) => ({ body: { byteLength: bytes }, status: 200, delay: 800, duplicate: true }) });
  const value = await rt.run('(async()=>{const b=' + budgetCode + ";const state=await measureDownload('',512*1024,b);return {state,result:b.best};})()");
  assert.equal(value.result.mbps, 1.5 * MiB * 8 / 800 / 1000); assert.equal(value.state.failed, 0);
  assert.equal(value.state.completed, 3); assert.equal(rt.calls.length, 3);
});
test('aggregate: admission refuses an entire batch before starting any request', async () => {
  const rt = runtime();
  const value = await rt.run('(async()=>{const b=' + budgetCode + ";b.bytes=63*1024*1024;return measureDownload('',512*1024,b);})()");
  assert.equal(value.started, 0); assert.equal(rt.calls.length, 0);
});

for (const callbackDelay of [100, 300, 700]) test('sampler: native callback delay ' + callbackDelay + 'ms is included in elapsed', async () => {
  const rt = runtime({ speedMbps: 300, latency: 150, callbackDelay });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.ok(result.mbps > 0 && result.mbps < 300);
  assert.ok(rt.now() - NOW <= 8000 && rt.stats.peakSpeed <= 3 && speedBytes(rt) <= 64 * MiB);
});
test('sampler: end-to-end delayed complete callbacks still yield an estimate', async () => {
  const rt = runtime({ trigger: 'button', speedReply: (q, bytes) =>
    reply({ byteLength: bytes }, 200, {}, bytes <= 32 * 1024 ? 10 : 1800) });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.state, 'fresh'); assert.equal(result.mode, '单流估算');
  assert.equal(result.mbps, 0.5 * MiB * 8 / 1800 / 1000); assert.equal(result.elapsed, 1800);
  assert.equal(rt.calls.length, 2, 'predicted batch exceeds native timeout; retain the complete probe');
  assert.ok(rt.now() - NOW <= 8000);
});

for (const [reason, failure] of [
  ['http', reply({ byteLength: 0 }, 403)],
  ['timeout', { error: 'request timed out', delay: 100 }],
  ['body_mismatch', reply({ byteLength: 0 })],
  ['body_limit', { error: 'Response body exceeds size limit' }],
  ['transport', { error: 'private transport error' }],
  ['deadline', 'hang']
]) test('sampler: final batch ' + reason + ' preserves a complete single-stream probe', async () => {
  const rt = runtime({ trigger: 'button', speedMbps: 300, latency: 150, speedReply: (q, bytes) => bytes > 2 * MiB ? failure : undefined });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.state, 'fresh'); assert.equal(result.mode, '单流估算');
  assert.ok(Math.abs(result.mbps - 2 * MiB * 8 / (150 + 2 * MiB * 8 / 300 / 1000) / 1000) < 0.001);
  assert.equal(rt.calls.length, 6, 'one fixed failed batch; no shrinking or retry loop');
  assert.ok(rt.now() - NOW <= 8000 && rt.stats.peakSpeed <= 3);
  assert.equal(JSON.parse(rt.store.get(SPEED)).mbps, result.mbps);
});
test('sampler: failed optional enlargement cannot erase a complete single-stream result', async () => {
  const rt = runtime({ speedReply: (q, bytes) => bytes >= 8 * MiB ? reply('', 500) :
    reply({ byteLength: bytes }, 200, {}, bytes === 32768 ? 10 : bytes === 512 * 1024 ? 150 : bytes === 2 * MiB ? 600 : 300) });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.mode, '单流估算'); assert.ok(result.mbps > 0);
  assert.equal(rt.calls.length, 9, 'one too-short complete batch then one failed larger batch');
});
test('sampler: successful short batch enlarges once and never replenishes workers', async () => {
  const rt = runtime({ speedReply: (q, bytes) => reply({ byteLength: bytes }, 200, {},
    bytes === 32768 ? 10 : bytes === 512 * 1024 ? 150 : bytes === 2 * MiB ? 600 : bytes === 4 * MiB ? 300 : 900) });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.mode, '多流采样');
  assert.equal(rt.calls.length, 9); assert.equal(rt.stats.peakSpeed, 3);
  assert.equal(result.mbps, 24 * MiB * 8 / 900 / 1000);
  const counts = new Map();
  for (const q of rt.calls) counts.set(q.time, (counts.get(q.time) || 0) + 1);
  assert.deepEqual([...counts.values()], [1, 1, 1, 3, 3]);
  assert.ok(speedBytes(rt) <= 64 * MiB);
});

for (const bytes of [512 * 1024, 2 * MiB]) test('sampler: a qualified ' + bytes + '-byte response is retained with honest single-stream mode', async () => {
  let sent = 0;
  const rt = runtime({ trigger: 'button', speedReply: (q, size) => {
    sent++;
    if (size <= 32 * 1024) return reply({ byteLength: size });
    if (size < bytes) return reply({ byteLength: size }, 200, {}, 10);
    if (size === bytes && sent <= 3) return reply({ byteLength: size }, 200, {}, 300);
    return reply({ byteLength: 0 }, 503);
  } });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.state, 'fresh'); assert.equal(result.mode, '单流估算');
  assert.equal(result.mbps, bytes * 8 / 300 / 1000);
});
test('sampler: extremely short complete requests never become a credible aggregate rate', async () => {
  const rt = runtime({ speedReply: (q, bytes) => reply({ byteLength: bytes }, 200, {}, 1) });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.failure.reason, 'insufficient_samples'); assert.ok(rt.calls.length <= 9);
});
test('sampler: a probe near deadline stays single-stream without a late batch', async () => {
  const rt = runtime({ trigger: 'button', speedReply: (q, bytes) =>
    reply({ byteLength: bytes }, 200, {}, bytes <= 32 * 1024 ? 10 : NOW + 7950 - q.time) });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.state, 'fresh'); assert.equal(result.mode, '单流估算');
  assert.equal(result.elapsed, 7940); assert.equal(rt.calls.length, 2);
});
test('probe sizing: slower, faster and very fast paths choose progressively larger safe final blocks', async () => {
  const sizes = [];
  for (const mbps of [10, 100, 500]) {
    const rt = runtime();
    const transfer = bytes => bytes * 8 / mbps / 1000;
    sizes.push(await rt.run('chooseSpeedBlock(' +
      JSON.stringify({ bytes: 2 * MiB, elapsed: 150 + transfer(2 * MiB) }) + ',' +
      JSON.stringify({ bytes: 512 * 1024, elapsed: 150 + transfer(512 * 1024) }) + ',' +
      JSON.stringify({ ok: true, elapsed: 150 + transfer(32768) }) + ',' + budgetCode + ')'));
  }
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2]);
  assert.equal(sizes[0], 512 * 1024); assert.equal(sizes[2], 16 * MiB);
});

for (const bodyLimit of [60 * 1024, 48 * 1024, 32 * 1024]) test('sampler: response cap ' + bodyLimit + ' has bounded sequential recovery', async () => {
  const rt = runtime({ bodyLimit, speedMbps: 20, latency: 50 });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.mode, '小响应降级'); assert.ok(result.mbps > 0);
  assert.equal(rt.stats.peakSpeed, 1); assert.ok(rt.calls.length <= 14);
  assert.ok(speedBytes(rt) < MiB && rt.stats.peakTimers <= 1);
});
test('sampler: the last allowed small sample may complete the minimum evidence', async () => {
  const rt = runtime({ speedReply: (q, bytes) => bytes > 32 * 1024
    ? { error: 'Response body exceeds size limit', delay: 10 }
    : reply({ byteLength: bytes }, 200, {}, 10) });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.mode, '小响应降级'); assert.equal(result.elapsed, 100); assert.equal(rt.calls.length, 14);
});
for (const status of [403, 429, 500]) test('sampler: HTTP ' + status + ' during small fallback stops immediately', async () => {
  const rt = runtime({ speedReply: (q, bytes) => bytes >= 512 * 1024
    ? { error: 'Response body exceeds size limit' }
    : bytes > 32 * 1024 ? reply({ byteLength: 0 }, status) : undefined });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.failure.reason, 'http'); assert.equal(result.failure.status, status); assert.equal(rt.calls.length, 3);
});
for (const cap of [512 * 1024, 2 * MiB]) {
  for (const reason of ['body_limit', 'body_mismatch']) test('sampler: short complete ' + cap + '-byte blocks survive larger ' + reason, async () => {
    const rt = runtime({ speedMbps: 500, latency: 20, speedReply: (q, bytes) => bytes > cap
      ? reason === 'body_limit' ? { error: 'Response body exceeds size limit' } : reply({ byteLength: bytes - 1 }) : undefined });
    const result = await rt.run("runDownloadSpeedTest('')");
    assert.equal(result.mode, '小响应降级'); assert.ok(result.mbps > 0 && result.mbps <= 500);
    assert.ok(result.elapsed >= 100 && rt.stats.peakSpeed <= 3);
    assert.equal(rt.calls.filter(q => Number(new URL(q.url).searchParams.get('bytes')) > cap).length, cap === 512 * 1024 ? 1 : 3);
    assert.ok(rt.calls.length <= 16 && speedBytes(rt) <= 64 * MiB);
  });
}
test('sampler: a short earlier block never retries after explicit HTTP rejection', async () => {
  const rt = runtime({ speedMbps: 500, speedReply: (q, bytes) => bytes >= 2 * MiB ? reply({ byteLength: 0 }, 403) : undefined });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.equal(result.failure.reason, 'http'); assert.equal(result.failure.status, 403); assert.equal(rt.calls.length, 3);
});
test('sampler: mixed body failure and HTTP rejection must not trigger small-block retries', async () => {
  let n = 0;
  const rt = runtime({ speedMbps: 500, latency: 20, speedReply: (q, bytes) => bytes > 2 * MiB
    ? ++n === 1 ? reply('', 403) : { error: 'Response body exceeds size limit' } : undefined });
  const result = await rt.run("runDownloadSpeedTest('')");
  assert.ok(result.failure); assert.equal(rt.calls.length, 6);
});
test('sampler: watchdog closes admission and late batch successes cannot overwrite stored fallback', async () => {
  const rt = runtime({ trigger: 'button', speedMbps: 300, latency: 150, speedReply: (q, bytes) =>
    bytes > 2 * MiB ? reply({ byteLength: bytes }, 200, {}, 9000) : undefined });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.state, 'fresh'); assert.equal(result.mode, '单流估算');
  const saved = rt.store.get(SPEED), count = rt.calls.length;
  await rt.run('new Promise(resolve => setTimeout(resolve, 10000))');
  assert.equal(rt.store.get(SPEED), saved); assert.equal(rt.calls.length, count);
});

for (const mode of ['多流采样', '单流估算', '小响应降级']) test('speed modes: ' + mode + ' survives caching without becoming fresh or triggering downloads', async () => {
  const rt = runtime();
  const result = { mbps: 123, time: NOW - 60000, ip: IP, mode, elapsed: 900, streams: 3, started: 3 };
  assert.equal(await rt.run('saveSpeedResult(' + JSON.stringify(result) + ')'), true);
  const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(value.mode, mode); assert.notEqual(value.state, 'fresh'); assert.equal(rt.calls.length, 0);
  const text = await rt.run('(()=>{const a=[];appendSpeedLines(a,' + JSON.stringify(value) + ");return a.join('\\n');})()");
  assert.match(text, new RegExp(mode)); assert.doesNotMatch(text, /[●○]/);
});
for (const fields of [{}, { version: 1, mode: '双样本采样' }, { version: 2, mode: '多流采样', elapsed: 300, streams: 3, started: 3 },
  { version: 2, mode: '多流采样', elapsed: 900, streams: 1, started: 3 }]) test('speed cache: unproven legacy/schema mode stays history ' + JSON.stringify(fields), async () => {
  const rt = runtime({ store: new Map([[SPEED, JSON.stringify({ mbps: 11.2, time: NOW - 60000, ip: IP, ...fields })]]) });
  const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(value.mode, '历史采样'); assert.equal(value.time, NOW - 60000); assert.equal(rt.calls.length, 0);
});
test('speed UI: small-body single-stream fallback has no node-throughput bar', async () => {
  const rt = runtime();
  const text = await rt.run("(()=>{const a=[];appendSpeedLines(a,{state:'fresh',mode:'小响应降级',mbps:20});return a.join('\\n');})()");
  assert.match(text, /^单流 /); assert.match(text, /小响应降级/); assert.doesNotMatch(text, /[●○]/);
});

test('throughput regression: a per-stream ceiling must lead to a real fixed multi-stream measurement', async () => {
  const rt = runtime({ trigger: 'button', speedMbps: 300, streamMbps: 20, latency: 100 });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(result.mode, '多流采样');
  assert.ok(rt.stats.peakSpeed >= 3, 'final stage must actually issue concurrent requests');
  assert.ok(result.mbps > 40 && result.mbps <= 60, 'finite three-stream throughput, not a fabricated 300 Mbps');
});
test('throughput regression: a single-stream result must not use the node-throughput bar', async () => {
  const rt = runtime();
  const lines = await rt.run("(()=>{const lines=[];appendSpeedLines(lines,{state:'fresh',mode:'单流估算',mbps:23.2});return lines.join('\\n');})()");
  assert.match(lines, /单流估算/);
  assert.doesNotMatch(lines, /[●○]/);
});
