// Temporary endpoint-contract probe; removed before merge. No capacity benchmark.
for (const bytes of [32768, 524288, 4194304]) {
  const url = 'https://speed.cloudflare.com/__down?bytes=' + bytes;
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(8000), headers: { 'Accept-Encoding': 'identity' } });
    const body = await response.arrayBuffer();
    console.log(JSON.stringify({ url, method: 'GET', status: response.status,
      contentType: response.headers.get('content-type'), requestedBytes: bytes,
      actualBytes: body.byteLength, retryAfter: response.headers.get('retry-after') }));
  } catch {
    console.log(JSON.stringify({ url, method: 'GET', failure: 'request_failed_or_timeout' }));
  }
}
