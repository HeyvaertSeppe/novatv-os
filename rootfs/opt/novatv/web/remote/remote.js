'use strict';
/* NovaTV phone remote */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const I = window.ICONS;
const R = { ws: null, apps: [], info: {}, settings: {}, mode: localStorage.getItem('mode') || 'swipe', editing: false, active: null };

const vibe = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* iOS */ } };

async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (r.status === 401) { showPair(); throw new Error('pair'); }
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

let toastT;
function toast(t) {
  const e = $('#toast');
  e.textContent = t;
  e.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => e.classList.remove('on'), 2000);
}

/* ================================================================ pairing */
function showPair(err) {
  $('#shell').classList.add('hidden');
  $('#pair').classList.remove('hidden');
  if (err) $('#pair-err').textContent = err;
  setTimeout(() => $('#pair-input').focus(), 300);
}
async function doPair() {
  const code = $('#pair-input').value.replace(/\D/g, '');
  if (code.length !== 6) { $('#pair-err').textContent = 'The code has 6 digits.'; return; }
  const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const j = await r.json().catch(() => ({}));
  if (j.ok) { history.replaceState(null, '', '/'); boot(); }
  else $('#pair-err').textContent = j.error === 'locked' ? 'Too many tries. Wait 5 minutes.' : 'That code is not right. Check the TV.';
}
$('#pair-btn').onclick = doPair;
$('#pair-input').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6) doPair(); });

/* ================================================================ websocket */
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  R.ws = ws;
  ws.onopen = () => $('#dot').classList.add('on');
  ws.onclose = () => {
    $('#dot').classList.remove('on');
    setTimeout(async () => {
      try { await api('/api/info'); connect(); } catch (e) { if (e.message !== 'pair') setTimeout(connect, 2000); }
    }, 1200);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'hello') { R.info = m; R.settings = m.settings; R.apps = m.apps; R.active = m.active_app; render(); }
    else if (m.t === 'state') { R.active = m.active_app; renderNow(); renderApps(); }
    else if (m.t === 'apps') { R.apps = m.apps; renderApps(); }
    else if (m.t === 'settings') { R.settings = m.settings; render(); }
    else if (m.t === 'toast') toast(m.text);
  };
}
function send(m) {
  if (R.ws && R.ws.readyState === 1) { R.ws.send(JSON.stringify(m)); return true; }
  return false;
}
function key(k) { vibe(); send({ t: 'key', k }); }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!R.ws || R.ws.readyState > 1)) connect();
});

/* ================================================================ render */
function render() {
  $('#tv-name').textContent = R.settings.device_name || 'NovaTV';
  document.title = `${R.settings.device_name || 'NovaTV'} Remote`;
  renderNow();
  renderApps();
  renderSettings();
}
function renderNow() {
  const a = R.apps.find((x) => x.id === R.active);
  $('#now').textContent = a ? `Watching ${a.name}` : (R.active === 'url' ? 'Browsing the web' : 'Home screen');
}

/* ---------- tabs */
$$('#tabs button').forEach((b) => {
  b.querySelector('span').innerHTML = I[{ remote: 'remote', apps: 'apps', settings: 'gear' }[b.dataset.tab]];
  b.onclick = () => {
    vibe(5);
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `v-${b.dataset.tab}`));
  };
});
function showTab(t) { $(`#tabs button[data-tab="${t}"]`).click(); }

/* ================================================================ remote: buttons */
const BTN_ICONS = { back: I.back, home: I.tv, playpause: I.playpause, mute: I.mute, volup: I.plus, voldown: I.minus };
$$('.buttons [data-k]').forEach((b) => {
  b.innerHTML = BTN_ICONS[b.dataset.k];
  const repeatable = b.dataset.k.startsWith('vol');
  holdRepeat(b, () => key(b.dataset.k), repeatable);
});
$$('.dpad [data-k]').forEach((b) => {
  if (b.classList.contains('dp')) b.innerHTML = { up: I.up, down: I.down, left: I.back, right: I.chevron }[b.dataset.k];
  holdRepeat(b, () => key(b.dataset.k), b.dataset.k !== 'select');
});
$('#kb-btn span').innerHTML = I.keyboard;

function holdRepeat(el, fn, repeat) {
  let t1, t2;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fn();
    if (repeat) t1 = setTimeout(() => { t2 = setInterval(fn, 140); }, 420);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, stop));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ---------- modes */
function setMode(m) {
  R.mode = m;
  localStorage.setItem('mode', m);
  const idx = ['swipe', 'dpad', 'pointer'].indexOf(m);
  $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('.mode-pill').style.transform = `translateX(${idx * 100}%)`;
  $('#dpad').classList.toggle('hidden', m !== 'dpad');
  $('#pad').classList.toggle('pointer', m === 'pointer');
  $('#pad-hint').textContent = m === 'pointer' ? 'Drag to move the pointer · Tap to click · Two fingers to scroll'
    : m === 'swipe' ? 'Swipe to move · Tap to select' : '';
  $('#pad-hint').style.opacity = 1;
}
$$('#modes button').forEach((b) => (b.onclick = () => { vibe(5); setMode(b.dataset.mode); }));

/* ---------- touch surface */
const pad = $('#pad');
const dot = $('#touch-dot');
const T = { id: null, x0: 0, y0: 0, x: 0, y: 0, t0: 0, moved: 0, ax: 0, ay: 0, fingers: 0, pdx: 0, pdy: 0, raf: 0 };
const STEP = 42;

function flash(dir) {
  pad.classList.remove('flash-up', 'flash-down', 'flash-left', 'flash-right');
  void pad.offsetWidth;
  pad.classList.add(`flash-${dir}`);
  setTimeout(() => pad.classList.remove(`flash-${dir}`), 160);
}

function placeDot(x, y) {
  const r = pad.getBoundingClientRect();
  dot.style.left = `${x - r.left}px`;
  dot.style.top = `${y - r.top}px`;
}

pad.addEventListener('touchstart', (e) => {
  if (R.mode === 'dpad') return;
  e.preventDefault();
  const t = e.touches[0];
  T.fingers = e.touches.length;
  T.x0 = T.x = t.clientX; T.y0 = T.y = t.clientY;
  T.ax = t.clientX; T.ay = t.clientY;
  T.t0 = Date.now(); T.moved = 0;
  placeDot(t.clientX, t.clientY);
  dot.classList.add('on');
  $('#pad-hint').style.opacity = 0;
}, { passive: false });

pad.addEventListener('touchmove', (e) => {
  if (R.mode === 'dpad') return;
  e.preventDefault();
  const t = e.touches[0];
  T.fingers = Math.max(T.fingers, e.touches.length);
  const dx = t.clientX - T.x, dy = t.clientY - T.y;
  T.x = t.clientX; T.y = t.clientY;
  T.moved += Math.abs(dx) + Math.abs(dy);
  placeDot(t.clientX, t.clientY);
  if (R.mode === 'pointer') {
    const accel = (v) => v * (1.6 + Math.min(Math.abs(v) / 12, 2.4));
    if (e.touches.length >= 2) { T.pdy += -dy * 3; T.pdx += -dx * 3; T.scroll = true; }
    else { T.pdx += accel(dx); T.pdy += accel(dy); T.scroll = false; }
    if (!T.raf) T.raf = requestAnimationFrame(flushPointer);
    return;
  }
  // swipe mode: every STEP pixels of travel along the main axis = one arrow press
  const sx = t.clientX - T.ax, sy = t.clientY - T.ay;
  if (Math.max(Math.abs(sx), Math.abs(sy)) >= STEP) {
    const dir = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? 'right' : 'left') : (sy > 0 ? 'down' : 'up');
    key(dir);
    flash(dir);
    T.ax = t.clientX; T.ay = t.clientY;
  }
}, { passive: false });

function flushPointer() {
  T.raf = 0;
  if (T.scroll) send({ t: 'scroll', dx: Math.round(T.pdx), dy: Math.round(T.pdy) });
  else send({ t: 'pointer', dx: Math.round(T.pdx), dy: Math.round(T.pdy) });
  T.pdx = T.pdy = 0;
}

pad.addEventListener('touchend', (e) => {
  if (R.mode === 'dpad') return;
  e.preventDefault();
  if (e.touches.length) return;
  dot.classList.remove('on');
  const quick = Date.now() - T.t0 < 350;
  if (T.moved < 12 && quick) {
    dot.classList.add('on', 'tap');
    setTimeout(() => dot.classList.remove('on', 'tap'), 180);
    if (R.mode === 'pointer') { vibe(); send({ t: 'click' }); }
    else key('select');
  }
}, { passive: false });

// desktop testing: arrow keys / mouse click on the pad
pad.addEventListener('click', () => { if (R.mode === 'swipe' && !('ontouchstart' in window)) key('select'); });
document.addEventListener('keydown', (e) => {
  if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'select', Escape: 'back', Backspace: 'back', ' ': 'playpause', h: 'home' };
  if (map[e.key]) { e.preventDefault(); key(map[e.key]); }
});

/* ---------- keyboard sheet */
let kbPrev = '';
$('#kb-btn').onclick = () => {
  $('#kb-sheet').classList.remove('hidden');
  const inp = $('#kb-input');
  inp.value = ''; kbPrev = '';
  setTimeout(() => inp.focus(), 50);
};
$('#kb-input').addEventListener('input', (e) => {
  const now = e.target.value;
  let i = 0;
  while (i < kbPrev.length && i < now.length && kbPrev[i] === now[i]) i++;
  for (let n = kbPrev.length - i; n > 0; n--) send({ t: 'key', k: 'backspace' });
  if (now.length > i) send({ t: 'text', text: now.slice(i) });
  kbPrev = now;
});
$('#kb-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); send({ t: 'key', k: 'enter' }); vibe(); }
  else if (e.key === 'Backspace' && !e.target.value) send({ t: 'key', k: 'backspace' });
});
$('#kb-enter').onclick = () => { send({ t: 'key', k: 'enter' }); vibe(); };
$('#kb-clear').onclick = () => {
  for (let n = kbPrev.length; n > 0; n--) send({ t: 'key', k: 'backspace' });
  $('#kb-input').value = ''; kbPrev = ''; $('#kb-input').focus();
};
$('#kb-done').onclick = () => { $('#kb-sheet').classList.add('hidden'); $('#kb-input').blur(); };
$('#kb-sheet').addEventListener('click', (e) => { if (e.target.id === 'kb-sheet') $('#kb-done').click(); });

/* ================================================================ apps */
$('#url-go').innerHTML = I.chevron;
async function openUrl() {
  const u = $('#url-input').value.trim();
  if (!u) return;
  const url = /\s/.test(u) || !/\./.test(u) ? `https://duckduckgo.com/?q=${encodeURIComponent(u)}` : u;
  await api('/api/launch', { url });
  $('#url-input').value = '';
  $('#url-input').blur();
  toast('Opening on TV');
  showTab('remote');
}
$('#url-go').onclick = openUrl;
$('#url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') openUrl(); });

$('#edit-toggle').onclick = () => {
  R.editing = !R.editing;
  $('#edit-toggle').textContent = R.editing ? 'Done' : 'Edit';
  renderApps();
};

function renderApps() {
  const g = $('#app-grid');
  g.classList.toggle('editing', R.editing);
  g.innerHTML = '';
  R.apps.forEach((a) => {
    const d = document.createElement('div');
    d.className = 'app' + (a.id === R.active ? ' playing' : '');
    d.innerHTML = `<div class="face">${tileFace(a)}</div><div class="nm">${esc(a.name)}</div>` +
      (a.type !== 'system' ? `<div class="badge">${I.pencil}</div>` : '');
    d.onclick = () => {
      vibe();
      if (R.editing) { if (a.type !== 'system') openEditor(a); return; }
      send({ t: 'launch', id: a.id });
      toast(`Opening ${a.name}`);
      showTab('remote');
    };
    g.appendChild(d);
  });
  const add = document.createElement('div');
  add.className = 'app add';
  add.innerHTML = `<div class="face">${I.plus}</div><div class="nm">Add App</div>`;
  add.onclick = () => openEditor(null);
  g.appendChild(add);
}

/* ---------- editor */
const SWATCHES = [['#e50914', '#5a0408'], ['#1a98ff', '#0b2a4a'], ['#1d3fd6', '#06123f'], ['#7b2cff', '#1d0550'], ['#ff2d55', '#4a0716'],
  ['#ff5a1f', '#4a1300'], ['#ffc421', '#7a5200'], ['#1ed760', '#05361a'], ['#00c2c7', '#003c40'], ['#3a3a46', '#121218']];
let edApp = null;
const ed = (id) => $(`#ed-${id}`);

function openEditor(app) {
  edApp = app;
  ed('title').textContent = app ? 'Edit App' : 'Add App';
  ed('name').value = app?.name || '';
  ed('url').value = app?.url || '';
  ed('label').value = app?.label || '';
  ed('icon').value = app?.icon && /^(https?:|data:|\/)/.test(app.icon) ? app.icon : '';
  ed('c1').value = app?.c1 || '#3a3a46';
  ed('c2').value = app?.c2 || '#121218';
  ed('fg').value = app?.fg || '#ffffff';
  ed('ua').value = app?.ua || 'default';
  ed('back').value = app?.back || 'smart';
  ed('tag').value = app?.tagline || '';
  ed('delete').classList.toggle('hidden', !app);
  ed('move').classList.toggle('hidden', !app);
  $('#ed-sheet').classList.remove('hidden');
  preview();
}
function edData() {
  return {
    name: ed('name').value.trim(), url: ed('url').value.trim(), label: ed('label').value.trim() || ed('name').value.trim(),
    c1: ed('c1').value, c2: ed('c2').value, fg: ed('fg').value, ua: ed('ua').value, back: ed('back').value,
    tagline: ed('tag').value.trim(),
    icon: ed('icon').value.trim() || (edApp && edApp.icon && !/^(https?:|data:|\/)/.test(edApp.icon) ? edApp.icon : ''),
  };
}
function preview() { ed('tile').innerHTML = tileFace(edData()); }
['name', 'label', 'icon', 'c1', 'c2', 'fg'].forEach((k) => ed(k).addEventListener('input', preview));
ed('swatches').innerHTML = SWATCHES.map(([a, b]) => `<button style="background:linear-gradient(150deg,${a},${b})" data-a="${a}" data-b="${b}"></button>`).join('');
ed('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  ed('c1').value = b.dataset.a; ed('c2').value = b.dataset.b;
  ed('fg').value = b.dataset.a === '#ffc421' || b.dataset.a === '#1ed760' ? '#111111' : '#ffffff';
  preview();
});
ed('url').addEventListener('change', () => {
  // suggest a browser identity for well-known streaming services
  const u = ed('url').value.toLowerCase();
  if (/netflix|primevideo|amazon\.|disneyplus|hbomax|max\.com|apple\.com/.test(u)) ed('ua').value = 'chromeos';
  if (/youtube\.com\/tv/.test(u)) { ed('ua').value = 'smarttv'; ed('back').value = 'escape'; }
  if (!ed('name').value) {
    try { const h = new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').split('.')[0]; ed('name').value = h.charAt(0).toUpperCase() + h.slice(1); preview(); } catch (e) { /* ignore */ }
  }
});
ed('cancel').onclick = () => $('#ed-sheet').classList.add('hidden');
ed('save').onclick = async () => {
  const d = edData();
  if (!d.name || !d.url) { toast('Name and web address are needed'); return; }
  try {
    if (edApp) await api(`/api/apps/${encodeURIComponent(edApp.id)}`, d, 'PUT');
    else await api('/api/apps', d);
    $('#ed-sheet').classList.add('hidden');
    toast(edApp ? 'App updated' : 'App added to the TV');
  } catch (e) { toast('Could not save'); }
};
ed('delete').onclick = async () => {
  if (!edApp || !confirm(`Remove ${edApp.name} from the TV?`)) return;
  await api(`/api/apps/${encodeURIComponent(edApp.id)}`, undefined, 'DELETE');
  $('#ed-sheet').classList.add('hidden');
  toast('App removed');
};
async function moveApp(delta) {
  const ids = R.apps.map((a) => a.id);
  const i = ids.indexOf(edApp.id), j = i + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await api('/api/apps/order', { ids });
  toast(delta < 0 ? 'Moved earlier' : 'Moved later');
}
ed('left').onclick = () => moveApp(-1);
ed('right').onclick = () => moveApp(1);

/* ================================================================ settings */
function renderSettings() {
  const s = R.settings, i = R.info;
  const ss = [0, 2, 5, 10, 15, 30].map((m) => `<option value="${m}" ${+s.screensaver_minutes === m ? 'selected' : ''}>${m ? `${m} minutes` : 'Never'}</option>`).join('');
  const bg = [0, 1, 2, 3].map((n) => `<option value="${n}" ${+s.keep_background === n ? 'selected' : ''}>${n}</option>`).join('');
  $('#settings-list').innerHTML = `
    <div class="group-title">TV</div>
    <div class="group">
      <label class="item"><span class="k">Name</span><input id="s-name" value="${esc(s.device_name || '')}" enterkeyhint="done"></label>
      <div class="item"><span class="k">Address</span><span class="v">${esc(i.ip || '—')}</span></div>
    </div>
    <div class="group-title">Display</div>
    <div class="group">
      <label class="item"><span class="k">Screen saver</span><select id="s-ss">${ss}</select></label>
      <label class="item"><span class="k">Apps kept open</span><select id="s-bg">${bg}</select></label>
    </div>
    <div class="group-title">Apps</div>
    <div class="group">
      <button class="item action" id="s-reset-apps">Restore default apps</button>
    </div>
    <div class="group-title">Remote</div>
    <div class="group">
      <button class="item danger" id="s-forget">Sign out all other phones</button>
    </div>
    <div class="group-title">Power</div>
    <div class="group">
      <button class="item action" data-sys="restart-ui">Restart interface</button>
      <button class="item action" data-sys="reboot">Restart TV box</button>
      <button class="item danger" data-sys="poweroff">Shut down</button>
    </div>
    <p class="about">NovaTV ${esc(i.version || '')} · ${esc(i.hostname || '')}<br>Widevine L3 · Chromium</p>`;
  const save = (body) => api('/api/settings', body).then((r) => { R.settings = r; toast('Saved'); }).catch(() => toast('Could not save'));
  $('#s-name').addEventListener('change', (e) => save({ device_name: e.target.value }));
  $('#s-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#s-ss').addEventListener('change', (e) => save({ screensaver_minutes: +e.target.value }));
  $('#s-bg').addEventListener('change', (e) => save({ keep_background: +e.target.value }));
  $('#s-reset-apps').onclick = async () => { if (confirm('Replace your app list with the default apps?')) { await api('/api/apps/reset', {}); toast('Default apps restored'); } };
  $('#s-forget').onclick = async () => { if (confirm('Sign out every other phone and create a new pairing code?')) { await api('/api/repair', {}); toast('Other phones signed out'); } };
  $$('[data-sys]').forEach((b) => (b.onclick = async () => {
    const label = b.textContent;
    if (!confirm(`${label}?`)) return;
    await api(`/api/system/${b.dataset.sys}`, {});
    toast(`${label}…`);
  }));
}

/* ================================================================ boot */
async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.get('pair_error')) {
    history.replaceState(null, '', '/');
    showPair(q.get('pair_error') === 'locked' ? 'Too many tries. Wait 5 minutes.' : 'That code has expired. Enter the code shown on the TV.');
    return;
  }
  try {
    R.info = await api('/api/info');
  } catch (e) {
    if (e.message !== 'pair') setTimeout(boot, 2000);
    return;
  }
  $('#pair').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  setMode(R.mode);
  connect();
}
boot();
