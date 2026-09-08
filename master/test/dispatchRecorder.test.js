'use strict';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const mongoose = require('mongoose');

const DispatchLog = require('../src/models/DispatchLog');
const { DispatchRecorder } = require('../src/services/dispatchRecorder');

let connected = false;

before(async () => {
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/urouter_test_recorder', {
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

test('bulkWrite 部分失败（writeErrors 带 index）时只重新入队失败的键', async () => {
  const rec = new DispatchRecorder(600000, { log: () => {} });
  rec.record('e1', 'f1');
  rec.record('e1', 'f2');

  const orig = DispatchLog.bulkWrite.bind(DispatchLog);
  DispatchLog.bulkWrite = async () => {
    // 真实 MongoBulkWriteError 的形状：writeErrors[].index（上一轮错误地依赖不存在的 err.results）
    const err = new Error('partial failure');
    err.writeErrors = [{ index: 1, code: 14 }];
    throw err;
  };
  try {
    await assert.rejects(() => rec.flush());
  } finally {
    DispatchLog.bulkWrite = orig;
  }
  assert.equal(rec.pending.size, 1, '只有失败的键回到待重试队列');
  const key = [...rec.pending.keys()][0];
  assert.ok(key.endsWith('|e1|f2'), `重新入队的应是失败的键: ${key}`);
});

test('writeErrors 缺少 index 或整体失败时保守全部重入队', async () => {
  const rec = new DispatchRecorder(600000, { log: () => {} });
  rec.record('e1', 'f1');
  rec.record('e2', 'f1');

  const orig = DispatchLog.bulkWrite.bind(DispatchLog);
  DispatchLog.bulkWrite = async () => {
    const err = new Error('weird');
    err.writeErrors = [{ errmsg: 'no index field' }];
    throw err;
  };
  try {
    await assert.rejects(() => rec.flush());
  } finally {
    DispatchLog.bulkWrite = orig;
  }
  assert.equal(rec.pending.size, 2);
});

test('真实 Mongo 部分失败：成功键不重复累计（毒化分钟桶回归）', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await DispatchLog.init(); // 确保唯一/TTL 索引建好
  await DispatchLog.deleteMany({});

  const minuteMs = Math.floor(Date.now() / 60000) * 60000;
  const minute = new Date(minuteMs);
  // 毒化 f2 的分钟桶：count 是字符串，$inc 会失败 → 只有该键失败
  await mongoose.connection
    .collection('dispatchlogs')
    .insertOne({ minute, edge_id: 'e1', file_id: 'f2', count: 'not-a-number' });

  const rec = new DispatchRecorder(600000, { log: () => {} });
  rec.record('e1', 'f1', 1, minuteMs); // op0 应成功
  rec.record('e1', 'f2', 1, minuteMs); // op1 应失败
  await assert.rejects(() => rec.flush());

  assert.deepEqual(
    [...rec.pending.keys()].map((k) => k.split('|').slice(1).join('|')),
    ['e1|f2'],
    '已成功的 f1 不得重新入队',
  );

  // 修复毒化桶后再 flush：f1 仍是 1（不重复累计），f2 = 5 + 1
  await mongoose.connection
    .collection('dispatchlogs')
    .updateOne({ edge_id: 'e1', file_id: 'f2' }, { $set: { count: 5 } });
  await rec.flush();
  const f1 = await DispatchLog.findOne({ edge_id: 'e1', file_id: 'f1' }).lean();
  const f2 = await DispatchLog.findOne({ edge_id: 'e1', file_id: 'f2' }).lean();
  assert.equal(f1.count, 1);
  assert.equal(f2.count, 6);
});
