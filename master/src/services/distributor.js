'use strict';

const crypto = require('node:crypto');
const Distribution = require('../models/Distribution');
const File = require('../models/File');
const Edge = require('../models/Edge');
const { sign } = require('./token');
const { isValidId } = require('./validators');
const { fetchEdge } = require('./networkPolicy');

// 分发编排引擎（总控不过文件字节）：
// 1. createDistribution：确定源（首个或指定映射）、校验目标、自动发现源文件元数据
// 2. runRound：给 pending 目标派发拉取任务（签名源 URL），跟踪 pulling 进度，
//    done 后自动登记 File.edges；失败重试直到上限
// 文件数据流：目标 Edge ←(签名 URL + Range 断点续传)← 源 Edge

function httpErr(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const headersFor = (edgeDoc) => (edgeDoc.api_key ? { 'x-api-key': edgeDoc.api_key } : {});

function dedupKeyFor(taskId, edgeId, attempt) {
  const readable = `${taskId}:${edgeId}:${attempt}`;
  if (readable.length <= 128) return readable;
  return `d_${crypto.createHash('sha256').update(readable).digest('hex')}`;
}

// 从源 Edge 的文件列表自动发现 sha256 / size / filename
async function discoverSourceMeta(sourceEdge, sourceFileId) {
  const base = sourceEdge.base_url.replace(/\/+$/, '');
  const res = await fetchEdge(`${base}/api/files?limit=10000`, {
    signal: AbortSignal.timeout(5000),
    headers: headersFor(sourceEdge),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const files = await res.json();
  const hit = (Array.isArray(files) ? files : []).find((f) => f.file_id === sourceFileId);
  if (!hit) throw new Error(`源 Edge 上找不到文件 ${sourceFileId}`);
  return { filename: hit.filename, size: hit.size, sha256: hit.sha256 };
}

async function createDistribution(
  { downloadId, targets, sourceEdgeId, sha256, size, filename },
  cfg,
  log = console.log,
) {
  const file = await File.findOne({ download_id: downloadId });
  if (!file) throw httpErr('download_id 不存在', 404);
  if (!Array.isArray(targets) || targets.length === 0) {
    throw httpErr('targets 必填（至少一个 edge_id）');
  }
  for (const t of targets) {
    if (!isValidId(t)) throw httpErr('targets 包含非法 edge_id');
  }
  const source = sourceEdgeId
    ? file.edges.find((e) => e.edge_id === sourceEdgeId)
    : file.edges[0];
  if (!source) throw httpErr('该下载项还没有任何 Edge 映射，无法确定分发源');

  let meta = {
    filename: filename || file.filename,
    size: size || file.size || 0,
    sha256: sha256 || file.sha256 || '',
  };
  if (!meta.sha256 || !meta.size) {
    try {
      const srcEdge = await Edge.findOne({ edge_id: source.edge_id });
      if (srcEdge) {
        const discovered = await discoverSourceMeta(srcEdge, source.edge_file_id);
        meta = {
          filename: meta.filename || discovered.filename,
          size: meta.size || discovered.size,
          sha256: meta.sha256 || discovered.sha256,
        };
      }
    } catch (e) {
      log(`[distribute] ${downloadId} 源元数据自动发现失败（将不做校验分发）: ${e.message}`);
    }
  }

  const existing = new Set(file.edges.map((e) => e.edge_id));
  const uniqTargets = [...new Set(targets)];
  const edgeDocs = await Edge.find({ edge_id: { $in: uniqTargets } }).lean();
  const byId = new Map(edgeDocs.map((e) => [e.edge_id, e]));

  const targetRows = uniqTargets.map((tid) => {
    if (tid === source.edge_id) return { edge_id: tid, status: 'skipped', error: '目标即分发源' };
    if (existing.has(tid)) return { edge_id: tid, status: 'skipped', error: '该 Edge 已有映射' };
    const doc = byId.get(tid);
    if (!doc) return { edge_id: tid, status: 'failed', error: 'edge_id 未注册' };
    if (doc.enabled === false) return { edge_id: tid, status: 'failed', error: 'Edge 已停用' };
    return { edge_id: tid, status: 'pending' };
  });

  return Distribution.create({
    task_id: `t_${crypto.randomBytes(6).toString('hex')}`,
    download_id: downloadId,
    filename: meta.filename,
    size: meta.size,
    sha256: meta.sha256,
    source_edge_id: source.edge_id,
    source_file_id: source.edge_file_id,
    targets: targetRows,
    status: 'running',
  });
}

async function runRound(cfg, log = console.log) {
  const tasks = await Distribution.find({ status: 'running' });
  const staleSec = Math.max(60, Number(cfg.distributionStaleSec) || 3600);
  for (const task of tasks) {
    const [sourceEdge, file] = await Promise.all([
      Edge.findOne({ edge_id: task.source_edge_id }),
      File.findOne({ download_id: task.download_id }),
    ]);

    for (const t of task.targets) {
      if (t.status !== 'pending' && t.status !== 'pulling') continue;
      try {
        if (t.status === 'pending') {
          if (t.attempts >= cfg.distributionMaxAttempts) {
            t.status = 'failed';
            t.error = t.error || '重试次数用尽';
            t.updated_at = new Date();
            continue;
          }
          if (!sourceEdge) throw new Error('源 Edge 已注销');
          const targetEdge = await Edge.findOne({ edge_id: t.edge_id });
          if (!targetEdge || targetEdge.enabled === false) throw new Error('目标 Edge 不可用');

          // 用源 Edge 的密钥签发下载 token：目标 Edge 直连源拉取，总控不过字节
          const exp = Math.floor(Date.now() / 1000) + cfg.distributionTokenTtlSec;
          const token = sign({ f: task.source_file_id, exp }, sourceEdge.token_secret);
          const sourceUrl = `${sourceEdge.base_url.replace(/\/+$/, '')}/d/${token}`;

          t.attempts += 1;
          if (!t.dedup_key) t.dedup_key = dedupKeyFor(task.task_id, t.edge_id, t.attempts);
          const res = await fetchEdge(`${targetEdge.base_url.replace(/\/+$/, '')}/api/pulls`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headersFor(targetEdge) },
            body: JSON.stringify({
              source_url: sourceUrl,
              filename: task.filename,
              expected_sha256: task.sha256 || undefined,
              expected_size: task.size || undefined,
              // 稳定幂等键（task:edge:attempt）：同一逻辑派发的重复 POST
              //（响应丢失后重试）在 Edge 端命中仍在运行的同一任务，不重复下载
              dedup_key: t.dedup_key,
            }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) throw new Error(`创建拉取任务 HTTP ${res.status}`);
          const { pull_id } = await res.json();
          t.status = 'pulling';
          t.pull_id = pull_id;
          t.error = '';
          t.updated_at = new Date();
        } else {
          // pulling：先查远端，再做 stale 判定——远端若已完成应直接完成，
          // 而不是按本地陈旧的 updated_at 误重派
          const targetEdge = await Edge.findOne({ edge_id: t.edge_id });
          if (!targetEdge) {
            t.status = 'failed';
            t.error = '目标 Edge 已注销';
            t.updated_at = new Date();
            continue;
          }
          let p = null;
          let queryError = null;
          try {
            const res = await fetchEdge(
              `${targetEdge.base_url.replace(/\/+$/, '')}/api/pulls/${t.pull_id}`,
              { headers: headersFor(targetEdge), signal: AbortSignal.timeout(5000) },
            );
            if (!res.ok) throw new Error(`查询拉取状态 HTTP ${res.status}`);
            p = await res.json();
          } catch (e) {
            queryError = e;
          }

          // 只有真实进展（字节推进/终态）才刷新 updated_at：
          // 持续 queued 或卡死不动的任务会在 stale 窗口后被重派
          const progressed =
            p && (p.bytes_downloaded !== t.bytes || p.status === 'done' || p.status === 'failed');
          if (progressed) t.updated_at = new Date();

          if (p && (p.status === 'done' || p.status === 'failed')) {
            t.bytes = p.bytes_downloaded || 0;
            if (p.status === 'done') {
              t.status = 'done';
              t.edge_file_id = p.file_id;
              t.error = '';
              t.updated_at = new Date();
              log(`[distribute] ${task.task_id} → ${t.edge_id} 完成（file_id=${p.file_id}）`);
              if (file) {
                await File.updateOne(
                  { download_id: task.download_id, 'edges.edge_id': { $ne: t.edge_id } },
                  {
                    $push: {
                      edges: {
                        edge_id: t.edge_id,
                        edge_file_id: p.file_id,
                        weight: 100,
                        paused: false,
                        url_override: '',
                      },
                    },
                  },
                );
              }
            } else {
              t.error = p.error || '拉取失败';
              if (t.attempts >= cfg.distributionMaxAttempts) t.status = 'failed';
              else {
                t.status = 'pending'; // Edge 内部已重试过，重新派发一轮
                t.pull_id = '';
                t.dedup_key = '';
              }
              t.updated_at = new Date();
            }
          } else {
            // 未终态（queued/pulling）或查询失败：记录字节，检查 stale
            if (p) t.bytes = p.bytes_downloaded || 0;
            const idleMs = t.updated_at ? Date.now() - t.updated_at.getTime() : 0;
            if (idleMs > staleSec * 1000) {
              t.error = (queryError && queryError.message) || `拉取超过 ${staleSec}s 无进展`;
              t.status = t.attempts >= cfg.distributionMaxAttempts ? 'failed' : 'pending';
              t.pull_id = '';
              // 保留 dedup_key：下轮先通过幂等 POST 找回目标 Edge 上的原任务。
              // 若原任务已终态，Edge 仍返回同一 pull_id，随后按真实终态处理。
              t.updated_at = new Date();
              log(`[distribute] ${task.task_id} → ${t.edge_id} stale：${t.status === 'failed' ? '判失败' : '重派'}`);
            } else if (queryError) {
              // 查询临时失败：保持 pulling 等下轮再查（目标上的任务可能仍在
              // 正常运行，立即重派会造成重复下载和孤儿文件），由 stale 窗口兜底
              t.error = queryError.message;
            }
          }
        }
      } catch (e) {
        t.error = e.message || String(e);
        if (t.status === 'pending') {
          // 派发失败：达到上限则判失败，否则下轮再试
          if (t.attempts >= cfg.distributionMaxAttempts) {
            t.status = 'failed';
            t.updated_at = new Date();
          }
        }
        // pulling 查询临时失败：保持 pulling 等下轮再查（目标上的任务可能仍在
        // 正常运行，立即重派会造成重复下载和孤儿文件），由 stale 窗口兜底
      }
    }

    const statuses = task.targets.map((x) => x.status);
    if (statuses.every((s) => s === 'done' || s === 'skipped')) {
      task.status = 'completed';
    } else if (statuses.every((s) => ['done', 'skipped', 'failed'].includes(s))) {
      task.status = statuses.some((s) => s === 'done' || s === 'skipped') ? 'partial' : 'failed';
    }
    await task.save();
  }
}

function startDistributorLoop(cfg, log = console.log) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runRound(cfg, log);
    } catch (err) {
      log(`[distribute] 本轮编排异常: ${err.message}`);
    } finally {
      running = false;
    }
  }, cfg.distributorIntervalSec * 1000);
  timer.unref?.();
  return timer;
}

module.exports = { createDistribution, runRound, startDistributorLoop, discoverSourceMeta, dedupKeyFor };
