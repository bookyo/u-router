'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const makeEdgesRouter = require('../src/routes/edges');

test('stripSecrets：列表/详情响应不含密钥字段', () => {
  const doc = {
    edge_id: 'e1',
    name: 'n',
    base_url: 'https://e1.example.com',
    token_secret: 'top-secret',
    api_key: 'admin-key',
    weight: 100,
    status: 'healthy',
    health: { latency_ms: 3 },
  };
  const out = makeEdgesRouter.stripSecrets(doc);
  assert.equal('token_secret' in out, false);
  assert.equal('api_key' in out, false);
  assert.equal(out.edge_id, 'e1');
  assert.equal(out.weight, 100);
  assert.deepEqual(out.health, { latency_ms: 3 });
});
