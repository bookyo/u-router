'use strict';

const mongoose = require('mongoose');

// 文件分发任务：把某个下载项的源文件铺到更多 Edge。
// 总控只下发指令与签名 URL，文件字节直接在 Edge 之间传输（PULL 模式）。
const targetSchema = new mongoose.Schema(
  {
    edge_id: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'pulling', 'done', 'failed', 'skipped'],
      default: 'pending',
    },
    pull_id: { type: String, default: '' },
    // 当前逻辑拉取代次的稳定幂等键；POST 响应不确定或 stale 对账时复用，
    // 只有远端明确 failed 后才清空并开启新代次。
    dedup_key: { type: String, default: '' },
    // 完成后回填：该 Edge 上的 file_id，并自动登记到 File.edges
    edge_file_id: { type: String, default: '' },
    bytes: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: '' },
    // 最近一次有效进展（派发/字节推进/状态变化）；超过 stale 窗口无进展则重派
    updated_at: Date,
  },
  { _id: false },
);

const distributionSchema = new mongoose.Schema(
  {
    task_id: { type: String, required: true, unique: true },
    download_id: { type: String, required: true },
    filename: { type: String, default: '' },
    size: { type: Number, default: 0 },
    sha256: { type: String, default: '' },
    source_edge_id: { type: String, required: true },
    source_file_id: { type: String, required: true },
    targets: { type: [targetSchema], default: [] },
    status: {
      type: String,
      enum: ['running', 'completed', 'partial', 'failed'],
      default: 'running',
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Distribution', distributionSchema);
