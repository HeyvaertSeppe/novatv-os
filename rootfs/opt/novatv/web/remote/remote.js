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
    if (m.t === 'hello') { R.info = m; R.settings = m.settings; R.apps = m.apps; R.active = m.active_app; R.audio = m.audio || {}; R.bt = m.bt || { devices: [] }; render(); renderAudio(); }
    else if (m.t === 'audio') { const { t, ...a } = m; R.audio = a; renderAudio(); }
    else if (m.t === 'eq') { R.audio.eq = m.eq; R.audio.preset = m.preset; if (!A.dragging) updateEqUI(); }
    else if (m.t === 'bt') { const { t, ...b } = m; R.bt = b; renderBt(); }
    else if (m.t === 'volume') { R.audio.volume = { level: m.level, muted: m.muted }; if (!A.vdrag) updateVolume(); if ($('#v-remote').offsetParent) toast(m.muted ? 'Muted' : `Volume ${m.level}% · ${m.output || ''}`); }
    else if (m.t === 'state') { R.active = m.active_app; renderNow(); renderApps(); }
    else if (m.t === 'apps') { R.apps = m.apps; renderApps(); if (LIB && !$('#lib-sheet').classList.contains('hidden')) renderLib(); }
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
  b.querySelector('span').innerHTML = I[{ remote: 'remote', apps: 'apps', audio: 'sliders', settings: 'gear' }[b.dataset.tab]];
  b.onclick = () => {
    vibe(5);
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `v-${b.dataset.tab}`));
    if (b.dataset.tab === 'audio') renderAudio();
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

/* ---------- app library */
let LIB = null, libRegion = 'INT';
$('#lib-open span').innerHTML = I.apps;
$('#lib-open').onclick = async () => {
  vibe();
  try { LIB = await api('/api/catalog'); } catch (e) { toast('Could not load the App Library'); return; }
  $('#lib-sheet').classList.remove('hidden');
  renderLib();
};
$('#lib-done').onclick = () => $('#lib-sheet').classList.add('hidden');
function renderLib() {
  const onHome = new Set(R.apps.map((a) => a.id));
  $('#lib-regions').innerHTML = LIB.regions.map((r) => `<button data-r="${r.code}" class="${r.code === libRegion ? 'sel' : ''}">${esc(r.name)}</button>`).join('');
  $$('#lib-regions button').forEach((b) => (b.onclick = () => { libRegion = b.dataset.r; renderLib(); }));
  const list = LIB.apps.filter((a) => a.regions.includes(libRegion));
  $('#lib-list').innerHTML = list.map((a) => `<button class="item" data-id="${esc(a.id)}"><span class="thumb">${tileFace(a)}</span>
      <span class="k">${esc(a.name)}<br><span class="badge2">${esc(a.tagline || '')}</span></span>
      <span class="tog ${onHome.has(a.id) ? 'on' : ''}">${onHome.has(a.id) ? I.check : I.plus}</span></button>`).join('');
  $$('#lib-list [data-id]').forEach((b) => (b.onclick = async () => {
    vibe();
    const id = b.dataset.id, add = !R.apps.some((a) => a.id === id);
    try { await api('/api/catalog', { id, add }); } catch (e) { toast('Could not change the Home Screen'); return; }
    if (add) R.apps.push({ id }); else R.apps = R.apps.filter((a) => a.id !== id);
    renderLib();
    toast(add ? 'Added to Home' : 'Taken off Home');
  }));
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
  CROP.img = null;
  setEdMode(app && app.icon && /^(https?:|data:|\/)/.test(app.icon) ? 'logo' : 'name');
  $('#ed-sheet').classList.remove('hidden');
  preview();
}

/* ---------- tile style: name or logo (with a cropper for logos from the phone) */
const CROP = { img: null, zoom: 1, x: 0, y: 0, base: 1 };
let edMode = 'name';
function setEdMode(m) {
  edMode = m;
  $$('#ed-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  $('.m-name').classList.toggle('hidden', m !== 'name');
  $('.m-logo').classList.toggle('hidden', m !== 'logo');
  $('#crop-tools').classList.toggle('hidden', !CROP.img);
  preview();
}
$$('#ed-mode button').forEach((b) => (b.onclick = () => { vibe(); setEdMode(b.dataset.m); }));
ed('pick').onclick = () => ed('file').click();
ed('file').onchange = () => {
  const f = ed('file').files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => { CROP.img = img; fitLogo(0.8); $('#crop-tools').classList.remove('hidden'); preview(); };
  img.src = URL.createObjectURL(f);
};
function fitLogo(k) {   // k < 1: logo inside the tile, k = 'fill': cover the tile
  const W = 640, H = 384, img = CROP.img;
  CROP.base = k === 'fill' ? Math.max(W / img.width, H / img.height) : Math.min(W / img.width, H / img.height) * k;
  CROP.zoom = 1; CROP.x = 0; CROP.y = 0;
  ed('zoom').value = 100;
  drawCrop();
}
ed('fit').onclick = () => { fitLogo(0.8); };
ed('fill').onclick = () => { fitLogo('fill'); };
ed('zoom').oninput = () => { CROP.zoom = ed('zoom').value / 100; drawCrop(); };
function drawCrop() {
  const cv = ed('crop'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  const grad = g.createLinearGradient(0, 0, W * 0.6, H);
  grad.addColorStop(0, ed('c1').value); grad.addColorStop(1, ed('c2').value);
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  if (!CROP.img) return;
  const s = CROP.base * CROP.zoom, w = CROP.img.width * s, h = CROP.img.height * s;
  g.imageSmoothingQuality = 'high';
  g.drawImage(CROP.img, (W - w) / 2 + CROP.x, (H - h) / 2 + CROP.y, w, h);
}
(() => {   // drag to move, pinch to zoom
  const cv = ed('crop'), pts = new Map();
  let last = null, pinch = null;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); last = [e.clientX, e.clientY]; });
  cv.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const k = cv.width / cv.clientWidth;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) { CROP.zoom = Math.max(0.1, Math.min(4, CROP.zoom * d / pinch)); ed('zoom').value = Math.round(CROP.zoom * 100); }
      pinch = d;
    } else if (last) {
      CROP.x += (e.clientX - last[0]) * k; CROP.y += (e.clientY - last[1]) * k;
    }
    last = [e.clientX, e.clientY];
    drawCrop();
  });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; last = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
})();
function edData() {
  return {
    name: ed('name').value.trim(), url: ed('url').value.trim(), label: ed('label').value.trim() || ed('name').value.trim(),
    c1: ed('c1').value, c2: ed('c2').value, fg: ed('fg').value, ua: ed('ua').value, back: ed('back').value,
    tagline: ed('tag').value.trim(),
    icon: edMode === 'name' ? '' : (ed('icon').value.trim() || (edApp && edApp.icon && !/^(https?:|data:|\/)/.test(edApp.icon) ? edApp.icon : '')),
  };
}
function preview() {
  const cropping = edMode === 'logo' && CROP.img;
  ed('crop').classList.toggle('hidden', !cropping);
  ed('tile').classList.toggle('hidden', !!cropping);
  if (cropping) drawCrop();
  else ed('tile').innerHTML = tileFace(edData());
}
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
    if (edMode === 'logo' && CROP.img) {   // upload the cropped logo first
      drawCrop();
      const up = await api('/api/icons', { data: ed('crop').toDataURL('image/png') });
      d.icon = up.url;
    }
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
      <label class="item"><span class="k">Screen saver style</span><select id="s-sst"><option value="gradient" ${s.screensaver_style !== 'black' ? 'selected' : ''}>Dark gradient</option><option value="black" ${s.screensaver_style === 'black' ? 'selected' : ''}>Black</option></select></label>
      <label class="item"><span class="k">Apps kept open</span><select id="s-bg">${bg}</select></label>
    </div>
    <div class="group-title">Display</div>
    <div class="group">
      <label class="item"><span class="k">Resolution</span><select id="s-res"><option>Loading…</option></select></label>
    </div>
    <div class="group-title">TV</div>
    <div class="group">
      <label class="item"><span class="k">Control with TV remote (HDMI-CEC)</span><label class="switch"><input type="checkbox" id="s-cec" ${s.cec_enabled !== false ? 'checked' : ''}><i></i></label></label>
      <label class="item"><span class="k">Switch TV to NovaTV on start</span><label class="switch"><input type="checkbox" id="s-cecas" ${s.cec_autoswitch !== false ? 'checked' : ''}><i></i></label></label>
      <button class="item action" id="s-tvswitch">Switch TV to NovaTV</button>
      <button class="item danger" id="s-tvoff">Turn off TV</button>
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
  $('#s-sst').addEventListener('change', (e) => save({ screensaver_style: e.target.value }));
  loadResolutions();
  const cec = (body, msg) => api('/api/cec', body).then(() => msg && toast(msg)).catch(() => toast('Could not change this'));
  $('#s-cec').onchange = (e) => cec({ cec_enabled: e.target.checked }, 'Saved');
  $('#s-cecas').onchange = (e) => cec({ cec_autoswitch: e.target.checked }, 'Saved');
  $('#s-tvswitch').onclick = () => cec({ tv: 'switch' });
  $('#s-tvoff').onclick = () => { if (confirm('Turn off the TV?')) cec({ tv: 'off' }); };
  $('#s-reset-apps').onclick = async () => { if (confirm('Replace your app list with the default apps?')) { await api('/api/apps/reset', {}); toast('Default apps restored'); } };
  $('#s-forget').onclick = async () => { if (confirm('Sign out every other phone and create a new pairing code?')) { await api('/api/repair', {}); toast('Other phones signed out'); } };
  $$('[data-sys]').forEach((b) => (b.onclick = async () => {
    const label = b.textContent;
    if (!confirm(`${label}?`)) return;
    await api(`/api/system/${b.dataset.sys}`, {});
    toast(`${label}…`);
  }));
}

/* ================================================================ display */
async function loadResolutions() {
  let d;
  try { d = await api('/api/display'); } catch (e) { return; }
  const sel = $('#s-res');
  if (!sel) return;
  const opts = [`<option value="auto" ${d.setting === 'auto' ? 'selected' : ''}>Automatic${d.best ? ` (${esc(d.best)})` : ''}</option>`,
    ...d.modes.map((m) => `<option value="${m.id}" ${d.setting !== 'auto' && m.current ? 'selected' : ''}>${esc(m.label)}</option>`)];
  sel.innerHTML = d.modes.length ? opts.join('') : '<option>Not available</option>';
  sel.onchange = async () => {
    const res = await api('/api/display', { mode: sel.value }).catch(() => null);
    if (!res || !res.ok) { toast("The TV doesn't accept this mode"); loadResolutions(); return; }
    // the TV reverts by itself after 15 s if nobody confirms
    const keep = confirm(`Does the TV show a picture at ${res.label}? OK keeps it, Cancel goes back.`);
    await api('/api/display/confirm', { keep });
    loadResolutions();
  const cec = (body, msg) => api('/api/cec', body).then(() => msg && toast(msg)).catch(() => toast('Could not change this'));
  $('#s-cec').onchange = (e) => cec({ cec_enabled: e.target.checked }, 'Saved');
  $('#s-cecas').onchange = (e) => cec({ cec_autoswitch: e.target.checked }, 'Saved');
  $('#s-tvswitch').onclick = () => cec({ tv: 'switch' });
  $('#s-tvoff').onclick = () => { if (confirm('Turn off the TV?')) cec({ tv: 'off' }); };
  };
}

/* ================================================================ audio tab */
const A = { dragging: false, vdrag: false, built: false, killPrev: {} };
R.audio = {}; R.bt = { devices: [] };

function renderAudio() {
  if (!A.built) buildAudio();
  updateVolume();
  renderOutputs();
  renderBt();
  renderPresets();
  updateEqUI();
}

function updateVolume() {
  const a = R.audio, v = a.volume || { level: 0, muted: false };
  $('.vol-card').classList.toggle('bt', !!a.active_bluetooth);
  $('#vol-icon').innerHTML = a.active_bluetooth ? I.bluetooth : I.speaker;
  $('#vol-name').textContent = a.active_name || 'TV';
  $('#vfill').style.width = `${v.muted ? 0 : v.level}%`;
  $('#vnum').textContent = v.muted ? 'Muted' : v.level;
  $('#vol-mute').classList.toggle('on', !!v.muted);
}

function renderOutputs() {
  const a = R.audio, list = $('#out-list');
  const rows = [{ name: 'auto', description: 'Automatic', sub: 'Bluetooth speaker when connected' }, ...(a.outputs || [])];
  list.innerHTML = rows.map((o) => `<button class="item" data-out="${esc(o.name)}">
      <span class="ic">${o.name === 'auto' ? I.sliders : o.bluetooth ? I.bluetooth : I.tv}</span>
      <span class="k">${esc(o.description)}${o.name !== 'auto' && a.active === o.name ? ' <span class="badge2 on">· playing</span>' : ''}</span>
      ${a.output_mode === o.name ? '<span class="check">✓</span>' : ''}</button>`).join('');
  $$('[data-out]', list).forEach((b) => (b.onclick = async () => {
    vibe();
    try { R.audio = { ...R.audio, ...(await api('/api/audio/output', { name: b.dataset.out })) }; renderOutputs(); updateVolume(); } catch (e) { toast('Not available'); }
  }));
}

const BUSY = { pairing: 'Pairing…', connecting: 'Connecting…', trusting: 'Connecting…', disconnecting: 'Disconnecting…', removing: 'Removing…' };
function renderBt() {
  const b = R.bt || { devices: [] };
  $('#bt-scan').innerHTML = b.scanning ? '<span class="spin"></span>Searching' : 'Search';
  const list = $('#bt-list');
  if (b.available === false) { list.innerHTML = '<div class="item"><span class="k" style="color:var(--fg2)">Bluetooth is not available</span></div>'; return; }
  const devs = b.devices || [];
  if (!devs.length) { list.innerHTML = `<div class="item"><span class="k" style="color:var(--fg2)">${b.scanning ? 'Looking for speakers…' : 'No devices yet. Tap Search.'}</span></div>`; return; }
  list.innerHTML = devs.map((d) => `<div class="item" data-mac="${d.mac}">
      <span class="ic">${(d.icon || '').includes('head') ? I.headphones : I.speakerbox}</span>
      <span class="k">${esc(d.name)}<br><span class="badge2 ${d.connected ? 'on' : ''}">${d.busy ? `<span class="spin"></span>${BUSY[d.busy] || '…'}` : d.connected ? 'Connected' : d.paired ? 'Paired · tap to connect' : 'Tap to pair'}</span></span>
      ${d.paired ? '<button class="more">···</button>' : ''}</div>`).join('');
  $$('[data-mac]', list).forEach((row) => {
    const d = devs.find((x) => x.mac === row.dataset.mac);
    row.onclick = (e) => {
      vibe();
      if (e.target.closest('.more')) {
        actionSheet(d.name, [
          d.connected ? { label: 'Disconnect', act: () => api('/api/bt/disconnect', { mac: d.mac }) }
                      : { label: 'Connect', act: () => { api('/api/bt/connect', { mac: d.mac }); toast(`Connecting to ${d.name}…`); } },
          { label: 'Forget This Device', danger: true, act: () => api('/api/bt/forget', { mac: d.mac }) },
        ]);
        return;
      }
      if (d.busy) return;
      if (!d.paired) { api('/api/bt/pair', { mac: d.mac }); toast(`Pairing with ${d.name}…`); }
      else if (!d.connected) { api('/api/bt/connect', { mac: d.mac }); toast(`Connecting to ${d.name}…`); }
      else api('/api/bt/disconnect', { mac: d.mac });
    };
  });
}

function actionSheet(title, actions) {
  const s = document.createElement('div');
  s.className = 'sheet';
  s.innerHTML = `<div class="sheet-card"><div class="sheet-grab"></div><div class="sheet-title">${esc(title)}</div><div class="acts"></div></div>`;
  const acts = $('.acts', s);
  [...actions, { label: 'Cancel', cancel: true }].forEach((a) => {
    const b = document.createElement('button');
    b.className = `act${a.danger ? ' danger' : ''}${a.cancel ? ' cancel' : ''}`;
    b.textContent = a.label;
    b.onclick = () => { vibe(); s.remove(); if (a.act) a.act(); };
    acts.appendChild(b);
  });
  s.addEventListener('click', (e) => { if (e.target === s) s.remove(); });
  document.body.appendChild(s);
}

function renderPresets() {
  const a = R.audio, p = a.presets || { builtin: [], user: [] };
  const box = $('#m-presets');
  box.innerHTML = [...p.builtin, ...p.user].map((n) => `<button class="${p.user.includes(n) ? 'user' : ''} ${a.preset === n ? 'sel' : ''}" data-p="${esc(n)}">${esc(n)}</button>`).join('');
  $$('[data-p]', box).forEach((b) => (b.onclick = async () => {
    vibe();
    const n = b.dataset.p;
    if (p.user.includes(n) && a.preset === n) {
      if (confirm(`Delete the preset “${n}”?`)) await api('/api/audio/preset', { action: 'delete', name: n });
      return;
    }
    await api('/api/audio/preset', { name: n });
  }));
}

function updateEqUI() {
  const a = R.audio, eq = a.eq;
  if (!eq || !A.built) return;
  $('#eq-on').checked = !!eq.enabled;
  $('#eq-card').classList.toggle('off', !eq.enabled);
  $('#m-mixer').style.opacity = eq.enabled ? 1 : 0.45;
  $$('#m-presets button').forEach((b) => b.classList.toggle('sel', b.dataset.p === a.preset));
  $$('.mband').forEach((b, i) => {
    const v = eq.bands[i], pct = (v - EQ.BAND_MIN) / (EQ.BAND_MAX - EQ.BAND_MIN);
    $('.th', b).style.top = `${(1 - pct) * 100}%`;
    const f = $('.f', b);
    f.style.top = `${Math.min(50, (1 - pct) * 100)}%`;
    f.style.bottom = `${Math.min(50, pct * 100)}%`;
    $('.v', b).textContent = `${v > 0 ? '+' : ''}${Math.round(v)}`;
  });
  $$('.mknob').forEach((k) => {
    const v = eq[k.dataset.key];
    EQ.setKnob(k, v);
    $('.r', k).textContent = EQ.fmt(v, true);
    $('.kill', k).classList.toggle('on', v <= EQ.ISO_MIN + 0.01);
  });
  EQ.draw($('#m-curve'), eq, { glow: 8, width: 2.5, range: 15 });
}

let eqT = 0, pendingEq = null;
function sendEq(upd) {
  const eq = R.audio.eq;
  if ('band' in upd) eq.bands[upd.band] = upd.value;
  for (const k of ['low', 'mid', 'high', 'enabled']) if (k in upd) eq[k] = upd[k];
  R.audio.preset = 'Custom';
  updateEqUI();
  pendingEq = { ...(pendingEq || {}), ...upd };
  if (!eqT) eqT = setTimeout(() => { send({ t: 'eq', ...pendingEq }); pendingEq = null; eqT = 0; }, 35);
}

function buildAudio() {
  A.built = true;
  $('#vol-mute').innerHTML = I.mute;
  $('#vol-mute').onclick = () => { vibe(); send({ t: 'key', k: 'mute' }); };
  // volume slider
  const vs = $('#vslider');
  let vt = 0;
  const setV = (x) => {
    const r = vs.getBoundingClientRect();
    const level = Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * 100);
    R.audio.volume = { level, muted: false };
    updateVolume();
    clearTimeout(vt);
    vt = setTimeout(() => send({ t: 'volume_set', level }), 40);
  };
  vs.addEventListener('pointerdown', (e) => { A.vdrag = true; vs.classList.add('drag'); vs.setPointerCapture(e.pointerId); setV(e.clientX); });
  vs.addEventListener('pointermove', (e) => { if (A.vdrag) setV(e.clientX); });
  const vEnd = () => { A.vdrag = false; vs.classList.remove('drag'); };
  vs.addEventListener('pointerup', vEnd); vs.addEventListener('pointercancel', vEnd);

  $('#bt-scan').onclick = () => { vibe(); api('/api/bt/scan', { on: !R.bt.scanning }); };
  $('#eq-on').onchange = (e) => sendEq({ enabled: e.target.checked });

  // EQ sliders
  const box = $('#m-sliders');
  box.innerHTML = EQ.LABELS.map((l) => `<div class="mband"><div class="v"></div><div class="t"><div class="f"></div><div class="th"></div></div><div class="l">${l}</div></div>`).join('');
  $$('.mband', box).forEach((b, i) => {
    const t = $('.t', b);
    const set = (y) => {
      const r = t.getBoundingClientRect();
      const pct = 1 - Math.max(0, Math.min(1, (y - r.top) / r.height));
      const v = Math.round(EQ.BAND_MIN + pct * (EQ.BAND_MAX - EQ.BAND_MIN));
      if (v !== R.audio.eq.bands[i]) { sendEq({ band: i, value: v }); vibe(4); }
    };
    t.addEventListener('pointerdown', (e) => { A.dragging = true; b.classList.add('drag'); t.setPointerCapture(e.pointerId); set(e.clientY); });
    t.addEventListener('pointermove', (e) => { if (b.classList.contains('drag')) set(e.clientY); });
    const end = () => { b.classList.remove('drag'); A.dragging = false; };
    t.addEventListener('pointerup', end); t.addEventListener('pointercancel', end);
  });

  // DJ knobs
  const mixer = $('#m-mixer');
  [['low', 'LOW'], ['mid', 'MID'], ['high', 'HI']].forEach(([key, label]) => {
    const k = document.createElement('div');
    k.className = 'mknob';
    k.dataset.key = key;
    k.innerHTML = `<div class="n">${label}</div>${EQ.knobSVG()}<div class="r"></div><button class="kill">KILL</button>`;
    mixer.appendChild(k);
    const svg = $('svg', k);
    let y0 = 0, v0 = 0, lastTap = 0;
    svg.addEventListener('pointerdown', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) { sendEq({ [key]: 0 }); vibe(12); lastTap = 0; return; }
      lastTap = now;
      A.dragging = true; y0 = e.clientY; v0 = R.audio.eq[key]; svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!A.dragging || !svg.hasPointerCapture(e.pointerId)) return;
      const d = (y0 - e.clientY) / 5;
      const v = Math.max(EQ.ISO_MIN, Math.min(EQ.ISO_MAX, Math.round(v0 + (v0 + d < 0 ? d * 2 : d))));
      if (v !== R.audio.eq[key]) { sendEq({ [key]: v }); vibe(3); }
    });
    const end = () => { A.dragging = false; };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    $('.kill', k).onclick = () => {
      vibe(15);
      const v = R.audio.eq[key];
      if (v <= EQ.ISO_MIN + 0.01) sendEq({ [key]: A.killPrev[key] ?? 0 });
      else { A.killPrev[key] = v; sendEq({ [key]: EQ.ISO_MIN }); }
    };
  });

  $('#m-save').onclick = async () => {
    const name = (prompt('Name this preset', '') || '').trim();
    if (!name) return;
    try { await api('/api/audio/preset', { action: 'save', name }); toast('Preset saved'); } catch (e) { toast('Choose another name'); }
  };
  $('#m-reset').onclick = () => { vibe(); api('/api/audio/preset', { name: 'Flat' }); };
  window.addEventListener('resize', () => updateEqUI());
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
