'use strict';

const crypto = require('node:crypto');

// 常数时间比较，避免逐字节泄露密钥
function secretEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireApiKey(cfg) {
  return (req, res, next) => {
    if (!cfg.apiKey) return next(); // 未配置密钥 = 开发模式（启动时会打印警告）
    if (secretEqual(req.get('x-api-key') || '', cfg.apiKey)) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
}

// 简单 per-IP 固定窗口限流（单实例内存版）。max <= 0 时不建议挂载。
// 用途：保护分发接口不被刷——刷 links 会虚增分配量，把 delivery_ratio
// 压到阈值以下，导致被动健康引擎误摘所有 Edge。
function rateLimitPerIp({ windowMs = 60000, max = 0 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }
  let lastSweep = Date.now();
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) {
        if (v.resetAt <= now) hits.delete(k);
      }
      lastSweep = now;
    }
    const ip = req.socket?.remoteAddress || 'unknown';
    const rec = hits.get(ip);
    if (!rec || rec.resetAt <= now) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rec.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'rate limited' });
    }
    return next();
  };
}

// async 路由兜底，把异常交给 express 错误中间件
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { requireApiKey, rateLimitPerIp, secretEqual, ah };
