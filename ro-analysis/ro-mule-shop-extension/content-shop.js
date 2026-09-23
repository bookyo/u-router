'use strict';
// MAIN 世界：蝎子商人商店面板（v2 界面驱动版）
// v1 的封包直发会与官方客户端的流式加密错位（服务器密钥流多走一步→客户端下一包乱码→踢线，
//   2026-09-21 抓包实证），v2 彻底移除注入：所有动作改为驱动游戏自己的 DOM 界面
//   （#WinPrompt 确认弹窗 → #Trade 交易窗 .zeny.send 输入 → .btn.ok 自动放钱+锁定 → .btn.trade 执行），
//   由客户端自己加密发送，流永远同步。
(() => {
  if (window.__muleShop) return;
  window.__muleShop = true;

  const MERCHANT = { map: 'morocc', x: 181, y: 85, name: '蝎子商人' };
  const STAND = { x: 178, y: 85 };            // 定向飞落点（商人旁 3 格）

  // ---------- 封包通道（收敛安全版）----------
  // 浏览器 OUT 加密 = LCG 逐包推进流（keys B），第 16 次推进后收敛到不动点掩码 0x5945 永不再变。
  // 未收敛期（登录后前 16 个包）注入会使服务器密钥流错位 → 踢线（2026-09-21 抓包实证）；
  // 收敛后所有包（客户端自己的和我们注入的）用同一掩码，注入 100% 安全（node 机器人全程如此）。
  // → 护栏：客户端发送数 ≥24 才允许注入。
  const CONV_MASK = 0x5945, CONV_MIN = 18;
  const hooks = { ws: null, count: 0, map: null, pos: null };
  function hookWS() {
    if (window.__muleShopWSHooked) return;
    window.__muleShopWSHooked = true;
    const OrigWS = window.WebSocket;
    // 0x0087 的 readPos2 布局（client.js 同源）：a d b c e (+1) → [x1,y1,x2,y2]
    const pos2 = (b, o) => {
      const a = b[o], d = b[o + 1], q = b[o + 2], c = b[o + 3], e = b[o + 4];
      return [((a & 255) << 2) | ((d & 192) >> 6), ((d & 63) << 4) | ((q & 240) >> 4), ((c & 252) >> 2) | ((q & 15) << 6), ((c & 3) << 8) | (e & 255)];
    };
    function HookedWS(url, protocols) {
      const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      ws.__zone = false;             // 只有见过 0x0091/0x0087 的连接才是游戏连接（login/char 连接不注入）
      hooks.count = 0;               // ★ 每条新连接密钥流从头计数（跨图传送会换连接！旧计数作废）
      hooks.map = null; hooks.pos = null;
      const origSend = ws.send.bind(ws);
      ws.send = function (data) { hooks.count++; return origSend(data); };
      ws.addEventListener('message', (ev) => {
        try {
          if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength < 12) return;
          const u = new Uint8Array(ev.data);
          const pid = u[0] | (u[1] << 8);
          if (pid === 0x0091 && u.length >= 18) {
            let s = '';
            for (let i = 2; i < 18 && u[i]; i++) s += String.fromCharCode(u[i]);
            s = s.replace(/\.gat$/i, '');
            if (/^[a-z0-9_]+$/i.test(s)) { hooks.map = s; ws.__zone = true; }
          } else if (pid === 0x0087 && u.length === 12) {
            ws.__zone = true;
            const m = pos2(u, 6);
            hooks.pos = [m[2], m[3]];   // [x2, y2] 终点=自己新位置
          }
        } catch (_) {}
      });
      ws.addEventListener('close', () => { if (hooks.ws === ws) hooks.ws = null; });
      hooks.ws = ws;
      return ws;
    }
    HookedWS.prototype = OrigWS.prototype;
    Object.defineProperty(window, 'WebSocket', { value: HookedWS, writable: true, configurable: true });
    HookedWS.CONNECTING = 0; HookedWS.OPEN = 1; HookedWS.CLOSING = 2; HookedWS.CLOSED = 3;
  }
  function sendConv(bytes) {   // 收敛期注入（掩码恒 0x5945）
    if (!hooks.ws || hooks.ws.readyState !== 1) throw new Error('游戏未连接');
    if (!hooks.ws.__zone) throw new Error('游戏连接未就绪');
    if (hooks.count < CONV_MIN) throw new Error(`密钥流未收敛（${hooks.count}/${CONV_MIN} 包）——刚传送过请稍等`);
    const u = new Uint8Array(bytes);
    const v = u[0] | (u[1] << 8);
    const o = (v ^ CONV_MASK) & 0xffff;
    u[0] = o & 0xff; u[1] = (o >> 8) & 0xff;
    return hooks.ws.send(u.buffer);
  }
  const pkt = (pid, total) => { const b = new Uint8Array(total); b[0] = pid & 0xff; b[1] = (pid >> 8) & 0xff; return b; };
  const u32at = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; return b; };
  const strAt = (b, o, len, s) => { const e = new TextEncoder().encode(String(s).replace(/\.gat$/i, '')); for (let i = 0; i < len; i++) b[o + i] = i < e.length ? e[i] : 0; return b; };
  const writePos = (b, o, x, y) => { b[o] = (x >> 2) & 0xff; b[o + 1] = (((x & 3) << 6) | (y >> 4)) & 0xff; b[o + 2] = (((y & 15) << 4)) & 0xff; return b; };
  const CZ = {
    airship: (map, x, y) => { const b = pkt(0x0A49, 34); strAt(b, 2, 16, map); u32at(b, 18, x); u32at(b, 22, y); u32at(b, 26, 1); u32at(b, 30, 14527); return b; },
    move: (x, y) => writePos(pkt(0x035F, 5), 2, x, y),
  };

  // ---------- 面板 UI ----------
  let panel, stock = [], sel = null, qtyEl, totalEl, listEl, statusEl, bodyEl;
  const toast = (msg) => {
    let t = document.getElementById('__muleToast');
    if (!t) {
      t = document.createElement('div');
      t.id = '__muleToast';
      Object.assign(t.style, {
        position: 'fixed', left: '50%', top: '18%', transform: 'translateX(-50%)',
        background: 'rgba(20,20,28,.88)', color: '#ffe9a8', padding: '8px 14px',
        borderRadius: '8px', fontSize: '13px', zIndex: 99999, pointerEvents: 'none',
        border: '1px solid rgba(255,220,120,.35)', maxWidth: '60vw',
      });
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.style.display = 'none'; }, 3400);
  };
  const status = (s) => { if (statusEl) statusEl.textContent = s || ' '; };

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = '__muleShopPanel';
    Object.assign(panel.style, {
      position: 'fixed', right: '330px', top: '262px', width: '224px',
      background: 'rgba(16,18,26,.86)', color: '#d8dce8', border: '1px solid rgba(140,160,220,.4)',
      borderRadius: '10px', font: '12px/1.5 system-ui, "Microsoft YaHei", sans-serif',
      zIndex: 99998, userSelect: 'none', boxShadow: '0 4px 18px rgba(0,0,0,.45)',
    });
    panel.innerHTML = `
      <div id="__muleHead" style="cursor:move;padding:6px 10px;background:rgba(70,90,160,.5);border-radius:9px 9px 0 0;display:flex;justify-content:space-between;align-items:center;gap:6px">
        <b style="flex:1">🛒 ${MERCHANT.name}</b><span id="__muleMin" style="cursor:pointer;opacity:.7">−</span><span id="__muleClose" style="cursor:pointer;opacity:.7">✕</span>
      </div>
      <div id="__muleBody" style="padding:7px 10px">
        <div id="__muleList" style="max-height:148px;overflow-y:auto;margin-bottom:6px"></div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span>数量</span>
          <button data-q="-1" style="width:22px">−</button>
          <input id="__muleQty" type="number" min="1" value="1" style="width:52px;background:rgba(255,255,255,.1);color:#fff;border:1px solid #556;border-radius:5px;padding:2px 4px">
          <button data-q="1" style="width:22px">＋</button>
          <span id="__muleTotal" style="margin-left:auto;color:#ffd76e;font-weight:600"></span>
        </div>
        <div id="__muleStatus" style="min-height:16px;color:#9fd0ff;margin-bottom:5px"> </div>
        <button id="__muleFly" style="width:100%;margin-bottom:5px;padding:5px;border:0;border-radius:6px;background:#2d6a4f;color:#fff;cursor:pointer">🚀 去商人处（异地定向飞 / 梦罗克自动巡路）</button>
        <button id="__muleBuy" style="width:100%;padding:6px;border:0;border-radius:6px;background:#8a5a1e;color:#fff;cursor:pointer;font-weight:600">🤝 发起交易（自动放钱+锁定）</button>
        <div id="__muleHint" style="margin-top:5px;opacity:.55;font-size:11px"></div>
        <div style="margin-top:2px;opacity:.55;font-size:11px" id="__muleName"></div>
      </div>`;
    document.body.appendChild(panel);
    listEl = panel.querySelector('#__muleList');
    qtyEl = panel.querySelector('#__muleQty');
    totalEl = panel.querySelector('#__muleTotal');
    statusEl = panel.querySelector('#__muleStatus');
    bodyEl = panel.querySelector('#__muleBody');

    panel.querySelector('#__muleClose').onclick = () => { panel.style.display = 'none'; };
    panel.querySelector('#__muleMin').onclick = () => {
      const hidden = bodyEl.style.display === 'none';
      bodyEl.style.display = hidden ? 'block' : 'none';
      panel.querySelector('#__muleMin').textContent = hidden ? '−' : '+';
    };
    panel.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => { qtyEl.value = Math.max(1, (+qtyEl.value || 1) + (+b.dataset.q)); renderTotal(); }; });
    qtyEl.oninput = renderTotal;
    panel.querySelector('#__muleBuy').onclick = doBuy;

    // 🚀 去商人处（封包模拟，收敛护栏版）：
    //   异地 → 0x0A49 定向飞到商人旁(178,85)；同城(梦罗克) → 直接 0x035F 巡路过去。
    //   ★ 跨图传送会换新 WebSocket（密钥流从头计数）→ 落地后巡路要等新流重新收敛（约 10-40s），
    //     walkLoop 会显示「收敛中 n/18」进度，收敛完成后开始走位
    const walkLoop = () => {
      let n = 0;
      const t = setInterval(() => {
        n++;
        const [px, py] = hooks.pos || [0, 0];
        const d = Math.max(Math.abs(px - MERCHANT.x), Math.abs(py - MERCHANT.y));
        if (d <= 3) { clearInterval(t); toast(`✅ 已到商人旁 (${px},${py})，可直接点发起交易`); status(' '); return; }
        if (n > 45) { clearInterval(t); toast('巡路 90s 未到位（收敛慢或被卡），请手动走最后一段'); status(' '); return; }
        if (!hooks.ws || !hooks.ws.__zone || hooks.count < CONV_MIN) {
          status(`⏳ 新连接密钥流收敛中 ${Math.min(hooks.count, CONV_MIN)}/${CONV_MIN}（传送后需等一会）…`);
          return;
        }
        try { sendConv(CZ.move(MERCHANT.x - 1, MERCHANT.y)); status(`🚶 巡路中… 当前 (${px},${py}) 距商人 ${d} 格`); }
        catch (e) { /* 收敛护栏未过：等下一轮 */ status('⏳ ' + e.message); }
      }, 2000);
    };
    panel.querySelector('#__muleFly').onclick = () => {
      try {
        if (hooks.map && hooks.map !== MERCHANT.map) {
          sendConv(CZ.airship(MERCHANT.map, STAND.x, STAND.y));
          toast(`🚀 定向飞 → ${MERCHANT.map}(${STAND.x},${STAND.y})（需传送道具），落地后自动巡路`);
          setTimeout(walkLoop, 4000);
        } else if (hooks.map === MERCHANT.map) {
          toast(`🚶 已在${MERCHANT.map === 'morocc' ? '梦罗克' : MERCHANT.map}——巡路去商人…`);
          walkLoop();
        } else {
          // 地图未知（未捕获 0x0091）——按异地处理：飞+巡路
          sendConv(CZ.airship(MERCHANT.map, STAND.x, STAND.y));
          toast(`🚀 定向飞已发送（地图状态未知，飞后自动巡路）`);
          setTimeout(walkLoop, 4000);
        }
      } catch (e) { toast('❌ ' + e.message); }
    };

    // 点击/按键隔离：面板上的任何交互都不再穿透到游戏（点到地面会走人、打字会触发快捷键）
    for (const ev of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'keydown', 'keyup', 'keypress', 'focusin', 'input']) {
      panel.addEventListener(ev, (e) => { e.stopPropagation(); });
    }

    // 拖动（mousemove/mouseup 挂 window 捕获阶段：面板自身的事件隔离会吞掉冒泡的 mouseup，
    //   曾导致拖动后黏住鼠标永不释放——捕获阶段先于一切冒泡监听执行，必达）
    const head = panel.querySelector('#__muleHead');
    let drag = null;
    const endDrag = () => { drag = null; };
    head.addEventListener('mousedown', (e) => {
      if (e.target.id === '__muleMin' || e.target.id === '__muleClose') return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = (e.clientX - drag.dx) + 'px';
      panel.style.top = (e.clientY - drag.dy) + 'px';
      panel.style.right = 'auto';
    }, true);
    window.addEventListener('mouseup', endDrag, true);
    window.addEventListener('blur', endDrag);
    window.addEventListener('keydown', (e) => { if (drag && e.key === 'Escape') endDrag(); }, true);

    refreshName();
    panel.querySelector('#__muleHint').textContent = `📍 商人 ${MERCHANT.map} ${MERCHANT.x},${MERCHANT.y}（请自行走到商人旁再下单）`;
    setInterval(refreshName, 3000);
    setInterval(refreshStock, 15000);
    refreshStock();
    setInterval(automationTick, 300);   // 界面驱动交易状态机
  }
  function refreshName() {
    const el = panel.querySelector('#__muleName');
    el.textContent = '当前角色：' + ((typeof window.rolename === 'string' && window.rolename) || '(未进游戏)');
  }
  function muleFetch(path, body) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const onRes = (e) => {
        if (e.detail.id !== id) return;
        window.removeEventListener('__muleRes', onRes);
        if (e.detail.err) return reject(new Error(e.detail.err));
        resolve({ status: e.detail.status, data: e.detail.data });
      };
      window.addEventListener('__muleRes', onRes);
      window.dispatchEvent(new CustomEvent('__muleReq', { detail: { id, path, method: body ? 'POST' : 'GET', body } }));
      setTimeout(() => { window.removeEventListener('__muleRes', onRes); reject(new Error('商人服务无响应（127.0.0.1:8790）')); }, 15000);
    });
  }
  async function refreshStock() {
    try {
      const { data } = await muleFetch('/stock');
      stock = (data && data.items) || [];
      if (listEl) renderList();
    } catch (e) { if (listEl) listEl.innerHTML = `<div style="opacity:.6">⚠ 商人离线（本机 8790 未运行）</div>`; }
  }
  function renderList() {
    if (!stock.length) { listEl.innerHTML = `<div style="opacity:.6">（无在售商品——价格用 /price 设置后才会上架）</div>`; renderTotal(); return; }
    listEl.innerHTML = stock.map((it, i) => `
      <div data-i="${i}" style="display:flex;justify-content:space-between;padding:3px 5px;border-radius:5px;cursor:pointer;${it.count <= 0 ? 'opacity:.45' : ''};${sel === i ? 'background:rgba(255,210,90,.22);outline:1px solid rgba(255,210,90,.5)' : ''}">
        <span>${it.count <= 0 ? '<s>' + it.name + '</s> 缺货' : it.name}</span>
        <span style="color:#ffd76e">${it.price == null ? '?' : it.price + 'z'} <span style="opacity:.6">×${it.count}</span></span>
      </div>`).join('');
    listEl.querySelectorAll('[data-i]').forEach((el) => {
      el.onclick = () => {
        const i = +el.dataset.i;
        if (stock[i].count <= 0) return;
        sel = i;
        qtyEl.max = stock[i].count;
        qtyEl.value = Math.min(+qtyEl.value || 1, stock[i].count);
        renderList(); renderTotal();
      };
    });
    renderTotal();
  }
  function renderTotal() {
    if (sel == null || !stock[sel]) { totalEl.textContent = ''; return; }
    const it = stock[sel];
    const q = Math.max(1, +qtyEl.value || 1);
    if (q > it.count) { totalEl.innerHTML = `<span style="color:#ff7b6e">库存不足(≤${it.count})</span>`; return; }
    totalEl.textContent = (it.price * q) + ' z';
  }

  // ---------- 下单 ----------
  let buying = false;
  const auto = { armed: false, armedAt: 0, price: 0, name: '', qty: 0, phase: 'idle', tick: null };
  let queueTimer = null, queueN = 0;
  async function placeOrder(name, it, q) {   // 返回 'ok' | 'busy' | 'fail'
    status('下单中…');
    const { data } = await muleFetch('/trade', { buyer: name, name: it.name, qty: q, aid: window.aid || null, gid: window.gid || null });
    if (data && data.ok) {
      auto.armed = true; auto.armedAt = Date.now();
      auto.price = data.free ? 0 : data.price; auto.name = data.name; auto.qty = data.qty;
      auto.phase = 'prompt';
      auto.timeoutMs = data.passive ? 300000 : 90000;   // 被动单要等你手动右键，放宽到 5 分钟
      if (data.passive) {
        status('商人暂时看不到你 → 请右键商人点「交易」，其余全自动');
        toast(`🖱 商人视野被市场卡住：请右键商人点「交易」发起，面板自动放 ${auto.price}z+锁定+执行`);
      } else {
        status(`已下单 ${data.qty}×${data.name}，弹窗出现后自动接受…`);
        toast(`🤝 已下单：${data.name}×${data.qty} = ${data.free ? '授权免费' : data.price + 'z'}，等待交易弹窗`);
      }
      setTimeout(refreshStock, 4000);
      return 'ok';
    }
    if (data && data.error === 'busy') return 'busy';
    toast('❌ 下单失败：' + ((data && (data.reason || data.error)) || '未知错误'));
    status(' ');
    return 'fail';
  }
  async function doBuy() {
    if (buying) return toast('⏳ 已有订单处理中…');
    const name = (typeof window.rolename === 'string' && window.rolename) || '';
    if (!name) return toast('❌ 未读到角色名（先进入游戏）');
    if (sel == null || !stock[sel]) return toast('❌ 先选择商品');
    const it = stock[sel];
    const q = Math.max(1, +qtyEl.value || 1);
    if (q > it.count) return toast('❌ 库存不足：只剩 ' + it.count);
    buying = true;
    try {
      const r = await placeOrder(name, it, q).catch(() => 'fail');
      if (r === 'busy') {   // 商人正与他人交易 → 自动排队等位
        queueN = 0;
        clearInterval(queueTimer);
        status('⏳ 商人正在与他人交易，已排队（每 4s 探测）…');
        toast('⏳ 商人正忙，已自动排队——前一位成交/取消后自动下单');
        queueTimer = setInterval(async () => {
          queueN++;
          if (auto.armed || queueN > 45) {   // 3 分钟排队上限
            clearInterval(queueTimer);
            if (!auto.armed) { status(' '); toast('⏱ 排队超时（3 分钟），请稍后再试'); }
            return;
          }
          const rr = await placeOrder(name, it, q).catch(() => 'fail');
          if (rr !== 'busy') { clearInterval(queueTimer); return; }   // ok/fail 都结束排队（各自已有提示）
          status(`⏳ 排队中… 第 ${queueN} 次探测（商人仍忙）`);
        }, 4000);
      }
    } finally { buying = false; }
  }

  // ---------- 界面驱动交易状态机（全程点游戏自己的按钮，客户端自行加密，密钥流永不错位） ----------
  // 可见性：不用 offsetParent（position:fixed 的游戏窗口恒为 null，会全盘误判）
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  function automationTick() {
    if (!auto.armed) return;
    if (Date.now() - auto.armedAt > (auto.timeoutMs || 90000)) {   // 超时（被动单 5 分钟）
      auto.armed = false; auto.phase = 'idle';
      toast('⏱ 交易超时未完成，订单已失效'); status(' ');
      return;
    }
    const tradeWin = document.getElementById('Trade');
    if (auto.phase === 'prompt') {
      // ① 交易请求弹窗：#WinPrompt（文本含商人名，第一个按钮=确定）
      const prompts = document.querySelectorAll('#WinPrompt');
      for (const p of prompts) {
        const txt = (p.querySelector('.text') || {}).textContent || '';
        if (!txt.includes(MERCHANT.name)) continue;
        const okBtn = p.querySelector('.btns button');
        if (okBtn) { okBtn.click(); auto.phase = 'window'; status('已接受，交易窗处理中…'); toast('🤝 已自动接受交易'); }
        return;
      }
      if (visible(tradeWin)) auto.phase = 'window';   // 无弹窗直接开窗（自己发起等场景）
      return;
    }
    if (auto.phase === 'window') {
      if (!visible(tradeWin)) { finishByMerchant(); return; }   // 窗被关：成交或取消，问商人
      const zeny = tradeWin.querySelector('.zeny.send');
      if (!zeny || zeny.disabled || zeny.classList.contains('disabled')) {
        // 已锁定（我方 OK 已点）→ 等对端确认按钮亮起
        const execBtn = tradeWin.querySelector('.btn.trade.enabled');
        if (visible(execBtn)) { execBtn.click(); auto.phase = 'exec'; status('对方已锁定，已点执行…'); }
        return;
      }
      // 一气呵成版（用户指定还原）：开窗即填钱点 OK（客户端自动放钱+锁定），商人端开窗即放货，时序天然正确
      const okBtn = tradeWin.querySelector('.btn.ok.enabled');
      if (!visible(okBtn)) return;
      zeny.value = String(auto.price);
      okBtn.click();
      auto.phase = 'exec';   // 立即闩锁：防止下一 tick 重复点 OK（“同样的道具不能重复发送”的来源）
      status('已放入 ' + auto.price + 'z 并锁定，等商人验钱…');
      toast(`💰 已放 ${auto.price}z 并锁定，等商人验钱…`);
      return;
    }
    if (auto.phase === 'exec') {
      if (!visible(tradeWin)) { finishByMerchant(); return; }   // 执行后窗关
    }
  }
  async function finishByMerchant() {
    auto.armed = false; auto.phase = 'idle';
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const { data } = await muleFetch('/lasttrade');
      if (data && data.ok === true && Date.now() - (data.at || 0) < 60000) {
        toast(`✅ 交割完成：${auto.name}×${auto.qty}`); status('✅ 成交');
        setTimeout(refreshStock, 1500);
      } else if (data && data.ok === false && Date.now() - (data.at || 0) < 60000) {
        if (data.reason === '钱不符') toast(`❌ 交易取消：钱不符（需 ${data.expect}z，实收 ${data.got}z——客户端会把金额截断到你的余额，请补足后再试）`);
        else toast('❌ 交易被取消（商人端：钱不符或超时）');
        status('❌ 被取消');
      } else {
        toast('交易窗口已关闭'); status(' ');
      }
    } catch (e) { toast('交易窗口已关闭'); status(' '); }
  }

  // ---------- 启动 ----------
  hookWS();   // 必须在游戏建连前装好计数钩（document_idle 早于登录点击，来得及）
  const boot = () => { if (!document.getElementById('__muleShopPanel')) buildPanel(); };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
