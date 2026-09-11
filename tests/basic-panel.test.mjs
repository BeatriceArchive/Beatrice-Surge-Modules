import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../Scripts/Betty-Basic-Panel.js', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 8, 11, 12);
const IP = '8.8.4.4', OTHER = '1.1.1.1';
const INTEL = 'betty.basic.intel.v1', SPEED = 'betty.basic.speed';
const who = (ip = IP, country = 'HK', asn = 15169) => ({ ip, success: true, country_code: country, country: country === 'HK' ? 'Hong Kong' : 'Singapore', connection: { asn, org: 'Example Networks' } });
const api = (ip = IP, country = 'HK', flags = {}) => ({ ip, location: { country_code: country }, asn: { asn: 15169, org: 'Example Networks' }, ...flags });
const pc = (ip = IP, detections = {}, type = 'Hosting') => ({ status: 'ok', [ip]: { network: { type }, detections: { vpn: true, proxy: false, tor: false, hosting: type === 'Hosting', risk: 50, confidence: 98, ...detections } } });
const reply = (body, status = 200, headers = {}, delay = 10) => ({ body, status, headers, delay });

function defaultReply(q) {
  const u = new URL(q.url);
  if (u.hostname === 'speed.cloudflare.com' && u.pathname === '/meta') return reply({ clientIp: IP, country: 'HK', asn: 15169, asOrganization: 'Example Networks' });
  if (u.hostname === 'ipwho.is') return reply(who(u.pathname.length > 1 ? decodeURIComponent(u.pathname.slice(1)) : IP));
  if (u.hostname === 'api.ipapi.is') return reply(api(u.searchParams.get('q'), 'HK', { is_vpn: true, is_proxy: false, is_tor: false, is_datacenter: true }));
  if (u.hostname === 'proxycheck.io') return reply(pc(decodeURIComponent(u.pathname.slice(4))));
  if (u.hostname === 'api.ipify.org') return reply({ ip: IP });
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
  speedMbps = 100, latency = 20, bodyLimit = Infinity, failSpeed = false, clockStart = NOW, failStore = false } = {}) {
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
      if (failSpeed === 'hang') return;
      if (failSpeed) r = { error: 'fixture failure', delay: 10 };
      else if (size > bodyLimit) r = { error: 'Response body exceeds size limit', delay: latency };
      else {
        wireFree = Math.max(clock + latency, wireFree) + size * 8 / speedMbps / 1000;
        r = { body: { byteLength: size }, status: 200, delay: wireFree - clock };
      }
    } else r = respond(q);
    if (r === 'hang') return;
    if (r === null) r = { error: 'network timeout', delay: 10 };
    schedule(() => {
      active--; if (speed) activeSpeed--;
      callback(r.error || null, r.error && !r.responseOnError ? null : { status: r.status ?? 200, headers: r.headers || {} },
        speed ? r.body : typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
    }, r.delay ?? 10, 'network');
  }]));
  const context = vm.createContext({
    Date: Clock, Math, Uint8Array, ArrayBuffer, console: { log: (...args) => logs.push(args) },
    setTimeout: (fn, ms) => schedule(fn, ms, 'timer'),
    $network: network, $trigger: trigger, $input: { purpose: 'panel', panelName: '贝蒂的基础面板' }, $argument: argument,
    $persistentStore: { read: k => store.get(k) || '', write: (v, k) => {
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

for (const scenario of [
  { name: 'agreement', countries: ['HK', 'HK'], expected: 'HK', count: 3, total: 3, disagreement: false },
  { name: 'majority with disagreement', countries: ['SG', 'HK'], expected: 'HK', count: 2, total: 3, disagreement: true },
  { name: 'one Geo source fails', countries: [null, 'HK'], expected: 'HK', count: 2, total: 2, disagreement: false },
  { name: 'two-source tie has no invented winner', countries: ['SG', null], expected: '', count: 1, total: 2, disagreement: true }
]) test(`geo: ${scenario.name}`, async () => {
  const rt = runtime({ respond: q => {
    const u = new URL(q.url);
    if (u.hostname === 'ipwho.is') return scenario.countries[0] ? reply(who(IP, scenario.countries[0])) : null;
    if (u.hostname === 'api.ipapi.is') return scenario.countries[1] ? reply(api(IP, scenario.countries[1])) : null;
    return defaultReply(q);
  } });
  const { exit } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.country, scenario.expected); assert.equal(exit.countryVote.count, scenario.count);
  assert.equal(exit.countryVote.total, scenario.total); assert.equal(exit.countryVote.disagreement, scenario.disagreement);
});

test('geo: all discovery sources fail without old exit or risk data', async () => {
  const store = new Map([[INTEL, JSON.stringify({ version: 1, ip: IP, entries: { IPWho: { time: NOW, data: who() } } })]]);
  const rt = runtime({ store, respond: () => null });
  const value = await rt.run("getNetworkIntelligence('')");
  assert.equal(value.exit.ip, ''); assert.equal(value.exit.countryVote.total, 0); assert.equal(value.risk.available, false);
  assert.equal(rt.calls.length, 3);
});

test('geo: fallback discovery is reused, never queried twice or counted twice', async () => {
  const rt = runtime({ respond: q => q.url.includes('/meta') ? null : defaultReply(q) });
  const { exit } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.ip, IP); assert.equal(exit.countryVote.total, 2);
  assert.equal(rt.calls.filter(q => new URL(q.url).hostname === 'ipwho.is').length, 1);
});

test('geo: explicit same-IP queries ignore data for another route/exit', async () => {
  const rt = runtime({ respond: q => q.url.includes('ipwho.is') ? reply(who(OTHER)) : defaultReply(q) });
  const { exit } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.countryVote.total, 2);
  for (const q of rt.calls.filter(q => /ipwho.is|api.ipapi.is|proxycheck.io/.test(q.url))) assert.ok(q.url.includes(IP));
});

test('geo: current anonymous IPAPI name/ASN shape contributes only matching geography, never risk', async () => {
  const rt = runtime({ respond: q => q.url.includes('api.ipapi.is') ? reply({ ip: IP, country: 'Hong Kong', company: 'Example Networks', asn: 'AS15169 Example Networks' }) : defaultReply(q) });
  const value = await rt.run("getNetworkIntelligence('')");
  assert.equal(value.exit.countryVote.count, 3); assert.equal(value.exit.asnVote.count, 3);
  assert.equal(value.risk.count, 1); assert.equal(value.risk.comparable, 0);
  rt.context.risk = value.risk;
  const text = await rt.run('(()=>{const lines=[];appendRiskLines(lines,risk);return lines.join("\\n")})()');
  assert.match(text, /IPAPI：无风险字段/); assert.match(text, /未交叉确认/);
});

test('geo: ASN ties and organization aliases do not acquire false consensus', async () => {
  const rt = runtime({ argument: 'RISK=0', respond: q => q.url.includes('ipwho.is') ? reply(who(IP, 'HK', 13335)) : defaultReply(q) });
  const { exit } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.asn, null); assert.equal(exit.org, ''); assert.equal(exit.asnVote.disagreement, true);
});

test('cache: same exit uses bounded cache; switching IP invalidates every Geo/reputation entry', async () => {
  const store = new Map();
  const first = runtime({ store }); await first.run("getNetworkIntelligence('')");
  const same = runtime({ store, clockStart: NOW + 1000 }); await same.run("getNetworkIntelligence('')");
  assert.equal(same.calls.length, 1, 'fresh exit observation is mandatory even with cache');
  const next = runtime({ store, clockStart: NOW + 2000, respond: q => q.url.includes('/meta') ? reply({ clientIp: OTHER, country: 'SG', asn: 13335 }) : defaultReply(q) });
  const { exit } = await next.run("getNetworkIntelligence('')");
  assert.equal(exit.ip, OTHER); assert.equal(next.calls.length, 4);
  assert.equal(JSON.parse(store.get(INTEL)).ip, OTHER);
  assert.equal(next.calls.slice(1).every(q => q.url.includes(OTHER)), true);
  const expired = runtime({ store, clockStart: NOW + 7200000 }); await expired.run("getNetworkIntelligence('')");
  assert.equal(expired.calls.length, 4);
});

for (const failure of ['{', '[]', '{}', 'null', '{"version":1,"ip":"8.8.4.4","entries":null}']) test(`cache: malformed record ${failure}`, async () => {
  const rt = runtime({ store: new Map([[INTEL, failure]]) });
  const { exit } = await rt.run("getNetworkIntelligence('')"); assert.equal(exit.country, 'HK');
});

test('reputation: source scores and comparable signals agree without a purity score', async () => {
  const rt = runtime(); const value = await rt.run("getNetworkIntelligence('')");
  assert.equal(value.risk.risk, 50); assert.equal(value.risk.confidence, 98);
  assert.equal(value.risk.count, 2); assert.equal(value.risk.conflicts, 0); assert.equal(value.risk.comparable, 4);
  rt.context.risk = value.risk;
  const lines = await rt.run('(()=>{const l=[];appendRiskLines(l,risk);return l.join("\\n")})()');
  assert.match(lines, /PC Risk 50\/100/); assert.match(lines, /2\/2/); assert.doesNotMatch(lines, /纯净|综合.*分/);
});

test('reputation: ProxyCheck failure degrades to available IPAPI signals without inventing a score', async () => {
  const rt = runtime({ respond: q => q.url.includes('proxycheck.io') ? null : defaultReply(q) });
  const { risk } = await rt.run("getNetworkIntelligence('')");
  assert.equal(risk.available, true); assert.equal(risk.count, 1); assert.equal(risk.risk, null);
});

test('reputation: conflicting comparable signals are explicit; hosting plus VPN alone is not a conflict', async () => {
  const rt = runtime({ respond: q => q.url.includes('api.ipapi.is') ? reply(api(IP, 'HK', { is_vpn: false, is_datacenter: true })) : defaultReply(q) });
  const { risk } = await rt.run("getNetworkIntelligence('')"); assert.equal(risk.conflicts, 1); assert.equal(risk.comparable, 2);
  const onlyHosting = runtime({ respond: q => q.url.includes('api.ipapi.is') ? reply(api(IP, 'HK', { is_datacenter: true })) : defaultReply(q) });
  assert.equal((await onlyHosting.run("getNetworkIntelligence('')")).risk.conflicts, 0);
});

for (const response of [reply('{'), reply([], 200), reply(pc(OTHER)), reply(pc(IP, { risk: '99', confidence: null })), reply({ status: 'denied' })]) test(`reputation: malformed/wrong-IP/missing numeric data ${JSON.stringify(response.body).slice(0,45)}`, async () => {
  const rt = runtime({ respond: q => q.url.includes('proxycheck.io') ? response : defaultReply(q) });
  const { risk } = await rt.run("getNetworkIntelligence('')"); assert.equal(risk.risk, null); assert.equal(risk.highRisk, false);
});

test('rate limit: 429 honors Retry-After, survives IP changes and does not retry in a run', async () => {
  const store = new Map();
  const first = runtime({ store, respond: q => q.url.includes('api.ipapi.is') ? reply({ error: 'ERR_FREE_TIER_EXHAUSTED' }, 429, { 'Retry-After': '86400' }) : defaultReply(q) });
  await first.run("getNetworkIntelligence('')");
  assert.equal(first.calls.filter(q => q.url.includes('api.ipapi.is')).length, 1);
  const next = runtime({ store, clockStart: NOW + 1000, respond: q => q.url.includes('/meta') ? reply({ clientIp: OTHER, country: 'SG' }) : defaultReply(q) });
  await next.run("getNetworkIntelligence('')");
  assert.equal(next.calls.filter(q => q.url.includes('api.ipapi.is')).length, 0);
  const later = runtime({ store, clockStart: NOW + 86401000 }); await later.run("getNetworkIntelligence('')");
  assert.equal(later.calls.filter(q => q.url.includes('api.ipapi.is')).length, 1);
});

test('sources: hung API callback is bounded independently', async () => {
  const rt = runtime({ respond: q => q.url.includes('ipwho.is') ? 'hang' : defaultReply(q) });
  const { exit } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.countryVote.total, 2); assert.ok(rt.now() - NOW <= 7100);
});

for (const [status, state] of [[200, 'reachable'], [302, 'reachable'], [401, 'restricted'], [403, 'restricted'], [429, 'restricted'], [405, 'unknown'], [500, 'unknown']]) test(`AI/site: HTTP ${status} means ${state}, not full availability`, async () => {
  const rt = runtime({ respond: () => reply('', status) });
  const result = await rt.run("testAIReachable('https://chatgpt.com/','')");
  assert.equal(result.state, state); assert.doesNotMatch(result.label, /✓|完整|解锁/);
  assert.equal(rt.calls.length, 1); assert.equal(rt.calls[0].method, 'head'); assert.equal(rt.calls[0]['auto-redirect'], false);
});

test('AI/site: network timeout is unreachable', async () => {
  const rt = runtime({ respond: () => null }); assert.equal((await rt.run("testAIReachable('https://claude.ai/','')")).state, 'unreachable');
});

test('Netflix: full regional title-page evidence still does not claim playback unlock', async () => {
  const rt = runtime(); const result = await rt.run("testNetflix('')");
  assert.equal(result.label, '样片可达 🇭🇰'); assert.doesNotMatch(result.label, /解锁|完整/);
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
  assert.match(text, /IPv6 本地有 · VIF 未知/); assert.match(text, /IPv6 出口未测/);
  assert.doesNotMatch(text, /IPv6 ✓|VIF 关闭|IPv6 已启用/);
  assert.match(await rt.run("formatIPv6('','2001:4860:4860::8888')"), /观测出口 IPv6 可达/);
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
  assert.equal(await rt.run("inferNAT('192.168.1.3')"), '私网 / NAT 推断');
  assert.equal(await rt.run("inferNAT('')"), 'NAT 未测');
  assert.equal(await rt.run('fmtMs(null)'), '未知');
  for (const delay of [0.002, 5, 25]) {
    const r = runtime({ apiReply: () => ({ delay }) }); assert.equal(await r.run('getDNSDelay()'), 25, 'observed API wall time, no guessed unit');
  }
});

for (const trigger of ['auto-interval', 'editor', 'http-api', 'intent', '', undefined]) test(`speed: ${String(trigger)} cannot download`, async () => {
  const rt = runtime({ trigger }); await rt.run("getSpeedForThisRun('', '8.8.4.4')"); assert.equal(rt.calls.length, 0);
});

for (const [speedMbps, mode] of [[25, '低速采样'], [200, '中速采样'], [500, '高速采样']]) test(`speed: adaptive ${speedMbps} Mbps path is bounded and never exceeds link capacity`, async () => {
  const rt = runtime({ trigger: 'button', speedMbps });
  const result = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.ok(result && result.mbps > 0, JSON.stringify(result)); assert.equal(result.mode, mode);
  assert.ok(result.mbps <= speedMbps * 1.001); assert.ok(result.mbps > speedMbps * 0.5, 'avoid gross underestimate on controlled link');
  assert.ok(rt.now() - NOW <= 8000); assert.ok(rt.stats.peakSpeed <= 4);
  const downloads = rt.calls.filter(q => q.url.includes('/__down'));
  const total = downloads.reduce((n, q) => n + Number(new URL(q.url).searchParams.get('bytes')), 0);
  assert.ok(total <= 128 * 1024 * 1024); assert.ok(downloads.length <= 256);
  if (speedMbps < 150) assert.ok(total < 20 * 1024 * 1024);
  assert.ok(rt.store.has(SPEED));
});

test('speed: legacy small body limits use bounded safe fallback and label its limitation', async () => {
  const rt = runtime({ trigger: 'button', speedMbps: 20, bodyLimit: 64 * 1024 });
  const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.equal(value.mode, '小响应降级'); assert.ok(rt.stats.peakSpeed <= 4);
});

test('speed: network failure and hung callback preserve last success and its timestamp', async () => {
  for (const failSpeed of [true, 'hang']) {
    const saved = JSON.stringify({ mbps: 300, mbPerSecond: 37.5, time: NOW - 3600000, ip: IP });
    const rt = runtime({ trigger: 'button', failSpeed, store: new Map([[SPEED, saved]]) });
    const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
    assert.equal(value.mbps, 300); assert.equal(value.time, NOW - 3600000); assert.match(value.notice, /本次失败/);
    assert.equal(rt.store.get(SPEED), saved); assert.ok(rt.now() - NOW <= 8000);
  }
});

test('speed: rapid second button press cannot add downloads; cache from another exit is marked', async () => {
  const rt = runtime({ trigger: 'button', speedMbps: 25 });
  await rt.run("getSpeedForThisRun('', '8.8.4.4')"); const count = rt.calls.length;
  const again = await rt.run("getSpeedForThisRun('', '1.1.1.1')");
  assert.equal(rt.calls.length, count); assert.equal(again.otherExit, true); assert.match(again.notice, /冷却/);
});

test('speed: bytes never come from string length or Content-Length, bar is labelled 500 Mbps', async () => {
  const rt = runtime();
  assert.equal(await rt.run("binaryLength('x'.repeat(8192))"), 0);
  assert.equal(await rt.run("binaryLength(new Uint8Array(37))"), 37);
  assert.match(await rt.run('speedResultBar(500)'), /^●{10} · 满格 500 Mbps$/);
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
  assert.equal(rt.done.length, 1); assert.equal(rt.calls.length, 18); assert.ok(rt.stats.peak <= 20);
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
  assert.match(rt.done[0].content, /ChatGPT 受限 403/); assert.match(rt.done[0].content, /IPv6 本地未发现/);
});

test('main: all sources failing still renders local information without leaking original error bodies', async () => {
  const secret = 'fixture-token-cookie-authorization';
  const rt = runtime({ respond: () => ({ error: `failed URL ${secret}`, delay: 10 }) });
  await rt.run('main()'); assert.equal(rt.done.length, 1); assert.match(rt.done[0].content, /出口 IP 未识别/);
  assert.equal(JSON.stringify([rt.done, rt.logs, rt.writes]).includes(secret), false); assert.equal(rt.done[0]['icon-color'], '#FF453A');
});

test('module: exactly one panel, privacy defaults and no extra interception or forced policy', () => {
  const module = readFileSync(new URL('../Modules/Betty-Basic-Panel.sgmodule', import.meta.url), 'utf8');
  assert.equal((module.match(/^\[Panel\]$/gm) || []).length, 1);
  assert.match(module, /^贝蒂的基础面板 = script-name=Betty-Basic-Panel, update-interval=1800$/m);
  assert.match(module, /argument="YS=1&RISK=1"/);
  assert.doesNotMatch(module, /\[(?:MITM|Rule|URL Rewrite|Header Rewrite)\]|POLICY=/);
});

test('reputation: live v3 shape uses detection booleans separately from network allocation', async () => {
  const rt = runtime();
  rt.context.sample = pc(IP, { hosting: false, vpn: false, risk: 31, confidence: 100 }, 'Hosting');
  const parsed = await rt.run("parseProxyCheck(sample,'8.8.4.4')");
  assert.equal(parsed.signals.hosting, false); assert.equal(parsed.type, 'Hosting');
  assert.equal(parsed.risk, 31); assert.equal(parsed.confidence, 100);
  rt.context.parsed = parsed;
  assert.equal(await rt.run('signalLabel(parsed)'), '机房分配');
  rt.context.sample[IP].detections.compromised = true;
  assert.match(await rt.run("signalLabel(parseProxyCheck(sample,'8.8.4.4'))"), /失陷标记/);
});

test('geo: unnormalized country names are flagged, not guessed or counted as disagreement', async () => {
  const rt = runtime({ respond: q => q.url.includes('api.ipapi.is') ? reply({ ip: IP, country: 'Unmapped fixture country', asn: 'AS15169 Example' }) : defaultReply(q) });
  const { exit } = await rt.run("getNetworkIntelligence('')");
  assert.equal(exit.countryVote.total, 2); assert.equal(exit.unmappedCountry, true); assert.equal(exit.countryVote.disagreement, false);
  rt.context.exit = exit; assert.match(await rt.run('geoAgreementLine(exit)'), /名称待核对/);
});

test('geo: placeholder country and invalid ASN do not add confident metadata', async () => {
  const rt = runtime();
  rt.context.d = { clientIp: IP, country: 'XX', asn: 1e20, asOrganization: '' };
  const result = await rt.run('parseCloudflare(d)'); assert.equal(result.country, ''); assert.equal(result.asn, null);
  const v = await rt.run("vote(['constructor','constructor','other'])"); assert.equal(v.count, 2); assert.equal(v.value, 'constructor');
});

test('profile: malformed numeric suffixes and contradictory duplicate fields are not traffic data', async () => {
  const rt = runtime();
  for (const header of ['upload=1e9; download=2; total=100', 'upload=1; download=2; total=100junk', 'upload=1; download=2; total=100; total=200']) {
    rt.context.header = header; assert.equal((await rt.run('parseSubscriptionUserInfo(header)')).available, false);
  }
});

for (const [speedMbps, latency] of [[100, 5], [300, 80], [500, 150], [800, 50]]) test(`speed: ${speedMbps} Mbps / ${latency}ms RTT never exceeds four active workers across stages`, async () => {
  const rt = runtime({ trigger: 'button', speedMbps, latency });
  const value = await rt.run("getSpeedForThisRun('', '8.8.4.4')");
  assert.ok(value && value.mbps > 0); assert.ok(value.mbps <= speedMbps * 1.001);
  assert.ok(value.mbps >= speedMbps * 0.5, 'controlled network should avoid >50% underestimation');
  assert.ok(rt.stats.peakSpeed <= 4); assert.ok(rt.now() - NOW <= 8000);
  assert.ok(rt.calls.reduce((n, q) => n + Number(new URL(q.url).searchParams.get('bytes')), 0) <= 128 * 1024 * 1024);
});

test('main: button performs bounded adaptive test, explicit policy stays out of diagnostics', async () => {
  const policy = 'fixture-private-policy';
  const rt = runtime({ trigger: 'button', speedMbps: 500, argument: 'YS=1&RISK=1&POLICY=' + policy });
  await rt.run('main()'); assert.equal(rt.done.length, 1); assert.ok(rt.stats.peakSpeed <= 4);
  assert.match(rt.done[0].content, /下载估算.*Mbps/); assert.match(rt.done[0].content, /高速采样/);
  assert.equal(JSON.stringify([rt.logs, rt.writes, rt.done]).includes(policy), false);
  assert.ok(rt.calls.filter(q => !q.url.includes('gstatic.com')).every(q => q.policy === policy));
  assert.ok(rt.done[0].content.split('\n').length <= 38, 'single panel remains bounded in height');
});

test('parameters: RISK=0 makes no reputation query; YS=0 deliberately reveals IP', async () => {
  const rt = runtime({ argument: 'RISK=0&YS=0' }); await rt.run('main()');
  assert.equal(rt.calls.some(q => /proxycheck.io|api.ipapi.is/.test(q.url)), false);
  assert.match(rt.done[0].content, /IP 信誉 · 已关闭/); assert.ok(rt.done[0].content.includes(IP));
});

test('cache: malformed nested source data is refetched independently rather than crashing the panel', async () => {
  const store = new Map(); const first = runtime({ store }); await first.run("getNetworkIntelligence('')");
  const cache = JSON.parse(store.get(INTEL)); cache.entries.IPAPI.data.countryName = { malformed: true };
  store.set(INTEL, JSON.stringify(cache));
  const rt = runtime({ store, clockStart: NOW + 1000 }); await rt.run('main()');
  assert.equal(rt.done.length, 1); assert.match(rt.done[0].content, /Geo 3\/3/);
  assert.equal(rt.calls.filter(q => /ipapi.is/.test(q.url)).length, 1);
  assert.equal(rt.calls.filter(q => /proxycheck.io|ipwho.is/.test(q.url)).length, 0);
});

test('media: transport error with partial HTTP 200 body cannot establish catalogue or Premium evidence', async () => {
  for (const fn of ['testNetflix', 'testYouTubePremium']) {
    const rt = runtime({ respond: () => ({ error: 'truncated response', responseOnError: true, status: 200,
      body: '<title>Netflix</title>/title/81280792 {"ypcOffers":[{"ypcOfferId":"fixture"}]}' }) });
    const value = await rt.run(fn + "('')"); assert.equal(value.state, 'unreachable'); assert.equal(value.label, '不可达');
  }
});
