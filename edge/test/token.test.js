'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { sign, verify } = require('../src/token');

const SECRET = 'unit-test-secret';

describe('edge 下载 token 签名/验签', () => {
  test('签名后可验签并取回 payload', () => {
    const t = sign({ f: 'f_abc', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const v = verify(t, SECRET);
    assert.equal(v.ok, true);
    assert.equal(v.payload.f, 'f_abc');
  });

  test('过期拒绝 reason=expired', () => {
    const t = sign({ f: 'x', exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    assert.equal(verify(t, SECRET).reason, 'expired');
  });

  test('密钥不一致拒绝 reason=bad_signature', () => {
    const t = sign({ f: 'x', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    assert.equal(verify(t, 'other').reason, 'bad_signature');
  });

  test('篡改拒绝 reason=bad_signature，格式错误 reason=malformed', () => {
    const t = sign({ f: 'x' }, SECRET);
    const [body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ f: 'y' })).toString('base64url') + '.' + mac;
    assert.equal(verify(forged, SECRET).reason, 'bad_signature');
    assert.equal(verify('garbage', SECRET).reason, 'malformed');
  });
});
