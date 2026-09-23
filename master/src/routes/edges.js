'use strict';

const crypto = require('node:crypto');
const express = require('express');
const Edge = require('../models/Edge');
const File = require('../models/File');
const { ah } = require('../middleware');
const { validateEdgeCreate, sanitizeEdgePatch } = require('../services/validators');
const { allEdgesDelivery, edgeDelivery } = require('../services/metricsQuery');
const { checkEdge } = require('../services/healthCheck');
const { resetStreak } = require('../services/passiveHealth');
const { assertPublicUrl } = require('../services/networkPolicy');

// 列表/详情响应中隐藏密钥字段（创建响应保留一次生成的密钥供登记 Edge）
function stripSecrets(edge) {
  if (!edge || typeof edge !== 'object') return edge;
  const plain = typeof edge.toObject === 'function' ? edge.toObject() : { ...edge };
  delete plain.token_secret;
  delete plain.api_key;
  return plain;
}

// 列表一次性聚合所有边的窗口数据（每窗口 2 次聚合，而非每边每窗口 2 次）
async function deliveryForWindow(cfg, name) {
  const per = await allEdgesDelivery(cfg.ratioWindows[name].sec);
  return (edgeId) => {
    const d = per.get(edgeId) || {
      dispatch: 0,
      requests: 0,
      s2xx: 0,
      downloads_started: 0,
      downloads_completed: 0,
      ratio: null,
    };
    return {
      dispatch: d.dispatch,
      requests: d.requests,
      s2xx: d.s2xx,
      downloads_started: d.downloads_started,
      downloads_completed: d.downloads_completed,
      ratio: d.ratio === null ? null : Number(d.ratio.toFixed(4)),
    };
  };
}

module.exports = function edgesRouter({ config: cfg }) {
  const router = express.Router();

  router.post(
    '/api/v1/edges',
    ah(async (req, res) => {
      const body = req.body || {};
      const v = validateEdgeCreate(body);
      if (!v.ok) return res.status(400).json({ error: v.error });
      await assertPublicUrl(body.base_url);

      const { edge_id, name, region, base_url, weight, token_secret, api_key, enabled } = body;
      const id = edge_id || `edge-${crypto.randomBytes(3).toString('hex')}`;
      if (await Edge.findOne({ edge_id: id })) {
        return res.status(409).json({ error: `edge_id ${id} 已存在` });
      }
      const doc = await Edge.create({
        edge_id: id,
        name: name || id,
        region: region || '',
        base_url,
        // 不传则自动生成；需与该 Edge 的 TOKEN_SECRET 一致
        token_secret: token_secret || crypto.randomBytes(24).toString('hex'),
        api_key: api_key || '',
        weight: weight ?? 100,
        enabled: enabled !== false,
      });
      // 注册后立即触发首次探活：base_url 填错能秒级发现，而不是等下一轮巡检
      checkEdge(doc, cfg).catch((e) => console.error(`[health] ${id} 注册后首探异常: ${e.message}`));
      return res.status(201).json(doc);
    }),
  );

  router.get(
    '/api/v1/edges',
    ah(async (req, res) => {
      const edges = await Edge.find().lean();
      const getters = {};
      for (const name of Object.keys(cfg.ratioWindows)) {
        getters[name] = await deliveryForWindow(cfg, name);
      }
      return res.json(
        edges.map((e) => ({
          ...stripSecrets(e),
          delivery: Object.fromEntries(
            Object.entries(getters).map(([name, get]) => [name, get(e.edge_id)]),
          ),
        })),
      );
    }),
  );

  router.get(
    '/api/v1/edges/:edgeId',
    ah(async (req, res) => {
      const edge = await Edge.findOne({ edge_id: req.params.edgeId }).lean();
      if (!edge) return res.status(404).json({ error: 'edge_id 不存在' });
      const delivery = {};
      for (const [name, w] of Object.entries(cfg.ratioWindows)) {
        const d = await edgeDelivery(edge.edge_id, w.sec);
        delivery[name] = {
          dispatch: d.dispatch,
          requests: d.requests,
          s2xx: d.s2xx,
          downloads_started: d.downloads_started,
          downloads_completed: d.downloads_completed,
          ratio: d.ratio === null ? null : Number(d.ratio.toFixed(4)),
        };
      }
      return res.json({ ...stripSecrets(edge), delivery });
    }),
  );

  // 通过 sanitizeEdgePatch 白名单校验后再 $set（Mongoose update 默认不跑
  // validators，直写会把 status=banana / 负 weight 存进库）
  router.patch(
    '/api/v1/edges/:edgeId',
    ah(async (req, res) => {
      const v = sanitizeEdgePatch(req.body || {});
      if (!v.ok) return res.status(400).json({ error: v.error });
      if (Object.keys(v.patch).length === 0) {
        return res.status(400).json({ error: '没有可更新的字段' });
      }
      if (v.patch.base_url) await assertPublicUrl(v.patch.base_url);
      const doc = await Edge.findOneAndUpdate(
        { edge_id: req.params.edgeId },
        { $set: v.patch },
        { new: true, runValidators: true },
      );
      if (!doc) return res.status(404).json({ error: 'edge_id 不存在' });
      return res.json(stripSecrets(doc));
    }),
  );

  // 手动触发一次探活
  router.post(
    '/api/v1/edges/:edgeId/probe',
    ah(async (req, res) => {
      const edge = await Edge.findOne({ edge_id: req.params.edgeId });
      if (!edge) return res.status(404).json({ error: 'edge_id 不存在' });
      const result = await checkEdge(edge, cfg);
      const fresh = await Edge.findOne({ edge_id: edge.edge_id }).lean();
      return res.json({ probe: result, edge: stripSecrets(fresh) });
    }),
  );

  router.delete(
    '/api/v1/edges/:edgeId',
    ah(async (req, res) => {
      const { deletedCount } = await Edge.deleteOne({ edge_id: req.params.edgeId });
      if (!deletedCount) return res.status(404).json({ error: 'edge_id 不存在' });
      // 同步清理文件上的该 Edge 映射和被动引擎的评估轮数残留
      await File.updateMany({}, { $pull: { edges: { edge_id: req.params.edgeId } } });
      resetStreak(req.params.edgeId);
      return res.status(204).end();
    }),
  );

  return router;
};

module.exports.stripSecrets = stripSecrets;
