'use strict';
// 时装/头饰图鉴导出
// 来源A: LRO GRF idnum2itemdesctable.txt（经典头饰，Big5→简体：系列/位置/防御/重量/等级/装备/效果）
// 来源B: web CDN itemInfo lua（V6 [时装] 系列：名称/描述/位置/防御/重量/职业）
// 产物: data/fashion-catalog.json + data/fashion-catalog.md
const fs = require('fs');
const path = require('path');
const iconv = require('./roclient/node_modules/iconv-lite');

const ZH = JSON.parse(fs.readFileSync(path.join(__dirname, 'roclient/data/itemnames-zh.json'), 'utf8'));
// opencc 繁转简（复用已安装的 /tmp/opencc）
let t2s = (s) => s;
try { t2s = require('/tmp/opencc/node_modules/opencc-js').Converter({ from: 'tw', to: 'cn' }); } catch (_) {}

const stripColor = (s) => String(s).replace(/\^[0-9a-fA-F]{6}/g, '').trim();
const SEP = /^-{5,}$/;
// 位置归一化：去重量残留/空白，繁→简
function normPos(p, t2sFn) {
  let s = String(p).replace(/重量\s*:?\s*\d+/gi, '').replace(/\s+/g, '');
  s = t2sFn(s).replace(/Garment/i, '披肩');
  return s || '';
}

// ---------- 来源A：GRF 描述表 ----------
function parseGrfDesc() {
  const raw = fs.readFileSync('/tmp/grf-desc.txt');
  const lines = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === 0x0a) {
      let end = i;
      if (end > start && raw[end - 1] === 0x0d) end--;
      lines.push(raw.slice(start, end));
      start = i + 1;
    }
  }
  const items = new Map();
  let cur = null;
  for (const line of lines) {
    if (line.length && line[line.length - 1] === 0x23 && !cur) { // '#'
      const id = parseInt(line.slice(0, -1).toString(), 10);
      if (!Number.isNaN(id)) cur = { id, lines: [] };
      continue;
    }
    if (cur) {
      if (line.length === 1 && line[0] === 0x23) { items.set(cur.id, cur); cur = null; continue; } // '#'
      let text;
      try { text = t2s(iconv.decode(line, 'big5')); } catch (_) { text = line.toString('latin1'); }
      cur.lines.push(stripColor(text));
    }
  }
  const headgear = [];
  for (const { id, lines: ls } of items.values()) {
    // 结构行：系列/位置/防御/重量/要求等级/装备
    const meta = { 系列: '', 位置: '', 防御: '', 重量: '', 等级: '', 职业: '' };
    const effects = [];
    for (const l of ls) {
      if (SEP.test(l) || !l) continue;
      // 同一行可能含多个字段（"系列 : 頭具  防禦 : 6"），按 2+ 空格分块
      const chunks = l.split(/\s{2,}/);
      let allMeta = chunks.length > 0;
      for (const chunk of chunks) {
        let m;
        if ((m = /^系列\s*:\s*(.+)$/i.exec(chunk))) meta.系列 = m[1].trim();
        else if ((m = /^位置\s*:\s*(.+)$/i.exec(chunk))) meta.位置 = m[1].trim();
        else if ((m = /^防禦\s*:\s*(\d+)$/i.exec(chunk)) || (m = /^防御\s*:\s*(\d+)$/i.exec(chunk))) meta.防御 = m[1];
        else if ((m = /^重量\s*:\s*(\d+)$/i.exec(chunk))) meta.重量 = m[1];
        else if ((m = /^要求等級\s*:\s*(\d+)$/i.exec(chunk)) || (m = /^要求等级\s*:\s*(\d+)$/i.exec(chunk))) meta.等级 = m[1];
        else if ((m = /^裝備\s*:\s*(.+)$/i.exec(chunk)) || (m = /^装备\s*:\s*(.+)$/i.exec(chunk))) meta.职业 = m[1];
        else { allMeta = false; break; } // 任一块不是字段 → 整行按效果处理
      }
      if (!allMeta) effects.push(l);
    }
    if (/頭具|头具/.test(meta.系列)) {
      headgear.push({
        ITID: id, 名称: ZH[id] || `#${id}`, 类型: normPos(meta.位置, t2s) || '头具',
        防御: +meta.防御 || 0, 重量: +meta.重量 || 0, 等级: +meta.等级 || 0,
        职业: meta.职业, 效果: effects,
      });
    }
  }
  return headgear;
}

// ---------- 来源B：CDN lua 的 V6 时装 ----------
function parseLuaFile(file, sink) {
  const src = iconv.decode(fs.readFileSync(file), 'gbk');
  const re = /\[(\d+)\]\s*=\s*\{([\s\S]*?)\n\t\},/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const id = parseInt(m[1], 10);
    const body = m[2];
    // (?<!un) 防止匹配到 unidentifiedDiSPlayName 的子串
    const nameM = /(?<!un)identifiedDiSPlayName\s*=\s*"([^"]*)"/.exec(body);
    if (!nameM) continue;
    const name = nameM[1];
    if (!/^\[时装\]/.test(name)) continue;
    // 描述数组（同样 (?<!un) 锚定已鉴定描述）
    const descM = /(?<!un)identifiedDescriptionName\s*=\s*\{([\s\S]*?)\},/.exec(body);
    const effects = [];
    const meta = { 防御: 0, 重量: 0, 位置: '', 职业: '', 等级: 0 };
    if (descM) {
      const qlines = descM[1].match(/"((?:[^"\\]|\\.)*)"/g) || [];
      for (const q of qlines) {
        let l = t2s(stripColor(q.slice(1, -1)));
        if (SEP.test(l) || !l) continue;
        const chunks = l.split(/\s{2,}/);
        let allMeta = chunks.length > 0;
        for (const chunk of chunks) {
          let mm;
          if ((mm = /^系列\s*:\s*(.+)$/i.exec(chunk))) { if (!/时装/.test(mm[1])) effects.push(l); continue; }
          if ((mm = /^位置\s*:\s*(.+)$/i.exec(chunk))) { meta.位置 = normPos(mm[1], t2s); continue; }
          if ((mm = /^防御\s*:\s*(\d+)$/i.exec(chunk))) { meta.防御 = +mm[1]; continue; }
          if ((mm = /^重量\s*:\s*(\d+)$/i.exec(chunk))) { meta.重量 = +mm[1]; continue; }
          if ((mm = /^装备\s*:\s*(.+)$/i.exec(chunk))) { meta.职业 = mm[1].trim(); continue; }
          if ((mm = /^要求等级\s*:\s*(\d+)$/i.exec(chunk))) { meta.等级 = +mm[1]; continue; }
          allMeta = false; break;
        }
        if (!allMeta) effects.push(l);
      }
    }
    const cleanName = t2s(name.replace(/^\[时装\]\s*/, ''));
    sink.push({ ITID: id, 名称: cleanName, 类型: meta.位置 || '时装', 防御: meta.防御, 重量: meta.重量, 等级: meta.等级, 职业: meta.职业, 效果: effects });
  }
}

(async () => {
  const OpenCC = require('/tmp/opencc/node_modules/opencc-js');
  void OpenCC;
  console.log('解析 GRF 头饰…');
  const headgear = parseGrfDesc();
  console.log(`  头饰 ${headgear.length} 件`);
  console.log('解析 V6 时装（CDN lua）…');
  const costumes = [];
  parseLuaFile('/tmp/iteminfo61.lua', costumes);
  parseLuaFile('/tmp/iteminfo-base.lua', costumes);
  // 去重（base 与 re61 可能重叠，re61 优先：先 base 后 re61 覆盖）
  console.log(`  时装 ${costumes.length} 件`);

  // ---------- 输出 ----------
  const byPos = (arr) => {
    const g = {};
    for (const it of arr) { (g[it.类型] ||= []).push(it); }
    return g;
  };
  const fsJson = path.join(__dirname, 'data/fashion-catalog.json');
  fs.writeFileSync(fsJson, JSON.stringify({ 头饰: headgear, 时装: costumes }, null, 1));

  const L = [];
  L.push('# 时装 · 头饰图鉴（V6）');
  L.push('');
  L.push(`- 数据源：LRO APP data.grf（效果/属性，Big5→简体）+ 服务端 itemInfo lua（V6 时装系列）`);
  L.push(`- 头饰（经典）共 **${headgear.length}** 件；时装（V6）共 **${costumes.length}** 件`);

  const mdTable = (list) => {
    L.push(`| 名称 | ITID | 位置 | 防御 | 重量 | 等级 | 装备 | 效果/说明 |`);
    L.push(`|---|---|---|---:|---:|---:|---|---|`);
    for (const it of list) {
      L.push(`| ${it.名称} | ${it.ITID} | ${it.类型} | ${it.防御} | ${it.重量} | ${it.等级 || '-'} | ${it.职业 || '-'} | ${(it.效果 || []).join('；') || '-'} |`);
    }
  };

  L.push('');
  const wearables = costumes.filter((x) => x.类型 !== '时装');
  const related = costumes.filter((x) => x.类型 === '时装');
  L.push(`## 一、V6 时装（可穿戴 ${wearables.length} 件；另有相关道具 ${related.length} 件见附录）`);
  const groups = [
    ['头饰·上段', (t) => t === '头上'],
    ['头饰·中段', (t) => t === '头中'],
    ['头饰·下段', (t) => t === '头下'],
    ['组合头饰', (t) => ['头上中', '头中下', '头上中下', '中上', '中下', '全部'].includes(t)],
    ['披肩/背部', (t) => ['披风', '披肩', '背部', '背饰'].includes(t)],
    ['服装', (t) => ['上身', '下身', '装饰品'].includes(t)],
    ['武器/盾牌', (t) => ['单手', '盾牌'].includes(t)],
  ];
  for (const [label, pred] of groups) {
    const list = wearables.filter((x) => pred(x.类型));
    if (!list.length) continue;
    L.push('');
    L.push(`### ${label}（${list.length} 件）`);
    L.push('');
    mdTable(list.sort((a, b) => a.ITID - b.ITID));
  }
  L.push('');
  L.push(`### 附录：时装相关道具（${related.length} 件，扭蛋/礼盒/兑换券，不可穿戴）`);
  L.push('');
  mdTable(related.sort((a, b) => a.ITID - b.ITID));
  L.push('');
  L.push(`## 二、经典头饰（${headgear.length} 件）`);
  const hg = byPos(headgear);
  for (const pos of ['上', '中', '下']) {
    if (!hg[pos]) continue;
    L.push('');
    L.push(`### 位置：${pos}段（${hg[pos].length} 件）`);
    L.push('');
    mdTable(hg[pos].sort((a, b) => a.ITID - b.ITID));
  }
  const others = Object.entries(hg).filter(([k]) => !['上', '中', '下'].includes(k));
  for (const [k, list] of others) {
    L.push('');
    L.push(`### 其他位置：${k}（${list.length} 件）`);
    L.push('');
    mdTable(list);
  }
  const mdFile = path.join(__dirname, 'data/fashion-catalog.md');
  fs.writeFileSync(mdFile, L.join('\n') + '\n');
  console.log(`✅ 图鉴: ${mdFile}`);
  console.log(`   JSON: ${fsJson}`);
})();
