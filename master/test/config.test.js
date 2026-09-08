'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { sanitizeConfig } = require('../src/config');

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
});
