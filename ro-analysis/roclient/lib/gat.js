'use strict';
// GRAT (.gat) 地图文件加载：下载/缓存 + 可走性网格
// 格式: "GRAT"(4) + 版本(2) + width u32 + height u32 + 每格 20 字节(4 float 高度 + u32 类型)
// 类型: 0=可走地面 1=阻挡 2=水(不可走) 3=浅水(可走) 4/5=仅射程
const fs = require('fs');
const path = require('path');
const https = require('https');

const CDN = 'https://post.lastro.cn/ro/client_re/data/';
const CACHE_DIR = path.join(__dirname, '..', 'maps');

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://post.lastro.cn' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

class Gat {
  constructor(width, height, types) {
    this.width = width;
    this.height = height;
    this.types = types; // Uint8Array
  }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  walkable(x, y) {
    if (!this.inBounds(x, y)) return false;
    const t = this.types[y * this.width + x];
    return t === 0 || t === 3;
  }
  // 与服务器一致的路径校验用的直线可走检查（斜向需两侧正交格均可走）
  canStep(fx, fy, tx, ty) {
    if (!this.walkable(tx, ty)) return false;
    const dx = Math.sign(tx - fx), dy = Math.sign(ty - fy);
    if (dx !== 0 && dy !== 0) return this.walkable(fx + dx, fy) && this.walkable(fx, fy + dy);
    return true;
  }
}

async function loadGat(mapName) {
  const name = mapName.replace(/\.gat$/i, '');
  const file = path.join(CACHE_DIR, `${name}.gat`);
  let buf;
  if (fs.existsSync(file)) {
    buf = fs.readFileSync(file);
  } else {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    buf = await download(CDN + name + '.gat');
    fs.writeFileSync(file, buf);
  }
  if (buf.slice(0, 4).toString() !== 'GRAT') throw new Error('非法 gat 文件: ' + name);
  const width = buf.readUInt32LE(6), height = buf.readUInt32LE(10);
  const types = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) types[i] = buf.readUInt8(14 + i * 20 + 16);
  return new Gat(width, height, types);
}

// OpenKore .fld2 字段（u16宽 + u16高 + 每格1字节：0=可走 其他=阻挡），转成 Gat 网格
function loadFld2(mapName) {
  const name = mapName.replace(/\.(gat|fld2)$/i, '');
  const file = path.join(CACHE_DIR, `${name}.fld2`);
  const buf = fs.readFileSync(file);
  const width = buf.readUInt16LE(0), height = buf.readUInt16LE(2);
  const types = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) types[i] = buf.readUInt8(4 + i) === 0 ? 0 : 1;
  return new Gat(width, height, types);
}

// 统一加载：优先 .gat（官方数据），回退 .fld2（OpenKore 字段）
async function loadMap(mapName) {
  const name = mapName.replace(/\.(gat|fld2)$/i, '');
  if (fs.existsSync(path.join(CACHE_DIR, `${name}.gat`))) return loadGat(name);
  if (fs.existsSync(path.join(CACHE_DIR, `${name}.fld2`))) return loadFld2(name);
  try { return await loadGat(name); } catch (_) { return loadFld2(name); }
}

module.exports = { loadGat, loadFld2, loadMap, Gat };
