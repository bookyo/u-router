'use strict';

const Edge = require('../models/Edge');
const { nextStatusFromActive, nextStatusFromRatio } = require('./healthRules');
const { allEdgesDelivery } = require('./metricsQuery');

// 连续良好比率的评估轮数（edge_id -> 次数），滞后恢复用
const goodRatioStreaks = new Map();

// Edge 被删除或人工重置状态时清掉残留的评估轮数，避免小泄漏/脏 streak
function resetStreak(edgeId) {
  goodRatioStreaks.delete(edgeId);
}

// CAS 状态迁移：只有当前状态仍是 expectedFrom 时才写入。
// guard 可选地绑定探活计数版本——探活引擎的迁移基于某次读取的
// {successes, failures} 计算，若并发探活已改写计数（如新的失败把成功数归零），
// 迟到的迁移必须放弃，否则会用过期的成功信号把节点恢复为 degraded。
async function transitionStatus(edgeId, expectedFrom, next, guard = null) {
  if (expectedFrom === next) return { updated: false, noop: true };
  const filter = { edge_id: edgeId, status: expectedFrom };
  if (guard) {
    if (guard.successes !== undefined) filter['health.consecutive_successes'] = guard.successes;
    if (guard.failures !== undefined) filter['health.consecutive_failures'] = guard.failures;
    if (guard.revision !== undefined) filter['health.revision'] = guard.revision;
  }
  const r = await Edge.updateOne(filter, { $set: { status: next } });
  return { updated: r.modifiedCount === 1 };
}

async function runRound(cfg, log = console.log) {
  const primary = cfg.ratioWindows[cfg.primaryWindow];
  const edges = await Edge.find({ enabled: true, status: { $ne: 'maintenance' } });
  if (edges.length === 0) return;

  // 一轮一次聚合所有边的窗口数据（逐边聚合在节点多时拖长单轮）
  const per = await allEdgesDelivery(primary.sec);

  for (const edge of edges) {
    if (edge.health?.payload?.delivery_completion_observable === false) {
      resetStreak(edge.edge_id);
      await Edge.updateOne(
        { edge_id: edge.edge_id },
        { $set: { 'health.last_ratios': { [cfg.primaryWindow]: null } } },
      );
      continue;
    }
    const d = per.get(edge.edge_id) || {
      dispatch: 0,
      requests: 0,
      downloads_started: 0,
      downloads_completed: 0,
      ratio: null,
    };
    const { dispatch, downloads_completed: completed, ratio } = d;
    const ratios = { [cfg.primaryWindow]: ratio === null ? null : Number(ratio.toFixed(4)) };

    // 分配量不足时不判定：凌晨没流量不能说明 Edge 有问题
    if (ratio === null || dispatch < primary.minDispatch) {
      await Edge.updateOne({ edge_id: edge.edge_id }, { $set: { 'health.last_ratios': ratios } });
      continue;
    }

    // 主动探活先原子更新计数、随后 CAS 状态；被动轮次可能恰好读到两步之间的
    // 快照。若计数已明确要求主动迁移，则本轮让主动引擎优先，不能用高 ratio
    // 抢先把 degraded 恢复为 healthy。
    const activeNext = nextStatusFromActive(
      edge.status,
      edge.health?.consecutive_successes || 0,
      edge.health?.consecutive_failures || 0,
      cfg,
    );
    if (activeNext !== edge.status) {
      await Edge.updateOne({ edge_id: edge.edge_id }, { $set: { 'health.last_ratios': ratios } });
      log(`[passive] ${edge.edge_id}: 主动健康迁移待完成（${edge.status} → ${activeNext}），本轮让路`);
      continue;
    }

    const good = ratio >= cfg.degradedBelow;
    const streak = good ? (goodRatioStreaks.get(edge.edge_id) || 0) + 1 : 0;
    goodRatioStreaks.set(edge.edge_id, streak);

    const next = nextStatusFromRatio(edge.status, ratio, streak, cfg);
    if (next !== edge.status) {
      const r = await transitionStatus(edge.edge_id, edge.status, next, {
        revision: edge.health?.revision || 0,
      });
      if (r.updated) {
        log(
          `[passive] ${edge.edge_id}: delivery_ratio=${(ratio * 100).toFixed(1)}% (${completed}/${dispatch}) ${edge.status} → ${next}`,
        );
      } else {
        log(`[passive] ${edge.edge_id}: 状态已被并发修改（原读取为 ${edge.status}），本轮跳过`);
      }
    }
    await Edge.updateOne({ edge_id: edge.edge_id }, { $set: { 'health.last_ratios': ratios } });
  }
}

function startPassiveLoop(cfg, log = console.log) {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runRound(cfg, log);
    } catch (err) {
      log(`[passive] 本轮判定异常: ${err.message}`);
    } finally {
      running = false;
    }
  }, cfg.passiveCheckIntervalSec * 1000);
  t.unref?.();
  return t;
}

module.exports = { runRound, startPassiveLoop, resetStreak, transitionStatus };
