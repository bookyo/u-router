'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');

const { assertPublicUrl, createGuardedLookup, fetchEdge, isNonPublicIp } = require('../src/services/networkPolicy');

test('Master 拒绝域名解析到私网或链路本地地址', async () => {
  const privateDns = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    () => assertPublicUrl('https://apparently-public.example/api', { lookup: privateDns }),
    /内网|非公网|回环/,
  );
  await assert.rejects(() => assertPublicUrl('http://[fe90::1]/api'), /内网|非公网|回环/);
  await assert.rejects(() => assertPublicUrl('http://[fec0::1]/api'), /内网|非公网|回环/);
  await assert.rejects(() => assertPublicUrl('http://[::127.0.0.1]/api'), /内网|非公网|回环/);
});

test('Master 连接层重新解析到私网时拒绝连接（DNS rebinding）', async () => {
  const rawLookup = (_host, _opts, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
  const guarded = createGuardedLookup(rawLookup);
  const error = await new Promise((resolve) => {
    guarded('edge.example.com', { all: false }, (err) => resolve(err));
  });
  assert.ok(error);
  assert.match(error.message, /内网|非公网|169\.254\.169\.254/);
});

test('Master 拒绝完整的 IPv6 特殊用途空间，仅放行明确全局单播', () => {
  for (const ip of [
    '64:ff9b:1::1', // local-use NAT64
    '100::1', // discard-only
    '2001:2::1', // benchmark
    '2001:10::1', // ORCHID
    '2001:20::1', // ORCHIDv2
    '2002:7f00:1::1', // 6to4 可嵌入 IPv4
    '3fff::1', // documentation
  ]) {
    assert.equal(isNonPublicIp(ip), true, `${ip} 必须视为非公网地址`);
  }
  assert.equal(isNonPublicIp('2606:4700:4700::1111'), false, '正常全局单播应放行');
});

test('显式允许内网时跳过公网地址限制', async () => {
  await assert.doesNotReject(() => assertPublicUrl('http://127.0.0.1:7100', { allowPrivate: true }));
});

test('Master 出站请求不跟随重定向，防止公网 302 跳入私网', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/secret' });
      return res.end();
    }
    res.end('LOCAL_SECRET');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.MASTER_ALLOW_PRIVATE_EDGE_URL = 'true';
  try {
    await assert.rejects(
      () => fetchEdge(`http://127.0.0.1:${server.address().port}/redirect`),
      (error) => /redirect/i.test(`${error.message} ${error.cause?.message || ''}`),
    );
  } finally {
    delete process.env.MASTER_ALLOW_PRIVATE_EDGE_URL;
    server.close();
  }
});
