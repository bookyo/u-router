'use strict';
// MAIN 世界守卫（document_start，全页面最早运行）：
// api.html 的一次性 message 监听会被【第一条】消息消费——其它扩展（钱包类等）
// 常向页面 postMessage 垃圾数据，导致页面加载 undefined.js 404 永久卡死。
// 这里抢先注册监听：垃圾消息拦截拦下（stopImmediatePropagation），合法 ROConfig 放行。
(() => {
  if (window.__roGuard) return;
  window.__roGuard = true;
  let passed = false;
  window.addEventListener('message', (e) => {
    if (passed) return; // 合法配置已放行、页面已消费 → 之后不再干预
    const d = e.data;
    if (
      d && typeof d === 'object' &&
      typeof d.application === 'string' && d.application &&
      'remoteClient' in d && 'version' in d
    ) {
      passed = true; // opener 或本扩展注入的合法配置 → 放行给页面
      return;
    }
    // 垃圾消息（其它扩展/脚本）→ 页面永远不应看到
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
})();
