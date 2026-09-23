'use strict';

const mongoose = require('mongoose');

// 总控“分配量”分钟桶：链接每被分发一次 +1。
// 与 Edge 上报的“完整下载量”对比得到 delivery_ratio，用于被动健康检测。
const dispatchLogSchema = new mongoose.Schema({
  minute: { type: Date, required: true }, // 分钟起点
  edge_id: { type: String, required: true },
  file_id: { type: String, required: true }, // download_id
  count: { type: Number, default: 0 },
});

dispatchLogSchema.index({ minute: 1, edge_id: 1, file_id: 1 }, { unique: true });
// TTL：分配量分钟桶保留 30 天，长期运行防止 MongoDB 无限增长
//（如需更长保留期，用 mongosh 的 collMod 调整 expireAfterSeconds）
dispatchLogSchema.index({ minute: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model('DispatchLog', dispatchLogSchema);
