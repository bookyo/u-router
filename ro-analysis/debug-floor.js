'use strict';
// 自动地板逐步诊断：F1 / F2 / 点击 每步后解码新增 OUT 封包（密钥组 B 重放）
module.paths.push('/opt/homebrew/lib/node_modules');
const { chromium } = require('@playwright/test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/ro-ext-test2', {
    headless: false,
    viewport: { width: 900, height: 760 },
    args: [
      '--disable-extensions-except=/Users/quyue/www/u-router/ro-analysis/ro-unsticker-extension',
      '--load-extension=/Users/quyue/www/u-router/ro-analysis/ro-unsticker-extension',
    ],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://post.lastro.cn/ro/api.html?69.77', { waitUntil: 'domcontentloaded' });

  console.log('等待游戏就绪…');
  let ready = false;
  // 自动登录（新档案无存储凭据）：填表 → 登录 → 确定
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const boxes = page.getByRole('textbox');
    if ((await boxes.count().catch(() => 0)) >= 2) {
      await boxes.nth(0).fill('xiezixing3');
      await boxes.nth(1).fill(process.env.RO_PASS || '');
      try { await page.getByRole('button', { name: '登录' }).click(); } catch (_) {}
      console.log('已提交登录');
      break;
    }
  }
  try { await page.locator('text=确定').last().click({ timeout: 15000 }); console.log('已选角'); } catch (_) {}
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate(`(() => ({
      frames: (window.__wsLog || []).length,
      online: /蝎子星/.test(document.body ? document.body.innerText : ''),
    }))()`).catch(() => null);
    if (st && st.online && st.frames > 20) { ready = true; console.log(`[${i * 2}s] 就绪 (${st.frames} 帧)`); break; }
  }
  if (!ready) { console.log('❌ 游戏未就绪'); await ctx.close(); process.exit(1); }

  // 解码器：在页面内执行，重放密钥组 B，返回指定序号之后的新解码帧
  const decodeNew = (fromIdx) => page.evaluate(`(() => {
    const K0 = 1205481659, K1 = 453065404, K2 = 592073252;
    const log = window.__wsLog || [];
    const zone = log.filter(e => e.k === 'open').map(e => e.id).pop();
    const outs = log.filter(e => e.k === 'out' && e.id === zone);
    let k0 = K0;
    const all = outs.map(f => {
      const b = atob(f.d);
      const bytes = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
      k0 = (Math.imul(k0, K1) + K2) >>> 0;
      const mask = (k0 >>> 16) & 0x7fff;
      const pid = ((bytes[0] | (bytes[1] << 8)) ^ mask) & 0xffff;
      return { t: f.t, pid, len: bytes.length };
    });
    return { total: outs.length, fresh: all.slice(${fromIdx}) };
  })()`);

  const describe = (fresh) => fresh.map((f) => '0x' + f.pid.toString(16).padStart(4, '0') + `(${f.len}B)`).join(' ') || '(无)';

  let idx = await page.evaluate(`(window.__wsLog || []).filter(e => e.k === 'out').length`);
  console.log(`起始 OUT 帧序号: ${idx}`);

  // 步骤1：F1 瞬移
  await page.evaluate(`(() => {
    const e = new KeyboardEvent('keydown', { key: 'F5', code: 'F5', keyCode: 115, which: 115, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    document.dispatchEvent(new KeyboardEvent('keyup', e));
  })()`);
  await sleep(1200);
  let r = await decodeNew(idx); idx = r.total;
  console.log('F5 后新增:', describe(r.fresh), '(期望 0x0438 瞬移)');

  // 步骤2：F2 群法（进入指向状态应无封包）
  await page.evaluate(`(() => {
    const e = new KeyboardEvent('keydown', { key: 'F6', code: 'F6', keyCode: 116, which: 116, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    document.dispatchEvent(new KeyboardEvent('keyup', e));
  })()`);
  await sleep(800);
  r = await decodeNew(idx); idx = r.total;
  console.log('F6 后新增:', describe(r.fresh), '(期望无包=进入指向/地面指示)');

  // 步骤3：点击人物下方一格（中心 +32px）
  await page.evaluate(`(() => {
    const x = Math.round(innerWidth / 2), y = Math.round(innerHeight / 2) + 32;
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
    c.dispatchEvent(new MouseEvent('mousemove', Object.assign({ buttons: 0 }, o)));
    c.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, o)));
    c.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, o)));
    c.dispatchEvent(new MouseEvent('click', Object.assign({ buttons: 0 }, o)));
    return [x, y, c ? c.className || 'canvas' : 'none'];
  })()`);
  await sleep(1200);
  r = await decodeNew(idx); idx = r.total;
  const kinds = r.fresh.map((f) => f.pid);
  console.log('点击后新增:', describe(r.fresh));
  if (kinds.includes(0x0366)) console.log('✅ 地面施法包 0x0366 出现 → 整链路通！');
  else if (kinds.includes(0x035f)) console.log('⚠ 出现走路包 0x035F → F2 指向未激活（点击被当成移动）');
  else if (r.fresh.length === 0) console.log('⚠ 点击完全无包 → 点击事件未被游戏处理');

  await ctx.close();
})();
