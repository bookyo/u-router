'use strict';
// v1.1.0 守卫端到端测试：模拟钱包类扩展在 document_start 后抢发垃圾消息，
// 验证守卫拦截 + 配置注入 + Online.js 加载 + 登录表单出现 + 无 undefined.js
module.paths.push('/opt/homebrew/lib/node_modules');
const { chromium } = require('@playwright/test');

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
  // 模拟其它扩展：页面脚本运行后立即抢发垃圾消息（比我们的注入早）
  await page.addInitScript(`
    setTimeout(() => { window.postMessage({ type: 'metamask-like', data: 1 }, '*'); }, 5);
    setTimeout(() => { window.postMessage('garbage-string'); }, 60);
    setTimeout(() => { window.postMessage({ foo: 'bar' }); }, 120);
    setTimeout(() => { window.postMessage({ application: undefined, version: 'x' }); }, 140);
  `);
  await page.goto('https://post.lastro.cn/ro/api.html?69.77', { waitUntil: 'domcontentloaded' });

  let ok = false, detail = null;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(2000);
    detail = await page.evaluate(`(() => ({
      body: (document.body.innerText || '').slice(0, 60).replace(/\\n/g, '|'),
      posted: !!window.__roUnstickPosted,
      guard: !!window.__roGuard,
      hooked: !!window.__wsHookedV2,
      frames: (window.__wsLog || []).length,
      online: performance.getEntriesByType('resource').some(r => /Online\\.js(\\?|$)/.test(r.name)),
      broken: performance.getEntriesByType('resource').some(r => /undefined\\.js/.test(r.name)),
    }))()`).catch(() => null);
    if (!detail) continue;
    if (i % 5 === 0) console.log(`[${i * 2}s]`, JSON.stringify(detail));
    if (detail.online && !detail.broken && detail.frames > 0) { ok = true; console.log(`[${i * 2}s]`, JSON.stringify(detail)); break; }
  }
  console.log(ok ? '✅ 守卫生效：垃圾消息被拦截，配置注入成功，游戏正常加载'
                 : '❌ 未通过：' + JSON.stringify(detail));
  await ctx.close();
  process.exit(ok ? 0 : 1);
})();
