'use strict';

// Edge 状态 → 分发权重倍率：
// degraded 保留 20% 流量做观察期验证，其余异常状态全部摘除
const STATUS_WEIGHT_MULTIPLIER = Object.freeze({
  healthy: 1,
  degraded: 0.2,
  unhealthy: 0,
  offline: 0,
  maintenance: 0,
});

// 有放回的加权随机抽样：返回 count 个被选中的下标（与 weights 一一对应）。
// 权重为 0 的候选不会被选中；总权重为 0 时返回空数组。
// 负权重视为 0（历史脏数据兜底）：负值会抵消总权重，让全部分发失败。
function weightedSampleN(weights, count, rand = Math.random) {
  const weightsSafe = weights.map((w) => (w > 0 ? w : 0));
  const total = weightsSafe.reduce((a, b) => a + b, 0);
  if (total <= 0 || count <= 0) return [];

  let lastPositive = -1;
  for (let i = 0; i < weightsSafe.length; i++) {
    if (weightsSafe[i] > 0) lastPositive = i;
  }
  if (lastPositive < 0) return [];

  const picks = [];
  for (let n = 0; n < count; n++) {
    let r = rand() * total;
    let chosen = lastPositive; // 浮点边界兜底
    for (let i = 0; i < weightsSafe.length; i++) {
      r -= weightsSafe[i];
      if (r < 0) {
        chosen = i;
        break;
      }
    }
    picks.push(chosen);
  }
  return picks;
}

// 计算文件各候选边的有效权重：文件边权重 × Edge 权重 × 状态倍率。
// paused / 未注册 / enabled=false / 异常状态的候选权重为 0。
// 返回数组与入参 fileEdges 下标一一对应，方便外层按下标取候选。
function effectiveWeights(fileEdges, edgeDocs) {
  const byId = new Map(edgeDocs.map((e) => [e.edge_id, e]));
  return fileEdges.map((fe) => {
    const edge = byId.get(fe.edge_id);
    let weight = 0;
    if (edge && !fe.paused && edge.enabled !== false) {
      const multiplier = STATUS_WEIGHT_MULTIPLIER[edge.status] ?? 0;
      // 钳到非负：脏数据里的负权重会把其它候选的权重也抵消掉
      weight = Math.max(0, (fe.weight ?? 100) * (edge.weight ?? 100) * multiplier);
    }
    return { fileEdge: fe, edge, weight };
  });
}

module.exports = { weightedSampleN, effectiveWeights, STATUS_WEIGHT_MULTIPLIER };
