'use strict';

const express = require('express');
const Edge = require('../models/Edge');
const File = require('../models/File');
const { ah } = require('../middleware');
const { allEdgesDelivery, fileDelivery, pickWindow } = require('../services/metricsQuery');

module.exports = function metricsRouter({ config: cfg }) {
  const router = express.Router();

  // 各 Edge 的分配量 / 完整交付量 / delivery_ratio（一次聚合，无 N+1）
  router.get(
    '/api/v1/metrics/edges',
    ah(async (req, res) => {
      const window = pickWindow(cfg, req.query.window);
      const w = cfg.ratioWindows[window];
      const [edges, perEdge] = await Promise.all([Edge.find().lean(), allEdgesDelivery(w.sec)]);
      return res.json(
        edges.map((e) => {
          const d = perEdge.get(e.edge_id) || {
            dispatch: 0,
            requests: 0,
            s2xx: 0,
            downloads_started: 0,
            downloads_completed: 0,
            ratio: null,
          };
          return {
            edge_id: e.edge_id,
            status: e.status,
            window,
            dispatch: d.dispatch,
            requests: d.requests,
            s2xx: d.s2xx,
            downloads_started: d.downloads_started,
            downloads_completed: d.downloads_completed,
            ratio: d.ratio === null ? null : Number(d.ratio.toFixed(4)),
            health: {
              latency_ms: e.health?.latency_ms ?? null,
              last_check_at: e.health?.last_check_at ?? null,
              last_ok_at: e.health?.last_ok_at ?? null,
              last_error: e.health?.last_error || '',
            },
          };
        }),
      );
    }),
  );

  // 单个下载项在各 Edge 上的表现：按 (edge_id, edge_file_id) 维度，
  // 同一物理 Edge 双域名注册时不会合并双计数
  router.get(
    '/api/v1/metrics/files/:downloadId',
    ah(async (req, res) => {
      const file = await File.findOne({ download_id: req.params.downloadId }).lean();
      if (!file) return res.status(404).json({ error: 'download_id 不存在' });
      const window = pickWindow(cfg, req.query.window);
      const w = cfg.ratioWindows[window];
      const rows = await fileDelivery(file, w.sec);
      return res.json({
        download_id: file.download_id,
        window,
        edges: rows.map((r) => ({
          ...r,
          ratio: r.ratio === null ? null : Number(r.ratio.toFixed(4)),
        })),
      });
    }),
  );

  return router;
};
