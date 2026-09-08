'use strict';

const crypto = require('node:crypto');
const express = require('express');
const File = require('../models/File');
const Edge = require('../models/Edge');
const { ah } = require('../middleware');
const { isValidId, validateFileEdges } = require('../services/validators');

const genDownloadId = () => `f_${crypto.randomBytes(5).toString('hex')}`;

async function assertEdgesRegistered(edges) {
  const ids = [...new Set(edges.map((e) => e.edge_id))];
  const found = await Edge.countDocuments({ edge_id: { $in: ids } });
  if (found !== ids.length) {
    const err = new Error('edges 中包含未注册的 edge_id');
    err.status = 400;
    throw err;
  }
}

module.exports = function filesRouter() {
  const router = express.Router();

  router.post(
    '/api/v1/files',
    ah(async (req, res) => {
      const { download_id, filename, size, sha256, enabled, edges } = req.body || {};
      if (!filename) return res.status(400).json({ error: 'filename 必填' });
      if (download_id !== undefined && !isValidId(download_id)) {
        return res.status(400).json({ error: 'download_id 只允许字母数字与 . _ -（1~128 位）' });
      }
      const v = validateFileEdges(edges);
      if (!v.ok) return res.status(400).json({ error: v.error });
      await assertEdgesRegistered(v.normalized);

      const doc = await File.create({
        download_id: download_id || genDownloadId(),
        filename,
        size: size || 0,
        sha256: sha256 || '',
        enabled: enabled !== false,
        edges: v.normalized,
      });
      return res.status(201).json(doc);
    }),
  );

  router.get(
    '/api/v1/files',
    ah(async (req, res) => {
      const files = await File.find().sort({ createdAt: -1 }).lean();
      const edges = await Edge.find().lean();
      const byId = new Map(edges.map((e) => [e.edge_id, e]));
      return res.json(
        files.map((f) => ({
          ...f,
          edges: f.edges.map((fe) => ({
            ...fe,
            edge_status: byId.get(fe.edge_id)?.status ?? 'unregistered',
          })),
        })),
      );
    }),
  );

  router.get(
    '/api/v1/files/:downloadId',
    ah(async (req, res) => {
      const file = await File.findOne({ download_id: req.params.downloadId }).lean();
      if (!file) return res.status(404).json({ error: 'download_id 不存在' });
      const edges = await Edge.find({ edge_id: { $in: file.edges.map((e) => e.edge_id) } }).lean();
      const byId = new Map(edges.map((e) => [e.edge_id, e]));
      return res.json({
        ...file,
        edges: file.edges.map((fe) => ({
          ...fe,
          edge_status: byId.get(fe.edge_id)?.status ?? 'unregistered',
        })),
      });
    }),
  );

  router.patch(
    '/api/v1/files/:downloadId',
    ah(async (req, res) => {
      const { filename, size, sha256, enabled, edges } = req.body || {};
      const update = {};
      if (filename !== undefined) update.filename = filename;
      if (size !== undefined) update.size = size;
      if (sha256 !== undefined) update.sha256 = sha256;
      if (enabled !== undefined) update.enabled = !!enabled;
      if (edges !== undefined) {
        const v = validateFileEdges(edges);
        if (!v.ok) return res.status(400).json({ error: v.error });
        await assertEdgesRegistered(v.normalized);
        update.edges = v.normalized;
      }
      const doc = await File.findOneAndUpdate({ download_id: req.params.downloadId }, update, { new: true });
      if (!doc) return res.status(404).json({ error: 'download_id 不存在' });
      return res.json(doc);
    }),
  );

  // 追加一条 Edge 映射（不用整组替换 edges）
  router.post(
    '/api/v1/files/:downloadId/edges',
    ah(async (req, res) => {
      const v = validateFileEdges([req.body || {}]);
      if (!v.ok) return res.status(400).json({ error: v.error });
      const normalized = v.normalized[0];
      await assertEdgesRegistered([normalized]);
      const doc = await File.findOneAndUpdate(
        { download_id: req.params.downloadId, 'edges.edge_id': { $ne: normalized.edge_id } },
        { $push: { edges: normalized } },
        { new: true },
      );
      if (!doc) return res.status(409).json({ error: 'download_id 不存在或该 edge 映射已存在' });
      return res.status(201).json(doc);
    }),
  );

  router.delete(
    '/api/v1/files/:downloadId/edges/:edgeId',
    ah(async (req, res) => {
      const doc = await File.findOneAndUpdate(
        { download_id: req.params.downloadId },
        { $pull: { edges: { edge_id: req.params.edgeId } } },
        { new: true },
      );
      if (!doc) return res.status(404).json({ error: 'download_id 不存在' });
      return res.json(doc);
    }),
  );

  router.delete(
    '/api/v1/files/:downloadId',
    ah(async (req, res) => {
      const { deletedCount } = await File.deleteOne({ download_id: req.params.downloadId });
      if (!deletedCount) return res.status(404).json({ error: 'download_id 不存在' });
      return res.status(204).end();
    }),
  );

  return router;
};
