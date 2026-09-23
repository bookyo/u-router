'use strict';
// ISOLATED 桥：MAIN 世界面板 → 本机商人 HTTP API（host_permissions 免 CORS/混合内容限制）
(() => {
  const MULE = 'http://127.0.0.1:8790';
  window.addEventListener('__muleReq', async (e) => {
    const { id, path, method, body } = e.detail || {};
    let status = 0, data = null, err = null;
    try {
      const res = await fetch(MULE + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      status = res.status;
      data = await res.json();
    } catch (ex) { err = String(ex && ex.message || ex); }
    window.dispatchEvent(new CustomEvent('__muleRes', { detail: { id, status, data, err } }));
  });
})();
