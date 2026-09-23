'use strict';

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { before, after, test } = require('node:test');

const EdgeMetric = require('../src/models/EdgeMetric');
const DispatchLog = require('../src/models/DispatchLog');
const { edgeDelivery, allEdgesDelivery, fileDelivery } = require('../src/services/metricsQuery');

let connected = false;

before(async () => {
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/urouter_test_metrics', {
      serverSelectionTimeoutMS: 2000,
    });
    connected = true;
  } catch {
    connected = false;
  }
});

after(async () => {
  if (connected) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function seed() {
  await EdgeMetric.deleteMany({});
  await DispatchLog.deleteMany({});
  const m = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000);
  // started 与 completed 故意不同：打开后中止的请求不应抬高交付比率。
  await EdgeMetric.insertMany([
    { edge_id: 'e1', minute: m, file_id: 'fa', requests: 12, downloads_started: 12, downloads_completed: 9, bytes_sent: 100, s2xx: 10 },
    { edge_id: 'e2', minute: m, file_id: 'fa', requests: 6, downloads_started: 6, downloads_completed: 5, bytes_sent: 50, s2xx: 5 },
    { edge_id: 'e1', minute: m, file_id: 'fb', requests: 8, downloads_started: 8, downloads_completed: 7, bytes_sent: 70, s2xx: 7 },
    { edge_id: 'e3', minute: m, file_id: 'fb', requests: 3, downloads_started: 3, downloads_completed: 3, bytes_sent: 30, s2xx: 3 },
    // 系统桶：无效 token / 未知文件，不应计入 delivery_ratio
    { edge_id: 'e1', minute: m, file_id: '_invalid', requests: 999, downloads_started: 0, downloads_completed: 0, bytes_sent: 0, s4xx: 999 },
    { edge_id: 'e1', minute: m, file_id: '_unknown', requests: 500, downloads_started: 0, downloads_completed: 0, bytes_sent: 0, s4xx: 500 },
  ]);
  await DispatchLog.insertMany([
    { minute: m, edge_id: 'e1', file_id: 'pkg', count: 10 },
    { minute: m, edge_id: 'e2', file_id: 'pkg', count: 5 },
    { minute: m, edge_id: 'e1', file_id: 'other', count: 99 },
  ]);
}

test('edgeDelivery：比率分子是 downloads_completed（中断、失败和 HEAD 不抬高健康比率）', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await seed();
  const r = await edgeDelivery('e1', 600);
  assert.equal(r.dispatch, 109); // pkg 10 + other 99
  assert.equal(r.requests, 20); // 12 + 8（含失败）
  assert.equal(r.s2xx, 17); // 10 + 7（真实成功）
  assert.equal(r.downloads_started, 20);
  assert.equal(r.downloads_completed, 16);
  assert.ok(Math.abs(r.ratio - 16 / 109) < 1e-9, `ratio 应基于 downloads_completed: ${r.ratio}`);
});

test('allEdgesDelivery：一次聚合返回所有边（排除系统桶，ratio 基于 downloads_completed）', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await seed();
  const map = await allEdgesDelivery(600);
  assert.equal(map.get('e1').dispatch, 109);
  assert.equal(map.get('e1').requests, 20);
  assert.equal(map.get('e1').s2xx, 17);
  assert.equal(map.get('e1').downloads_started, 20);
  assert.equal(map.get('e1').downloads_completed, 16);
  assert.ok(Math.abs(map.get('e1').ratio - 16 / 109) < 1e-9);
  assert.equal(map.get('e2').dispatch, 5);
  assert.equal(map.get('e2').s2xx, 5);
  assert.equal(map.get('e3').dispatch, 0);
  assert.equal(map.get('e3').s2xx, 3);
});

test('fileDelivery：同一 file_id 注册在两台 edge 上不合并计数', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await seed();
  const file = {
    download_id: 'pkg',
    edges: [
      { edge_id: 'e1', edge_file_id: 'fa' },
      { edge_id: 'e2', edge_file_id: 'fa' }, // 同一物理 edge 双域名注册的场景
    ],
  };
  const rows = await fileDelivery(file, 600);
  assert.equal(rows.length, 2);
  const e1 = rows.find((x) => x.edge_id === 'e1');
  const e2 = rows.find((x) => x.edge_id === 'e2');
  assert.equal(e1.requests, 12); // 旧实现按 file_id 聚合会拿到 18
  assert.equal(e1.s2xx, 10);
  assert.equal(e1.downloads_started, 12);
  assert.equal(e1.ratio, 0.9); // 9/10，打开后中断的 3 次不算交付
  assert.equal(e2.requests, 6);
  assert.equal(e2.ratio, 1); // 5/5
});

test('HEAD 的 s2xx 不计入 delivery_ratio', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await EdgeMetric.deleteMany({});
  await DispatchLog.deleteMany({});
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000);
  await DispatchLog.create({ minute, edge_id: 'head-edge', file_id: 'pkg', count: 20 });
  await EdgeMetric.create({
    minute,
    edge_id: 'head-edge',
    file_id: 'f1',
    requests: 20,
    s2xx: 20,
    downloads_started: 0,
    downloads_completed: 0,
  });
  const r = await edgeDelivery('head-edge', 600);
  assert.equal(r.s2xx, 20);
  assert.equal(r.downloads_started, 0);
  assert.equal(r.downloads_completed, 0);
  assert.equal(r.ratio, 0);
});
