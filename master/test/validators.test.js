'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  isValidId,
  validateEdgeCreate,
  sanitizeEdgePatch,
  validateFileEdges,
} = require('../src/services/validators');

describe('isValidId（edge_id / download_id / edge_file_id 字符集）', () => {
  test('允许字母数字与 . _ -，1~128 位', () => {
    assert.equal(isValidId('edge-us-01'), true);
    assert.equal(isValidId('f_ab12cd34'), true);
    assert.equal(isValidId('a.b_c-d'), true);
    assert.equal(isValidId('x'.repeat(128)), true);
  });

  test('拒绝竖线/空串/超长/非字符串/空白/非 ASCII', () => {
    assert.equal(isValidId('a|b'), false); // 竖线会破坏 DispatchRecorder 的键拆分
    assert.equal(isValidId(''), false);
    assert.equal(isValidId('x'.repeat(129)), false);
    assert.equal(isValidId(123), false);
    assert.equal(isValidId(null), false);
    assert.equal(isValidId('has space'), false);
    assert.equal(isValidId('中文'), false);
  });
});

describe('validateEdgeCreate', () => {
  test('合法输入通过', () => {
    const r = validateEdgeCreate({ edge_id: 'edge-1', base_url: 'https://a.example.com', weight: 50 });
    assert.equal(r.ok, true);
  });

  test('base_url 必填且必须 http(s)', () => {
    assert.equal(validateEdgeCreate({ base_url: 'ftp://x' }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'not a url' }).ok, false);
    assert.equal(validateEdgeCreate({}).ok, false);
  });

  test('base_url 默认拒绝私网/回环/链路本地/元数据地址（SSRF 面，回归）', () => {
    assert.equal(validateEdgeCreate({ base_url: 'http://192.168.1.5' }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'http://10.0.0.9:7100' }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'http://169.254.169.254/latest/meta-data' }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'http://127.0.0.1:7100' }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'http://localhost:7100' }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'http://[::ffff:10.0.0.1]:80' }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'https://edge.example.com' }).ok, true);
  });

  test('内网部署可显式放行 base_url', () => {
    process.env.MASTER_ALLOW_PRIVATE_EDGE_URL = 'true';
    try {
      assert.equal(validateEdgeCreate({ base_url: 'http://127.0.0.1:7100' }).ok, true);
      assert.equal(sanitizeEdgePatch({ base_url: 'http://192.168.1.5' }).ok, true);
    } finally {
      delete process.env.MASTER_ALLOW_PRIVATE_EDGE_URL;
    }
    // 恢复默认后再校验拒绝
    assert.equal(sanitizeEdgePatch({ base_url: 'http://10.0.0.5' }).ok, false);
  });

  test('非法 edge_id / 负 weight / 非数字 weight 拒绝', () => {
    assert.equal(validateEdgeCreate({ base_url: 'https://a.example.com', edge_id: 'a|b' }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'https://a.example.com', weight: -1 }).ok, false);
    assert.equal(validateEdgeCreate({ base_url: 'https://a.example.com', weight: '50' }).ok, false);
  });
});

describe('sanitizeEdgePatch（修复 PATCH 绕过 schema 校验）', () => {
  test('status 只接受五个枚举值', () => {
    assert.equal(sanitizeEdgePatch({ status: 'maintenance' }).ok, true);
    assert.equal(sanitizeEdgePatch({ status: 'banana' }).ok, false);
  });

  test('weight 拒绝负数与非数字（负权重会抵消总权重打死分发）', () => {
    assert.equal(sanitizeEdgePatch({ weight: -5 }).ok, false);
    assert.equal(sanitizeEdgePatch({ weight: '50' }).ok, false);
    assert.equal(sanitizeEdgePatch({ weight: 50 }).ok, true);
    assert.equal(sanitizeEdgePatch({ weight: 0 }).ok, true);
  });

  test('base_url / enabled 校验', () => {
    assert.equal(sanitizeEdgePatch({ base_url: 'ftp://x' }).ok, false);
    assert.equal(sanitizeEdgePatch({ base_url: 'https://x.example.com' }).ok, true);
    assert.equal(sanitizeEdgePatch({ enabled: 'yes' }).ok, false);
    assert.equal(sanitizeEdgePatch({ enabled: false }).ok, true);
  });

  test('未知字段被忽略，不进 patch', () => {
    const r = sanitizeEdgePatch({ weight: 10, hacker: { $gt: '' } });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.patch), ['weight']);
  });
});

describe('validateFileEdges', () => {
  test('空数组/非数组拒绝', () => {
    assert.equal(validateFileEdges([]).ok, false);
    assert.equal(validateFileEdges(undefined).ok, false);
  });

  test('重复 edge_id 拒绝（防止同一 Edge 映射翻倍放大调度权重）', () => {
    const r = validateFileEdges([
      { edge_id: 'a', edge_file_id: 'f1' },
      { edge_id: 'a', edge_file_id: 'f2' },
    ]);
    assert.equal(r.ok, false);
  });

  test('前导下划线保留给系统统计桶，ID 不允许以 _ 开头', () => {
    assert.equal(isValidId('_invalid'), false);
    assert.equal(isValidId('_x'), false);
    assert.equal(isValidId('f_ok'), true);
    assert.equal(
      validateFileEdges([{ edge_id: 'a', edge_file_id: '_invalid' }]).ok,
      false,
    );
  });

  test('edge_id / edge_file_id 必须是合法 ID（含竖线拒绝，防 recorder 键错位）', () => {
    assert.equal(validateFileEdges([{ edge_id: 'a|b', edge_file_id: 'f1' }]).ok, false);
    assert.equal(validateFileEdges([{ edge_id: 'a', edge_file_id: 'f|x' }]).ok, false);
    assert.equal(validateFileEdges([{ edge_id: 'a' }]).ok, false);
  });

  test('weight 非负、url_override 必须 http(s)', () => {
    assert.equal(validateFileEdges([{ edge_id: 'a', edge_file_id: 'f', weight: -1 }]).ok, false);
    assert.equal(
      validateFileEdges([{ edge_id: 'a', edge_file_id: 'f', url_override: 'javascript:alert(1)' }]).ok,
      false,
    );
  });

  test('合法输入规范化（默认 weight 100 / paused false，接受 file_id 别名）', () => {
    const r = validateFileEdges([
      { edge_id: 'a', file_id: 'f1' },
      { edge_id: 'b', edge_file_id: 'f2', weight: 30, paused: true },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.normalized, [
      { edge_id: 'a', edge_file_id: 'f1', weight: 100, paused: false, url_override: '' },
      { edge_id: 'b', edge_file_id: 'f2', weight: 30, paused: true, url_override: '' },
    ]);
  });
});
