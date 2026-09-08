'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { sign, verify } = require('../src/services/token');

const SECRET = 'unit-test-secret';

describe('下载 token 签名/验签', () => {
  test('签名后可验签并取回 payload', () => {
    const t = sign({ f: 'f_abc', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const v = verify(t, SECRET);
    assert.equal(v.ok, true);
    assert.equal(v.reason, undefined);
    assert.equal(v.payload.f, 'f_abc');
  });

  test('过期的 token 被拒绝，reason=expired', () => {
    const t = sign({ f: 'x', exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    const v = verify(t, SECRET);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'expired');
  });

  test('密钥不一致拒绝，reason=bad_signature', () => {
    const t = sign({ f: 'x', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const v = verify(t, 'another-secret');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  test('篡改 payload 后签名校验失败', () => {
    const t = sign({ f: 'x' }, SECRET);
    const [body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ f: 'y' })).toString('base64url') + '.' + mac;
    assert.equal(verify(forged, SECRET).reason, 'bad_signature');
  });

  test('格式错误的 token 拒绝，reason=malformed', () => {
    assert.equal(verify('garbage', SECRET).reason, 'malformed');
    assert.equal(verify('a.b.c', SECRET).reason, 'malformed');
    assert.equal(verify('', SECRET).reason, 'malformed');
    assert.equal(verify(undefined, SECRET).reason, 'malformed');
  });

  test('没有 exp 字段视为长期有效', () => {
    const t = sign({ f: 'x' }, SECRET);
    assert.equal(verify(t, SECRET).ok, true);
  });
});
