'use strict';

require('dotenv').config();
const path = require('node:path');

const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isNaN(n) ? d : n;
};

const DEFAULTS = Object.freeze({
  port: 7100,
  tokenTtlSec: 86400,
  maxUploadBytes: 10 * 1024 * 1024 * 1024,
  statsFlushIntervalMs: 1000,
  pullMaxConcurrent: 2,
  pullTimeoutMs: 30 * 60 * 1000,
  pullMaxBytes: 10 * 1024 * 1024 * 1024,
});
const MAX_TIMER_MS = 2_147_483_647;
const MAX_TOKEN_TTL_SEC = 365 * 86400;
const MAX_TRANSFER_BYTES = 1024 ** 4;

function sanitizeConfig(input, warnFn = (message) => console.warn(`[config] ${message}`)) {
  const out = { ...input };
  const integer = (key, min, max, fallback) => {
    const value = Number(out[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      warnFn(`${key}=${out[key]} 非法，已回退 ${fallback}`);
      out[key] = fallback;
    } else {
      out[key] = value;
    }
  };

  integer('port', 1, 65535, DEFAULTS.port);
  integer('tokenTtlSec', 60, MAX_TOKEN_TTL_SEC, DEFAULTS.tokenTtlSec);
  integer('maxUploadBytes', 1, MAX_TRANSFER_BYTES, DEFAULTS.maxUploadBytes);
  integer('statsFlushIntervalMs', 100, MAX_TIMER_MS, DEFAULTS.statsFlushIntervalMs);
  integer('pullMaxConcurrent', 1, 1024, DEFAULTS.pullMaxConcurrent);
  integer('pullTimeoutMs', 1000, MAX_TIMER_MS, DEFAULTS.pullTimeoutMs);
  integer('pullMaxBytes', 1, MAX_TRANSFER_BYTES, DEFAULTS.pullMaxBytes);

  if (!out.publicBaseUrl) out.publicBaseUrl = `http://localhost:${out.port}`;
  out.publicBaseUrl = String(out.publicBaseUrl).replace(/\/+$/, '');
  return out;
}

const raw = {
  port: num(process.env.PORT, DEFAULTS.port),
  edgeId: process.env.EDGE_ID || 'edge-01',
  // 留空时在 sanitize 后使用已校验的端口构造，避免 PORT=Infinity 污染 URL。
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  storageDir: process.env.STORAGE_DIR || path.resolve('data/files'),
  dbPath: process.env.DB_PATH || path.resolve('data/edge.db'),

  tokenSecret: process.env.TOKEN_SECRET || '',
  tokenTtlSec: num(process.env.TOKEN_TTL_SEC, DEFAULTS.tokenTtlSec),
  apiKey: process.env.EDGE_API_KEY || '',

  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, DEFAULTS.maxUploadBytes),
  statsFlushIntervalMs: num(process.env.STATS_FLUSH_INTERVAL_MS, DEFAULTS.statsFlushIntervalMs),

  allowPrivatePull: process.env.PULL_ALLOW_PRIVATE_NET === 'true',
  pullMaxConcurrent: num(process.env.PULL_MAX_CONCURRENT, DEFAULTS.pullMaxConcurrent),
  pullTimeoutMs: num(process.env.PULL_TIMEOUT_MS, DEFAULTS.pullTimeoutMs),
  pullMaxBytes: num(process.env.PULL_MAX_BYTES, DEFAULTS.pullMaxBytes),

  enableXAccel: process.env.ENABLE_X_ACCEL === 'true',
  xAccelPrefix: process.env.X_ACCEL_PREFIX || '/internal',
  version: require('../package.json').version,
};

const config = sanitizeConfig(raw);
module.exports = config;
module.exports.sanitizeConfig = sanitizeConfig;
