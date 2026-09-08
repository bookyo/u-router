'use strict';

const express = require('express');
const Distribution = require('../models/Distribution');
const { ah } = require('../middleware');
const { createDistribution } = require('../services/distributor');

module.exports = function distributionsRouter({ config: cfg }) {
  const router = express.Router();

  // 把某个下载项的源文件铺到更多 Edge（PULL 模式，总控不过文件字节）
  router.post(
    '/api/v1/files/:downloadId/distribute',
    ah(async (req, res) => {
      const { targets, source_edge_id, sha256, size, filename } = req.body || {};
      const task = await createDistribution(
        { downloadId: req.params.downloadId, targets, sourceEdgeId: source_edge_id, sha256, size, filename },
        cfg,
      );
      return res.status(201).json(task);
    }),
  );

  router.get(
    '/api/v1/distributions',
    ah(async (req, res) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const tasks = await Distribution.find().sort({ createdAt: -1 }).limit(limit).lean();
      return res.json(tasks);
    }),
  );

  router.get(
    '/api/v1/distributions/:taskId',
    ah(async (req, res) => {
      const task = await Distribution.findOne({ task_id: req.params.taskId }).lean();
      if (!task) return res.status(404).json({ error: 'task_id 不存在' });
      return res.json(task);
    }),
  );

  // 重试失败的目标（全部或指定 edge_ids）：清零计数重新派发
  router.post(
    '/api/v1/distributions/:taskId/retry',
    ah(async (req, res) => {
      const only = Array.isArray(req.body && req.body.edge_ids) ? req.body.edge_ids : null;
      const task = await Distribution.findOne({ task_id: req.params.taskId });
      if (!task) return res.status(404).json({ error: 'task_id 不存在' });
      let reset = 0;
      for (const t of task.targets) {
        if (t.status !== 'failed') continue;
        if (only && !only.includes(t.edge_id)) continue;
        t.status = 'pending';
        t.attempts = 0;
        t.error = '';
        reset += 1;
      }
      if (reset > 0) {
        task.status = 'running';
        await task.save();
      }
      return res.json({ reset, task });
    }),
  );

  return router;
};
