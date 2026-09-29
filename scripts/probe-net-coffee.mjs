// Temporary read-only investigation; removed before release.
const ORIGIN = 'https://ip.net.coffee';
const seen = new Set();
const assetURLs = new Set();
const sampleIPs = new Set(['1.1.1.1', '8.8.8.8']);
function redact(value) {
  return String(value).replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ip => sampleIPs.has(ip) ? ip : '<ip>')
    .replace(/((?:token|authorization|cookie|secret|api[_-]?key)\s*[:=]\s*)['"][^'"]+['"]/ig, '$1"<redacted>"');
}
function print(value) { console.log(JSON.stringify(value)); }
function permitted(value, base = ORIGIN) {
  try { const u = new URL(value, base); return u.origin === ORIGIN && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}
async function read(url, kind) {
  if (seen.has(url)) return '';
  seen.add(url);
  let response;
  try {
    response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: { Accept: kind === 'html' ? 'text/html' : '*/*', 'User-Agent': 'Beatrice-Surge-Modules-public-contract-audit' } });
    const reader = response.body?.getReader(); const chunks = []; let size = 0;
    if (reader) while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); print({ url, method: 'GET', status: response.status, result: 'body limit' }); return ''; } chunks.push(value); }
    const text = Buffer.concat(chunks).toString('utf8');
    print({ url, method: 'GET', status: response.status, contentType: response.headers.get('content-type'),
      retryAfter: response.headers.get('retry-after'), bytes: size });
    if (!response.ok) return '';
    const scripts = [...text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => permitted(m[1], url)).filter(Boolean);
    scripts.forEach(u => assetURLs.add(u)); if (scripts.length) print({ url, publicScriptURLs: scripts });
    const refs = [...text.matchAll(/["'\x60]([^"'\x60\n]{0,200}(?:\/api\/|geoip|iprisk|trustScore|ipify|ipwho|net\.coffee)[^"'\x60\n]{0,200})["'\x60]/gi)]
      .slice(0,30).map(m => redact(m[1]));
    const windows = []; const pattern = /(?:fetch\s*\(|axios\.|\/api\/|trustScore|currentIP|currentIp)/g; let match;
    while ((match = pattern.exec(text)) && windows.length < 18) {
      const start = Math.max(0, match.index - 100), end = Math.min(text.length, match.index + 260);
      if (!windows.some(x => Math.abs(x.index - match.index) < 180)) windows.push({ index: match.index, sample: redact(text.slice(start, end).replace(/\s+/g, ' ')) });
    }
    if (refs.length || windows.length) print({ url, boundedPublicResponseEvidence: { references: refs, samples: windows } });
    return text;
  } catch (error) { print({ url, method: 'GET', status: response?.status || null, error: error.name || 'network error' }); return ''; }
}
for (const path of ['/', '/ip/', '/ip/1.1.1.1']) await read(ORIGIN + path, 'html');
for (const url of [...assetURLs].slice(0,12)) await read(url, 'script');
