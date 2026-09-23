'use strict';

const mongoose = require('mongoose');

const edgeSchema = new mongoose.Schema(
  {
    edge_id: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    region: { type: String, default: '' },
    // Edge 对外 base_url，如 https://us1.example.com
    base_url: { type: String, required: true },
    // 与 Edge 共享的 HMAC 密钥：总控用它签发下载 token，Edge 用它验签
    token_secret: { type: String, required: true },
    // 调用该 Edge 管理 API（拉取 /api/stats 等）时携带的 x-api-key，可空
    api_key: { type: String, default: '' },
    weight: { type: Number, default: 100, min: 0 },
    status: {
      type: String,
      enum: ['healthy', 'degraded', 'unhealthy', 'offline', 'maintenance'],
      default: 'healthy',
    },
    enabled: { type: Boolean, default: true },
    health: {
      // 每次主动探活计数变化时递增；主动/被动状态迁移以此做版本 CAS，
      // 避免两个引擎分别基于不同快照互相覆盖。
      revision: { type: Number, default: 0 },
      last_check_at: Date,
      last_ok_at: Date,
      latency_ms: Number,
      consecutive_failures: { type: Number, default: 0 },
      consecutive_successes: { type: Number, default: 0 },
      last_error: { type: String, default: '' },
      payload: { type: mongoose.Schema.Types.Mixed, default: null },
      last_ratios: { type: mongoose.Schema.Types.Mixed, default: null },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Edge', edgeSchema);
