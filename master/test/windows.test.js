'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { pickWindow } = require('../src/services/metricsQuery');
const { sinceFromLastStored } = require('../src/services/statsPuller');

const cfg = {
  ratioWindows: { '5m': { sec: 300 }, '1h': { sec: 3600 }, '24h': { sec: 86400 } },
  primaryWindow: '5m',
};

describe('pickWindow（修复 ?window=constructor 触发 500）', () => {
  test('合法窗口名', () => {
    assert.equal(pickWindow(cfg, '5m'), '5m');
    assert.equal(pickWindow(cfg, '1h'), '1h');
    assert.equal(pickWindow(cfg, '24h'), '24h');
  });

  test('原型链键不当作合法窗口', () => {
    assert.equal(pickWindow(cfg, 'constructor'), '5m');
    assert.equal(pickWindow(cfg, '__proto__'), '5m');
    assert.equal(pickWindow(cfg, 'toString'), '5m');
  });

  test('未知/缺省/非字符串 → 主窗口', () => {
    assert.equal(pickWindow(cfg, 'nope'), '5m');
    assert.equal(pickWindow(cfg, undefined), '5m');
    assert.equal(pickWindow(cfg, ''), '5m');
    assert.equal(pickWindow(cfg, ['5m']), '5m');
  });
});

describe('sinceFromLastStored（修复停机统计空洞的拉取游标）', () => {
  test('无历史默认回拉 2 分钟', () => {
    const now = Date.now();
    assert.equal(sinceFromLastStored(NaN, now), Math.floor(now / 60000) - 2);
    assert.equal(sinceFromLastStored(undefined, now), Math.floor(now / 60000) - 2);
  });

  test('有历史则从最后已存分钟续拉', () => {
    const nowMin = Math.floor(Date.now() / 60000);
    assert.equal(sinceFromLastStored(nowMin - 30, nowMin * 60000), nowMin - 30);
  });

  test('时钟偏移（未来分钟）钳到当前分钟', () => {
    const nowMin = Math.floor(Date.now() / 60000);
    assert.equal(sinceFromLastStored(nowMin + 5, nowMin * 60000), nowMin);
  });

  test('过早的历史最多回溯 24 小时', () => {
    const nowMin = Math.floor(Date.now() / 60000);
    assert.equal(sinceFromLastStored(nowMin - 5000, nowMin * 60000), nowMin - 1440);
  });
});
