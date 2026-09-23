'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { sanitizeConfig } = require('../src/config');
const pkg = require('../package.json');

const base = {
  port: 7000,
  mongoUri: 'mongodb://x',
  apiKey: '',
  healthCheckIntervalSec: 15,
  healthTimeoutMs: 4000,
  statsPullIntervalSec: 60,
  passiveCheckIntervalSec: 30,
  unhealthyAfterFailures: 3,
  offlineAfterFailures: 10,
  recoverySuccesses: 3,
  recoveryPasses: 2,
  degradedBelow: 0.9,
  unhealthyBelow: 0.7,
  ratioWindows: { '5m': { sec: 300, minDispatch: 30 }, '1h': { sec: 3600, minDispatch: 100 } },
  primaryWindow: '5m',
  defaultTokenTtlSec: 86400,
  maxTokenTtlSec: 604800,
  dispatchFlushIntervalMs: 5000,
  linksRateLimitPerMin: 0,
  distributorIntervalSec: 10,
  distributionMaxAttempts: 3,
  distributionTokenTtlSec: 172800,
  distributionStaleSec: 3600,
};

describe('sanitizeConfig（非法配置不会让后台循环失效）', () => {
  test('非法 PRIMARY_WINDOW 回退 5m（含原型链键）', () => {
    assert.equal(sanitizeConfig({ ...base, primaryWindow: 'banana' }).primaryWindow, '5m');
    assert.equal(sanitizeConfig({ ...base, primaryWindow: 'constructor' }).primaryWindow, '5m');
  });

  test('非正数/非有限的循环间隔钳到安全下限', () => {
    const c = sanitizeConfig({
      ...base,
      healthCheckIntervalSec: -5,
      statsPullIntervalSec: Number.NaN,
      distributorIntervalSec: 0,
      passiveCheckIntervalSec: 'abc',
      dispatchFlushIntervalMs: -1,
    });
    assert.ok(c.healthCheckIntervalSec >= 1);
    assert.ok(c.statsPullIntervalSec >= 1);
    assert.ok(c.distributorIntervalSec >= 1);
    assert.ok(c.passiveCheckIntervalSec >= 1);
    assert.ok(c.dispatchFlushIntervalMs >= 100);
  });

  test('比率阈值非法或颠倒时回退默认', () => {
    const c = sanitizeConfig({ ...base, degradedBelow: 0.5, unhealthyBelow: 0.8 });
    assert.equal(c.degradedBelow, 0.9);
    assert.equal(c.unhealthyBelow, 0.7);
    const c2 = sanitizeConfig({ ...base, degradedBelow: Number.NaN });
    assert.equal(c2.degradedBelow, 0.9);
  });

  test('限流负数归零', () => {
    assert.equal(sanitizeConfig({ ...base, linksRateLimitPerMin: -3 }).linksRateLimitPerMin, 0);
  });

  test('探活超时/失败计数/token TTL/重试次数钳制（含 0、负数）', () => {
    const c = sanitizeConfig({
      ...base,
      healthTimeoutMs: 0,
      unhealthyAfterFailures: 0,
      offlineAfterFailures: 2, // 小于 unhealthy，语义颠倒
      recoverySuccesses: -1,
      recoveryPasses: 0,
      defaultTokenTtlSec: 0,
      maxTokenTtlSec: 10, // 小于 default
      distributionMaxAttempts: 0,
      distributionTokenTtlSec: -5,
    });
    assert.ok(c.healthTimeoutMs >= 250);
    assert.ok(c.unhealthyAfterFailures >= 1);
    assert.ok(c.offlineAfterFailures >= c.unhealthyAfterFailures + 1, 'offline 阈值必须大于 unhealthy');
    assert.ok(c.recoverySuccesses >= 1);
    assert.ok(c.recoveryPasses >= 1);
    assert.ok(c.defaultTokenTtlSec >= 60);
    assert.ok(c.maxTokenTtlSec >= c.defaultTokenTtlSec);
    assert.ok(c.distributionMaxAttempts >= 1);
    assert.ok(c.distributionTokenTtlSec >= 60);
  });

  test('Infinity 视为非法', () => {
    const c = sanitizeConfig({
      ...base,
      healthCheckIntervalSec: Infinity,
      healthTimeoutMs: Infinity,
      distributionMaxAttempts: Infinity,
    });
    assert.ok(Number.isFinite(c.healthCheckIntervalSec) && c.healthCheckIntervalSec >= 1);
    assert.ok(Number.isFinite(c.healthTimeoutMs));
    assert.ok(Number.isFinite(c.distributionMaxAttempts) && c.distributionMaxAttempts >= 1);
  });

  test('端口、毫秒超时、计数和 TTL 必须是范围内整数', () => {
    const c = sanitizeConfig({
      ...base,
      port: Infinity,
      healthTimeoutMs: 250.5,
      unhealthyAfterFailures: 1.5,
      offlineAfterFailures: 3.5,
      recoverySuccesses: 2.2,
      recoveryPasses: 1.1,
      defaultTokenTtlSec: 60.5,
      maxTokenTtlSec: 600.5,
      distributionMaxAttempts: 2.5,
      distributionTokenTtlSec: 600.5,
      distributionStaleSec: 60.5,
    });
    for (const key of [
      'port',
      'healthTimeoutMs',
      'unhealthyAfterFailures',
      'offlineAfterFailures',
      'recoverySuccesses',
      'recoveryPasses',
      'defaultTokenTtlSec',
      'maxTokenTtlSec',
      'distributionMaxAttempts',
      'distributionTokenTtlSec',
      'distributionStaleSec',
    ]) {
      assert.equal(Number.isInteger(c[key]), true, `${key} 应是整数，实际 ${c[key]}`);
    }
    assert.ok(c.port >= 1 && c.port <= 65535);
    assert.doesNotThrow(() => AbortSignal.timeout(c.healthTimeoutMs));
  });

  test('巨大但有限的间隔、TTL、计数也回退，不触发计时器或日期溢出', () => {
    const c = sanitizeConfig({
      ...base,
      healthCheckIntervalSec: Number.MAX_VALUE,
      statsPullIntervalSec: Number.MAX_VALUE,
      passiveCheckIntervalSec: Number.MAX_VALUE,
      distributorIntervalSec: Number.MAX_VALUE,
      defaultTokenTtlSec: Number.MAX_SAFE_INTEGER,
      maxTokenTtlSec: Number.MAX_SAFE_INTEGER,
      distributionTokenTtlSec: Number.MAX_SAFE_INTEGER,
      unhealthyAfterFailures: Number.MAX_SAFE_INTEGER - 1,
      offlineAfterFailures: Number.MAX_SAFE_INTEGER,
      linksRateLimitPerMin: Number.MAX_SAFE_INTEGER,
    });
    for (const key of [
      'healthCheckIntervalSec',
      'statsPullIntervalSec',
      'passiveCheckIntervalSec',
      'distributorIntervalSec',
    ]) {
      assert.ok(c[key] * 1000 <= 2_147_483_647, `${key} 不能让 setInterval 溢出`);
    }
    for (const key of ['defaultTokenTtlSec', 'maxTokenTtlSec', 'distributionTokenTtlSec']) {
      assert.ok(c[key] <= 365 * 86400, `${key} 应有语义上限`);
      assert.ok(Number.isFinite(Date.now() + c[key] * 1000));
    }
    assert.ok(c.offlineAfterFailures > c.unhealthyAfterFailures);
    assert.ok(c.linksRateLimitPerMin <= 1_000_000);
  });
});

test('Node engines 覆盖 undici 7 的真实最低版本', () => {
  assert.equal(pkg.engines.node, '>=20.18.1');
});
