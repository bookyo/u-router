'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { weightedSampleN, effectiveWeights, STATUS_WEIGHT_MULTIPLIER } = require('../src/services/scheduler');

describe('weightedSampleN（加权随机抽样）', () => {
  test('返回指定数量的合法下标', () => {
    const picks = weightedSampleN([1, 1, 2], 1000);
    assert.equal(picks.length, 1000);
    assert.ok(picks.every((i) => i >= 0 && i < 3));
  });

  test('大样本下分布接近权重比 25/25/50', () => {
    const n = 200000;
    const picks = weightedSampleN([1, 1, 2], n);
    const cnt = [0, 0, 0];
    for (const p of picks) cnt[p]++;
    assert.ok(Math.abs(cnt[0] / n - 0.25) < 0.01, `idx0=${cnt[0] / n}`);
    assert.ok(Math.abs(cnt[1] / n - 0.25) < 0.01, `idx1=${cnt[1] / n}`);
    assert.ok(Math.abs(cnt[2] / n - 0.50) < 0.01, `idx2=${cnt[2] / n}`);
  });

  test('支持注入随机源，结果可复现', () => {
    let call = 0;
    const rands = [0, 0.5, 0.99];
    const rand = () => rands[call++ % rands.length];
    // total=4：rand=0   → r=0   → 命中 idx0
    //         rand=0.5 → r=2   → idx0(1)剩1，idx1(1)剩0，命中 idx2
    //         rand=0.99→ r=3.96→ 命中 idx2
    assert.deepEqual(weightedSampleN([1, 1, 2], 3, rand), [0, 2, 2]);
  });

  test('总权重为 0 时返回空数组', () => {
    assert.deepEqual(weightedSampleN([0, 0], 5), []);
  });
});

describe('effectiveWeights（候选边有效权重）', () => {
  const fileEdges = [
    { edge_id: 'a', edge_file_id: 'fa', weight: 100, paused: false },
    { edge_id: 'b', edge_file_id: 'fb', weight: 50, paused: false },
    { edge_id: 'c', edge_file_id: 'fc', weight: 100, paused: true },
    { edge_id: 'zz', edge_file_id: 'fz', weight: 100, paused: false },
  ];
  const edges = [
    { edge_id: 'a', weight: 100, status: 'healthy', enabled: true },
    { edge_id: 'b', weight: 100, status: 'degraded', enabled: true },
    { edge_id: 'c', weight: 100, status: 'healthy', enabled: true },
    { edge_id: 'd', weight: 100, status: 'unhealthy', enabled: true },
  ];

  test('paused / 未注册 / unhealthy 权重为 0，degraded 打 2 折', () => {
    const result = effectiveWeights(fileEdges, edges);
    // a: 100(文件边) × 100(Edge) × 1   = 10000
    // b: 50 × 100 × 0.2                = 1000
    assert.deepEqual(
      result.map((r) => r.weight),
      [10000, 1000, 0, 0],
    );
    // 保留下标与输入 fileEdges 一一对应，方便外层按位置取候选
    assert.equal(result.length, fileEdges.length);
  });

  test('状态 → 权重倍率表', () => {
    assert.equal(STATUS_WEIGHT_MULTIPLIER.healthy, 1);
    assert.equal(STATUS_WEIGHT_MULTIPLIER.degraded, 0.2);
    assert.equal(STATUS_WEIGHT_MULTIPLIER.unhealthy, 0);
    assert.equal(STATUS_WEIGHT_MULTIPLIER.offline, 0);
    assert.equal(STATUS_WEIGHT_MULTIPLIER.maintenance, 0);
  });
});

describe('负权重防御（历史脏数据兜底）', () => {
  test('effectiveWeights 把负权重钳制为 0', () => {
    const fileEdges = [{ edge_id: 'a', edge_file_id: 'fa', weight: 100, paused: false }];
    const edges = [{ edge_id: 'a', weight: -100, status: 'healthy', enabled: true }];
    assert.deepEqual(
      effectiveWeights(fileEdges, edges).map((r) => r.weight),
      [0], // 旧实现返回 -10000，会抵消其它候选的总权重
    );
  });

  test('weightedSampleN 把负权重当 0，不因抵消导致返回空', () => {
    const picks = weightedSampleN([50, -100, 50], 100);
    assert.equal(picks.length, 100);
    assert.ok(picks.every((i) => i === 0 || i === 2));
  });
});
