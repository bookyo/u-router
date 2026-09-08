'use strict';

const mongoose = require('mongoose');

// Edge 上报的分钟统计桶（file_id 是 Edge 本地文件 ID，不是 download_id）。
// 每次拉取用最新值整体覆盖（$set），重复拉取幂等。
const edgeMetricSchema = new mongoose.Schema({
  edge_id: { type: String, required: true },
  minute: { type: Date, required: true },
  file_id: { type: String, required: true },
  requests: { type: Number, default: 0 },
  downloads_started: { type: Number, default: 0 },
  downloads_completed: { type: Number, default: 0 },
  bytes_sent: { type: Number, default: 0 },
  s2xx: { type: Number, default: 0 },
  s4xx: { type: Number, default: 0 },
  s5xx: { type: Number, default: 0 },
});

edgeMetricSchema.index({ edge_id: 1, minute: 1, file_id: 1 }, { unique: true });
// TTL：Edge 统计分钟桶保留 30 天，长期运行防止 MongoDB 无限增长
edgeMetricSchema.index({ minute: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model('EdgeMetric', edgeMetricSchema);
