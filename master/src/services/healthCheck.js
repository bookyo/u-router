'use strict';

const Edge = require('../models/Edge');
const { nextStatusFromActive } = require('./healthRules');
const { transitionStatus } = require('./passiveHealth');

// 对单个 Edge 执行一次主动探活并落库状态迁移。
// 计数用 findOneAndUpdate + $inc 原子更新：定时循环、手动 probe、注册后首探
// 可能并发跑同一个 Edge，读-改-写整个 health 子文档会互相覆盖丢计数；
// 同时只 $set 具体字段，不再整体覆盖 health（避免盖掉被动引擎写的 last_ratios）。
async function checkEdge(edge, cfg, log = console.log) {
  const base = edge.base_url.replace(/\/+$/, '');
  const started = Date.now();
  let ok = false;
  let error = '';
  let body = null;
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(cfg.healthTimeoutMs),
      headers: edge.api_key ? { 'x-api-key': edge.api_key } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
    ok = true;
  } catch (e) {
    error = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : e.message || String(e);
  }
  const latency = Date.now() - started;

  const ops = ok
    ? {
        $set: {
          'health.last_check_at': new Date(),
          'health.last_ok_at': new Date(),
          'health.latency_ms': latency,
          'health.last_error': '',
          'health.payload': body,
          'health.consecutive_failures': 0,
        },
        $inc: { 'health.consecutive_successes': 1 },
      }
    : {
        $set: {
          'health.last_check_at': new Date(),
          'health.last_error': error,
          'health.consecutive_successes': 0,
        },
        $inc: { 'health.consecutive_failures': 1 },
      };

  const fresh = await Edge.findOneAndUpdate({ edge_id: edge.edge_id }, ops, { new: true });
  if (!fresh) {
    // Edge 已被并发删除
    return { ok, error, latency_ms: latency, status: 'deleted', changed: false };
  }

  const next = nextStatusFromActive(
    fresh.status,
    fresh.health.consecutive_successes,
    fresh.health.consecutive_failures,
    cfg,
  );
  let changed = false;
  if (next !== fresh.status) {
    // CAS 绑定状态 + 计数版本：并发探活改写计数（如新的失败归零成功数）后，
    // 迟到的迁移必须放弃，避免用过期成功信号把节点恢复为 degraded
    const r = await transitionStatus(edge.edge_id, fresh.status, next, {
      successes: fresh.health.consecutive_successes,
      failures: fresh.health.consecutive_failures,
    });
    changed = r.updated;
    if (r.updated) {
      log(
        `[health] ${edge.edge_id}: ${fresh.status} → ${next}${ok ? '' : `（连续失败 ${fresh.health.consecutive_failures}: ${error}）`}`,
      );
    } else {
      log(`[health] ${edge.edge_id}: 状态/计数已被并发修改，跳过 ${next} 写入`);
    }
  }
  return { ok, error, latency_ms: latency, status: next, changed };
}

async function runRound(cfg, log) {
  const edges = await Edge.find({ enabled: true });
  await Promise.all(
    edges.map((e) =>
      checkEdge(e, cfg, log).catch((err) => log(`[health] ${e.edge_id} 检查异常: ${err.message}`)),
    ),
  );
}

function startHealthLoop(cfg, log = console.log) {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runRound(cfg, log);
    } finally {
      running = false;
    }
  }, cfg.healthCheckIntervalSec * 1000);
  t.unref?.();
  return t;
}

module.exports = { checkEdge, runRound, startHealthLoop };
