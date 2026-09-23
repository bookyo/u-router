'use strict';

const dnsCallback = require('node:dns').lookup;
const dnsPromises = require('node:dns').promises;
const net = require('node:net');
const { fetch: undiciFetch, Agent } = require('undici');

const PRIVATE_HINT = '禁止访问内网、回环、链路本地或保留地址';

const v4Block = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  v4Block.addSubnet(address, prefix, 'ipv4');
}

const v6Block = new net.BlockList();
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96], // 已废弃的 IPv4-compatible IPv6（如 ::127.0.0.1）
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10], // 已废弃的 site-local，仍不可作为公网目标
  ['ff00::', 8],
  // 2001::/23 是 IETF 特殊用途聚合段（含 benchmark、ORCHID 等），
  // 不是普通公网 Edge 地址。
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4，可编码 IPv4 目标
  ['3fff::', 20], // 文档地址
]) {
  v6Block.addSubnet(address, prefix, 'ipv6');
}

// 当前可路由的 IPv6 全局单播地址来自 2000::/3。先做允许域约束，
// 可一次覆盖 NAT64 local-use、discard-only、ULA/link-local 等位于该域外的
// IANA 特殊用途空间；再由 v6Block 排除 2000::/3 内部的特殊子段。
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function mappedIpv4(ip) {
  const lower = String(ip).toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const tail = lower.slice(7);
  if (net.isIPv4(tail)) return tail;
  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!match) return '';
  const hi = parseInt(match[1], 16);
  const lo = parseInt(match[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isNonPublicIp(ip) {
  if (net.isIPv4(ip)) return v4Block.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return true;
  const mapped = mappedIpv4(ip);
  if (mapped !== null) return mapped === '' || isNonPublicIp(mapped);
  return !globalV6.check(ip, 'ipv6') || v6Block.check(ip, 'ipv6');
}

function parseHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const error = new Error('URL 无法解析');
    error.status = 400;
    throw error;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const error = new Error('URL 必须使用 http(s)');
    error.status = 400;
    throw error;
  }
  return parsed;
}

function rejectPrivate(address) {
  if (!isNonPublicIp(address)) return;
  const error = new Error(`${PRIVATE_HINT}: ${address}`);
  error.status = 400;
  throw error;
}

async function assertPublicUrl(url, { allowPrivate = process.env.MASTER_ALLOW_PRIVATE_EDGE_URL === 'true', lookup = dnsPromises.lookup } = {}) {
  if (allowPrivate) return;
  const parsed = parseHttpUrl(url);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    rejectPrivate('localhost');
  }
  if (net.isIP(host)) {
    rejectPrivate(host);
    return;
  }
  let rows;
  try {
    rows = await lookup(host, { all: true });
  } catch (cause) {
    const error = new Error(`域名解析失败: ${host}`);
    error.status = 400;
    error.cause = cause;
    throw error;
  }
  const addresses = Array.isArray(rows) ? rows : [rows];
  if (addresses.length === 0) {
    const error = new Error(`域名没有可用地址: ${host}`);
    error.status = 400;
    throw error;
  }
  for (const row of addresses) rejectPrivate(row.address);
}

function createGuardedLookup(rawLookup = dnsCallback) {
  return (host, options, callback) => {
    rawLookup(host, { ...options, all: true }, (error, rows) => {
      if (error) return callback(error);
      const addresses = Array.isArray(rows) ? rows : [rows];
      const blocked = addresses.find((row) => isNonPublicIp(row.address));
      if (blocked) return callback(new Error(`${PRIVATE_HINT}: ${blocked.address}`));
      if (options && options.all) return callback(null, addresses);
      const first = addresses[0];
      return callback(null, first.address, first.family);
    });
  };
}

let publicDispatcher;
function dispatcher() {
  if (!publicDispatcher) {
    publicDispatcher = new Agent({ connect: { lookup: createGuardedLookup() } });
  }
  return publicDispatcher;
}

async function fetchEdge(url, init = {}) {
  const allowPrivate = process.env.MASTER_ALLOW_PRIVATE_EDGE_URL === 'true';
  // 不跟随重定向：否则初始公网 URL 可用 30x 把请求带入回环/内网，
  // IP literal 的跳转目标还会绕过仅作用于 DNS 的 guarded lookup。
  const safeInit = { ...init, redirect: 'error' };
  if (allowPrivate) return fetch(url, safeInit);
  await assertPublicUrl(url, { allowPrivate: false });
  return undiciFetch(url, { ...safeInit, dispatcher: dispatcher() });
}

module.exports = { assertPublicUrl, createGuardedLookup, fetchEdge, isNonPublicIp };
