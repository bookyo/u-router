'use strict';

const Edge = require('../models/Edge');
const EdgeMetric = require('../models/EdgeMetric');
const { fetchEdge } = require('./networkPolicy');

// 拉取起点游标：从该 Edge 已存的最后一个分钟桶续拉（覆盖式幂等），
// 修复总控停机超过 2 分钟时中间分钟桶永久丢失的问题。
// - 无历史：默认回拉 2 分钟
// - 时钟偏移（Edge 分钟超前）：钳到当前分钟
// - 过早历史：最多回溯 24 小时，避免首次注册拉全量
function sinceFromLastStored(lastMinute, nowMs = Date.now()) {
  const nowMin = Math.floor(nowMs / 60000);
  if (!Number.isFinite(lastMinute)) return nowMin - 2;
  return Math.max(Math.min(Math.floor(lastMinute), nowMin), nowMin - 1440);
}

async function pullEdge(edge, log = console.log) {
  const base = edge.base_url.replace(/\/+$/, '');
  const last = await EdgeMetric.findOne({ edge_id: edge.edge_id }).sort({ minute: -1 }).lean();
  const sinceMinute = sinceFromLastStored(last ? Math.floor(new Date(last.minute).getTime() / 60000) : NaN);
  const res = await fetchEdge(`${base}/api/stats?since=${sinceMinute}`, {
    signal: AbortSignal.timeout(8000),
    headers: edge.api_key ? { 'x-api-key': edge.api_key } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return 0;

  const ops = rows.map((r) => {
    const minute = new Date(r.minute);
    if (Number.isNaN(minute.getTime())) throw new Error(`非法的 minute 字段: ${r.minute}`);
    return {
      updateOne: {
        filter: { edge_id: edge.edge_id, minute, file_id: r.file_id },
        update: {
          $set: {
            requests: r.requests || 0,
            downloads_started: r.downloads_started || 0,
            downloads_completed: r.downloads_completed || 0,
            bytes_sent: r.bytes_sent || 0,
            s2xx: r.s2xx || 0,
            s4xx: r.s4xx || 0,
            s5xx: r.s5xx || 0,
          },
        },
        upsert: true,
      },
    };
  });
  await EdgeMetric.bulkWrite(ops, { ordered: false });
  return rows.length;
}

function startStatsLoop(cfg, log = console.log) {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // offline 已被主动探活判定不可达，跳过以减少无效请求和日志噪音；
      // 其余节点按批并发拉取（节点多时不拖长单轮）
      const edges = await Edge.find({ enabled: true, status: { $ne: 'offline' } });
      const BATCH = 4;
      for (let i = 0; i < edges.length; i += BATCH) {
        await Promise.all(
          edges.slice(i, i + BATCH).map(async (edge) => {
            try {
              const n = await pullEdge(edge, log);
              if (n > 0) log(`[stats] ${edge.edge_id} 拉取 ${n} 个分钟桶`);
            } catch (e) {
              log(`[stats] ${edge.edge_id} 拉取失败: ${e.message}`);
            }
          }),
        );
      }
    } finally {
      running = false;
    }
  }, cfg.statsPullIntervalSec * 1000);
  t.unref?.();
  return t;
}

module.exports = { pullEdge, startStatsLoop, sinceFromLastStored };
