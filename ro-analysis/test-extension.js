'use strict';
// 自动地板端到端测试：加载扩展 → 等游戏就绪（自动登录）→ 启动循环 → 验证帧数增长
module.paths.push('/opt/homebrew/lib/node_modules');
const { chromium } = require('@playwright/test');

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/ro-ext-test', {
    headless: false,
    viewport: { width: 900, height: 760 },
    args: [
      '--disable-extensions-except=/Users/quyue/www/u-router/ro-analysis/ro-unsticker-extension',
      '--load-extension=/Users/quyue/www/u-router/ro-analysis/ro-unsticker-extension',
    ],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://post.lastro.cn/ro/api.html?69.77', { waitUntil: 'domcontentloaded' });
  console.log('等待游戏就绪（自动登录）…');
  let ready = false;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate(`(() => ({
      frames: (window.__wsLog || []).length,
      online: /蝎子星/.test(document.body ? document.body.innerText : ''),
    }))()`).catch(() => null);
    if (st && st.online && st.frames > 20) { ready = true; console.log(`[${i * 2}s] 游戏就绪 (${st.frames} 帧)`); break; }
    if (i % 5 === 0) console.log(`[${i * 2}s] frames=${st ? st.frames : '?'} online=${st ? st.online : '?'}`);
  }
  if (!ready) { console.log('❌ 游戏未就绪'); await ctx.close(); process.exit(1); }

  // 记录启动前的 OUT 帧数
  const before = await page.evaluate(`(window.__wsLog || []).filter(e => e.k === 'out').length`);
  console.log('启动前 OUT 帧:', before);

  // 启动自动地板（加速版：瞬移延迟 300ms、施法等待 900ms，跑 4 个循环后自动停）
  console.log('启动自动地板（6 秒后自动停止）…');
  await page.evaluate(`(() => {
    window.__autoFloorSet({ tpDelay: 300, castTime: 700 });
    window.__autoFloorToggle();
  })()`);
  await page.waitForTimeout(6000);
  await page.evaluate(`(() => { window.__autoFloor.running = false; })()`);
  await page.waitForTimeout(800);

  const st = await page.evaluate(`(() => {
    const outs = (window.__wsLog || []).filter(e => e.k === 'out');
    const pids = {};
    outs.forEach(e => { const b = atob(e.d); const pid = b.charCodeAt(0) | (b.charCodeAt(1) << 8); pids[pid] = (pids[pid] || 0) + 1; });
    return { state: window.__autoFloorState(), outs: outs.length, pids };
  })()`);
  console.log('循环次数:', st.state.cycles, '| 当前运行:', st.state.running);
  console.log('OUT 帧总数:', st.outs, `(增加 ${st.outs - before})`);
  console.log('OUT 包分布:', Object.entries(st.pids).map(([p, n]) => '0x' + (+p).toString(16) + '×' + n).join(' '));
  const delta = st.outs - before;
  const ok = st.state.cycles >= 3 && delta >= 6; // 每循环至少 F1+F2 两个包
  console.log(ok ? '✅ 自动地板工作正常（瞬移键/群法键均产生游戏封包）' : '❌ 未验证通过');
  await ctx.close();
  process.exit(ok ? 0 : 1);
})();
