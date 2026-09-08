'use strict';

require('dotenv').config();

const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isNaN(n) ? d : n;
};

const raw = {
  port: num(process.env.PORT, 7000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/urouter',
  // 设置后所有 /api/* 需要 x-api-key 请求头（未设置 = 开发模式）
  apiKey: process.env.MASTER_API_KEY || '',

  healthCheckIntervalSec: num(process.env.HEALTH_CHECK_INTERVAL_SEC, 15),
  healthTimeoutMs: num(process.env.HEALTH_TIMEOUT_MS, 4000),
  statsPullIntervalSec: num(process.env.STATS_PULL_INTERVAL_SEC, 60),
  passiveCheckIntervalSec: num(process.env.PASSIVE_CHECK_INTERVAL_SEC, 30),

  // 主动探活的滞后参数
  unhealthyAfterFailures: num(process.env.UNHEALTHY_AFTER_FAILURES, 3),
  offlineAfterFailures: num(process.env.OFFLINE_AFTER_FAILURES, 10),
  recoverySuccesses: num(process.env.RECOVERY_SUCCESSES, 3),
  // 被动比率的滞后参数
  recoveryPasses: num(process.env.RECOVERY_PASSES, 2),
  degradedBelow: num(process.env.DEGRADED_BELOW, 0.9),
  unhealthyBelow: num(process.env.UNHEALTHY_BELOW, 0.7),

  // delivery_ratio 计算窗口：minDispatch 不足时不判定（凌晨没流量不惩罚）
  ratioWindows: Object.freeze({
    '5m': Object.freeze({ sec: 300, minDispatch: 30 }),
    '1h': Object.freeze({ sec: 3600, minDispatch: 100 }),
    '24h': Object.freeze({ sec: 86400, minDispatch: 300 }),
  }),
  primaryWindow: process.env.PRIMARY_WINDOW || '5m',

  defaultTokenTtlSec: num(process.env.DEFAULT_TOKEN_TTL_SEC, 86400),
  maxTokenTtlSec: num(process.env.MAX_TOKEN_TTL_SEC, 7 * 86400),
  dispatchFlushIntervalMs: num(process.env.DISPATCH_FLUSH_INTERVAL_MS, 5000),

  // 分发接口每 IP 每分钟限流（0 = 关闭）。开启可防止恶意刷 links 虚增
  // 分配量、把 delivery_ratio 压到阈值以下，导致被动健康引擎误摘除 Edge。
  linksRateLimitPerMin: num(process.env.LINKS_RATE_LIMIT_PER_MIN, 0),

  // 文件分发（PULL 模式）编排
  distributorIntervalSec: num(process.env.DISTRIBUTOR_INTERVAL_SEC, 10),
  distributionMaxAttempts: num(process.env.DISTRIBUTION_MAX_ATTEMPTS, 3),
  // 分发源 token 有效期（秒）：要覆盖慢速 Edge 间传输 + 重试的整段时间
  distributionTokenTtlSec: num(process.env.DISTRIBUTION_TOKEN_TTL_SEC, 172800),
  // 单个目标无进展（字节不推进）多久后重派
  distributionStaleSec: num(process.env.DISTRIBUTION_STALE_SEC, 3600),
};

// 配置清洗：非法值（负间隔/NaN/未知窗口名/颠倒阈值等）回退安全默认并告警，
// 否则一个坏环境变量就能让后台循环每轮抛错空转或高频运行
function sanitizeConfig(c) {
  const out = { ...c };
  const warn = (m) => console.warn(`[config] ${m}，已回退安全默认`);

  if (!Object.hasOwn(c.ratioWindows || {}, c.primaryWindow)) {
    warn(`PRIMARY_WINDOW=${c.primaryWindow} 不在支持列表`);
    out.primaryWindow = Object.keys(c.ratioWindows)[0];
  }

  const floors = {
    healthCheckIntervalSec: 1,
    statsPullIntervalSec: 1,
    passiveCheckIntervalSec: 1,
    distributorIntervalSec: 1,
    dispatchFlushIntervalMs: 100,
    healthTimeoutMs: 250,
    unhealthyAfterFailures: 1,
    recoverySuccesses: 1,
    recoveryPasses: 1,
    defaultTokenTtlSec: 60,
    distributionTokenTtlSec: 60,
  };
  for (const [k, min] of Object.entries(floors)) {
    if (!Number.isFinite(Number(out[k])) || Number(out[k]) < min) {
      warn(`${k}=${out[k]} 非法`);
      out[k] = min;
    } else {
      out[k] = Number(out[k]);
    }
  }

  // offline 必须严格大于 unhealthy，否则节点会先 offline 再 unhealthy（语义颠倒）
  if (!Number.isFinite(Number(out.offlineAfterFailures)) || Number(out.offlineAfterFailures) < 1) {
    out.offlineAfterFailures = 10;
  }
  if (Number(out.offlineAfterFailures) <= Number(out.unhealthyAfterFailures)) {
    warn('offlineAfterFailures 必须大于 unhealthyAfterFailures');
    out.offlineAfterFailures = Number(out.unhealthyAfterFailures) + 1;
  }

  if (!Number.isFinite(Number(out.distributionMaxAttempts)) || Number(out.distributionMaxAttempts) < 1) {
    warn('distributionMaxAttempts 非法');
    out.distributionMaxAttempts = 1;
  }
  // token 上限不能小于默认有效期
  if (!Number.isFinite(Number(out.maxTokenTtlSec)) || Number(out.maxTokenTtlSec) < Number(out.defaultTokenTtlSec)) {
    warn('maxTokenTtlSec 不能小于 defaultTokenTtlSec');
    out.maxTokenTtlSec = Number(out.defaultTokenTtlSec);
  }

  const okRatio = (v) => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1;
  if (
    !okRatio(out.degradedBelow) ||
    !okRatio(out.unhealthyBelow) ||
    Number(out.unhealthyBelow) >= Number(out.degradedBelow)
  ) {
    warn('比率阈值非法或 unhealthyBelow >= degradedBelow');
    out.degradedBelow = 0.9;
    out.unhealthyBelow = 0.7;
  }

  if (!Number.isFinite(Number(out.linksRateLimitPerMin)) || Number(out.linksRateLimitPerMin) < 0) {
    out.linksRateLimitPerMin = 0;
  }
  if (!Number.isFinite(Number(out.distributionStaleSec)) || Number(out.distributionStaleSec) < 60) {
    out.distributionStaleSec = 3600;
  }
  return out;
}

const config = sanitizeConfig(raw);
module.exports = config;
module.exports.sanitizeConfig = sanitizeConfig;
