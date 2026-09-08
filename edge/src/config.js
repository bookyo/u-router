'use strict';

require('dotenv').config();
const path = require('node:path');

const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isNaN(n) ? d : n;
};

const port = num(process.env.PORT, 7100);

module.exports = {
  port,
  edgeId: process.env.EDGE_ID || 'edge-01',
  // 拼接下载链接用（上传响应里的 download_url），生产环境应是对外域名
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  storageDir: process.env.STORAGE_DIR || path.resolve('data/files'),
  dbPath: process.env.DB_PATH || path.resolve('data/edge.db'),

  // 与总控共享的 HMAC 密钥（总控 Edge 注册表里的 token_secret）
  tokenSecret: process.env.TOKEN_SECRET || '',
  tokenTtlSec: num(process.env.TOKEN_TTL_SEC, 86400),

  // 设置后，除 /api/health 外的 /api/* 都需要 x-api-key（总控拉统计时也要带）
  apiKey: process.env.EDGE_API_KEY || '',

  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024 * 1024),
  statsFlushIntervalMs: Math.max(100, num(process.env.STATS_FLUSH_INTERVAL_MS, 1000)),

  // 拉取（PULL 分发）安全与资源限制
  // 默认拒绝私网/回环源（SSRF 防护）；Edge 之间走内网分发时置 true
  allowPrivatePull: process.env.PULL_ALLOW_PRIVATE_NET === 'true',
  pullMaxConcurrent: Math.max(1, num(process.env.PULL_MAX_CONCURRENT, 2)),
  pullTimeoutMs: Math.max(1000, num(process.env.PULL_TIMEOUT_MS, 30 * 60 * 1000)),
  pullMaxBytes: Math.max(1, num(process.env.PULL_MAX_BYTES, 10 * 1024 * 1024 * 1024)),

  // Nginx/Caddy 前置时置 true：Node 只做鉴权和计数，
  // 通过 X-Accel-Redirect 把大文件传输交给反向代理
  enableXAccel: process.env.ENABLE_X_ACCEL === 'true',
  xAccelPrefix: process.env.X_ACCEL_PREFIX || '/internal',

  version: require('../package.json').version,
};
