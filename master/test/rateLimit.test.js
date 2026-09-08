'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { rateLimitPerIp } = require('../src/middleware');

const fakeReq = (ip) => ({ socket: { remoteAddress: ip } });
const fakeRes = () => {
  const res = { headers: {}, statusCode: 0, body: null };
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('rateLimitPerIp（分发接口限流）', () => {
  test('窗口内超过 max 次返回 429 并带 Retry-After', () => {
    const mw = rateLimitPerIp({ windowMs: 60000, max: 2 });
    const nextCalls = [];
    const next = () => nextCalls.push(true);

    mw(fakeReq('1.1.1.1'), fakeRes(), next);
    mw(fakeReq('1.1.1.1'), fakeRes(), next);
    const blocked = fakeRes();
    mw(fakeReq('1.1.1.1'), blocked, next);

    assert.equal(nextCalls.length, 2);
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['Retry-After']) >= 1);
  });

  test('不同 IP 互不影响', () => {
    const mw = rateLimitPerIp({ windowMs: 60000, max: 1 });
    const nextCalls = [];
    const next = () => nextCalls.push(true);
    mw(fakeReq('1.1.1.1'), fakeRes(), next);
    mw(fakeReq('2.2.2.2'), fakeRes(), next);
    assert.equal(nextCalls.length, 2);
  });

  test('窗口过期后重新计数', async () => {
    const mw = rateLimitPerIp({ windowMs: 40, max: 1 });
    const nextCalls = [];
    const next = () => nextCalls.push(true);
    mw(fakeReq('3.3.3.3'), fakeRes(), next);
    const blocked = fakeRes();
    mw(fakeReq('3.3.3.3'), blocked, next); // 第 2 次被拦，next 不调用
    assert.equal(blocked.statusCode, 429);
    assert.equal(nextCalls.length, 1);
    await sleep(80);
    mw(fakeReq('3.3.3.3'), fakeRes(), next);
    assert.equal(nextCalls.length, 2);
  });
});
