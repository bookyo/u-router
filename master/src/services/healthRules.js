'use strict';

// 健康状态机的纯迁移规则（滞后设计，避免挂掉→恢复→挂掉反复抖动）：
//
// 主动探活（nextStatusFromActive）：
//   连续失败 >= offlineAfterFailures  → offline
//   连续失败 >= unhealthyAfterFailures → unhealthy
//   unhealthy/offline 连续成功 >= recoverySuccesses → degraded（观察期，小流量验证）
//
// 被动比率（nextStatusFromRatio，delivery_ratio = edge 实际请求 / 总控分发）：
//   ratio < unhealthyBelow → unhealthy
//   ratio < degradedBelow  → degraded（healthy 才降；degraded/unhealthy 保持）
//   比率良好时 degraded 需连续 recoveryPasses 次才回 healthy（先观察一个周期）

function nextStatusFromActive(current, consecutiveSuccesses, consecutiveFailures, cfg) {
  if (current === 'maintenance') return current;
  if (consecutiveFailures >= cfg.offlineAfterFailures) return 'offline';
  if (consecutiveFailures >= cfg.unhealthyAfterFailures) return 'unhealthy';
  if (
    (current === 'unhealthy' || current === 'offline') &&
    consecutiveSuccesses >= cfg.recoverySuccesses
  ) {
    return 'degraded';
  }
  return current;
}

function nextStatusFromRatio(current, ratio, consecutiveGoodRatio, cfg) {
  if (current === 'maintenance' || current === 'offline') return current;
  if (ratio < cfg.unhealthyBelow) return 'unhealthy';
  if (ratio < cfg.degradedBelow) {
    return current === 'healthy' ? 'degraded' : current;
  }
  // 比率良好
  if (current === 'healthy') return 'healthy';
  if (current === 'degraded') {
    return consecutiveGoodRatio >= cfg.recoveryPasses ? 'healthy' : 'degraded';
  }
  if (current === 'unhealthy') return 'degraded';
  return current;
}

module.exports = { nextStatusFromActive, nextStatusFromRatio };
