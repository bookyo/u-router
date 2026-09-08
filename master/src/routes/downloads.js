'use strict';

const express = require('express');
const File = require('../models/File');
const Edge = require('../models/Edge');
const { weightedSampleN, effectiveWeights } = require('../services/scheduler');
const { sign } = require('../services/token');
const { ah, rateLimitPerIp } = require('../middleware');

// 核心分发 API：GET /api/v1/downloads/:downloadId/links?count=10&ttl=86400
// 按有效权重加权随机挑选 Edge，签发带过期时间的下载 token，并记录分配量。
// 可选 per-IP 限流（LINKS_RATE_LIMIT_PER_MIN > 0 时启用），防止刷接口虚增分配量
// 把 delivery_ratio 压到阈值以下、导致被动健康引擎误摘 Edge。
module.exports = function downloadsRouter({ recorder, config: cfg }) {
  const router = express.Router();
  // 注意挂在具体路由上：本路由器挂载在根路径，router.use(mw) 会波及所有请求
  const linksGuard =
    cfg.linksRateLimitPerMin > 0 ? rateLimitPerIp({ windowMs: 60000, max: cfg.linksRateLimitPerMin }) : null;

  router.get(
    '/api/v1/downloads/:downloadId/links',
    ...(linksGuard ? [linksGuard] : []),
    ah(async (req, res) => {
      const count = Math.min(Math.max(parseInt(req.query.count, 10) || 1, 1), 50);
      let ttl = parseInt(req.query.ttl, 10) || cfg.defaultTokenTtlSec;
      ttl = Math.min(Math.max(ttl, 60), cfg.maxTokenTtlSec);

      const file = await File.findOne({ download_id: req.params.downloadId });
      if (!file) return res.status(404).json({ error: 'download_id 不存在' });
      if (!file.enabled) return res.status(403).json({ error: '该下载项已停用' });

      const edgeIds = file.edges.map((e) => e.edge_id);
      const edgeDocs = await Edge.find({ edge_id: { $in: edgeIds }, enabled: true });
      const candidates = effectiveWeights(file.edges, edgeDocs).filter((c) => c.weight > 0);
      if (candidates.length === 0) {
        return res.status(503).json({
          error: '没有可用的 Edge 节点',
          edges: file.edges.map((e) => ({ edge_id: e.edge_id, paused: e.paused })),
        });
      }

      const picks = weightedSampleN(
        candidates.map((c) => c.weight),
        count,
      );
      const exp = Math.floor(Date.now() / 1000) + ttl;
      const links = picks.map((idx) => {
        const { fileEdge, edge } = candidates[idx];
        recorder.record(edge.edge_id, file.download_id);
        const url = fileEdge.url_override
          ? fileEdge.url_override
          : `${edge.base_url.replace(/\/+$/, '')}/d/${sign({ f: fileEdge.edge_file_id, exp }, edge.token_secret)}`;
        return {
          url,
          edge_id: edge.edge_id,
          file_id: fileEdge.edge_file_id,
          expire: new Date(exp * 1000).toISOString(),
        };
      });

      return res.json({
        download_id: file.download_id,
        filename: file.filename,
        count,
        links,
      });
    }),
  );

  return router;
};
