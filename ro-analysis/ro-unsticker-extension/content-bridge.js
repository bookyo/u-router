'use strict';
// ISOLATED 世界桥：读取扩展存储（默认线路 + 自动地板配置），经 CustomEvent 转交 MAIN 世界
// （两个世界 JS 状态隔离，DOM 事件是唯一通道；__roReady/__roSettings 成对使用）
chrome.storage.sync.get({
  cv: 5,
  floor: { f1: 'F1', f2: 'F2', tpDelay: 500, castTime: 2000, dx: 0, dy: 32, toggleKey: 'Alt+Z', keyGap: 120 },
}, ({ cv, floor }) => {
  const send = () => {
    try { window.dispatchEvent(new CustomEvent('__roSettings', { detail: { cv, floor } })); } catch (_) {}
  };
  // MAIN 脚本可能晚于本脚本就绪：先应答其 __roReady，同时定时补发（幂等，MAIN 只消费一次）
  window.addEventListener('__roReady', send, { once: true });
  setTimeout(send, 60);
  setTimeout(send, 300);
});
