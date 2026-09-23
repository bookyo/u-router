'use strict';
const CV_NAMES = { 5: 'V6-Eden N 进阶二转', 3: 'V6-Online 三转', 4: '电信线路' };
const $ = (sel) => document.querySelector(sel);
const status = (msg, warn = false) => {
  const el = $('#status');
  el.textContent = msg;
  el.className = warn ? 'warn' : '';
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
const isApiPage = (url) => /https:\/\/(post|game)\.lastro\.cn\/ro\/api\.html/.test(url || '');
const versionOf = (url) => ((url || '').match(/(\d+(?:\.\d+)?)/) || [])[1] || '69.77';

function selectedCv() {
  return parseInt(document.querySelector('input[name=cv]:checked').value, 10);
}

// 注入函数体（在 MAIN 世界执行；不能引用外部变量）
function mainWorldInject(cv, version) {
  if (window.__roUnstickPosted) return '本标签已注入过（页面只收一次配置，需重载才能换线路）';
  window.dispatchEvent(new CustomEvent('__roCv', { detail: String(cv) }));
  const m = (location.search || '').match(/(\d+(?:\.\d+)?)/);
  window.postMessage({
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
    version: m ? m[1] : version,
    BGMFileExtension: ['mp3'],
    plugins: { IntroMessagePc: {}, LoadingDonate: {} },
    ClientVer: cv,
  }, '*');
  window.__roUnstickPosted = true;
  return '已注入 ClientVer=' + cv;
}

async function readStatus(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => ({
        hooked: !!window.__wsHookedV2,
        frames: (window.__wsLog || []).length,
        posted: !!window.__roUnstickPosted,
        stuck: /正在初始化程序/.test(document.body ? document.body.innerText : ''),
      }),
    });
    return res.result;
  } catch (_) { return null; }
}

(async () => {
  const tab = await activeTab();
  if (!isApiPage(tab.url)) {
    status('当前标签不是 api.html 页面。\n请打开 https://post.lastro.cn/ro/api.html?69.77 后使用。', true);
    return;
  }
  const st = await readStatus(tab.id);
  if (!st) { status('无法读取标签状态（权限或页面未就绪）。', true); return; }
  status(
    (st.posted ? '✅ 已注入配置\n' : st.stuck ? '⚠ 卡在初始化（尚未注入）\n' : '页面已初始化\n') +
    `封包监听: ${st.hooked ? '已挂载' : '未挂载'}（${st.frames} 帧）`
  );
})();

// 保存默认 + 重载
$('#reload').addEventListener('click', async () => {
  const cv = selectedCv();
  await chrome.storage.sync.set({ cv, floor: readFloorInputs() });
  const tab = await activeTab();
  await chrome.tabs.reload(tab.id);
  status(`已保存默认线路 ${cv}（${CV_NAMES[cv]}）与自动地板设置，并重载标签。`);
});

// 仅注入（不重载；页面若已消费过配置则无效，会提示）
$('#inject').addEventListener('click', async () => {
  const cv = selectedCv();
  const tab = await activeTab();
  if (!isApiPage(tab.url)) { status('当前标签不是 api.html。', true); return; }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: mainWorldInject,
      args: [cv, versionOf(tab.url)],
    });
    status(res.result + '。若 5 秒内未开始加载 Online.js，请改用「保存默认 + 重载」。');
  } catch (e) {
    status('注入失败: ' + e.message, true);
  }
});

// 导出封包：把页面 window.__wsLog 存成 JSON 文件到下载目录
$('#export').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!isApiPage(tab.url)) { status('当前标签不是 api.html。', true); return; }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: () => JSON.stringify({ exportedAt: new Date().toISOString(), url: location.href, log: window.__wsLog || [] }),
    });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const blob = new Blob([res.result], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ro-wslog-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status(`已导出 ${JSON.parse(res.result).log.length} 帧到浏览器下载目录。`);
  } catch (e) {
    status('导出失败: ' + e.message, true);
  }
});

// ---------------- 自动地板 ----------------
const FLOOR_DEFAULTS = { f1: 'F1', f2: 'F2', tpDelay: 500, castTime: 2000, dx: 0, dy: 32, toggleKey: 'Alt+Z', keyGap: 120 };
function readFloorInputs() {
  const num = (id, d) => { const v = parseInt($(id).value, 10); return Number.isNaN(v) ? d : v; };
  return {
    f1: $('#f1').value.trim() || 'F1',
    f2: $('#f2').value.trim() || 'F2',
    tpDelay: num('#tpDelay', 500),
    castTime: num('#castTime', 2000),
    dx: num('#dx', 0),
    dy: num('#dy', 32),
    toggleKey: $('#toggleKey').value.trim() || 'Alt+Z',
    keyGap: num('#keyGap', 120),
  };
}
function fillFloorInputs(f) {
  const v = Object.assign({}, FLOOR_DEFAULTS, f || {});
  $('#f1').value = v.f1; $('#f2').value = v.f2;
  $('#tpDelay').value = v.tpDelay; $('#castTime').value = v.castTime;
  $('#dx').value = v.dx; $('#dy').value = v.dy;
  $('#toggleKey').value = v.toggleKey; $('#keyGap').value = v.keyGap;
}
chrome.storage.sync.get({ cv: 5, floor: FLOOR_DEFAULTS }, ({ cv, floor }) => {
  document.querySelectorAll('input[name=cv]').forEach((r) => { r.checked = +r.value === +cv; });
  fillFloorInputs(floor);
});

$('#floorSave').addEventListener('click', async () => {
  const floor = readFloorInputs();
  await chrome.storage.sync.set({ floor });
  const tab = await activeTab();
  if (isApiPage(tab.url)) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: (f) => window.__autoFloorSet && window.__autoFloorSet(f),
      args: [floor],
    });
  }
  status('自动地板设置已保存并实时应用到当前游戏标签。');
});

$('#floorToggle').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!isApiPage(tab.url)) { status('当前标签不是 api.html（请先进入游戏）。', true); return; }
  const floor = readFloorInputs();
  await chrome.storage.sync.set({ floor });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: 'MAIN',
    func: (f) => {
      if (!window.__autoFloorSet) return { running: false, error: '内容脚本未就绪（请刷新页面）' };
      window.__autoFloorSet(f);
      const running = window.__autoFloorToggle();
      return Object.assign(window.__autoFloorState(), { running });
    },
    args: [floor],
  }).catch((e) => [{ result: { error: e.message } }]);
  status(res.result.error ? res.result.error : (res.result.running ? '自动地板已启动' : '已停止'), !!res.result.error);
});

// 弹窗打开期间每秒刷新运行状态
setInterval(async () => {
  const tab = await activeTab().catch(() => null);
  if (!tab || !isApiPage(tab.url)) return;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: () => window.__autoFloorState ? window.__autoFloorState() : null,
    });
    const st = res.result;
    $('#floorState').textContent = st ? (st.running ? `运行中 · 已循环 ${st.cycles}` : '已停止') : '未就绪';
  } catch (_) { $('#floorState').textContent = '-'; }
}, 1000);
