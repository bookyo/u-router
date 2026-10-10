const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer } = require('node:http');
const { createApp } = require('../src/app');
const { ReadRateLimiter } = require('../src/rate-limit');

async function service(t, options = {}) {
  let time = 1700000000000;
  const app = createApp({ apiKey: 'read-write-key', databasePath: ':memory:', now: () => time, ...options });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); app.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(path = '/v2/terms', headers = {}, method = 'GET', payload) {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const created = await request('/v2/terms', { 'x-api-key': 'read-write-key' }, 'POST', {
    translations: { en: ['Cache'], 'zh-Hans': ['缓存'] }, details: { en: { body: '# Cache' } },
  });
  assert.equal(created.status, 201);
  return { request, advance: (ms) => { time += ms; }, id: created.body.id };
}

test('anonymous reads share 20 requests per IP across v1/v2 search, detail and taxonomy', async (t) => {
  const s = await service(t);
  const paths = [
    '/v2/terms', '/v2/terms?q=cache&from=en', `/v2/terms/${s.id}`,
    `/v2/terms/${s.id}/content?language=en`, `/v2/terms/${s.id}/children`, `/v2/terms/${s.id}/ancestors`,
    '/v2/types', '/v2/tags', '/v2/categories', '/v1/terms?q=cache&from=en&to=zh-Hans',
  ];
  for (let i = 0; i < 20; i++) {
    const response = await s.request(paths[i % paths.length]);
    assert.equal(response.status, 200, paths[i % paths.length]);
    assert.equal(response.headers.get('ratelimit-limit'), '20');
    assert.equal(response.headers.get('ratelimit-remaining'), String(19 - i));
  }
  const blocked = await s.request();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(blocked.headers.get('ratelimit-remaining'), '0');
});

test('rolling window expires only old requests instead of allowing a boundary burst', async (t) => {
  const s = await service(t);
  for (let i = 0; i < 10; i++) assert.equal((await s.request()).status, 200);
  s.advance(30000);
  for (let i = 0; i < 10; i++) assert.equal((await s.request()).status, 200);
  assert.equal((await s.request()).status, 429);
  s.advance(29999);
  const wait = await s.request();
  assert.equal(wait.status, 429);
  assert.equal(wait.headers.get('retry-after'), '1');
  s.advance(1);
  for (let i = 0; i < 10; i++) assert.equal((await s.request()).status, 200);
  assert.equal((await s.request()).status, 429);
  s.advance(30000);
  assert.equal((await s.request()).status, 200);
});

test('valid API key and Bearer token bypass exhausted anonymous quota without consuming it', async (t) => {
  const s = await service(t);
  for (let i = 0; i < 20; i++) assert.equal((await s.request()).status, 200);
  for (let i = 0; i < 60; i++) {
    const headers = i % 2 ? { authorization: 'Bearer read-write-key' } : { 'x-api-key': 'read-write-key' };
    const response = await s.request('/v2/terms', headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('ratelimit-limit'), null);
  }
  assert.equal((await s.request()).status, 429);
});

test('trusted proxy resolves separate clients and ignores forged leftmost forwarded addresses', async (t) => {
  const s = await service(t, { trustedProxyIps: ['127.0.0.1', '::1'] });
  for (let i = 0; i < 20; i++) assert.equal((await s.request('/v2/terms', { 'x-forwarded-for': `203.0.113.${i + 1}, 198.51.100.1` })).status, 200);
  assert.equal((await s.request('/v2/terms', { 'x-forwarded-for': '203.0.113.99, 198.51.100.1' })).status, 429);
  assert.equal((await s.request('/v2/terms', { 'x-forwarded-for': '198.51.100.2' })).status, 200);
});

test('untrusted forwarded headers cannot create new IP quotas; health stays exempt', async (t) => {
  const s = await service(t);
  for (let i = 0; i < 20; i++) assert.equal((await s.request('/v2/terms', { 'x-forwarded-for': `198.51.100.${i + 1}` })).status, 200);
  assert.equal((await s.request('/v2/terms', { 'x-forwarded-for': '203.0.113.1', 'x-real-ip': '203.0.113.2' })).status, 429);
  for (let i = 0; i < 25; i++) assert.equal((await s.request('/health')).status, 200);
});

test('writes still require a valid key and invalid supplied read credentials return 401', async (t) => {
  const s = await service(t);
  assert.equal((await s.request('/v2/terms', { 'x-api-key': 'wrong' })).status, 401);
  assert.equal((await s.request('/v2/terms', { authorization: 'Bearer wrong' })).status, 401);
  for (const [path, method, payload] of [
    ['/v2/terms', 'POST', {}], [`/v2/terms/${s.id}`, 'PATCH', {}], [`/v2/terms/${s.id}`, 'DELETE'],
    [`/v2/terms/${s.id}/names`, 'POST', {}], ['/v2/tags', 'POST', {}], ['/v1/terms', 'POST', {}],
  ]) assert.equal((await s.request(path, {}, method, payload)).status, 401);
  assert.equal((await s.request(`/v2/terms/${s.id}`)).status, 200);
  assert.equal((await s.request(`/v2/terms/${s.id}`, { 'x-api-key': 'read-write-key' }, 'PATCH', { details: { en: { summary: 'Updated' } } })).status, 200);
});

test('equivalent IPv4-mapped and expanded IPv6 addresses share their canonical quotas', async (t) => {
  const s = await service(t, { trustedProxyIps: ['127.0.0.1'] });
  for (const addresses of [
    ['198.51.100.1', '::ffff:c633:6401', '::ffff:198.51.100.1'],
    ['2001:db8::1', '2001:0DB8:0:0:0:0:0:1'],
  ]) {
    for (let i = 0; i < 20; i++) {
      assert.equal((await s.request('/v2/terms', { 'x-forwarded-for': addresses[i % addresses.length] })).status, 200);
    }
    assert.equal((await s.request('/v2/terms', { 'x-forwarded-for': addresses[0] })).status, 429);
  }
});

test('malformed forwarded chains fall back to the peer quota and anonymous failures also count', async (t) => {
  const s = await service(t, { trustedProxyIps: ['127.0.0.1'] });
  for (let i = 0; i < 20; i++) assert.equal((await s.request('/v2/terms/999999')).status, 404);
  assert.equal((await s.request('/v2/terms', { 'x-forwarded-for': '203.0.113.1, not-an-ip' })).status, 429);
  assert.throws(() => createApp({ apiKey: 'key', databasePath: ':memory:', trustedProxyIps: ['not-an-ip'] }), /invalid IP/);
});

test('limiter bounds active IP memory without evicting quotas and reclaims expired records', () => {
  let time = 0;
  const limiter = new ReadRateLimiter({ now: () => time, maxIps: 1 });
  for (let i = 0; i < 20; i++) assert.equal(limiter.consume('198.51.100.1').allowed, true);
  assert.equal(limiter.consume('198.51.100.2').allowed, false);
  assert.equal(limiter.consume('198.51.100.1').allowed, false);
  time = 60000;
  assert.equal(limiter.consume('198.51.100.2').allowed, true);
});
