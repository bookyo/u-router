'use strict';

const net = require('node:net');

// 入参校验与规范化。之前 PATCH 直接 $set 用户输入（Mongoose update 默认不跑
// validators），status/weight 可以写入任意值——负权重会抵消加权抽样的总权重，
// 直接把该文件的分发打死；含 '|' 的 ID 会破坏 DispatchRecorder 的键拆分。

const EDGE_STATUSES = ['healthy', 'degraded', 'unhealthy', 'offline', 'maintenance'];
// 必须以字母数字开头：前导下划线保留给系统统计桶（_invalid/_unknown），
// 竖线等分隔符会破坏 DispatchRecorder 的键拆分
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

const bad = (error) => ({ ok: false, error });
const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const isHttpUrl = (v) => typeof v === 'string' && HTTP_URL_RE.test(v);

// base_url 是总控主动 fetch 的目标（探活/拉统计/派发），默认只允许公网地址，
// 防止管理接口被滥用探测内网与云元数据端点；内网部署显式放行。
function isNonPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = String(ip).toLowerCase();
  if (v6.startsWith('::ffff:')) {
    const tail = v6.slice(7);
    if (net.isIPv4(tail)) return isNonPublicIp(tail);
    return true; // 映射形式一律按非公网处理
  }
  return (
    v6 === '::' || v6 === '::1' || v6.startsWith('fe80') || v6.startsWith('fc') ||
    v6.startsWith('fd') || v6.startsWith('ff')
  );
}

function privateEdgeUrlError(url) {
  if (process.env.MASTER_ALLOW_PRIVATE_EDGE_URL === 'true') return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'base_url 无法解析';
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const HINT = '（内网/本机部署设 MASTER_ALLOW_PRIVATE_EDGE_URL=true）';
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return `base_url 禁止内网主机名 ${h}${HINT}`;
  }
  if (net.isIP(h) && isNonPublicIp(h)) {
    return `base_url 禁止私网/回环/元数据地址 ${h}${HINT}`;
  }
  return null;
}

function isValidId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

function validateEdgeCreate(body = {}) {
  if (body.edge_id !== undefined && !isValidId(body.edge_id)) {
    return bad('edge_id 只允许字母数字与 . _ -（1~128 位）');
  }
  if (!isHttpUrl(body.base_url)) return bad('base_url 必填且必须是 http(s) 地址');
  const privateErr = privateEdgeUrlError(body.base_url);
  if (privateErr) return bad(privateErr);
  if (body.weight !== undefined && (Number.isNaN(toNum(body.weight)) || toNum(body.weight) < 0)) {
    return bad('weight 必须是非负数');
  }
  if (body.token_secret !== undefined && typeof body.token_secret !== 'string') {
    return bad('token_secret 必须是字符串');
  }
  if (body.api_key !== undefined && typeof body.api_key !== 'string') {
    return bad('api_key 必须是字符串');
  }
  return { ok: true };
}

function sanitizeEdgePatch(body = {}) {
  const patch = {};
  if (body.name !== undefined) patch.name = String(body.name);
  if (body.region !== undefined) patch.region = String(body.region);
  if (body.base_url !== undefined) {
    if (!isHttpUrl(body.base_url)) return bad('base_url 必须是 http(s) 地址');
    const privateErr = privateEdgeUrlError(body.base_url);
    if (privateErr) return bad(privateErr);
    patch.base_url = body.base_url;
  }
  if (body.weight !== undefined) {
    const w = toNum(body.weight);
    if (Number.isNaN(w) || w < 0) return bad('weight 必须是非负数');
    patch.weight = w;
  }
  if (body.api_key !== undefined) {
    if (typeof body.api_key !== 'string') return bad('api_key 必须是字符串');
    patch.api_key = body.api_key;
  }
  if (body.token_secret !== undefined) {
    if (typeof body.token_secret !== 'string') return bad('token_secret 必须是字符串');
    patch.token_secret = body.token_secret;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return bad('enabled 必须是布尔值');
    patch.enabled = body.enabled;
  }
  if (body.status !== undefined) {
    if (!EDGE_STATUSES.includes(body.status)) {
      return bad(`status 只能是 ${EDGE_STATUSES.join(' / ')}`);
    }
    patch.status = body.status;
  }
  return { ok: true, patch };
}

function validateFileEdges(edges) {
  if (!Array.isArray(edges) || edges.length === 0) {
    return bad('edges 需为非空数组（至少一条 Edge 映射）');
  }
  const normalized = [];
  const seen = new Set();
  for (const e of edges) {
    if (!e || typeof e !== 'object') return bad('edges 元素必须是对象');
    if (!isValidId(e.edge_id)) return bad(`edge_id 非法: ${JSON.stringify(e.edge_id)}`);
    if (seen.has(e.edge_id)) {
      return bad(`edge_id 重复: ${e.edge_id}（重复映射会翻倍放大该 Edge 的调度权重）`);
    }
    seen.add(e.edge_id);
    const edgeFileId = e.edge_file_id !== undefined ? e.edge_file_id : e.file_id;
    if (!isValidId(edgeFileId)) return bad(`edge_file_id 非法: ${JSON.stringify(edgeFileId)}`);
    const w = e.weight !== undefined ? toNum(e.weight) : 100;
    if (Number.isNaN(w) || w < 0) return bad('weight 必须是非负数');
    if (e.url_override !== undefined && e.url_override !== '' && !isHttpUrl(e.url_override)) {
      return bad('url_override 必须是 http(s) 地址');
    }
    normalized.push({
      edge_id: e.edge_id,
      edge_file_id: edgeFileId,
      weight: w,
      paused: !!e.paused,
      url_override: e.url_override || '',
    });
  }
  return { ok: true, normalized };
}

module.exports = { isValidId, validateEdgeCreate, sanitizeEdgePatch, validateFileEdges, EDGE_STATUSES };
