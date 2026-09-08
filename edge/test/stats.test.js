'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { initDatabase } = require('../src/db');
const { MinuteStats, STAT_FIELDS } = require('../src/stats');

describe('MinuteStats 分钟级统计', () => {
  test('同一分钟的多次 bump 累加，flush 后落盘可读', () => {
    const db = initDatabase(':memory:');
    const ms = new MinuteStats(db);
    const minute = Math.floor(Date.now() / 60000);
    ms.bump('f1', 'requests', 2, minute);
    ms.bump('f1', 's2xx', 1, minute);
    ms.flush();
    ms.bump('f1', 'requests', 3, minute);
    ms.bump('f1', 'bytes_sent', 1024, minute);
    ms.flush();

    const rows = ms.rowsSince(minute);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].file_id, 'f1');
    assert.equal(rows[0].requests, 5);
    assert.equal(rows[0].s2xx, 1);
    assert.equal(rows[0].bytes_sent, 1024);
  });

  test('rowsSince 只返回指定分钟及之后的行', () => {
    const db = initDatabase(':memory:');
    const ms = new MinuteStats(db);
    const now = Math.floor(Date.now() / 60000);
    ms.bump('fa', 'requests', 1, now - 5);
    ms.bump('fb', 'requests', 1, now);
    ms.flush();
    const rows = ms.rowsSince(now);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].file_id, 'fb');
  });

  test('不同文件分桶互不干扰', () => {
    const db = initDatabase(':memory:');
    const ms = new MinuteStats(db);
    const now = Math.floor(Date.now() / 60000);
    ms.bump('f1', 'requests', 7, now);
    ms.bump('f2', 'requests', 3, now);
    ms.flush();
    const rows = ms.rowsSince(now).sort((a, b) => (a.file_id < b.file_id ? -1 : 1));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].file_id, 'f1');
    assert.equal(rows[0].requests, 7);
    assert.equal(rows[1].file_id, 'f2');
    assert.equal(rows[1].requests, 3);
  });

  test('未知统计字段直接抛错，防止拼写错误悄悄丢数据', () => {
    const db = initDatabase(':memory:');
    const ms = new MinuteStats(db);
    assert.throws(() => ms.bump('f1', 'request', 1));
  });

  test('STAT_FIELDS 覆盖设计文档要求的全部指标', () => {
    assert.deepEqual([...STAT_FIELDS].sort(), [
      'bytes_sent',
      'downloads_completed',
      'downloads_started',
      'requests',
      's2xx',
      's4xx',
      's5xx',
    ]);
  });

  test('flush 落库失败时保留内存桶（成功后才清理，回归）', () => {
    const db = initDatabase(':memory:');
    const ms = new MinuteStats(db);
    ms.bump('f9', 'requests', 2);
    // 模拟磁盘满/写失败：让 upsert 语句抛错
    ms.upsertStmt = { run() { throw new Error('模拟磁盘满'); } };
    assert.throws(() => ms.flush());
    assert.equal(ms.pending.size, 1, '失败后 pending 应保留待下轮重试');
    // 恢复写入能力后，同一批数据可正常落库
    const healthy = new MinuteStats(initDatabase(':memory:'));
    ms.upsertStmt = healthy.upsertStmt;
    ms.flush();
    assert.equal(ms.pending.size, 0);
  });
});
