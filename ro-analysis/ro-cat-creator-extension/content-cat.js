'use strict';
// MAIN 世界（document_start）：角色选择页「一键创建猫角色」悬浮面板
//
// 封包真值（leveler.js 生产验证 + 2026-09-22 浏览器 wslog 复核）：
//   CH.MAKE_CHAR3 0x0A39，36B = pid u16 + name[24] + slot u8 + headPal u16 + head u16 + job u16 + unknown u16 + sex u8
//   job=4218 召唤师(猫) / 0 人类初心者；head=1（0=无头贴图）、headPal=0、sex=1（与 leveler 建猫参数一致）
//
// 注入安全性（2026-09-22 wslog 实证）：char 连接（角色服）浏览器 OUT 为【明文】
//   （抓包 conn:24322 直读出 0x65 CH.ENTER / 0x0066 选角），不同于 zone 连接的 LCG 流式加密
//   → 明文注入不存在密钥流错位/踢线风险。建角成功后服务器重推 0x006B 角色表
//   （leveler 即以「新名出现在表里」判成功，本插件同判）。
(() => {
  if (window.__catCreator) return;
  window.__catCreator = true;

  const SIZES = window.__roPacketSizes || {};
  const st = { ws: null, chars: [], total: 0, sent: null, busyUntil: 0 };
  const els = {};

  // ---------- WebSocket 钩子（document_start：抢在游戏建连接之前） ----------
  const OrigWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    ws.__catBuf = new Uint8Array(0);
    ws.addEventListener('message', (ev) => { try { onFrame(ws, ev.data); } catch (_) {} });
    ws.addEventListener('close', () => {
      if (st.ws === ws) { st.ws = null; st.chars = []; st.total = 0; st.sent = null; ui(); }
    });
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  HookedWS.CONNECTING = 0; HookedWS.OPEN = 1; HookedWS.CLOSING = 2; HookedWS.CLOSED = 3;
  Object.defineProperty(window, 'WebSocket', { value: HookedWS, writable: true, configurable: true });

  // ---------- 流切帧（一帧≠一包：按长度表切；半包跨帧拼接；语义与 node client.js onData 一致——
  //             -1=长度在 u16@2（0x006B/0x082D 均此类）；undefined=未知 → 丢弃本帧剩余） ----------
  function onFrame(ws, data) {
    if (!(data instanceof ArrayBuffer)) return;
    let u = new Uint8Array(data);
    if (ws.__catBuf && ws.__catBuf.length) {
      const c = new Uint8Array(ws.__catBuf.length + u.length);
      c.set(ws.__catBuf); c.set(u, ws.__catBuf.length); u = c;
    }
    let i = 0;
    if (!ws.__catSynced && u.length >= 6) {
      // V6 定制：连接首个包前有 4B 回声（char=AID / zone=GID，非标准封包）。
      // 判据：首 2 字节不是已知 pid，而偏移 4 处是，且首 4 字节数值像 ID（1e6~1e8）
      const p0 = u[0] | (u[1] << 8), p4 = u[4] | (u[5] << 8);
      const v = (u[0] | (u[1] << 8) | (u[2] << 16) | (u[3] << 24)) >>> 0;
      if (SIZES[p0] === undefined && SIZES[p4] !== undefined && v >= 1000000 && v < 100000000) i = 4;
    }
    while (i + 2 <= u.length) {
      const pid = u[i] | (u[i + 1] << 8);
      const ln = SIZES[pid];
      if (ln === undefined) { i = -1; break; }                     // 完全未知：放弃本帧剩余
      let total;
      if (ln > 0) total = ln;
      else { if (i + 4 > u.length) break; total = u[i + 2] | (u[i + 3] << 8); }
      if (total < 4 || total > 65535) { i = -1; break; }           // 长度不自洽：防死循环
      if (i + total > u.length) break;                             // 半包：留缓冲等下帧
      ws.__catSynced = true;
      handlePkt(ws, u.subarray(i, i + total), pid);
      i += total;
    }
    ws.__catBuf = i < 0 ? new Uint8Array(0) : u.slice(Math.min(i, u.length));
  }

  function handlePkt(ws, p, pid) {
    if (pid === 0x082D) {           // 槽位头包（仅 29B，无角色数据；byte@4=总槽位数）——char 连接的铁证
      st.ws = ws;
      if (p[4] > 0 && p[4] <= 40) st.total = p[4];
      ui();
    } else if (pid === 0x006B || pid === 0x099D) {           // 角色表（进角色页/建角后都会推）
      const parsed = parseCharList(p);
      if (!parsed) return;
      st.ws = ws; st.chars = parsed.chars;
      if (parsed.total) st.total = parsed.total;
      if (st.sent && parsed.chars.some((c) => c.name === st.sent.name)) {
        log(`✅ 创建成功：${st.sent.name}（slot ${st.sent.slot}）已出现在角色表`, 'ok');
        st.sent = null; st.busyUntil = 0; newName();
      } else if (st.sent && Date.now() - st.sent.at < 7800) {
        log(`📋 角色表已刷新（${parsed.chars.length} 个角色），继续等待 ${st.sent.name}…`);
      } else if (!st.sent) {
        log(`📋 角色服已连接：${parsed.chars.length} 个角色`);
      }
      ui();
    } else if (pid === 0x006C) {
      log('⚠ 0x006C 角色服拒绝（重入冷却/占用中）', 'warn');
    } else if (pid === 0x006D || pid === 0x086D) {
      log(`📩 建角回执 0x${pid.toString(16)}: ${hex(p.subarray(0, 16))}（若 8s 后未见新角色=失败）`, 'warn');
    }
  }

  // ---------- 0x006B 解析（与 roclient client.js 同算法：V6 头部不定长 → 探测 175B 块起点） ----------
  // 真值（2026-09-22 wslog 实拍解析验证）：pid u16 + len u16 + [4]=总槽位 … 块起点 +27；
  // 175B 块内偏移：job@84(u16) level@92(u16) name@108(24B,GBK) slot@138(u8)
  function parseCharList(p) {
    for (let probe = 17; probe <= 33; probe++) {
      const rest = p.length - probe;
      if (rest > 0 && rest % 175 === 0 && rd32(p, probe) < 100000000) {
        const chars = [];
        for (let o = probe; o + 175 <= p.length; o += 175) {
          const name = rdStr(p, o + 108, 24);
          if (!name) continue;
          chars.push({ name, slot: p[o + 138], job: p[o + 84] | (p[o + 85] << 8), level: p[o + 92] | (p[o + 93] << 8) });
        }
        chars.sort((a, b) => a.slot - b.slot);
        const hdrTotal = p[4] > 0 && p[4] <= 40 ? p[4] : 0;
        const total = Math.max(hdrTotal, chars.length ? chars[chars.length - 1].slot + 1 : 0);
        return { chars, total };
      }
    }
    return null;
  }
  const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const rdStr = (b, o, len) => {
    let s = '';
    for (let i = 0; i < len && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
    return s.trim();
  };
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

  // ---------- 建角 ----------
  function create() {
    const ws = st.ws;
    if (!ws || ws.readyState !== 1) return log('❌ 角色服未连接：请在「角色选择页」使用（进图后自动失效）', 'err');
    if (Date.now() < st.busyUntil) return log('⏳ 上一次创建还在等服务器确认（8s 保护）…', 'warn');
    const name = (els.name.value || '').trim();
    if (!/^[\x21-\x7e]+$/.test(name)) return log('❌ 名字仅支持英文/数字/符号（服务器中文名是 GBK 编码，插件暂不支持输入中文）', 'err');
    const bytes = new TextEncoder().encode(name);
    if (bytes.length < 4 || bytes.length > 23) return log('❌ 名字需 4~23 字节', 'err');
    const used = new Set(st.chars.map((c) => c.slot));
    let slot = 0; while (used.has(slot) && slot < 40) slot++;
    if (used.has(slot)) return log('❌ 没有空闲槽位', 'err');
    const job = els.job.value === '4218' ? 4218 : 0;

    const b = new Uint8Array(36);
    b[0] = 0x39; b[1] = 0x0A;                        // pid 0x0A39
    b.set(bytes.subarray(0, 24), 2);                 // name[24]（余量补 0）
    b[26] = slot;                                    // slot u8
    b[27] = 0x00; b[28] = 0x00;                      // headPal = 0
    b[29] = 0x01; b[30] = 0x00;                      // head = 1（0=无头贴图）
    b[31] = job & 0xff; b[32] = (job >> 8) & 0xff;   // job（4218=猫 / 0=人类）
    b[33] = 0x00; b[34] = 0x00;                      // unknown（客户端固定 0）
    b[35] = 0x01;                                    // sex = 1
    try { ws.send(b.buffer); } catch (e) { return log('❌ 发送失败: ' + e.message, 'err'); }

    st.sent = { name, slot, at: Date.now() };
    st.busyUntil = Date.now() + 8000;
    log(`🚀 已发送建角：${name}（slot ${slot}，${job === 4218 ? '召唤师猫' : '人类初心者'}）→ 等角色表刷新确认…`);
    setTimeout(() => {
      if (st.sent && Date.now() - st.sent.at >= 7800) {
        log(`⏱ 8s 未见 ${st.sent.name} 出现在角色表（名称被占/被拒）`, 'warn');
        st.sent = null; st.busyUntil = 0; ui();
      }
    }, 8100);
    ui();
  }

  function newName() {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
    els.name.value = (els.job.value === '4218' ? 'Mao' : 'Ro') + s;
  }

  // ---------- 面板 ----------
  function log(msg, cls) {
    if (!els.log) return;
    const d = document.createElement('div');
    d.textContent = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
    d.style.color = cls === 'ok' ? '#7ce38b' : cls === 'err' ? '#ff7b72' : cls === 'warn' ? '#e3b341' : '#c9d1d9';
    els.log.appendChild(d);
    while (els.log.children.length > 8) els.log.removeChild(els.log.firstChild);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function ui() {
    if (!els.root) return;
    const on = st.ws && st.ws.readyState === 1;
    els.status.textContent = on ? `角色服已连接 ✓（${st.chars.length}/${st.total || '?'} 槽）` : '未检测到角色服（在角色选择页自动连接）';
    const used = new Set(st.chars.map((c) => c.slot));
    const free = [];
    for (let s = 0; s < (st.total || 0) && free.length < 6; s++) if (!used.has(s)) free.push(s);
    els.slots.textContent = on ? (free.length ? `空闲槽：${free.join(', ')}${free.length >= 6 ? '…' : ''}（将使用 ${free[0]}）` : '无空闲槽位') : '—';
    els.btn.disabled = !on || Date.now() < st.busyUntil;
    els.btn.textContent = Date.now() < st.busyUntil ? '等待服务器确认…' : `🐱 创建${els.job.value === '4218' ? '猫角色' : '人类角色'}`;
  }

  function buildUI() {
    if (els.root || !document.body) return;
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:999999;width:280px;background:rgba(13,17,23,.94);color:#c9d1d9;border:1px solid #30363d;border-radius:10px;font:12px/1.6 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5)';
    root.innerHTML = `
      <div id="cat-head" style="padding:8px 12px;cursor:pointer;user-select:none;font-weight:600;border-bottom:1px solid #30363d">🐱 创建猫角色 <span id="cat-fold" style="float:right;color:#8b949e">−</span></div>
      <div id="cat-body" style="padding:10px 12px">
        <div id="cat-status" style="color:#8b949e"></div>
        <div id="cat-slots" style="margin:2px 0 8px;color:#8b949e"></div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input id="cat-name" style="flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;padding:4px 8px" maxlength="23" spellcheck="false">
          <button id="cat-rand" title="随机名字" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 8px;cursor:pointer">↻</button>
        </div>
        <select id="cat-job" style="width:100%;margin-bottom:8px;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;padding:4px 8px">
          <option value="4218" selected>召唤师（猫）</option>
          <option value="0">初心者（人类）</option>
        </select>
        <button id="cat-btn" style="width:100%;background:#238636;color:#fff;border:none;border-radius:6px;padding:7px 0;font-weight:600;cursor:pointer">🐱 创建猫角色</button>
        <div id="cat-log" style="margin-top:8px;max-height:130px;overflow-y:auto;font-size:11px;font-family:ui-monospace,monospace"></div>
      </div>`;
    document.body.appendChild(root);
    Object.assign(els, {
      root, status: root.querySelector('#cat-status'), slots: root.querySelector('#cat-slots'),
      name: root.querySelector('#cat-name'), job: root.querySelector('#cat-job'),
      btn: root.querySelector('#cat-btn'), log: root.querySelector('#cat-log'),
    });
    els.btn.onclick = create;
    els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    root.querySelector('#cat-rand').onclick = newName;
    els.job.onchange = () => { newName(); ui(); };
    root.querySelector('#cat-head').onclick = () => {
      const b = root.querySelector('#cat-body');
      const folded = b.style.display === 'none';
      b.style.display = folded ? '' : 'none';
      root.querySelector('#cat-fold').textContent = folded ? '−' : '+';
    };
    newName();
    log('插件就绪：登录到「角色选择页」即可使用（char 连接明文注入，无加密错位风险）');
    ui();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else buildUI();
  setTimeout(buildUI, 3000);   // 兜底：个别时序下 DOMContentLoaded 已过但 body 未就绪

  // 调试钩子（控制台可查状态/手动喂包测试）
  window.__catCreatorDebug = { st, parseCharList, onFrame };
})();
