'use strict';
// A* 寻路（RO 移动规则：8 方向；斜向要求两个相邻正交格均可走）
// 代价与 RO 一致：直线 10、斜线 14；启发式为切比雪夫近似
const DIRS = [
  [0, -1, 10], [0, 1, 10], [-1, 0, 10], [1, 0, 10],
  [-1, -1, 14], [1, -1, 14], [-1, 1, 14], [1, 1, 14],
];

class MinHeap {
  constructor() { this.a = []; }
  push(node) {
    const a = this.a; a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// 返回 [[x,y], ...]（含起点终点），无可达路径返回 null
function findPath(gat, sx, sy, tx, ty, maxExpand = 60000) {
  sx |= 0; sy |= 0; tx |= 0; ty |= 0;
  if (!gat.walkable(tx, ty)) return null;
  if (sx === tx && sy === ty) return [[sx, sy]];

  const W = gat.width;
  const g = new Float64Array(W * gat.height).fill(Infinity);
  const parent = new Int32Array(W * gat.height).fill(-1);
  const closed = new Uint8Array(W * gat.height);
  const h = (x, y) => {
    const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
    return 10 * (dx + dy) + (14 - 20) * Math.min(dx, dy); // 绑定对角代价的曼哈顿
  };
  const start = sy * W + sx;
  g[start] = 0;
  const open = new MinHeap();
  open.push({ i: start, f: h(sx, sy) });
  let expanded = 0;

  while (open.size) {
    const cur = open.pop();
    if (closed[cur.i]) continue;
    closed[cur.i] = 1;
    if (++expanded > maxExpand) return null; // 防爆栈
    const cx = cur.i % W, cy = (cur.i / W) | 0;
    if (cx === tx && cy === ty) {
      // 回溯
      const path = [];
      let i = cur.i;
      while (i !== -1) { path.push([i % W, (i / W) | 0]); i = parent[i]; }
      return path.reverse();
    }
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!gat.canStep(cx, cy, nx, ny)) continue;
      const ni = ny * W + nx;
      if (closed[ni]) continue;
      const ng = g[cur.i] + cost;
      if (ng < g[ni]) {
        g[ni] = ng;
        parent[ni] = cur.i;
        open.push({ i: ni, f: ng + h(nx, ny) });
      }
    }
  }
  return null;
}

module.exports = { findPath };
