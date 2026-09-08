'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { nextStatusFromActive, nextStatusFromRatio } = require('../src/services/healthRules');

const cfg = {
  unhealthyAfterFailures: 3,
  offlineAfterFailures: 10,
  recoverySuccesses: 3,
  degradedBelow: 0.9,
  unhealthyBelow: 0.7,
  recoveryPasses: 2,
};

describe('主动健康检测的状态迁移（带滞后）', () => {
  test('连续失败达到阈值 → unhealthy', () => {
    assert.equal(nextStatusFromActive('healthy', 0, 2, cfg), 'healthy');
    assert.equal(nextStatusFromActive('healthy', 0, 3, cfg), 'unhealthy');
  });

  test('连续失败达到 offline 阈值 → offline', () => {
    assert.equal(nextStatusFromActive('healthy', 0, 10, cfg), 'offline');
  });

  test('healthy 状态下探活成功不改变状态', () => {
    assert.equal(nextStatusFromActive('healthy', 9, 0, cfg), 'healthy');
  });

  test('unhealthy/offline 恢复需连续成功 N 次，且先降级为 degraded 观察期', () => {
    assert.equal(nextStatusFromActive('unhealthy', 2, 0, cfg), 'unhealthy');
    assert.equal(nextStatusFromActive('unhealthy', 3, 0, cfg), 'degraded');
    assert.equal(nextStatusFromActive('offline', 3, 0, cfg), 'degraded');
  });

  test('degraded 状态不受探活结果影响（升回 healthy 由被动比率决定）', () => {
    assert.equal(nextStatusFromActive('degraded', 100, 0, cfg), 'degraded');
  });

  test('maintenance 为人工状态，不被自动改写', () => {
    assert.equal(nextStatusFromActive('maintenance', 0, 99, cfg), 'maintenance');
  });
});

describe('被动 delivery_ratio 的状态迁移', () => {
  test('healthy 且 ratio < degradedBelow → degraded', () => {
    assert.equal(nextStatusFromRatio('healthy', 0.85, 0, cfg), 'degraded');
  });

  test('ratio < unhealthyBelow → unhealthy（无论当前是 healthy 还是 degraded）', () => {
    assert.equal(nextStatusFromRatio('healthy', 0.5, 0, cfg), 'unhealthy');
    assert.equal(nextStatusFromRatio('degraded', 0.5, 0, cfg), 'unhealthy');
  });

  test('degraded 需连续 recoveryPasses 次良好比率才回 healthy', () => {
    assert.equal(nextStatusFromRatio('degraded', 0.95, 0, cfg), 'degraded');
    assert.equal(nextStatusFromRatio('degraded', 0.95, 1, cfg), 'degraded');
    assert.equal(nextStatusFromRatio('degraded', 0.95, 2, cfg), 'healthy');
  });

  test('unhealthy 且比率恢复良好 → 先进入 degraded 观察期', () => {
    assert.equal(nextStatusFromRatio('unhealthy', 0.95, 0, cfg), 'degraded');
  });

  test('offline / maintenance 不参与被动判定', () => {
    assert.equal(nextStatusFromRatio('offline', 0.1, 0, cfg), 'offline');
    assert.equal(nextStatusFromRatio('maintenance', 0.99, 5, cfg), 'maintenance');
  });

  test('healthy 且比率良好 → 保持 healthy', () => {
    assert.equal(nextStatusFromRatio('healthy', 0.97, 0, cfg), 'healthy');
  });
});
