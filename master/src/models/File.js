'use strict';

const mongoose = require('mongoose');

// 文件在某台 Edge 上的映射：edge_file_id 是该 Edge 本地的 file_id
const fileEdgeSchema = new mongoose.Schema(
  {
    edge_id: { type: String, required: true },
    edge_file_id: { type: String, required: true },
    weight: { type: Number, default: 100, min: 0 },
    paused: { type: Boolean, default: false },
    // 特殊场景直接覆盖下载 URL（如镜像站），一般留空
    url_override: { type: String, default: '' },
  },
  { _id: false },
);

const fileSchema = new mongoose.Schema(
  {
    download_id: { type: String, required: true, unique: true },
    filename: { type: String, required: true },
    size: { type: Number, default: 0 },
    sha256: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    edges: { type: [fileEdgeSchema], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model('File', fileSchema);
