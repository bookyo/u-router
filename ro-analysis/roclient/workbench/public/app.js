'use strict';
/* 猫队练级工作台前端：标签页 + SSE 实时日志（自动滚动 / 自动清理） */
const $ = (s, el = document) => el.querySelector(s);
const MAX_LINES = 500;          // 前端自动清理：日志最多保留行数
const state = { tabs: [], active: null, es: null };

// ---------- API ----------
// 统一 POST（无参动作接口 start/stop/clear 也要 POST，GET 会被服务端 404）
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.json();
}
const del = (path) => fetch(path, { method: 'DELETE' }).then((r) => r.ok);

// ---------- 标签栏 ----------
function tabById(id) { return state.tabs.find((t) => t.id === id); }

function renderTabs() {
  const bar = $('#tabbar');
  bar.classList.toggle('empty', !state.tabs.length);
  bar.innerHTML = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab ' + (t.state === 'running' ? 'running' : t.state) + (t.id === state.active ? ' active' : '');
    el.innerHTML = `<span class="dot"></span>
      <span class="name">${esc(t.name)}</span>
      ${t.status && t.status.level != null ? `<span class="lv">Lv${t.status.level}</span>` : ''}
      <span class="x" title="删除标签">✕</span>`;
    el.onclick = (e) => {
      if (e.target.classList.contains('x')) { if (confirm(`删除标签 ${t.name}？（worker 会停止）`)) del(`/api/tabs/${t.id}`).then(refresh); return; }
      activate(t.id);
    };
    bar.appendChild(el);
  }
  $('#summary').textContent = state.tabs.length
    ? `${state.tabs.filter((t) => t.state === 'running').length} 运行 / ${state.tabs.length} 标签` +
      (state.tabs.some((t) => t.state === 'done') ? ` · ${state.tabs.filter((t) => t.state === 'done').length} 已完成` : '')
    : '未启动';
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 主面板 ----------
function activate(id) {
  state.active = id;
  if (state.es) { state.es.close(); state.es = null; }
  renderTabs();
  const main = $('#main');
  main.classList.remove('empty');
  main.innerHTML = '';
  if (!id || !tabById(id)) { state.active = null; renderTabs(); return; }

  const t = tabById(id);
  const wrap = document.createElement('div');
  wrap.className = 'logwrap';
  wrap.innerHTML = `
    <div class="cards" id="cards"></div>
    <div class="logwrap" style="padding:12px 0 0">
      <div class="logtools">
        <label><input type="checkbox" id="autoScroll" checked> 自动滚动</label>
        <label><input type="checkbox" id="autoClear" checked> 自动清理（保留${MAX_LINES}行）</label>
        <span class="sp"></span>
        <button class="small" id="btnStart">启动/重启</button>
        <button class="small danger" id="btnStop">停止</button>
        <button class="small" id="btnClear">清屏</button>
      </div>
      <div id="log" class="logbody"></div>
    </div>`;
  main.appendChild(wrap);
  $('#btnStart').onclick = () => api(`/api/tabs/${id}/start`).then((nt) => Object.assign(t, nt)).catch(alert);
  $('#btnStop').onclick = () => api(`/api/tabs/${id}/stop`).then((nt) => Object.assign(t, nt)).catch(alert);
  $('#btnClear').onclick = () => { $('#log').innerHTML = ''; api(`/api/tabs/${id}/clear`).catch(() => {}); };

  renderCards(t);
  connectSSE(id);
}

function renderCards(t) {
  const box = $('#cards');
  if (!box) return;
  const S = t.status || {};
  const st = { running: '🟢 运行中', waiting: '⏳ 冷却等待', done: '🏁 已完成', stopped: '⏹ 已停止', error: '🔴 异常', idle: '⚪ 待启动' }[t.state] || t.state;
  if (t.mode === 'bounty') {
    const empty = S.account ? '' : '（待领号）';
    const errMsg = { POOL_EMPTY: '账号池无可用号', ACCOUNT_CLASH: '账号已被其他标签占用', COOLDOWN: '6h 任务刷新冷却中' }[t.stateMsg] || '';
    box.innerHTML = `
      <div class="card"><div class="k">标签</div><div class="v">💰 赏金</div></div>
      <div class="card"><div class="k">当前账号</div><div class="v acc">${esc(S.account || '—')}<br><small>${esc(S.password || '')}</small></div></div>
      <div class="card"><div class="k">当前角色</div><div class="v">${esc(S.char || '—')}</div></div>
      <div class="card"><div class="k">本轮任务</div><div class="v">${S.tasks || 0} 个</div></div>
      <div class="card"><div class="k">状态</div><div class="v">${st}${empty}</div><div class="v"><small>${esc(errMsg)}${t.loop ? (errMsg ? ' · ' : '') + '跑完自动领下一号' : ''}</small></div></div>
      <div class="controls"></div>`;
    renderTabs();
    return;
  }
  const pct = Math.round(((S.done || 0) / (S.total || 12)) * 100);
  box.innerHTML = `
    <div class="card"><div class="k">标签 / 模式</div><div class="v">${esc(t.name)}<br><small>${t.mode === 'old' ? '旧号补练' : '新号'}${t.stay ? ' · 在线' : ' · 离线挂机'}</small></div></div>
    <div class="card"><div class="k">账号</div><div class="v acc">${esc(S.account || '—')}<br><small>${esc(S.password || '')}</small></div></div>
    <div class="card"><div class="k">当前角色</div><div class="v">${esc(S.char || '—')}</div></div>
    <div class="card"><div class="k">等级</div><div class="v">${S.level != null ? 'Lv' + S.level : '—'}</div></div>
    <div class="card"><div class="k">账号进度（30级）</div><div class="v">${S.done || 0} / ${S.total || 12} 只</div>
      <div class="bar"><div style="width:${pct}%"></div></div></div>
    <div class="card"><div class="k">属性</div><div class="v" style="font-size:13px">${S.stats ? `Str${S.stats.str ?? '-'} Agi${S.stats.agi ?? '-'} Vit${S.stats.vit ?? '-'}<br>Dex${S.stats.dex ?? '-'} Int${S.stats.int ?? '-'} Luk${S.stats.luk ?? '-'}` : '—'}</div></div>
    <div class="card"><div class="k">状态</div><div class="v">${st}</div><div class="v"><small>${t.loop ? '循环开新号' : ''}</small></div></div>
    <div class="controls"></div>`;
  renderTabs();
}

// ---------- SSE ----------
function connectSSE(id) {
  const es = new EventSource(`/api/tabs/${id}/stream`);
  state.es = es;
  es.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const t = tabById(id);
    if (!t) return;
    if (msg.type === 'init') {
      Object.assign(t, msg.tab);
      const log = $('#log');
      log.innerHTML = '';
      for (const line of msg.lines) appendLine(log, line);
      scrollLog(true);
      renderCards(t);
    } else if (msg.type === 'log') {
      appendLine($('#log'), msg.line);
      scrollLog();
    } else if (msg.type === 'state') {
      // ★ 按消息里的 tab.id 路由，绝不能覆盖当前流所属之外的标签
      //   （服务端 broadcast(null) 会把所有标签的状态推到每条流上，
      //    旧代码 Object.assign(当前标签) 导致后台 worker 的账号串写前台显示）
      const target = msg.tab && msg.tab.id !== id ? tabById(msg.tab.id) : t;
      if (!target) return;
      Object.assign(target, msg.tab);
      renderTabs();
      if (state.active === target.id) renderCards(target);
    } else if (msg.type === 'clear') {
      $('#log').innerHTML = '';
    } else if (msg.type === 'tab-removed') {
      const gone = tabById(msg.id);
      if (gone) state.tabs.splice(state.tabs.indexOf(gone), 1);
      if (state.active === msg.id) {
        state.active = state.tabs.length ? state.tabs[0].id : null;
        if (state.active) activate(state.active);
        else { $('#main').classList.add('empty'); $('#main').innerHTML = '<div class="placeholder">标签已删除</div>'; renderTabs(); }
      } else renderTabs();
    }
  };
}

const CLS = [
  [/升级|达到|完成|🎉|✅|🏁/i, 'lv-up'],
  [/击杀|攻击|锁定|追击|🎯|👀|⚔/i, 'kill'],
  [/获得|🎁|物品栏/i, 'item'],
  [/⚠|失败|被拒|被踢|拉黑|💀|❌/i, 'warn'],
  [/技能|🎓/i, 'skill'],
  [/📌|飞艇|传送|换图|📍|🛌|巡访/i, 'phase'],
];
function classify(text) { for (const [re, cls] of CLS) if (re.test(text)) return cls; return 'sys'; }

function appendLine(log, line) {
  if (!log) return;
  const el = document.createElement('span');
  el.className = 'l ' + classify(line.text);
  const time = new Date(line.ts).toLocaleTimeString('zh-CN', { hour12: false });
  el.innerHTML = `<span class="ts">${time}</span> ${esc(line.text)}`;
  log.appendChild(el);
  // 自动清理
  if ($('#autoClear') && !$('#autoClear').checked) return;
  while (log.childNodes.length > MAX_LINES) log.removeChild(log.firstChild);
}
function scrollLog(force) {
  const log = $('#log');
  if (!log) return;
  const cb = $('#autoScroll');
  if (force || !cb || cb.checked) log.scrollTop = log.scrollHeight;
}

// ---------- 新建标签对话框 ----------
async function openDialog(mode) {
  const dlg = $('#dlg');
  $('#dlgTitle').textContent = mode === 'old' ? '旧号标签（补练到 30 级）' : mode === 'bounty' ? '赏金标签（自动跑赏金任务）' : '新号标签（自动注册）';
  const isOld = mode === 'old', isBounty = mode === 'bounty';
  $('#acctRow').style.display = isOld ? '' : 'none';
  $('#passRow').style.display = isOld ? '' : 'none';
  $('#manualRow').style.display = isBounty ? '' : 'none';
  $('#manualPassRow').style.display = isBounty ? '' : 'none';
  $('#loopRow').style.display = mode === 'new' ? '' : 'none';
  $('#loopBountyRow').style.display = isBounty ? '' : 'none';
  $('#stayRow').style.display = isBounty ? 'none' : '';
  // 赏金：账号池选号（可自动）；也可在"手动账号"里自行添加任意账号
  const poolRow = $('#poolRow');
  if (isBounty) {
    poolRow.style.display = '';
    const sel = $('#form').poolPick;
    sel.innerHTML = '<option value="">自动领号（账号池顺序）</option>';
    try {
      const { pool } = await fetch('/api/pool').then((r) => r.json());
      if (pool.length) {
        for (const a of pool) {
          const o = document.createElement('option');
          o.value = a.account;
          o.textContent = `${a.account}（${a.status}，跑过${a.bounty_runs}次/${a.bounty_tasks}任务）`;
          sel.appendChild(o);
        }
      } else sel.innerHTML = '<option value="">账号池为空（可下方手动加账号）</option>';
    } catch (_) {}
  } else poolRow.style.display = 'none';
  $('#form').reset();
  dlg.showModal();
  $('#form').onsubmit = (e) => {
    if (e.submitter.value !== 'ok') return;
    e.preventDefault();
    const manualAcct = $('#form').manualAccount.value.trim();
    const body = {
      mode,
      account: isBounty ? (manualAcct || $('#form').poolPick.value || '') : $('#form').account.value.trim(),
      password: isBounty ? $('#form').manualPassword.value.trim() : $('#form').password.value.trim(),
      stay: !isBounty && $('#form').stay.checked,
      loop: mode === 'new' ? $('#form').loop.checked : isBounty ? $('#form').loopBounty.checked : false,
    };
    api('/api/tabs', body)
      .then((t) => { dlg.close(); state.tabs.push(t); activate(t.id); })
      .catch((err) => alert(err.message));
  };
}

// ---------- 账号池面板 ----------
async function showPool() {
  const dlg = $('#poolDlg');
  dlg.showModal();
  $('#poolAdd').onsubmit = async (e) => {
    e.preventDefault();
    const account = $('#poolAdd').account.value.trim();
    const password = $('#poolAdd').password.value.trim();
    try {
      const r = await api('/api/pool', { account, password });
      $('#poolAdd').reset();
      await renderPool();
      alert(`✅ ${r.account} 已加入账号池`);
    } catch (err) { alert(err.message); }
  };
  await renderPool();
}

async function renderPool() {
  $('#poolBody').textContent = '加载中…';
  try {
    const { pool } = await fetch('/api/pool').then((r) => r.json());
    if (!pool.length) { $('#poolBody').textContent = '账号池为空：练级标签练满自动入库，或在上方手动添加'; return; }
    $('#poolBody').innerHTML = `<table>
      <tr><th>账号</th><th>状态</th><th>猫</th><th>赏金次数</th><th>累计任务</th><th>入池/练满</th><th>最近赏金</th><th></th></tr>
      ${pool.map((a) => `<tr>
        <td>${esc(a.account)}</td>
        <td><span class="st ${a.status}">${a.status}</span></td>
        <td>${a.chars}/12</td>
        <td>${a.bounty_runs}</td>
        <td>${a.bounty_tasks}</td>
        <td>${a.finished_at ? new Date(a.finished_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
        <td>${a.last_bounty_at ? new Date(a.last_bounty_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
        <td><button class="small danger" data-del="${esc(a.account)}">移除</button></td>
      </tr>`).join('')}</table>`;
    $('#poolBody').querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`从账号池移除 ${btn.dataset.del}？（不影响正在运行的标签）`)) return;
        try { await fetch('/api/pool/' + encodeURIComponent(btn.dataset.del), { method: 'DELETE' }); await renderPool(); }
        catch (e) { alert('移除失败'); }
      };
    });
  } catch (e) { $('#poolBody').textContent = '加载失败: ' + e.message; }
}

// ---------- 初始化 ----------
async function refresh() {
  const st = await fetch('/api/state').then((r) => r.json());
  state.tabs = st.tabs;
  if (state.active && !tabById(state.active)) state.active = null;
  if (!state.active && state.tabs.length) state.active = state.tabs[0].id;
  if (state.active) activate(state.active);
  else { $('#main').classList.add('empty'); renderTabs(); }
}
$('#btnNew').onclick = () => openDialog('new');
$('#btnOld').onclick = () => openDialog('old');
$('#btnBounty').onclick = () => openDialog('bounty');
$('#btnPool').onclick = showPool;
refresh();
