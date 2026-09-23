'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { sanitizeConfig } = require('../src/config');
const pkg = require('../package.json');

const base = {
  port: 7100,
  edgeId: 'edge-01',
  publicBaseUrl: 'https://edge.example.com',
  storageDir: '/tmp/files',
  dbPath: '/tmp/edge.db',
  tokenSecret: 'secret',
  tokenTtlSec: 86400,
  apiKey: '',
  maxUploadBytes: 1024,
  statsFlushIntervalMs: 1000,
  allowPrivatePull: false,
  pullMaxConcurrent: 2,
  pullTimeoutMs: 30000,
  pullMaxBytes: 4096,
  enableXAccel: false,
  xAccelPrefix: '/internal',
  version: 'test',
};

test('Edge 配置拒绝 Infinity、负数、零值和小数计数', () => {
  const warnings = [];
  const c = sanitizeConfig(
    {
      ...base,
      port: Infinity,
      tokenTtlSec: -3,
      maxUploadBytes: -1,
      statsFlushIntervalMs: Infinity,
      pullMaxConcurrent: 2.5,
      pullTimeoutMs: Infinity,
      pullMaxBytes: Infinity,
    },
    (message) => warnings.push(message),
  );
  assert.ok(Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535);
  assert.ok(Number.isInteger(c.tokenTtlSec) && c.tokenTtlSec >= 60);
  assert.ok(Number.isInteger(c.maxUploadBytes) && c.maxUploadBytes >= 1);
  assert.ok(Number.isInteger(c.statsFlushIntervalMs) && c.statsFlushIntervalMs >= 100);
  assert.ok(Number.isInteger(c.pullMaxConcurrent) && c.pullMaxConcurrent >= 1);
  assert.ok(Number.isInteger(c.pullTimeoutMs) && c.pullTimeoutMs >= 1000);
  assert.ok(Number.isInteger(c.pullMaxBytes) && c.pullMaxBytes >= 1);
  assert.doesNotThrow(() => AbortSignal.timeout(c.pullTimeoutMs));
  assert.ok(warnings.length >= 7, `每个非法值都应告警，实际 ${warnings.length}`);
});

test('Edge 合法配置保持不变', () => {
  assert.deepEqual(sanitizeConfig(base, () => {}), base);
});

test('Edge 巨大有限值不会造成日期、计时器或资源上限溢出', () => {
  const c = sanitizeConfig(
    {
      ...base,
      tokenTtlSec: Number.MAX_SAFE_INTEGER,
      maxUploadBytes: Number.MAX_SAFE_INTEGER,
      statsFlushIntervalMs: Number.MAX_SAFE_INTEGER,
      pullTimeoutMs: Number.MAX_SAFE_INTEGER,
      pullMaxBytes: Number.MAX_SAFE_INTEGER,
    },
    () => {},
  );
  assert.ok(c.tokenTtlSec <= 365 * 86400);
  assert.ok(c.maxUploadBytes <= 1024 ** 4);
  assert.ok(c.statsFlushIntervalMs <= 2_147_483_647);
  assert.ok(c.pullTimeoutMs <= 2_147_483_647);
  assert.ok(c.pullMaxBytes <= 1024 ** 4);
  assert.ok(Number.isFinite(Date.now() + c.tokenTtlSec * 1000));
});

test('Node engines 覆盖 undici 7 的真实最低版本', () => {
  assert.equal(pkg.engines.node, '>=20.18.1');
});
