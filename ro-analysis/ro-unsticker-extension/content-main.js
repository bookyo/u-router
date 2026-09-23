'use strict';
// MAIN 世界内容脚本：向 api.html 注入 ROConfig（解卡）+ WebSocket 封包监听
// 背景：api.html 的 inline 脚本只注册【一次性】message 监听，等待 opener（pc-api.js）
// 每 100ms 轮询投递 ROConfig；直接打开/刷新/弹窗被拦时握手丢失 → 永远卡在
// “正在初始化程序....”。本脚本在页面空闲时补发同构配置。
(() => {
  if (window.__roUnstick) return;
  window.__roUnstick = true;

  let clientVer = 5;      // 默认 V6-Eden N（进阶二转，26569 / 密钥组 B）
  let posted = false;

  // ---- 自动地板（巫师群法挂机）----
  const floorCfg = {
    f1: 'F1',          // 瞬间移动快捷键
    f2: 'F2',          // 地板群魔法快捷键
    tpDelay: 500,      // 瞬移后延迟(ms)
    castTime: 2000,    // 施法等待/重复间隔(ms)
    dx: 0, dy: 32,     // 点击点相对屏幕中心的像素偏移（下方一格默认 +32）
    toggleKey: 'Alt+Z',// 启停热键
    keyGap: 120,       // 按下群法键到点击的间隔(ms)
  };
  window.__autoFloor = { running: false, cycles: 0 };
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  function fk(key) {
    const n = /^F(\d{1,2})$/i.exec(String(key).trim());
    if (!n) return false;
    const kc = 111 + Number(n[1]);
    const opts = { key: 'F' + n[1], code: 'F' + n[1], keyCode: kc, which: kc, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
    return true;
  }
  function gameCanvas() {
    let best = null, bestA = 0;
    document.querySelectorAll('canvas').forEach((c) => {
      const r = c.getBoundingClientRect();
      if (r.width > 100 && r.height > 100 && r.width * r.height > bestA) { best = c; bestA = r.width * r.height; }
    });
    return best;
  }
  function mouseAt(x, y) {
    const c = gameCanvas();
    if (!c) return false;
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
    c.dispatchEvent(new MouseEvent('mousemove', Object.assign({ buttons: 0 }, o)));
    c.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, o)));
    c.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, o)));
    c.dispatchEvent(new MouseEvent('click', Object.assign({ buttons: 0 }, o)));
    return true;
  }
  async function floorCycle() {
    const c = floorCfg;
    fk(c.f1);                                   // 瞬间移动
    await sleepMs(c.tpDelay);
    fk(c.f2);                                   // 地板群法（进入指向状态）
    await sleepMs(c.keyGap);
    mouseAt(Math.round(innerWidth / 2 + c.dx), Math.round(innerHeight / 2 + c.dy)); // 人物下方一格落点
    await sleepMs(c.castTime);
  }
  async function floorLoop() {
    const A = window.__autoFloor;
    while (A.running) {
      if (!window.__wsSock || window.__wsSock.readyState !== 1) { A.running = false; break; } // 掉线自停
      try { await floorCycle(); } catch (e) { break; }
      A.cycles++;
    }
    A.running = false;
  }
  function floorToggle() {
    const A = window.__autoFloor;
    if (A.running) { A.running = false; return false; }
    A.running = true; A.cycles = 0;
    floorLoop();
    return true;
  }
  window.__autoFloorSet = (p) => Object.assign(floorCfg, p || {});
  window.__autoFloorToggle = floorToggle;
  window.__autoFloorState = () => ({ running: window.__autoFloor.running, cycles: window.__autoFloor.cycles, cfg: Object.assign({}, floorCfg) });

  // 启停热键（真实按键，拦截不透传给游戏）
  document.addEventListener('keydown', (e) => {
    const parts = String(floorCfg.toggleKey || '').toLowerCase().split('+');
    const key = parts.pop();
    if (!key) return;
    const pressed = (e.key || '').toLowerCase();
    if (pressed !== key && (e.code || '').toLowerCase().replace(/^key|^digit/, '') !== key) return;
    if (parts.includes('alt') !== e.altKey) return;
    if (parts.includes('ctrl') !== e.ctrlKey) return;
    if (parts.includes('shift') !== e.shiftKey) return;
    if (!parts.length && (e.altKey || e.ctrlKey || e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    floorToggle();
  }, true);

  // ---- 封包监听（与手工验证过的钩子一致）----
  function hookWS() {
    if (window.__wsHookedV2) return;
    window.__wsHookedV2 = true;
    const log = [];
    window.__wsLog = log;
    function b64(buf) {
      let bytes;
      if (buf instanceof ArrayBuffer) bytes = new Uint8Array(buf);
      else if (buf && ArrayBuffer.isView(buf)) bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      else return '';
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }
    const OrigWS = window.WebSocket;
    function HookedWS(url, protocols) {
      const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      const id = log.__n || 0; log.__n = id + 1;
      log.push({ k: 'open', id, url: String(url), t: Date.now() });
      ws.addEventListener('message', (ev) => { try { log.push({ k: 'in', id, t: Date.now(), d: b64(ev.data) }); } catch (e) {} });
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try { log.push({ k: 'out', id, t: Date.now(), d: b64(data) }); } catch (e) {}
        return origSend(data);
      };
      ws.addEventListener('close', () => log.push({ k: 'close', id, t: Date.now() }));
      window.__wsSock = ws;
      return ws;
    }
    HookedWS.prototype = OrigWS.prototype;
    Object.defineProperty(window, 'WebSocket', { value: HookedWS, writable: true, configurable: true });
    HookedWS.CONNECTING = 0; HookedWS.OPEN = 1; HookedWS.CLOSING = 2; HookedWS.CLOSED = 3;
    // 注入接口：按已发送帧数重放密钥流（密钥组 B；ClientVer=3 的线路应换密钥组 A）
    window.__sendGame = function (bytes) {
      const opens = log.filter((e) => e.k === 'open');
      const cur = opens[opens.length - 1];
      if (!cur) throw new Error('无连接');
      const n = log.filter((e) => e.k === 'out' && e.id === cur.id).length;
      let k0 = clientVer === 3 ? 1205481659 : 1205481659;
      const K1 = clientVer === 3 ? 453061308 : 453065404;
      const K2 = 592073252;
      for (let i = 0; i <= n; i++) k0 = (Math.imul(k0, K1) + K2) >>> 0;
      const mask = (k0 >>> 16) & 0x7fff;
      const u = new Uint8Array(bytes);
      const v = u[0] | (u[1] << 8);
      const o = (v ^ mask) & 0xffff;
      u[0] = o & 0xff; u[1] = (o >> 8) & 0xff;
      return window.__wsSock.send(u.buffer);
    };
  }

  // ---- 构造并投递 ROConfig ----
  function buildConfig() {
    const m = (location.search || '').match(/(\d+(?:\.\d+)?)/);
    return {
      application: 'Online',
      servers: 'data/clientinfo.xml',
      grfList: null,
      remoteClient: '/ro/client_re/',
      packetver: 'auto',
      charBlockSize: 0,
      clientHash: null,
      development: false,
      api: false,
      socketProxy: null,
      packetKeys: false,
      saveFiles: true,
      skipServerList: true,
      skipIntro: true,
      autoLogin: [],
      version: m ? m[1] : '69.77',
      BGMFileExtension: ['mp3'],
      plugins: { IntroMessagePc: {}, LoadingDonate: {} },
      ClientVer: clientVer,
    };
  }
  function postConfig() {
    window.postMessage(buildConfig(), '*');
    window.__roUnstickPosted = true;
    return true;
  }

  // ---- 注入后校验与自愈 ----
  // Online.js 开始加载 = 成功；页面请求 undefined.js = 配置被垃圾消息抢先消费（守卫
  // 未生效的旧会话）→ 重载一次；迟迟无进展 → 重发配置（守卫会拦掉垃圾、放行合法的）。
  function startVerify() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      let res;
      try { res = performance.getEntriesByType('resource'); } catch (_) { res = []; }
      const ok = res.some((r) => /Online\.js(\?|$)/.test(r.name));
      const broken = res.some((r) => /undefined\.js/.test(r.name));
      if (ok) {
        clearInterval(timer);
        try { sessionStorage.removeItem('__roReloaded'); } catch (_) {}
        return;
      }
      if (broken) {
        clearInterval(timer);
        try {
          if (!sessionStorage.getItem('__roReloaded')) {
            sessionStorage.setItem('__roReloaded', '1');
            location.reload();
            return;
          }
        } catch (_) {}
      }
      if (tries % 3 === 0 && tries <= 18) postConfig(); // 3s/6s/…/18s 重发
      if (tries >= 20) clearInterval(timer);
    }, 1000);
  }

  // ---- 与 ISOLATED 桥（storage → CustomEvent）握手 ----
  window.addEventListener('__roSettings', (e) => {
    const s = e.detail || {};
    if (s.cv != null && !Number.isNaN(parseInt(s.cv, 10))) clientVer = parseInt(s.cv, 10);
    if (s.floor) Object.assign(floorCfg, s.floor);
    if (!posted) { posted = true; startVerify(); postConfig(); }
  });
  try { window.dispatchEvent(new CustomEvent('__roReady')); } catch (_) {}

  // 页面脚本此时已注册完监听（document_idle 晚于页面 inline 脚本）。
  // 给桥 150ms 窗口送达 ClientVer 覆盖值，随后兜底注入。
  hookWS();
  setTimeout(() => {
    if (!posted) { posted = true; startVerify(); postConfig(); }
  }, 150);
})();
