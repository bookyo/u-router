'use strict';
// 物品中文名表构建管线（一次性工具，产物 roclient/data/itemnames-zh.json）
// 数据源优先级：
//   1. LRO APP 的 data.grf → data/idnum2itemdisplaynametable.txt（Big5 繁体，App 实际使用，ro321 同源）
//      经 opencc-js tw→cn 转简体
//   2. web CDN System/itemInfo.lua + System/itemInfo_re_61.lua（GBK 简体，V6 定制物品在此）
// 前置：/tmp/grf-names.json（由 grf-extract.js 提取 + Big5 解析生成）
//       /tmp/iteminfo-base.lua、/tmp/iteminfo61.lua（CDN 下载）
// 用法：cd /tmp/opencc && node /path/to/grf-build-names.js
const fs = require('fs');
const OpenCC = require('opencc-js');
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

const grf = JSON.parse(fs.readFileSync('/tmp/grf-names.json', 'utf8'));
const iconv = require(process.env.RO_HOME + '/roclient/node_modules/iconv-lite');
function parseLua(file) {
  const text = iconv.decode(fs.readFileSync(file), 'gbk');
  const names = {};
  const re = /\[(\d+)\]\s*=\s*\{[\s\S]*?identifiedDiSPlayName\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[2].replace(/_/g, ' ').trim();
    if (name) names[parseInt(m[1], 10)] = name;
  }
  return names;
}
const base = parseLua('/tmp/iteminfo-base.lua');
const re61 = parseLua('/tmp/iteminfo61.lua');
const web = { ...base, ...re61 };

const out = {};
for (const [id, big5] of Object.entries(grf)) {
  const simp = t2s(big5).replace(/_/g, ' ').trim();
  if (simp) out[id] = simp;
}
let webFilled = 0;
for (const [id, name] of Object.entries(web)) {
  if (out[id] == null) { out[id] = name; webFilled++; }
}
fs.writeFileSync(process.env.RO_HOME + '/roclient/data/itemnames-zh.json', JSON.stringify(out));
fs.writeFileSync(process.env.RO_HOME + '/data/itemnames-zh.json', JSON.stringify(out));
console.log(`最终表 ${Object.keys(out).length} 条（GRF ${Object.keys(grf).length} + web 补充 ${webFilled}）`);
