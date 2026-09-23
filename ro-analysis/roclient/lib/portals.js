'use strict';
/**
 * 传送门链路（openkore/tables/portals.txt）
 * ============================================================
 * 格式：`srcMap x y dstMap dx dy [cost] [对话序列...]`
 * findChain(targetMap)：从目标图反向 BFS，给出「入口图 → 踩格坐标 → 下一层 → … → 目标图」
 * 的最短可行链，用于挂机回图（飞艇随机传送到入口图 → 巡路踩门逐层进入）。
 */
const fs = require('fs');
const path = require('path');

const PORTALS_FILE = path.join(__dirname, '..', '..', 'openkore', 'tables', 'portals.txt');

let _edges = null;   // { srcMap: [{x, y, dst, dx, dy}] }
function load() {
  if (_edges) return _edges;
  _edges = {};
  for (const lineRaw of fs.readFileSync(PORTALS_FILE, 'latin1').split('\n')) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const t = line.split(/\s+/);
    // 只取纯走格传送（cost 段必须是数字 0 才免费；带 c/r/n 对话序列的是 NPC 船/门，跳过）
    if (t.length < 6) continue;
    const [src, x, y, dst, dx, dy] = t;
    const cost = t[6];
    if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) continue;
    // cost 字段缺省=免费走格；非 0 = 收费门，跳过
    if (cost !== undefined && cost !== '0') continue;
    if (src === dst) continue;
    (_edges[src] = _edges[src] || []).push({ x: +x, y: +y, dst, dx: +dx, dy: +dy });
  }
  return _edges;
}

// 地牢图启发式（飞艇大概率不可直达；入口图=链上第一个非地牢图）
const DUNGEON_RE = /(_dun\d*|pryd\d|sphinx|_sew\d|treasure|anthell|ama_dun|tur_dun|gon_dun|gld_dun|pay_dun|abyss_|mosk_dun|bra_dun|ecl_age|mal_dun|ogl_dun|it_dun|_dun00|gl_sew|prt_sewb)/;
const isDungeon = (m) => DUNGEON_RE.test(m) && !/^(alberta|aldebaran|amatsu|ayothaya|comodo|einbroch|einbech|geffen|gonryun|hugel|izlude|jawaii|lighthalzen|louyang|lutie|manuk|morocc|mora|moscovia|nameless_n|niflheim|payon|prontera|rachel|splendide|umbala|veins|yuno|brasilis|dewata|malangdo|malaya)/.test(m);

/**
 * 反向 BFS：目标图 ← 哪个图有门进来（限地牢段，最多 maxDepth 层）
 * 返回 [{ map: 入口图 }, { map, x, y, to }, ...] （map=踩门所在图, x/y=门坐标, to=进入后的图）
 * 末项 to === targetMap。找不到返回 null。
 */
function findChain(targetMap, maxDepth = 6) {
  const edges = load();
  targetMap = targetMap.replace(/\.gat$/i, '');
  if (!isDungeon(targetMap)) return [{ map: targetMap }];   // 表面图：飞艇直达
  // BFS from target outward: pred[to] = {from, x, y}
  const pred = { [targetMap]: null };
  let frontier = [targetMap];
  const entrances = [];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const [src, list] of Object.entries(edges)) {
        if (pred[src] !== undefined) continue;
        const e = list.find((p) => p.dst === cur);
        if (!e) continue;
        pred[src] = { from: cur, x: e.x, y: e.y };
        next.push(src);
        if (!isDungeon(src)) entrances.push(src);
      }
    }
    frontier = next;
    if (entrances.length) break;   // 找到入口即可（BFS 层序保证最短）
  }
  if (!entrances.length) return null;
  // 从入口走回目标，组装链
  const start = entrances.sort((a, b) => depth(a, pred) - depth(b, pred))[0];
  const chain = [{ map: start }];
  let cur = start;
  for (let i = 0; i < maxDepth + 1 && pred[cur]; i++) {
    const p = pred[cur];
    chain.push({ map: cur, x: p.x, y: p.y, to: p.from });
    cur = p.from;
  }
  return chain[chain.length - 1].to === targetMap ? chain : null;
}
function depth(m, pred) { let n = 0, c = m; while (pred[c]) { c = pred[c].from; n++; } return n; }

/** 递归全部候选入口（运行时飞艇失败时按序回退） */
function chainCandidates(targetMap, limit = 3, maxDepth = 8) {
  // 简化：findChain 已按最短优先；如需多候选可扩展。这里返回主链 + 每层向外一跳的备选
  const main = findChain(targetMap, maxDepth);
  if (!main) return [];
  const alts = [];
  if (main.length > 1) {
    // 备选：从链上第 2 层的图的入口再外扩（少用，正常主链够）
    const outer = findChain(main[0].map, 2);
    if (outer && outer.length > 1) alts.push(outer.concat(main.slice(1)));
  }
  return [main, ...alts].slice(0, limit);
}

module.exports = { load, findChain, chainCandidates, isDungeon };
