'use strict';
// 物品 ID→名称表（移植自 OpenKore 的 item name 解析需求）
// 数据源：与 gat 同一 CDN 的 idnum2itemdisplaynametable.txt（CP949 编码，`id#名字#` 每行）
// 支持本地中文覆盖表 data/itemnames-zh.json（{ "501": "红色药水" }），优先级高于 CDN 表。
const fs = require('fs');
const path = require('path');
const https = require('https');
const iconv = require('iconv-lite');

const CDN = 'https://post.lastro.cn/ro/client_re/data/idnum2itemdisplaynametable.txt';
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE = path.join(DATA_DIR, 'idnum2itemdisplaynametable.txt');
const ZH_OVERRIDE = path.join(DATA_DIR, 'itemnames-zh.json');
const DESC_FILE = path.join(DATA_DIR, 'itemdesc-zh.json');   // 物品描述（2026-09-23 新增，LastROLTSD）

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

class ItemDB {
  constructor() {
    this.byId = new Map();   // ITID -> 名称
    this._loaded = null;
  }

  async load({ refresh = false, file = CACHE } = {}) {
    if (this._loaded && !refresh) return this;
    this._loaded = (async () => {
      let buf = null;
      if (!refresh && fs.existsSync(file)) buf = fs.readFileSync(file);
      if (!buf) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        buf = await download(CDN);
        fs.writeFileSync(file, buf);
      }
      // CP949 解码；个别扩展字符解码失败时按字节回退 latin1
      let text;
      try { text = iconv.decode(buf, 'cp949'); } catch (_) { text = buf.toString('latin1'); }
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^(\d+)#([^#]*)#/);
        if (m) this.byId.set(parseInt(m[1], 10), m[2].trim());
      }
      // 中文覆盖表（2026-09-23 换源：LastROLTSD 仓库 catalog 合并产物，24928 条——
      // 名字比旧 GRF 提取表更具体（旧表大量"鞋子/帽子"泛称占位）；韩文名回退旧中文，旧表补缺 1974 项）
      if (fs.existsSync(ZH_OVERRIDE)) {
        try {
          Object.entries(JSON.parse(fs.readFileSync(ZH_OVERRIDE, 'utf8'))).forEach(([id, name]) => {
            this.byId.set(parseInt(id, 10), String(name));
          });
        } catch (_) {}
      }
      // 物品描述表（LastROLTSD itemsdescriptions，21399 条；含 ^xxxxxx 颜色码，展示时可按需剥离）
      if (fs.existsSync(DESC_FILE)) {
        try {
          this.descById = new Map(Object.entries(JSON.parse(fs.readFileSync(DESC_FILE, 'utf8')))
            .map(([id, d]) => [parseInt(id, 10), String(d)]));
        } catch (_) { this.descById = new Map(); }
      }
      return this;
    })();
    return this._loaded;
  }

  name(id) { return this.byId.get(id) || `#${id}`; }
  desc(id) { return (this.descById && this.descById.get(id)) || ''; }   // 物品描述（无则空串）
  has(id) { return this.byId.has(id); }
  size() { return this.byId.size; }

  // 按名称关键字找 ID（包含匹配，不分大小写）——OpenKore 商品关键字检索的基础
  idsByName(keyword) {
    const kw = String(keyword).toLowerCase();
    const out = [];
    for (const [id, name] of this.byId) {
      if (name.toLowerCase().includes(kw)) out.push(id);
    }
    return out;
  }
}

module.exports = { ItemDB };
