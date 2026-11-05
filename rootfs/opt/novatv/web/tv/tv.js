'use strict';
/* NovaTV launcher: intro, first-boot setup, home screen, settings.
   Works with a keyboard, a mouse, an HDMI-CEC TV remote and the phone remote. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const I = window.ICONS;
const S = {
  apps: [], info: {}, settings: {}, screen: null, focus: null, ws: null, ready: false,
  remotes: 0, lastInput: Date.now(), saver: false, pairDismissed: false, artApp: null, artFlip: false,
  stack: [], alertPrev: null,
};
const rem = () => innerWidth / 192;

async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function el(tag, cls, html, act) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (act) { e.classList.add('focusable'); e._act = act; }
  return e;
}

/* ================================================================ focus engine */
function scopeEl() {
  if (!$('#alert').classList.contains('hidden')) return $('#alert');
  return $(`#${S.screen}`) || document.body;
}
function isVisible(e) { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
function focusables() { return $$('.focusable', scopeEl()).filter(isVisible); }

function setFocus(e, dir) {
  if (!e) return;
  const prev = S.focus;
  if (prev && prev !== e) prev.classList.remove('focused', 'tilt-left', 'tilt-right', 'tilt-up', 'tilt-down');
  S.focus = e;
  e.classList.add('focused');
  const input = e.matches('.field') ? $('input', e) : null;
  if (input) { if (document.activeElement !== input) input.focus({ preventScroll: true }); }
  else if (document.activeElement && document.activeElement.tagName === 'INPUT') document.activeElement.blur();
  if (dir && e.classList.contains('tile')) {
    e.classList.remove('tilt-left', 'tilt-right', 'tilt-up', 'tilt-down');
    void e.offsetWidth;
    e.classList.add(`tilt-${dir}`);
  }
  const box = e.closest('.list, .set-list, .lib-scroll');
  if (box) {
    const top = e.offsetTop - box.clientHeight / 2 + e.offsetHeight / 2;
    box.scrollTo({ top, behavior: prev && dir ? 'smooth' : 'auto' });
  }
  e.dispatchEvent(new CustomEvent('nv-focus'));
}

function focusFirst(container) {
  const c = container || scopeEl();
  const pref = $('.focusable.default', c) || $$('.focusable', c).find(isVisible);
  if (pref) setFocus(pref);
}

function move(dir) {
  const list = focusables();
  const cur = S.focus;
  if (!cur || !cur.isConnected || !list.includes(cur)) { focusFirst(); return; }
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bestScore = Infinity;
  for (const e of list) {
    if (e === cur) continue;
    const b = e.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    let main, cross;
    const sameRow = b.top < r.bottom - 4 && b.bottom > r.top + 4;
    if (dir === 'left') { if (x >= cx - 2 || !sameRow) continue; main = cx - x; cross = Math.abs(y - cy); }
    else if (dir === 'right') { if (x <= cx + 2 || !sameRow) continue; main = x - cx; cross = Math.abs(y - cy); }
    else if (dir === 'up') { if (b.bottom > cy) continue; main = cy - y; cross = Math.abs(x - cx); }
    else { if (b.top < cy) continue; main = y - cy; cross = Math.abs(x - cx); }
    const score = main + cross * 2.2;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  if (best) setFocus(best, dir);
  else if (cur) bump(cur, dir);
}

function bump(e, dir) {
  const d = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  e.animate([{ translate: '0 0' }, { translate: `${d[0] * 0.8}rem ${d[1] * 0.8}rem` }, { translate: '0 0' }],
    { duration: 260, easing: 'cubic-bezier(.3,.7,.4,1)' });
}

function activate() {
  const e = S.focus;
  if (!e || !e.isConnected) { focusFirst(); return; }
  e.classList.add('press');
  setTimeout(() => e.classList.remove('press'), 140);
  if (e._act) e._act();
}

/* one entry point for keyboard, CEC, mouse and the phone remote */
function input(k) {
  S.lastInput = Date.now();
  if (S.saver) { hideSaver(); return; }
  if (!S.ready) return;
  if (k === 'home') { goHome(); return; }
  if (S.screen === 'eq' && S.eqAdjust && eqAdjustKey(k)) return;
  if (['up', 'down', 'left', 'right'].includes(k)) { move(k); return; }
  if (k === 'select') { activate(); return; }
  if (k === 'menu') { if (S.screen === 'home' && S.focus && S.focus.classList.contains('tile')) tileMenu(S.focus.dataset.id); else activate(); return; }
  if (k === 'back') { back(); }
}

function back() {
  if (!$('#alert').classList.contains('hidden')) { closeAlert(); return; }
  if (S.screen === 'settings') { settingsBack(); return; }
  if (S.screen === 'eq') { closeEq(); return; }
  if (S.screen === 'library') { showHome(); return; }
  if (S.screen === 'setup') { setupBack(); return; }
  if (S.screen === 'home') {
    if (!$('#pair-card').classList.contains('hidden')) { hidePairCard(); return; }
    const first = $('#grid .tile');
    if (S.focus !== first && first) setFocus(first, 'up');
  }
}

document.addEventListener('keydown', (e) => {
  document.body.classList.add('no-cursor');
  const k = e.key;
  const inInput = document.activeElement && document.activeElement.tagName === 'INPUT';
  if (k.startsWith('Arrow')) {
    if (inInput && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
    e.preventDefault();
    input(k.slice(5).toLowerCase());
  } else if (k === 'Enter') {
    e.preventDefault();
    if (inInput && S.focus && S.focus._enter) { S.focus._enter(); return; }
    input('select');
  } else if (k === 'Escape' || k === 'BrowserBack' || k === 'GoBack' || (k === 'Backspace' && !inInput)) {
    e.preventDefault();
    input('back');
  } else if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'ContextMenu') {
    input('menu');
  } else if (k === 'BrowserHome' || (k === 'Home' && !inInput)) {
    input('home');
  } else if (S.saver) {
    hideSaver();
  } else {
    S.lastInput = Date.now();
  }
});

let mouseMoved = 0;
document.addEventListener('mousemove', (e) => {
  if (Math.abs(e.movementX) + Math.abs(e.movementY) < 2) return;
  document.body.classList.remove('no-cursor');
  S.lastInput = Date.now();
  mouseMoved = Date.now();
  if (S.saver) hideSaver();
});
document.addEventListener('mouseover', (e) => {
  if (Date.now() - mouseMoved > 400) return;
  const f = e.target.closest('.focusable');
  if (f && f !== S.focus && scopeEl().contains(f)) setFocus(f);
});
document.addEventListener('click', (e) => {
  S.lastInput = Date.now();
  if (S.saver) { hideSaver(); return; }
  if (e.target.closest('.eye')) return;
  const f = e.target.closest('.focusable');
  if (f && scopeEl().contains(f)) {
    if (f !== S.focus) setFocus(f);
    if (!f.matches('.field')) activate();
  }
});
document.addEventListener('wheel', (e) => {
  S.lastInput = Date.now();
  const box = e.target.closest('.list, .set-list');
  if (box) box.scrollTop += e.deltaY;
}, { passive: true });

/* ================================================================ websocket */
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws?role=tv`);
  S.ws = ws;
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connect, 1500);
}
function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      S.info = m; S.settings = m.settings; S.apps = m.apps; S.remotes = m.remotes;
      S.audio = m.audio || {}; S.bt = m.bt || { devices: [] };
      renderHome(); updateStatus();
      if (!S.started) start();
      break;
    case 'state':
      S.remotes = m.remotes;
      if (m.ip !== S.info.ip) { S.info.ip = m.ip; refreshQR(); }
      S.info.active_app = m.active_app;
      updateStatus();
      break;
    case 'apps': S.apps = m.apps; renderHome(); if (S.screen === 'settings') renderSettings(); if (S.screen === 'library') markLibrary(); break;
    case 'settings': S.settings = m.settings; updateStatus(); tick(); break;
    case 'paircode': refreshInfo().then(refreshQR); break;
    case 'remote_connected': onRemoteConnected(); break;
    case 'launching': playLaunch(m.id); break;
    case 'home': goHome(); closeLaunch(); break;
    case 'open': if (m.screen === 'settings') openSettings(); else if (m.screen === 'library') openLibrary(); break;
    case 'key': input(m.k); break;
    case 'display': { const { t, ...d } = m; S.display = d; closeAlertIf('display'); refreshAudioViews(); break; }
    case 'display_confirm': confirmDisplay(m.label, m.seconds); break;
    case 'volume': S.audio.volume = { level: m.level, muted: m.muted }; showVolume(m); break;
    case 'audio': { const { t, ...a } = m; S.audio = a; refreshAudioViews(); break; }
    case 'eq': S.audio.eq = m.eq; S.audio.preset = m.preset; if (S.screen === 'eq' && !S.eqLocal) updateEq(); break;
    case 'bt': { const { t, ...b } = m; S.bt = b; refreshAudioViews(); break; }
    case 'toast': toast(m.text); break;
  }
}

async function refreshInfo() {
  try { const i = await api('/api/info'); Object.assign(S.info, i); S.settings = i.settings; } catch (e) { /* offline */ }
}

/* ================================================================ startup */
// The boot logo stays on screen until this page has painted the same logo; then the
// compositor shows the page and the intro continues from there without a jump.
const shown = (async () => {
  try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* */ }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { await fetch('/api/ui-ready', { method: 'POST' }); } catch (e) { /* not on the TV */ }
  await new Promise((r) => setTimeout(r, 150));   // compositor polls every 100 ms
})();

async function start() {
  S.started = true;
  await shown;
  const intro = $('#intro');
  const played = sessionStorage.getItem('intro');
  const next = () => {
    S.ready = true;
    if (!S.settings.setup_done) openSetup(); else showHome(true);
    intro.classList.add('done');
    document.body.classList.remove('booting');
  };
  if (played) { next(); return; }
  sessionStorage.setItem('intro', '1');
  intro.classList.add('play');
  setTimeout(next, 550);
}

/* ================================================================ home */
function renderHome() {
  const grid = $('#grid');
  const keep = S.focus && S.focus.dataset.id;
  grid.innerHTML = '';
  S.apps.forEach((a, i) => {
    const t = el('div', 'tile', `<div class="shadow"></div>${tileFace(a)}<div class="gloss"></div><div class="name">${esc(a.name)}</div>`,
      () => launch(a.id));
    t.dataset.id = a.id;
    t.dataset.row = Math.floor(i / 5);
    t.style.setProperty('--i', i);
    t.addEventListener('nv-focus', () => onTileFocus(a, t));
    grid.appendChild(t);
  });
  if (S.screen === 'home') {
    const again = keep && $(`#grid .tile[data-id="${CSS.escape(keep)}"]`);
    setFocus(again || $('#grid .tile'));
  }
}

function onTileFocus(app, tile) {
  if (S.artApp !== app.id) {
    S.artApp = app.id;
    S.artFlip = !S.artFlip;
    const on = S.artFlip ? $('#art-a') : $('#art-b');
    const off = S.artFlip ? $('#art-b') : $('#art-a');
    on.style.setProperty('--c1', app.c1 || '#333');
    on.style.setProperty('--c2', app.c2 || '#111');
    on.style.setProperty('--fg-art', app.fg || '#fff');
    const img = app.icon && /^(https?:|data:|\/)/.test(app.icon);
    on.dataset.word = img ? '' : (app.label || app.name);
    on.classList.toggle('has-logo', !!img);
    on.style.setProperty('--logo', img ? `url("${app.icon}")` : 'none');
    on.classList.add('on');
    off.classList.remove('on');
    const ts = $('#topshelf');
    $('#ts-kicker').textContent = app.type === 'system' ? 'NovaTV' : (hostOf(app.url) || 'App');
    $('#ts-title').textContent = app.name;
    $('#ts-tag').textContent = app.tagline || '';
    ts.classList.remove('swap'); void ts.offsetWidth; ts.classList.add('swap');
  }
  const row = +tile.dataset.row;
  const home = $('#home');
  const wrap = $('#grid-wrap');
  if (row === 0) {
    wrap.style.transform = '';
    home.classList.remove('scrolled');
  } else {
    wrap.style.transform = `translateY(${-(61 * rem() + tile.offsetTop - 36 * rem())}px)`;
    home.classList.add('scrolled');
  }
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

function showHome(entering) {
  setScreen('home');
  if (entering) {
    document.body.classList.add('entering');
    setTimeout(() => document.body.classList.remove('entering'), 1800);
  }
  const first = $('#grid .tile');
  if (!S.focus || !$('#home').contains(S.focus)) setFocus(first);
  else setFocus(S.focus);
  maybeShowPairCard();
}

function setScreen(name) {
  for (const s of ['home', 'settings', 'setup', 'eq', 'library']) $(`#${s}`).classList.toggle('hidden', s !== name);
  S.screen = name;
}

function goHome() {
  closeAlert(true);
  if (S.saver) hideSaver();
  if (S.screen === 'setup' && !S.settings.setup_done) return; // finish setup first
  if (S.screen !== 'home') { showHome(); return; }
  const first = $('#grid .tile');
  if (first) setFocus(first, 'up');
}

function launch(id) {
  const app = S.apps.find((a) => a.id === id);
  if (!app) return;
  if (app.type === 'system') { if (id === 'library') openLibrary(); else openSettings(); return; }
  send({ t: 'launch', id });
}

/* tile zooms to full screen, like opening an app on Apple TV */
function playLaunch(id) {
  if (S.screen !== 'home') return;
  const tile = $(`#grid .tile[data-id="${CSS.escape(id)}"]`);
  const app = S.apps.find((a) => a.id === id);
  if (!tile || !app) return;
  if (S.focus !== tile) setFocus(tile);
  const L = $('#launch');
  const r = tile.getBoundingClientRect();
  L.innerHTML = tileFace(app);
  L.className = '';
  L.style.cssText = `display:block;left:0;top:0;width:${innerWidth}px;height:${innerHeight}px;` +
    `clip-path:inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px round ${2 * rem()}px)`;
  const mark = $('.wm, .glyph, img', L);
  const dx = r.left + r.width / 2 - innerWidth / 2, dy = r.top + r.height / 2 - innerHeight / 2;
  if (mark) mark.style.transform = `translate(${dx}px, ${dy}px)`;
  L.dataset.tile = JSON.stringify([r.top, r.right, r.bottom, r.left, dx, dy]);
  void L.offsetWidth;
  L.style.transition = 'clip-path .45s cubic-bezier(.5,0,.15,1)';
  L.style.clipPath = 'inset(0 0 0 0 round 0)';
  if (mark) {
    mark.style.transition = 'transform .45s cubic-bezier(.5,0,.15,1), opacity .5s .25s';
    mark.style.transform = 'translate(0,0) scale(1.8)';
  }
  S.launchedAt = Date.now();
  setTimeout(() => { if (document.visibilityState === 'visible' && Date.now() - S.launchedAt > 5000) closeLaunch(); }, 6000);
}

function closeLaunch() {
  const L = $('#launch');
  if (L.style.display !== 'block') return;
  const [t, r, b, l, dx, dy] = JSON.parse(L.dataset.tile || '[0,0,0,0,0,0]');
  const mark = $('.wm, .glyph, img', L);
  L.style.transition = 'clip-path .5s cubic-bezier(.3,.8,.25,1), opacity .25s .35s';
  L.style.clipPath = `inset(${t}px ${innerWidth - r}px ${innerHeight - b}px ${l}px round ${2 * rem()}px)`;
  L.style.opacity = '0';
  if (mark) { mark.style.transition = 'transform .5s cubic-bezier(.3,.8,.25,1)'; mark.style.transform = `translate(${dx}px, ${dy}px)`; }
  setTimeout(() => { L.style.display = 'none'; L.style.opacity = ''; }, 650);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    S.lastInput = Date.now();
    if (S.screen !== 'home' && S.settings.setup_done && !['settings', 'eq'].includes(S.screen)) showHome();
    setTimeout(closeLaunch, 60);
    tick();
  }
});

/* ---------- status bar + pairing card */
function updateStatus() {
  const chip = $('#remote-chip');
  if (S.info.ip) {
    chip.innerHTML = `${I.phone}<span>${esc(S.info.ip)}</span>`;
    chip.classList.remove('hidden');
  } else chip.classList.add('hidden');
  $('#net-icon').innerHTML = S.info.ip ? I.wifi : `<span style="opacity:.35">${I.wifi}</span>`;
  $('#pc-url').textContent = S.info.ip ? `http://${S.info.ip}` : 'connecting…';
  $('#pc-code').textContent = fmtCode(S.info.pair_code);
}
const fmtCode = (c) => (c ? `${c.slice(0, 3)} ${c.slice(3)}` : '');

function qrSrc() { return `/api/qr.svg?kind=pair&ip=${encodeURIComponent(S.info.ip || '')}&c=${S.info.pair_code || ''}&t=${Date.now()}`; }
function refreshQR() {
  updateStatus();
  $$('img.qr').forEach((img) => (img.src = qrSrc()));
  $('#pc-qr').src = qrSrc();
}

function maybeShowPairCard() {
  if (S.pairDismissed || S.remotes > 0 || !S.info.ip) return;
  const card = $('#pair-card');
  $('#pc-qr').src = qrSrc();
  card.classList.remove('hidden', 'out', 'success');
}
function hidePairCard() {
  S.pairDismissed = true;
  const card = $('#pair-card');
  card.classList.add('out');
  setTimeout(() => card.classList.add('hidden'), 500);
}
function onRemoteConnected() {
  toast('Remote connected', true);
  const ok = $('.qr-big');
  if (ok) ok.classList.add('success');
  if (!$('#pair-card').classList.contains('hidden')) {
    $('#pair-card').classList.add('success');
    setTimeout(hidePairCard, 900);
  }
  if (S.onRemote) S.onRemote();
}

/* ---------- clock + screensaver */
function tick() {
  const now = new Date();
  const h12 = ['US', 'CA', 'AU'].includes(S.settings.country);
  const t = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: h12 });
  $('#clock').textContent = t;

}
setInterval(tick, 5000);
tick();

setInterval(() => {
  const mins = +S.settings.screensaver_minutes || 0;
  if (!S.saver && mins > 0 && ['home', 'settings'].includes(S.screen) && document.visibilityState === 'visible' && !S.info.active_app &&
      $('#alert').classList.contains('hidden') && Date.now() - S.lastInput > mins * 60000) showSaver();
}, 5000);

let saverClock = 0, saverDrift = 0;
function saverTick() {
  const now = new Date();
  const h12 = ['US', 'CA', 'AU'].includes(S.settings.country);
  let hm = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: h12 });
  $('#saver-hm').textContent = hm.replace(/\s?[AP]M$/i, '');
  $('#saver-sec').textContent = String(now.getSeconds()).padStart(2, '0');
  $('#saver-date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
function showSaver() {
  S.saver = true;
  const sv = $('#saver');
  sv.classList.toggle('black', S.settings.screensaver_style === 'black');
  sv.classList.remove('hidden', 'leave');
  void sv.offsetWidth;
  sv.classList.add('show');
  $('#saver-wrap').style.transform = 'translate(-50%, -50%)';
  saverTick();
  clearInterval(saverClock); clearInterval(saverDrift);
  saverClock = setInterval(saverTick, 1000);
  // move the clock a little every minute so nothing burns into an OLED screen
  saverDrift = setInterval(() => {
    const dx = (Math.random() - 0.5) * 8 * rem(), dy = (Math.random() - 0.5) * 6 * rem();
    $('#saver-wrap').style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }, 60000);
}
function hideSaver() {
  S.saver = false;
  S.lastInput = Date.now();
  clearInterval(saverClock); clearInterval(saverDrift);
  const sv = $('#saver');
  sv.classList.remove('show');
  sv.classList.add('leave');
  setTimeout(() => { if (!S.saver) sv.classList.add('hidden'); }, 450);
}

/* ---------- HUD + toast */
let hudT, toastT;
function showVolume(v) {
  if (document.visibilityState !== 'visible') return;
  const hud = $('#hud');
  const level = v.muted ? 0 : v.level;
  const bt = v.bluetooth ?? S.audio.active_bluetooth;
  const icon = $('.hud-icon', hud);
  icon.className = 'hud-icon' + (v.muted ? ' muted' : bt ? ' bt' : '');
  icon.innerHTML = v.muted ? I.mute : bt ? I.bluetooth : I.speaker;
  $('.hud-name', hud).textContent = v.output || S.audio.active_name || 'TV';
  $('.bar i', hud).style.width = `${level}%`;
  $('.hud-num', hud).textContent = v.muted ? '' : level;
  hud.classList.add('on');
  clearTimeout(hudT);
  hudT = setTimeout(() => hud.classList.remove('on'), 2200);
}
function toast(text, ok) {
  const t = $('#toast');
  t.innerHTML = `${ok ? I.check : ''}<span>${esc(text)}</span>`;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 2600);
}

/* ---------- alert (confirmations) */
function alertBox(title, text, buttons) {
  S.alertPrev = S.focus;
  const a = $('#alert');
  a.innerHTML = '';
  const box = el('div', 'alert-box', `<h2>${esc(title)}</h2><p>${esc(text)}</p>`);
  buttons.forEach((b, i) => {
    const btn = el('div', `btn ${b.danger ? 'danger' : ''} ${i === 0 ? 'default' : ''}`, esc(b.label), () => { closeAlert(); b.act && b.act(); });
    box.appendChild(btn);
  });
  a.appendChild(box);
  a.classList.remove('hidden');
  focusFirst(a);
}
function closeAlert(silent) {
  const a = $('#alert');
  if (a.classList.contains('hidden')) return;
  a.classList.add('hidden');
  a.innerHTML = '';
  if (!silent && S.alertPrev && S.alertPrev.isConnected) setFocus(S.alertPrev);
}

/* ================================================================ settings */
function openSettings() {
  if (!S.settings.setup_done) return;
  api('/api/cooling').then((c) => { S.cooling = c; if (S.screen === 'settings' && S.stack.at(-1) === 'root') renderSettings(true); }).catch(() => {});
  if (!S.layouts) api('/api/layouts').then((l) => { S.layouts = l; if (S.screen === 'settings') renderSettings(true); }).catch(() => {});
  S.stack = ['root'];
  setScreen('settings');
  $('#settings').classList.remove('enter'); void $('#settings').offsetWidth; $('#settings').classList.add('enter');
  renderSettings();
}
function settingsBack() {
  if (S.stack[S.stack.length - 1] === 'bluetooth') api('/api/bt/scan', { on: false }).catch(() => {});
  S.stack.pop();
  if (!S.stack.length) { showHome(); return; }
  renderSettings();
}
function pushPage(p) { S.stack.push(p); renderSettings(); }

const SS_OPTS = [0, 2, 5, 10, 15, 30];
const ssLabel = (m) => (m ? `${m} min` : 'Never');

function settingsPages() {
  const s = S.settings, url = S.info.ip ? `http://${S.info.ip}` : 'Not connected';
  return {
    root: {
      title: 'Settings', icon: I.gear,
      rows: [
        { label: 'Remote', value: S.remotes ? `${S.remotes} connected` : 'Pair a phone', act: () => pushPage('remote') },
        { label: 'Network', value: S.info.ip || 'Offline', act: () => pushPage('network') },
        { label: 'Audio & Bluetooth', value: S.audio.active_name || 'TV', act: () => pushPage('audio') },
        { label: 'Resolution', value: (S.display && S.display.current) || '1080p · 60 Hz', act: () => openResolutions() },
        { label: 'TV Remote (HDMI-CEC)', value: s.cec_enabled === false ? 'Off' : 'On', act: () => openCec() },
        { label: 'Device Name', value: s.device_name, act: () => openSetupStep('name', 'settings') },
        { label: 'Keyboard Layout', value: (S.layouts || {})[s.keyboard] || s.keyboard, act: () => pushPage('keyboard') },
        { label: 'Screen Saver', value: ssLabel(s.screensaver_minutes), act: () => pushPage('saver') },
        { label: 'Apps Kept Open in Background', value: String(s.keep_background), act: () => cycle('keep_background', [0, 1, 2, 3]) },
        { heading: 'System' },
        { label: 'Cooling & Fan', value: coolSummary(), act: () => openCooling() },
        { label: 'About', act: () => pushPage('about') },
        { label: 'Restart Interface', act: () => confirmSys('restart-ui', 'Restart Interface?', 'The home screen and browser restart. Takes a few seconds.', 'Restart Interface') },
        { label: 'Restart', act: () => confirmSys('reboot', 'Restart NovaTV?', 'Your apps and settings are kept.', 'Restart') },
        { label: 'Shut Down', danger: true, act: () => confirmSys('poweroff', 'Shut Down?', 'Unplug and replug the power to turn it back on.', 'Shut Down', true) },
      ],
    },
    remote: {
      title: 'Phone Remote', qr: true,
      sub: `Scan the code with your phone's camera, or open ${url} and enter the code.`,
      rows: [
        { label: 'Address', value: url, static: true },
        { label: 'Pairing Code', value: fmtCode(S.info.pair_code), static: true },
        { label: 'Phones Connected', value: String(S.remotes), static: true },
        { label: 'Forget All Phones', danger: true, act: () => alertBox('Forget All Phones?', 'Every paired phone is signed out and a new code is created.', [
          { label: 'Cancel' },
          { label: 'Forget All', danger: true, act: async () => { await api('/api/repair', {}); toast('New pairing code created', true); } }]) },
      ],
    },
    network: {
      title: 'Network', icon: I.wifi,
      rows: [
        { label: 'IP Address', value: S.info.ip || 'Not connected', static: true },
        { label: 'Hostname', value: `${S.info.hostname || 'novatv'}.local`, static: true },
        { label: 'Choose Wi-Fi Network', act: () => openSetupStep('network', 'settings') },
      ],
    },
    audio: {
      title: 'Audio & Bluetooth', icon: I.audio,
      rows: [
        { label: 'Volume', value: `${S.audio.volume ? (S.audio.volume.muted ? 'Muted' : S.audio.volume.level + '%') : '—'}`, static: true },
        { label: 'Sound Output', value: S.audio.active_name || 'TV', act: () => pushPage('outputs') },
        { label: 'Bluetooth Speakers & Headphones', value: btSummary(), act: () => { pushPage('bluetooth'); api('/api/bt/scan', { on: true }).catch(() => {}); } },
        { label: 'Equalizer', value: S.audio.eq && !S.audio.eq.enabled ? 'Off' : (S.audio.preset || 'Flat'), act: () => openEq() },
      ],
    },
    outputs: {
      title: 'Sound Output', icon: I.speaker,
      sub: 'Automatic plays on a Bluetooth speaker as soon as one is connected, otherwise on the TV.',
      rows: [
        { label: 'Automatic', value: S.audio.output_mode === 'auto' ? '✓' : '', act: () => setOutput('auto') },
        ...(S.audio.outputs || []).map((o) => ({
          label: o.description, value: S.audio.output_mode === o.name ? '✓' : (S.audio.active === o.name ? 'Playing' : ''),
          act: () => setOutput(o.name),
        })),
      ],
    },
    bluetooth: btPage(),
    cec: {
      title: 'TV Remote', icon: I.remote,
      sub: "Control NovaTV with your TV's own remote. Switch on HDMI-CEC in the TV's settings: Anynet+ (Samsung), SimpLink (LG), Bravia Sync (Sony), EasyLink (Philips) or VIERA Link (Panasonic).",
      rows: [
        { label: 'Status', value: !S.cec ? 'Checking…' : !S.cec.enabled ? 'Off' : S.cec.connected ? `Connected${S.cec.tv ? ` to ${S.cec.tv}` : ''}${S.cec.port ? ` · ${S.cec.port}` : ''}` : (S.cec.error || 'No TV found'), static: true },
        { label: 'Use TV Remote', value: s.cec_enabled === false ? 'Off' : 'On', act: () => setCec({ cec_enabled: s.cec_enabled === false }) },
        { label: 'Switch TV to NovaTV on Start', value: s.cec_autoswitch === false ? 'Off' : 'On', act: () => setCec({ cec_autoswitch: s.cec_autoswitch === false }) },
        { label: 'Switch TV to NovaTV Now', act: () => setCec({ tv: 'switch' }) },
        { label: 'Turn Off TV', act: () => setCec({ tv: 'off' }) },
      ],
    },
    resolutions: {
      title: 'Resolution', icon: I.tv,
      sub: 'Pick what your TV can show. 4K is the sharpest; 1080p is the smoothest to navigate. Apps and the interface follow automatically.',
      rows: S.display && S.display.modes.length ? [
        { label: `Automatic${S.display.best ? ` (${S.display.best})` : ''}`, value: S.display.setting === 'auto' ? '✓' : '', act: () => chooseMode('auto') },
        ...S.display.modes.map((m) => ({
          label: m.label, value: m.current ? (S.display.setting === 'auto' ? 'Current' : '✓') : '', act: () => chooseMode(m.id),
        })),
      ] : [{ label: S.display ? 'No TV information available' : 'Reading the TV’s modes…', value: '', static: true }],
    },
    saver: {
      title: 'Screen Saver', icon: I.tv,
      sub: 'A calm clock appears when nothing happens on the home screen. Any button wakes the TV.',
      rows: [
        { label: 'Start After', value: ssLabel(s.screensaver_minutes), act: () => cycle('screensaver_minutes', SS_OPTS) },
        { label: 'Style', value: s.screensaver_style === 'black' ? 'Black' : 'Dark Gradient', act: () => cycleStyle() },
        { label: 'Preview', act: () => showSaver() },
      ],
    },
    keyboard: {
      title: 'Keyboard Layout', icon: I.keyboard,
      sub: 'For a USB keyboard. The interface restarts to apply the change.',
      rows: Object.entries(S.layouts || {}).map(([code, name]) => ({
        label: name, value: code === s.keyboard ? '✓' : '',
        act: async () => {
          if (code === s.keyboard) return;
          const r = await api('/api/settings', { keyboard: code }).catch(() => ({}));
          toast(r.restart ? 'Restarting with the new layout…' : 'Saved', true);
        },
      })),
    },
    cooling: coolPage(),
    about: {
      title: 'NovaTV', icon: I.spark,
      rows: [
        { label: 'Version', value: S.info.version, static: true },
        { label: 'Name', value: s.device_name, static: true },
        { label: 'IP Address', value: S.info.ip || '—', static: true },
        { label: 'Browser Engine', value: S.info.browser ? 'Chromium · running' : 'Chromium · starting', static: true },
        { label: 'DRM', value: 'Widevine L3', static: true },
        { label: 'Country', value: s.country || '—', static: true },
      ],
    },
  };
}

/* ---------- cooling (CPU temperature + Pi 5 fan) */
const FAN_PROFILES = [
  ['quiet', 'Quiet', 'Fan from 55 °C'],
  ['balanced', 'Balanced', 'Fan from 50 °C'],
  ['cool', 'Cool', 'Fan from 40 °C'],
  ['max', 'Always On', 'Fan always running'],
];
function coolSummary() {
  const c = S.cooling;
  if (!c || c.temp == null) return '';
  return `${Math.round(c.temp)} °C${c.fan ? (c.rpm ? ` · ${c.rpm} RPM` : ' · fan idle') : ''}`;
}
function fanText(c) {
  if (!c) return '…';
  if (!c.fan) return 'No fan found';
  if (c.rpm > 0) return `${c.rpm} RPM · ${c.pwm}%`;
  if (c.pwm > 0) return 'Not spinning: is the fan plugged in?';
  return 'Idle (cool enough)';
}
function coolStatus(c) {
  if (!c) return '…';
  const now = c.throttled.now, past = c.throttled.since_boot;
  if (now.includes('undervoltage')) return 'Power supply too weak';
  if (now.includes('temp_limit') || now.includes('throttled')) return 'Too hot: slowing down';
  if (past.includes('undervoltage')) return 'OK (power dipped earlier)';
  if (past.includes('temp_limit') || past.includes('throttled')) return 'OK (was hot earlier)';
  return 'OK';
}
function coolPage() {
  const c = S.cooling;
  const prof = c ? c.profile : S.settings.fan_profile;
  return {
    title: 'Cooling & Fan', icon: I.fan,
    sub: c && c.pending
      ? 'The new fan profile is saved and is used from the next restart.'
      : 'The fan on the Pi 5 fan connector (the official Active Cooler or a case fan) speeds up automatically as NovaTV gets warmer.',
    rows: [
      { label: 'Temperature', value: c && c.temp != null ? `${c.temp.toFixed(1)} °C` : '…', static: true },
      { label: 'Fan', value: fanText(c), static: true },
      { label: 'Status', value: coolStatus(c), static: true },
      { heading: 'Fan Profile' },
      ...FAN_PROFILES.map(([id, name, desc]) => ({ label: name, value: prof === id ? '✓' : desc, act: () => setFan(id) })),
      ...(c && c.pending ? [{ label: 'Restart Now', act: () => confirmSys('reboot', 'Restart NovaTV?', 'Your apps and settings are kept.', 'Restart') }] : []),
    ],
  };
}
let coolT;
function openCooling() {
  pushPage('cooling');
  clearInterval(coolT);
  const tick = async () => {
    if (S.screen !== 'settings' || S.stack.at(-1) !== 'cooling') { clearInterval(coolT); return; }
    try { S.cooling = await api('/api/cooling'); } catch (e) { return; }
    if (S.screen === 'settings' && S.stack.at(-1) === 'cooling') renderSettings(true);
  };
  tick();
  coolT = setInterval(tick, 2000);
}
async function setFan(id) {
  try { S.cooling = await api('/api/cooling', { profile: id }); } catch (e) { toast('Could not save'); return; }
  renderSettings(true);
  toast(S.cooling.pending ? 'Saved. Used from the next restart.' : 'Fan profile changed', true);
}

async function cycleStyle() {
  const val = S.settings.screensaver_style === 'black' ? 'gradient' : 'black';
  S.settings.screensaver_style = val;
  renderSettings(true);
  try { S.settings = await api('/api/settings', { screensaver_style: val }); } catch (e) { toast('Could not save'); }
}

async function cycle(key, opts) {
  const cur = opts.indexOf(+S.settings[key]);
  const val = opts[(cur + 1) % opts.length];
  S.settings[key] = val;
  renderSettings(true);
  try { S.settings = await api('/api/settings', { [key]: val }); } catch (e) { toast('Could not save'); }
}

function confirmSys(action, title, text, label, danger) {
  alertBox(title, text, [{ label: 'Cancel' }, { label, danger, act: () => api(`/api/system/${action}`, {}).catch(() => {}) }]);
}

function renderSettings(keepFocus) {
  const pageName = S.stack[S.stack.length - 1];
  const page = settingsPages()[pageName];
  const icon = $('#set-icon');
  icon.className = 'set-icon' + (page.qr ? ' qr' : '');
  icon.innerHTML = page.qr ? `<img class="qr" src="${qrSrc()}" alt="">` : page.icon;
  $('#set-title').textContent = page.title;
  let sub = $('.set-sub');
  if (page.sub) {
    if (!sub) { sub = el('div', 'set-sub'); $('.set-left').appendChild(sub); }
    sub.textContent = page.sub;
  } else if (sub) sub.remove();
  const idx = keepFocus && S.focus ? $$('.set-list .focusable').indexOf(S.focus) : -1;
  const list = $('#set-list');
  list.className = 'set-list' + (keepFocus ? '' : ' list-anim');
  list.style.position = 'relative';
  list.innerHTML = '';
  page.rows.forEach((r, i) => {
    let row;
    if (r.heading) row = el('div', 'row heading', esc(r.heading));
    else if (r.static) row = el('div', 'row static', `<span class="label">${esc(r.label)}</span><span class="value">${esc(r.value)}</span>`);
    else row = el('div', `row${r.danger ? ' danger' : ''}`,
      `<span class="label">${esc(r.label)}</span>${r.value != null ? `<span class="value">${esc(r.value)}</span>` : ''}${I.chevron}`, r.act);
    row.style.setProperty('--i', i);
    list.appendChild(row);
  });
  const rows = $$('.focusable', list);
  setFocus(rows[idx >= 0 ? idx : 0]);
}

/* ================================================================ setup */
const SETUP_FLOW = ['hello', 'country', 'network', 'name', 'remote', 'done'];
let setupCtx = { step: 'hello', from: 'setup' };

function openSetup() {
  setScreen('setup');
  const resume = S.settings.setup_resume;
  if (resume && STEPS[resume]) {
    showStep(resume);
    api('/api/settings', { setup_resume: '' }).catch(() => {});
  } else showStep('hello');
}
function openSetupStep(step, from) {
  setupCtx.from = from;
  setScreen('setup');
  showStep(step);
}

function nextStep() {
  if (setupCtx.from === 'settings') { setScreen('settings'); renderSettings(); return; }
  const cur = ['password', 'joining'].includes(setupCtx.step) ? 'network' : setupCtx.step;
  const i = SETUP_FLOW.indexOf(cur);
  showStep(SETUP_FLOW[Math.min(i + 1, SETUP_FLOW.length - 1)]);
}

function setupBack() {
  const step = setupCtx.step;
  if (step === 'password' || step === 'joining') { showStep('network', true); return; }
  if (setupCtx.from === 'settings') { setScreen('settings'); renderSettings(); return; }
  const i = SETUP_FLOW.indexOf(step);
  if (i > 0 && step !== 'done') showStep(SETUP_FLOW[i - 1], true);
}

function showStep(name, isBack, data) {
  clearInterval(S.helloTimer);
  const hq = document.querySelector('.hello-qr'); if (hq) hq.remove();
  S.onRemote = null;
  setupCtx.step = name;
  const stage = $('#setup-stage');
  stage.innerHTML = '';
  const node = STEPS[name](data || {});
  node.classList.add('step', isBack ? 'enter-back' : 'enter');
  stage.appendChild(node);
  const dots = $('#setup-dots');
  const flowIdx = SETUP_FLOW.indexOf(name === 'password' || name === 'joining' ? 'network' : name);
  dots.innerHTML = setupCtx.from === 'setup' && flowIdx > 0 && name !== 'done'
    ? SETUP_FLOW.slice(1, -1).map((_, i) => `<i class="${i === flowIdx - 1 ? 'on' : ''}"></i>`).join('') : '';
  focusFirst(node);
}

function field(placeholder, value, opts = {}) {
  const f = el('div', 'field', `<input type="${opts.password ? 'password' : 'text'}" spellcheck="false" autocomplete="off" placeholder="${esc(placeholder)}">` +
    (opts.password ? `<span class="eye">${I.eye}</span>` : ''), () => {});
  const inp = $('input', f);
  inp.value = value || '';
  if (opts.password) $('.eye', f).addEventListener('click', () => { inp.type = inp.type === 'password' ? 'text' : 'password'; inp.focus(); });
  if (opts.enter) f._enter = opts.enter;
  return f;
}

function spinner() { return el('div', 'spinner', Array.from({ length: 12 }, (_, i) => `<i style="transform:rotate(${i * 30}deg);animation-delay:${(i - 12) / 12}s"></i>`).join('')); }

function sigBars(signal) {
  const n = signal > 75 ? 4 : signal > 50 ? 3 : signal > 25 ? 2 : 1;
  return `<span class="sig">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
}

const GREETINGS = ['hello', 'hallo', 'bonjour', 'hola', 'ciao', 'olá', 'hej', 'こんにちは', 'привет', 'merhaba'];

const STEPS = {
  hello() {
    const n = el('div');
    n.innerHTML = `<div class="hello"></div><div class="hello-sub">Let's set up your NovaTV. Use a keyboard and mouse, or the arrow keys.</div>`;
    const h = $('.hello', n);
    let i = 0;
    const show = () => {
      h.innerHTML = `<span class="on">${esc(GREETINGS[i % GREETINGS.length])}</span>`;
      i++;
    };
    show();
    S.helloTimer = setInterval(show, 3000);
    const btn = el('div', 'btn default', 'Get Started', () => nextStep());
    const row = el('div', 'btn-row'); row.appendChild(btn); n.appendChild(row);
    // already online (Ethernet)? then the phone can drive the setup too
    if (S.info.ip) {
      const hint = el('div', 'hello-qr', `<img class="qr" src="${qrSrc()}" alt=""><div><b>No keyboard?</b><br>Scan to use your phone as the remote</div>`);
      document.getElementById('setup-stage').appendChild(hint);
    }
    return n;
  },

  country() {
    const n = el('div', '', `<div class="glyph-big">${I.globe}</div><h1>Country or Region</h1><p class="lead">This sets the time zone and the Wi-Fi radio rules for where you live.</p>`);
    const list = el('div', 'list'); list.style.position = 'relative';
    n.appendChild(list);
    api('/api/countries').then((cs) => {
      const cur = S.settings.country || 'BE';
      cs.forEach((c) => {
        const row = el('div', `row${c.code === cur ? ' default' : ''}`, `<span class="label">${esc(c.name)}</span>${c.code === S.settings.country ? I.check.replace('<svg', '<svg class="check"') : ''}`, async () => {
          row.innerHTML = `<span class="label">${esc(c.name)}</span>`;
          row.appendChild(spinner()).style.cssText = 'width:3rem;height:3rem;margin:0';
          let res = {};
          try { res = await api('/api/setup/country', { code: c.code }); S.settings.country = c.code; } catch (e) { /* keep going */ }
          if (res.restart) { showStep('applying'); return; }  // the interface restarts with the new keyboard layout
          nextStep();
        });
        list.appendChild(row);
      });
      focusFirst(list);
    });
    return n;
  },

  network() {
    const n = el('div', '', `<div class="glyph-big">${I.wifi}</div><h1>Choose a Network</h1><p class="lead">Connect to the internet to stream your apps.</p>`);
    const list = el('div', 'list'); list.style.position = 'relative';
    n.appendChild(list);
    list.appendChild(spinner());
    const load = async () => {
      let st = { ethernet: false, ip: null }, nets = [];
      try { st = await api('/api/net/status'); } catch (e) { /* ignore */ }
      try { nets = await api('/api/wifi/scan'); } catch (e) { /* ignore */ }
      if (setupCtx.step !== 'network') return;
      list.innerHTML = '';
      if (st.ethernet) {
        list.appendChild(el('div', 'row default', `<span class="ic">${I.ethernet}</span><span class="label">Ethernet</span><span class="value">Connected · ${esc(st.ip || '')}</span>${I.chevron}`, () => nextStep()));
      }
      nets.forEach((w) => {
        const row = el('div', `row${!st.ethernet && w.active ? ' default' : ''}`,
          `<span class="label">${esc(w.ssid)}</span>${w.active ? I.check.replace('<svg', '<svg class="check"') : ''}${w.secure ? `<span class="ic">${I.lock}</span>` : ''}${sigBars(w.signal)}`,
          () => {
            if (w.active) nextStep();
            else if (w.secure) showStep('password', false, { ssid: w.ssid });
            else join(w.ssid, '', false);
          });
        list.appendChild(row);
      });
      list.appendChild(el('div', 'row', `<span class="label">Other Network…</span>${I.chevron}`, () => showStep('password', false, { hidden: true })));
      list.appendChild(el('div', 'row', `<span class="label">Scan Again</span><span class="ic">${I.refresh}</span>`, () => showStep('network')));
      if (!nets.length && !st.ethernet) {
        list.prepend(el('div', 'row static', '<span class="label" style="color:var(--fg2)">No Wi-Fi networks found. Plug in an Ethernet cable or scan again.</span>'));
      }
      focusFirst(list);
    };
    load();
    return n;
  },

  password({ ssid, hidden, error }) {
    const n = el('div', '', `<div class="glyph-big">${I.lock}</div>` +
      `<h1>${hidden ? 'Other Network' : 'Enter Password'}</h1>` +
      `<p class="lead">${hidden ? 'Type the network name and password.' : `For “${esc(ssid)}”`}</p>`);
    let ssidField;
    const pw = field('Password', '', { password: true, enter: () => go() });
    if (hidden) {
      n.appendChild(el('div', 'field-label', 'Network Name'));
      ssidField = field('Network name', ssid || '', { enter: () => setFocus(pw) });
      ssidField.classList.add('default');
      n.appendChild(ssidField);
      n.appendChild(el('div', 'field-label', 'Password'));
    } else pw.classList.add('default');
    n.appendChild(pw);
    const err = el('div', 'err', esc(error || ''));
    n.appendChild(err);
    const go = () => {
      const name = hidden ? $('input', ssidField).value.trim() : ssid;
      const pass = $('input', pw).value;
      if (!name) { setFocus(ssidField); return; }
      if (pass && pass.length < 8) { err.textContent = 'Wi-Fi passwords are at least 8 characters.'; pw.classList.remove('shake'); void pw.offsetWidth; pw.classList.add('shake'); return; }
      join(name, pass, hidden);
    };
    const row = el('div', 'btn-row');
    row.appendChild(el('div', 'btn', 'Join', go));
    row.appendChild(el('div', 'btn subtle', 'Back', () => showStep('network', true)));
    n.appendChild(row);
    if (error) setTimeout(() => { pw.classList.add('shake'); }, 50);
    return n;
  },

  applying() {
    const n = el('div', '', `<div class="glyph-big">${I.keyboard}</div><h1>Setting Up Your Keyboard</h1><p class="lead">Matching the keyboard layout to your country. One moment…</p>`);
    n.appendChild(spinner());
    return n;
  },

  joining({ ssid }) {
    const n = el('div', '', `<h1>Joining “${esc(ssid)}”</h1><p class="lead">This can take up to half a minute.</p>`);
    n.appendChild(spinner());
    return n;
  },

  name() {
    const n = el('div', '', `<div class="glyph-big">${I.tv}</div><h1>Name Your TV</h1><p class="lead">This name shows on your phone remote.</p>`);
    const cur = S.settings.device_name && S.settings.device_name !== 'NovaTV' ? S.settings.device_name : 'Living Room';
    const save = async (name) => {
      name = (name || '').trim() || 'NovaTV';
      try { S.settings = await api('/api/settings', { device_name: name }); } catch (e) { /* ignore */ }
      nextStep();
    };
    const f = field('Living Room', cur, { enter: () => save($('input', f).value) });
    f.classList.add('default');
    n.appendChild(f);
    const chips = el('div', 'chips');
    ['Living Room', 'Bedroom', 'Kitchen', 'Office', 'Kids Room', 'Attic'].forEach((c) => {
      chips.appendChild(el('div', 'chip', esc(c), () => { $('input', f).value = c; save(c); }));
    });
    n.appendChild(chips);
    const row = el('div', 'btn-row');
    row.appendChild(el('div', 'btn', 'Continue', () => save($('input', f).value)));
    n.appendChild(row);
    return n;
  },

  remote() {
    const url = S.info.ip ? `http://${S.info.ip}` : '';
    const n = el('div', '', `<h1>Your Phone Is the Remote</h1><p class="lead">Point your phone's camera at the code. It opens the remote straight away, no app needed.</p>`);
    const qr = el('div', 'qr-big', `<img class="qr" src="${qrSrc()}" alt=""><div class="ok">${I.check}</div>`);
    n.appendChild(qr);
    n.appendChild(el('div', 'addr', url
      ? `${esc(url)}<small>or open this address and enter code <b class="code">${esc(fmtCode(S.info.pair_code))}</b></small>`
      : 'Waiting for network…'));
    const row = el('div', 'btn-row');
    row.appendChild(el('div', 'btn default', 'Continue', () => nextStep()));
    n.appendChild(row);
    S.onRemote = () => { qr.classList.add('success'); setTimeout(() => { if (setupCtx.step === 'remote') nextStep(); }, 1500); };
    refreshInfo().then(refreshQR);
    return n;
  },

  done() {
    const n = el('div', '', `<div class="done-spark">${I.spark}</div><h1>You're All Set</h1><p class="lead">Welcome to NovaTV. Press Home on the phone remote at any time to come back here.</p>`);
    const row = el('div', 'btn-row');
    row.appendChild(el('div', 'btn default', 'Start Watching', async () => {
      try { await api('/api/setup/done', {}); } catch (e) { /* ignore */ }
      S.settings.setup_done = true;
      S.pairDismissed = S.remotes > 0;
      showHome(true);
    }));
    n.appendChild(row);
    return n;
  },
};

async function join(ssid, password, hidden) {
  showStep('joining', false, { ssid });
  let res;
  try { res = await api('/api/wifi/connect', { ssid, password, hidden }); } catch (e) { res = { ok: false, error: 'Something went wrong. Try again.' }; }
  if (res.ok) {
    if (res.ip) S.info.ip = res.ip;
    await refreshInfo();
    refreshQR();
    toast(`Connected to ${ssid}`, true);
    nextStep();
  } else {
    showStep('password', true, { ssid, hidden, error: res.error || 'Could not join the network.' });
  }
}

/* ================================================================ boot */
connect();

/* ================================================================ audio + bluetooth */
function btSummary() {
  const c = (S.bt.devices || []).find((d) => d.connected);
  return c ? c.name : (S.bt.available === false ? 'Unavailable' : 'Not Connected');
}

const BUSY = { pairing: 'Pairing…', connecting: 'Connecting…', trusting: 'Connecting…', disconnecting: 'Disconnecting…', removing: 'Removing…' };

function btPage() {
  const devs = S.bt.devices || [];
  const mine = devs.filter((d) => d.paired), other = devs.filter((d) => !d.paired);
  const rows = [{ heading: 'My Devices' }];
  if (!mine.length) rows.push({ label: 'No paired speakers yet', value: '', static: true });
  mine.forEach((d) => rows.push({
    label: d.name, value: d.busy ? BUSY[d.busy] || '…' : d.connected ? 'Connected' : 'Not Connected',
    act: () => alertBox(d.name, d.connected ? 'Connected. Sound plays on this device.' : 'Paired, not connected.', [
      d.connected ? { label: 'Disconnect', act: () => api('/api/bt/disconnect', { mac: d.mac }) }
                  : { label: 'Connect', act: () => { toast(`Connecting to ${d.name}…`); api('/api/bt/connect', { mac: d.mac }); } },
      { label: 'Forget This Device', danger: true, act: () => api('/api/bt/forget', { mac: d.mac }) },
      { label: 'Cancel' },
    ]),
  }));
  rows.push({ heading: 'Other Devices' });
  other.forEach((d) => rows.push({
    label: d.name, value: d.busy ? BUSY[d.busy] || '…' : (d.icon || '').includes('head') ? 'Headphones' : 'Speaker',
    act: () => { toast(`Pairing with ${d.name}…`); api('/api/bt/pair', { mac: d.mac }); },
  }));
  rows.push(S.bt.scanning ? { label: 'Searching…', value: '', static: true }
                          : { label: 'Search Again', act: () => api('/api/bt/scan', { on: true }) });
  return {
    title: 'Bluetooth', icon: I.bluetooth,
    sub: 'Put your speaker or headphones in pairing mode (usually: hold the Bluetooth button), then pick it below.',
    rows,
  };
}

async function setOutput(name) {
  try { S.audio = { ...S.audio, ...(await api('/api/audio/output', { name })) }; } catch (e) { toast('That output is not available'); }
  renderSettings(true);
}

function refreshAudioViews() {
  const page = S.stack[S.stack.length - 1];
  if (S.screen === 'settings' && ['root', 'audio', 'outputs', 'bluetooth', 'resolutions'].includes(page)) renderSettings(true);
  if (S.screen === 'eq') renderEq(true);
}

/* ---------- equalizer screen */
const KNOBS = [['high', 'HI'], ['mid', 'MID'], ['low', 'LOW']];

function openEq() {
  S.eqFrom = S.screen;
  setScreen('eq');
  const eqEl = $('#eq');
  eqEl.classList.remove('enter'); void eqEl.offsetWidth; eqEl.classList.add('enter');
  renderEq();
}
function closeEq() {
  S.eqAdjust = null;
  if (S.eqFrom === 'settings') { setScreen('settings'); renderSettings(true); } else showHome();
}

function renderEq(keep) {
  const a = S.audio, eq = a.eq || { enabled: true, bands: Array(10).fill(0), low: 0, mid: 0, high: 0 };
  const focusKey = keep && S.focus ? S.focus.dataset.key : null;
  $('#eq-sub').innerHTML = `${a.active_bluetooth ? I.bluetooth : I.speaker}<span>Playing on ${esc(a.active_name || 'TV')}</span>`;
  const tog = $('#eq-toggle');
  tog.dataset.key = 'toggle';
  tog._act = () => sendEq({ enabled: !(S.audio.eq || {}).enabled });

  // presets
  const pr = $('#eq-presets');
  pr.innerHTML = '';
  const names = [...((a.presets || {}).builtin || []), ...((a.presets || {}).user || [])];
  names.forEach((n) => {
    const user = ((a.presets || {}).user || []).includes(n);
    const c = el('div', `chip${user ? ' user' : ''}`, esc(n), () => api('/api/audio/preset', { name: n }).catch(() => {}));
    c.dataset.key = `p:${n}`;
    pr.appendChild(c);
  });

  // knobs
  const mixer = $('#mixer');
  $$('.knob', mixer).forEach((k) => k.remove());
  KNOBS.forEach(([key, label]) => {
    const k = el('div', 'knob', `<div class="k-name">${label}</div>${EQ.knobSVG()}<div class="k-read"></div>`, () => startAdjust(k));
    k.dataset.key = key;
    k.dataset.kind = 'knob';
    mixer.appendChild(k);
    knobDrag(k, key);
  });

  // sliders
  const sl = $('#eq-sliders');
  sl.innerHTML = '';
  EQ.LABELS.forEach((lab, i) => {
    const b = el('div', 'band', `<div class="b-val"></div><div class="b-track"><div class="b-fill"></div><div class="b-thumb"></div></div><div class="b-freq">${lab}</div>`, () => startAdjust(b));
    b.dataset.key = `b${i}`;
    b.dataset.kind = 'band';
    b.dataset.band = i;
    sl.appendChild(b);
    sliderDrag(b, i);
  });

  // buttons
  const btns = $('#eq-btns');
  btns.innerHTML = '';
  const isUser = ((a.presets || {}).user || []).includes(a.preset);
  const mk = (label, key, act) => { const b = el('div', 'btn', label, act); b.dataset.key = key; btns.appendChild(b); };
  mk('Done', 'done', () => closeEq());
  mk('Save as Preset', 'save', () => savePresetPrompt());
  mk('Reset', 'reset', () => api('/api/audio/preset', { name: 'Flat' }));
  if (isUser) mk('Delete Preset', 'delete', () => alertBox(`Delete “${a.preset}”?`, '', [
    { label: 'Cancel' }, { label: 'Delete', danger: true, act: () => api('/api/audio/preset', { action: 'delete', name: a.preset }) }]));

  updateEq();
  const again = focusKey && $(`#eq [data-key="${CSS.escape(focusKey)}"]`);
  if (again) { setFocus(again); if (S.eqAdjust && S.eqAdjust.dataset.key === focusKey) { S.eqAdjust = again; again.classList.add('adjusting'); } }
  else setFocus($('#eq-sliders .band'));
}

function updateEq() {
  const a = S.audio, eq = a.eq;
  if (!eq) return;
  $('#eq').classList.toggle('off', !eq.enabled);
  const tog = $('#eq-toggle');
  tog.classList.toggle('on', eq.enabled);
  $('span', tog).textContent = eq.enabled ? 'On' : 'Off';
  $$('#eq-presets .chip').forEach((c) => c.classList.toggle('sel', c.dataset.key === `p:${a.preset}`));
  $$('#mixer .knob').forEach((k) => {
    const v = eq[k.dataset.key];
    EQ.setKnob(k, v);
    $('.k-read', k).textContent = EQ.fmt(v, true);
  });
  $$('#eq-sliders .band').forEach((b) => {
    const v = eq.bands[+b.dataset.band];
    const pct = (v - EQ.BAND_MIN) / (EQ.BAND_MAX - EQ.BAND_MIN);   // 0 bottom .. 1 top
    $('.b-thumb', b).style.top = `${(1 - pct) * 100}%`;
    const fill = $('.b-fill', b);
    fill.style.top = `${Math.min(50, (1 - pct) * 100)}%`;
    fill.style.bottom = `${Math.min(50, pct * 100)}%`;
    $('.b-val', b).textContent = `${v > 0 ? '+' : ''}${v.toFixed(0)}`;
  });
  EQ.draw($('#eq-curve'), eq, { glow: 18, width: 4 });
}

let eqSendT = 0;
function sendEq(upd) {
  // update locally right away, the server confirms and syncs the phone
  const eq = S.audio.eq;
  if ('band' in upd) eq.bands[upd.band] = upd.value;
  for (const k of ['low', 'mid', 'high', 'enabled']) if (k in upd) eq[k] = upd[k];
  S.audio.preset = 'Custom';
  updateEq();
  S.eqLocal = true;
  clearTimeout(eqSendT);
  eqSendT = setTimeout(() => { S.eqLocal = false; }, 400);
  send({ t: 'eq', ...upd });
}

function startAdjust(e) {
  if (S.eqAdjust) S.eqAdjust.classList.remove('adjusting');
  S.eqAdjust = e;
  e.classList.add('adjusting');
}
function stopAdjust() {
  if (S.eqAdjust) S.eqAdjust.classList.remove('adjusting');
  S.eqAdjust = null;
}
function nudge(e, dir) {
  const eq = S.audio.eq;
  if (e.dataset.kind === 'band') {
    const i = +e.dataset.band;
    sendEq({ band: i, value: Math.max(EQ.BAND_MIN, Math.min(EQ.BAND_MAX, Math.round(eq.bands[i] + dir))) });
  } else {
    const k = e.dataset.key, v = eq[k];
    const step = v < -6 || (v === -6 && dir < 0) ? 4 : 1;   // bigger steps towards "kill"
    sendEq({ [k]: Math.max(EQ.ISO_MIN, Math.min(EQ.ISO_MAX, v + dir * step)) });
  }
}
function eqAdjustKey(k) {
  const e = S.eqAdjust;
  if (k === 'up' || k === 'down') { nudge(e, k === 'up' ? 1 : -1); return true; }
  if (k === 'select' || k === 'back') { stopAdjust(); return true; }
  if (k === 'left' || k === 'right') {
    // hop to the neighbouring control and keep adjusting
    const all = [...$$('#mixer .knob'), ...$$('#eq-sliders .band')];
    const order = [all[2], all[1], all[0], ...all.slice(3)];   // LOW, MID, HI, then 31 Hz .. 16 kHz
    const i = order.indexOf(e) + (k === 'right' ? 1 : -1);
    if (order[i]) { setFocus(order[i]); startAdjust(order[i]); }
    return true;
  }
  return false;
}

/* mouse: drag sliders and knobs, scroll wheel adjusts */
function sliderDrag(b, i) {
  const track = $('.b-track', b);
  const setFromY = (y) => {
    const r = track.getBoundingClientRect();
    const pct = 1 - Math.max(0, Math.min(1, (y - r.top) / r.height));
    sendEq({ band: i, value: Math.round(EQ.BAND_MIN + pct * (EQ.BAND_MAX - EQ.BAND_MIN)) });
  };
  track.addEventListener('pointerdown', (e) => {
    setFocus(b); setFromY(e.clientY); track.setPointerCapture(e.pointerId);
    const mv = (ev) => setFromY(ev.clientY);
    const up = () => { track.removeEventListener('pointermove', mv); track.removeEventListener('pointerup', up); };
    track.addEventListener('pointermove', mv); track.addEventListener('pointerup', up);
  });
  b.addEventListener('wheel', (e) => { e.preventDefault(); nudge(b, e.deltaY < 0 ? 1 : -1); }, { passive: false });
}
function knobDrag(k, key) {
  const svg = $('svg', k);
  svg.addEventListener('pointerdown', (e) => {
    setFocus(k); svg.setPointerCapture(e.pointerId);
    let y0 = e.clientY, v0 = S.audio.eq[key];
    const mv = (ev) => {
      const d = (y0 - ev.clientY) / 6;   // 6 px per step
      const v = Math.max(EQ.ISO_MIN, Math.min(EQ.ISO_MAX, Math.round(v0 + (v0 + d < 0 ? d * 2 : d))));
      if (v !== S.audio.eq[key]) sendEq({ [key]: v });
    };
    const up = () => { svg.removeEventListener('pointermove', mv); svg.removeEventListener('pointerup', up); };
    svg.addEventListener('pointermove', mv); svg.addEventListener('pointerup', up);
  });
  svg.addEventListener('dblclick', () => sendEq({ [key]: 0 }));
  k.addEventListener('wheel', (e) => { e.preventDefault(); nudge(k, e.deltaY < 0 ? 1 : -1); }, { passive: false });
}

function savePresetPrompt() {
  S.alertPrev = S.focus;
  const a = $('#alert');
  a.innerHTML = '';
  const box = el('div', 'alert-box', '<h2>Save Preset</h2><p>Give your sound a name. You can type on your phone too.</p>');
  const save = async () => {
    const name = $('input', f).value.trim();
    if (!name) return;
    closeAlert(true);
    try { await api('/api/audio/preset', { action: 'save', name }); } catch (e) { toast('Choose another name'); }
    setFocus($('#eq [data-key="save"]'));
  };
  const f = field('My Sound', '', { enter: save });
  f.classList.add('default');
  box.appendChild(f);
  box.appendChild(el('div', 'btn', 'Save', save));
  box.appendChild(el('div', 'btn', 'Cancel', () => closeAlert()));
  a.appendChild(box);
  a.classList.remove('hidden');
  focusFirst(a);
}

/* ================================================================ display resolution */
async function openResolutions() {
  pushPage('resolutions');
  try { S.display = await api('/api/display'); } catch (e) { S.display = { modes: [] }; }
  if (S.stack[S.stack.length - 1] === 'resolutions') renderSettings(true);
}

async function chooseMode(id) {
  toast('Switching resolution…');
  try { await api('/api/display', { mode: id }); } catch (e) { toast("Your TV doesn't accept this mode"); }
}

let confirmTimer = 0;
function confirmDisplay(label, seconds) {
  let left = seconds;
  alertBox('Keep This Resolution?', '', [
    { label: 'Keep', act: () => { clearInterval(confirmTimer); api('/api/display/confirm', { keep: true }); } },
    { label: 'Go Back', act: () => { clearInterval(confirmTimer); api('/api/display/confirm', { keep: false }); } },
  ]);
  $('#alert').dataset.kind = 'display';
  const p = $('#alert p');
  const upd = () => { p.textContent = `${label}. Going back to the previous resolution in ${left} seconds.`; };
  upd();
  clearInterval(confirmTimer);
  confirmTimer = setInterval(() => { left--; if (left <= 0) { clearInterval(confirmTimer); closeAlertIf('display'); } else upd(); }, 1000);
}
function closeAlertIf(kind) {
  if ($('#alert').dataset.kind === kind) { $('#alert').dataset.kind = ''; closeAlert(); }
}

/* ================================================================ TV remote (HDMI-CEC) */
async function openCec() {
  pushPage('cec');
  try { S.cec = await api('/api/cec'); } catch (e) { S.cec = { enabled: false }; }
  if (S.stack[S.stack.length - 1] === 'cec') renderSettings(true);
}
async function setCec(body) {
  for (const k of ['cec_enabled', 'cec_autoswitch']) if (k in body) S.settings[k] = body[k];
  renderSettings(true);
  try { S.cec = await api('/api/cec', body); } catch (e) { toast('Could not change this'); }
  setTimeout(async () => { try { S.cec = await api('/api/cec'); if (S.stack[S.stack.length - 1] === 'cec') renderSettings(true); } catch (e) { /* ignore */ } }, 4000);
  if (S.stack[S.stack.length - 1] === 'cec') renderSettings(true);
}

/* ================================================================ app library + home screen editing */
async function openLibrary() {
  setScreen('library');
  const lib = $('#library');
  lib.classList.remove('enter'); void lib.offsetWidth; lib.classList.add('enter');
  try { S.catalog = await api('/api/catalog'); } catch (e) { S.catalog = { regions: [], apps: [] }; }
  S.libRegion = S.libRegion || 'INT';
  renderLibrary();
}

function renderLibrary(keepRegionFocus) {
  const c = S.catalog;
  const rg = $('#lib-regions');
  rg.innerHTML = '';
  c.regions.forEach((r) => {
    const n = c.apps.filter((a) => a.regions.includes(r.code)).length;
    const chip = el('div', `chip${r.code === S.libRegion ? ' sel' : ''}`, `${esc(r.name)} <span style="opacity:.5">${n}</span>`, () => {
      S.libRegion = r.code; renderLibrary(true);
    });
    chip.dataset.region = r.code;
    rg.appendChild(chip);
  });
  const web = el('div', 'chip add-web', `${I.plus}<span>Website</span>`, () => addWebsitePrompt());
  web.dataset.region = 'web';
  rg.appendChild(web);
  const grid = $('#lib-grid');
  grid.innerHTML = '';
  c.apps.filter((a) => a.regions.includes(S.libRegion)).forEach((a) => {
    const t = el('div', 'ltile', `<div class="face">${tileFace(a)}</div><div class="nm">${esc(a.name)}</div><div class="badge"></div>`, () => toggleLibraryApp(a, t));
    t.dataset.id = a.id;
    grid.appendChild(t);
  });
  markLibrary();
  $('#lib-scroll').scrollTop = 0;
  if (keepRegionFocus) setFocus($(`#lib-regions .chip[data-region="${S.libRegion}"]`));
  else setFocus($('#lib-grid .ltile') || $('#lib-regions .chip'));
}

const isOnHome = (id) => S.apps.some((a) => a.id === id);

function markLibrary() {
  $$('#lib-grid .ltile').forEach((t) => {
    const on = isOnHome(t.dataset.id);
    t.classList.toggle('added', on);
    $('.badge', t).innerHTML = on ? I.check : I.plus;
  });
}

async function toggleLibraryApp(a, tile) {
  const add = !isOnHome(a.id);
  tile.classList.remove('pop'); void tile.offsetWidth; tile.classList.add('pop');
  try {
    await api('/api/catalog', { id: a.id, add });
    toast(add ? `${a.name} added to Home` : `${a.name} taken off Home`, add);
  } catch (e) { toast('Could not change the Home Screen'); }
}

function tileMenu(id) {
  const app = S.apps.find((a) => a.id === id);
  if (!app) return;
  const tile = $(`#grid .tile[data-id="${CSS.escape(id)}"]`);
  if (tile) tile.classList.add('wiggle');
  const ids = S.apps.map((a) => a.id);
  const i = ids.indexOf(id);
  const move = async (d) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('/api/apps/order', { ids });
    setTimeout(() => { const t = $(`#grid .tile[data-id="${CSS.escape(id)}"]`); if (t) setFocus(t); }, 60);
  };
  const buttons = [
    { label: 'Move Left', act: () => move(-1) },
    { label: 'Move Right', act: () => move(1) },
  ];
  if (app.type !== 'system') {
    buttons.push({ label: 'Take Off Home Screen', danger: true,
      act: () => api(`/api/apps/${encodeURIComponent(id)}`, undefined, 'DELETE').then(() => toast(`${app.name} taken off Home`)) });
  }
  buttons.push({ label: 'Cancel' });
  alertBox(app.name, app.type === 'system' ? '' : 'You can add it back any time from Add Apps.', buttons);
  const stop = () => { const t = $(`#grid .tile[data-id="${CSS.escape(id)}"]`); if (t) t.classList.remove('wiggle'); };
  const obs = new MutationObserver(() => { if ($('#alert').classList.contains('hidden')) { stop(); obs.disconnect(); } });
  obs.observe($('#alert'), { attributes: true, attributeFilter: ['class'] });
}

/* add any website as an app (text tile; a logo can be added from the phone) */
const WEB_COLORS = [['#3a3a46', '#121218'], ['#1a98ff', '#0b2a4a'], ['#7b2cff', '#1d0550'], ['#ff2d55', '#4a0716'], ['#00c2c7', '#003c40'], ['#ff5a1f', '#4a1300']];
function addWebsitePrompt() {
  S.alertPrev = S.focus;
  const a = $('#alert');
  a.innerHTML = '';
  const box = el('div', 'alert-box', '<h2>Add a Website</h2><p>It opens fullscreen like an app. Add a logo later from the phone remote.</p>');
  const url = field('Web address, e.g. vrt.be/vrtnws', '', { enter: () => setFocus(name) });
  url.classList.add('default');
  $('input', url).type = 'url';
  const name = field('Name on the tile', '', { enter: () => save() });
  const save = async () => {
    let u = $('input', url).value.trim();
    if (!u) { setFocus(url); return; }
    let n = $('input', name).value.trim();
    if (!n) { try { n = new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').split('.')[0]; n = n.charAt(0).toUpperCase() + n.slice(1); } catch (e) { n = 'Website'; } }
    const [c1, c2] = WEB_COLORS[Math.floor(Math.random() * WEB_COLORS.length)];
    closeAlert(true);
    try { await api('/api/apps', { name: n, url: u, label: n, c1, c2, fg: '#ffffff' }); toast(`${n} added to Home`, true); } catch (e) { toast('Could not add this website'); }
    setFocus($('#lib-regions .add-web'));
  };
  box.appendChild(url);
  box.appendChild(name);
  box.appendChild(el('div', 'btn', 'Add to Home', save));
  box.appendChild(el('div', 'btn', 'Cancel', () => closeAlert()));
  a.appendChild(box);
  a.classList.remove('hidden');
  focusFirst(a);
}
