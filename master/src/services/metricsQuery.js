'use strict';

const DispatchLog = require('../models/DispatchLog');
const EdgeMetric = require('../models/EdgeMetric');

// 指标查询的统一实现：
// - 单边查询（被动健康引擎用）
// - 全边一次聚合（列表/指标 API 用，修复 N+1）
// - 单文件按 (edge_id, file_id) 维度查询（同一物理 Edge 双域名注册时不合并计数）

const windowStart = (windowSec) => new Date(Math.floor(Date.now() / 60000) * 60000 - windowSec * 1000);
// 比率分子用 downloads_completed（完整送达的下载）：
// - 打开后中断、失败请求不会进入分子
// - HEAD 即使返回 2xx 也只是元数据探测，不能抬高交付健康度
// requests / s2xx / downloads_started 仅作为原始指标展示
const ratioOf = (dispatch, completed) => (dispatch > 0 ? Math.min(completed / dispatch, 1.5) : null);
// 排除系统统计桶（_invalid/_unknown 等）：无效 token 或未知文件的请求
// 不代表真实交付
const NOT_SYSTEM_BUCKET = { file_id: { $not: /^_/ } };

async function edgeDelivery(edgeId, windowSec) {
  const since = windowStart(windowSec);
  const [d, r] = await Promise.all([
    DispatchLog.aggregate([
      { $match: { edge_id: edgeId, minute: { $gte: since } } },
      { $group: { _id: null, count: { $sum: '$count' } } },
    ]),
    EdgeMetric.aggregate([
      { $match: { edge_id: edgeId, minute: { $gte: since }, ...NOT_SYSTEM_BUCKET } },
      {
        $group: {
          _id: null,
          requests: { $sum: '$requests' },
          s2xx: { $sum: '$s2xx' },
          downloads_started: { $sum: '$downloads_started' },
          downloads_completed: { $sum: '$downloads_completed' },
        },
      },
    ]),
  ]);
  const dispatch = d[0]?.count || 0;
  const requests = r[0]?.requests || 0;
  const s2xx = r[0]?.s2xx || 0;
  const downloads_started = r[0]?.downloads_started || 0;
  const downloads_completed = r[0]?.downloads_completed || 0;
  return {
    dispatch,
    requests,
    s2xx,
    downloads_started,
    downloads_completed,
    ratio: ratioOf(dispatch, downloads_completed),
  };
}

async function allEdgesDelivery(windowSec) {
  const since = windowStart(windowSec);
  const [d, r] = await Promise.all([
    DispatchLog.aggregate([
      { $match: { minute: { $gte: since } } },
      { $group: { _id: '$edge_id', dispatch: { $sum: '$count' } } },
    ]),
    EdgeMetric.aggregate([
      { $match: { minute: { $gte: since }, ...NOT_SYSTEM_BUCKET } },
      {
        $group: {
          _id: '$edge_id',
          requests: { $sum: '$requests' },
          s2xx: { $sum: '$s2xx' },
          downloads_started: { $sum: '$downloads_started' },
          downloads_completed: { $sum: '$downloads_completed' },
        },
      },
    ]),
  ]);
  const map = new Map();
  for (const row of d) {
    map.set(row._id, {
      dispatch: row.dispatch,
      requests: 0,
      s2xx: 0,
      downloads_started: 0,
      downloads_completed: 0,
    });
  }
  for (const row of r) {
    const cur = map.get(row._id) || {
      dispatch: 0,
      requests: 0,
      s2xx: 0,
      downloads_started: 0,
      downloads_completed: 0,
    };
    cur.requests = row.requests;
    cur.s2xx = row.s2xx;
    cur.downloads_started = row.downloads_started;
    cur.downloads_completed = row.downloads_completed;
    map.set(row._id, cur);
  }
  for (const v of map.values()) v.ratio = ratioOf(v.dispatch, v.downloads_completed);
  return map;
}

async function fileDelivery(file, windowSec) {
  const since = windowStart(windowSec);
  const edgeIds = file.edges.map((e) => e.edge_id);
  const edgeFileIds = file.edges.map((e) => e.edge_file_id);
  const [d, m] = await Promise.all([
    DispatchLog.aggregate([
      { $match: { file_id: file.download_id, minute: { $gte: since } } },
      { $group: { _id: '$edge_id', dispatch: { $sum: '$count' } } },
    ]),
    EdgeMetric.aggregate([
      { $match: { edge_id: { $in: edgeIds }, file_id: { $in: edgeFileIds }, minute: { $gte: since } } },
      {
        $group: {
          _id: { edge_id: '$edge_id', file_id: '$file_id' },
          requests: { $sum: '$requests' },
          s2xx: { $sum: '$s2xx' },
          downloads_started: { $sum: '$downloads_started' },
          downloads_completed: { $sum: '$downloads_completed' },
          bytes_sent: { $sum: '$bytes_sent' },
        },
      },
    ]),
  ]);
  const dispatchByEdge = new Map(d.map((x) => [x._id, x.dispatch]));
  const metricByKey = new Map(m.map((x) => [`${x._id.edge_id}\u0000${x._id.file_id}`, x]));
  return file.edges.map((fe) => {
    const dispatch = dispatchByEdge.get(fe.edge_id) || 0;
    const row = metricByKey.get(`${fe.edge_id}\u0000${fe.edge_file_id}`) || {};
    const s2xx = row.s2xx || 0;
    const downloads_started = row.downloads_started || 0;
    return {
      edge_id: fe.edge_id,
      edge_file_id: fe.edge_file_id,
      dispatch,
      requests: row.requests || 0,
      s2xx,
      downloads_started,
      downloads_completed: row.downloads_completed || 0,
      bytes_sent: row.bytes_sent || 0,
      ratio: ratioOf(dispatch, row.downloads_completed || 0),
    };
  });
}

// 窗口白名单查找必须用自有属性判断：真值判断会把 constructor/__proto__
// 等原型链键当成合法窗口，导致下游 Invalid Date → 500
function pickWindow(cfg, q) {
  return typeof q === 'string' && Object.hasOwn(cfg.ratioWindows, q) ? q : cfg.primaryWindow;
}

module.exports = { edgeDelivery, allEdgesDelivery, fileDelivery, pickWindow };
