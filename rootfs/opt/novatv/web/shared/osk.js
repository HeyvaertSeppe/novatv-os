// NovaTV on-screen keyboard.
// Pops up when a text field gets focus (in the NovaTV interface and inside apps), driven with the
// TV remote / phone arrows + OK, or the mouse. Typing on a real keyboard hides it.
// Built with DOM APIs only (no innerHTML) so it also works on sites with Trusted Types / strict CSP.
(() => {
  if (window.top !== window || window.__novaOSK) return;

  const ABC = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '@'],
    ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '.', 'del'],
    ['sym', ',', 'space', '.com', 'next', 'done'],
  ];
  const SYM = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['!', '?', '#', '$', '%', '&', '*', '(', ')', '/'],
    ['-', '_', '+', '=', ':', ';', '"', "'", '€', '£'],
    ['[', ']', '{', '}', '<', '>', '\\', '|', '~', 'del'],
    ['abc', ',', 'space', '.', 'next', 'done'],
  ];
  const LABEL = { shift: '⇧', del: '⌫', sym: '#+=', abc: 'ABC', space: 'space', next: 'Next', done: 'Done' };
  const GROW = { space: 4, done: 1.8, next: 1.4, '.com': 1.4, sym: 1.3, abc: 1.3, shift: 1.3, del: 1.3 };

  let host, root, panel, preview, previewLabel, grid, rows = [], pos = [1, 0], mode = 'abc', caps = false;
  let open = false, target = null, hideTimer = 0;

  const css = `
    :host { all: initial; }
    .panel { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647; box-sizing: border-box;
      padding: calc(var(--u) * 22) calc(var(--u) * 140) calc(var(--u) * 28);
      background: linear-gradient(180deg, rgba(28,28,34,.86), rgba(12,12,16,.94));
      backdrop-filter: blur(40px) saturate(1.6); -webkit-backdrop-filter: blur(40px) saturate(1.6);
      box-shadow: 0 -20px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08);
      font-family: Inter, "SF Pro Display", system-ui, sans-serif; color: #f5f5f7;
      transform: translateY(105%); transition: transform .38s cubic-bezier(.2,.9,.25,1.05); pointer-events: auto; }
    .panel.on { transform: none; }
    .preview { display: flex; align-items: center; gap: calc(var(--u) * 20); height: calc(var(--u) * 66); margin-bottom: calc(var(--u) * 14);
      padding: 0 calc(var(--u) * 28); border-radius: calc(var(--u) * 18); background: rgba(255,255,255,.08); }
    .plabel { font-size: calc(var(--u) * 20); color: rgba(235,235,245,.5); font-weight: 600; white-space: nowrap; }
    .ptext { flex: 1; font-size: calc(var(--u) * 32); font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
    .ptext::after { content: ""; display: inline-block; width: calc(var(--u) * 3); height: calc(var(--u) * 34); margin-left: 2px;
      background: #7c8cff; vertical-align: middle; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .ptext.empty { color: rgba(235,235,245,.3); }
    .row { display: flex; gap: calc(var(--u) * 10); margin-top: calc(var(--u) * 10); }
    .key { flex: 1 1 0; height: calc(var(--u) * 68); border-radius: calc(var(--u) * 16); display: flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,.12); font-size: calc(var(--u) * 32); font-weight: 550; cursor: pointer; user-select: none;
      transition: transform .18s cubic-bezier(.2,.9,.25,1.2), background .12s, color .12s, box-shadow .18s; }
    .key.fn { background: rgba(255,255,255,.07); font-size: calc(var(--u) * 24); font-weight: 650; color: rgba(235,235,245,.85); }
    .key.done { background: #7c8cff; color: #fff; }
    .key.on { background: rgba(255,255,255,.3); }
    .key.focus { background: #f5f5f7; color: #111; transform: scale(1.1); box-shadow: 0 12px 30px rgba(0,0,0,.45); z-index: 1; }
    .key.press { transform: scale(.94); }
    .hint { margin-top: calc(var(--u) * 16); font-size: calc(var(--u) * 18); color: rgba(235,235,245,.4); text-align: center; }
  `;

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function build() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483647;pointer-events:none;';
    root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      el('style', null, root, css);
    }
    panel = el('div', 'panel', root);
    const pv = el('div', 'preview', panel);
    previewLabel = el('div', 'plabel', pv);
    preview = el('div', 'ptext', pv);
    grid = el('div', 'grid', panel);
    el('div', 'hint', panel, 'Arrows to move · OK to type · Back to close');
    (document.body || document.documentElement).appendChild(host);
    render();
  }

  function scale() {
    host.style.setProperty('--u', `${window.innerWidth / 1920}px`);
    panel.style.setProperty('--u', `${window.innerWidth / 1920}px`);
  }

  function render() {
    while (grid.firstChild) grid.firstChild.remove();
    rows = [];
    (mode === 'abc' ? ABC : SYM).forEach((r, ri) => {
      const row = el('div', 'row', grid);
      rows.push(r.map((k, ci) => {
        const fn = k.length > 1 && k !== '.com';
        const label = LABEL[k] || (k.length === 1 && caps && mode === 'abc' ? k.toUpperCase() : k);
        const b = el('div', `key${fn ? ' fn' : ''}${k === 'done' ? ' done' : ''}${k === 'shift' && caps ? ' on' : ''}`, row, label);
        b.style.flexGrow = GROW[k] || 1;
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); pos = [ri, ci]; focusKey(); press(); });
        return { k, b };
      }));
    });
    pos[0] = Math.min(pos[0], rows.length - 1);
    pos[1] = Math.min(pos[1], rows[pos[0]].length - 1);
    focusKey();
  }

  function focusKey() {
    rows.flat().forEach(({ b }) => b.classList.remove('focus'));
    const k = rows[pos[0]] && rows[pos[0]][pos[1]];
    if (k) k.b.classList.add('focus');
  }

  function move(dr, dc) {
    if (dc) {
      const n = rows[pos[0]].length;
      pos[1] = (pos[1] + dc + n) % n;
    } else {
      const nr = pos[0] + dr;
      if (nr < 0 || nr >= rows.length) return;
      const cur = rows[pos[0]][pos[1]].b.getBoundingClientRect();
      const cx = cur.left + cur.width / 2;
      let best = 0, bd = Infinity;
      rows[nr].forEach(({ b }, i) => {
        const r = b.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - cx);
        if (d < bd) { bd = d; best = i; }
      });
      pos = [nr, best];
    }
    focusKey();
  }

  // ---- editing the focused field
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  function editable(e) {
    if (!e || e.disabled || e.readOnly) return false;
    if (e.isContentEditable) return true;
    if (e.tagName === 'TEXTAREA') return true;
    if (e.tagName !== 'INPUT') return false;
    return ['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''].includes((e.getAttribute('type') || 'text').toLowerCase());
  }
  function insert(text) {
    const t = target && target.isConnected ? target : deepActive();
    if (!editable(t)) return;
    if (document.activeElement !== t && t.focus) t.focus();
    if (!document.execCommand('insertText', false, text)) {
      const proto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
      set.call(t, (t.value || '') + text);
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
    updatePreview();
  }
  function backspace() {
    const t = target && target.isConnected ? target : deepActive();
    if (!editable(t)) return;
    if (!document.execCommand('delete', false)) {
      const proto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(t, (t.value || '').slice(0, -1));
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
    updatePreview();
  }
  function enterKey(t) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const ok = t.dispatchEvent(new KeyboardEvent('keydown', opts));
    t.dispatchEvent(new KeyboardEvent('keypress', opts));
    t.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (ok && t.form && t.form.requestSubmit) {
      try { t.form.requestSubmit(); } catch (e) { /* ignore */ }
    }
  }
  function nextField() {
    const t = target;
    const all = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
      .filter((e) => editable(e) && e.offsetParent !== null);
    const i = all.indexOf(t);
    if (i >= 0 && all[i + 1]) { all[i + 1].focus(); return true; }
    return false;
  }

  function press() {
    const k = rows[pos[0]][pos[1]];
    k.b.classList.add('press');
    setTimeout(() => k.b.classList.remove('press'), 120);
    switch (k.k) {
      case 'shift': caps = !caps; render(); break;
      case 'sym': mode = 'sym'; render(); break;
      case 'abc': mode = 'abc'; render(); break;
      case 'del': backspace(); break;
      case 'space': insert(' '); break;
      case 'next': if (!nextField()) done(); break;
      case 'done': done(); break;
      default:
        insert(mode === 'abc' && caps ? k.k.toUpperCase() : k.k);
        if (caps && mode === 'abc') { caps = false; render(); }
    }
  }

  function done() {
    const t = target;
    hide();
    if (t && t.isConnected) enterKey(t);
  }

  function updatePreview() {
    if (!preview) return;
    const t = target;
    const v = t ? (t.isContentEditable ? t.textContent : t.value) || '' : '';
    const pw = t && t.tagName === 'INPUT' && (t.getAttribute('type') || '').toLowerCase() === 'password';
    preview.textContent = v ? (pw ? '•'.repeat(v.length) : v) : (t && t.getAttribute('placeholder')) || '';
    preview.classList.toggle('empty', !v);
    const label = t && (t.getAttribute('aria-label') || (t.labels && t.labels[0] && t.labels[0].textContent) || t.getAttribute('name') || '');
    previewLabel.textContent = pw ? 'Password' : (label || '').trim().slice(0, 30);
  }

  function show(t) {
    clearTimeout(hideTimer);
    build();
    scale();
    target = t;
    if (!open) { pos = [1, 0]; mode = 'abc'; caps = false; render(); }
    open = true;
    updatePreview();
    requestAnimationFrame(() => panel.classList.add('on'));
    document.documentElement.classList.add('nova-osk-open');
  }
  function hide() {
    open = false;
    target = null;
    if (panel) panel.classList.remove('on');
    document.documentElement.classList.remove('nova-osk-open');
  }

  // ---- events
  document.addEventListener('focusin', (e) => {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (editable(t)) {
      if (window.__novaOSKDisabled) return;
      show(t);
    }
  }, true);
  document.addEventListener('focusout', () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!editable(deepActive())) hide(); }, 150);
  }, true);
  document.addEventListener('input', () => { if (open) updatePreview(); }, true);
  window.addEventListener('resize', () => { if (host) scale(); });

  window.addEventListener('keydown', (e) => {
    if (!open || !e.isTrusted) return;
    const map = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    let handled = true;
    if (map[e.key]) move(...map[e.key]);
    else if (e.key === 'Enter') press();
    else if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') hide();
    else if (e.key.length === 1 && !/[0-9]/.test(e.key) && !e.ctrlKey && !e.metaKey) { hide(); handled = false; }  // real keyboard
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  window.__novaOSK = {
    isOpen: () => open,
    state: () => ({ open, mode, key: rows[pos[0]] && rows[pos[0]][pos[1]] ? rows[pos[0]][pos[1]].k : null }),
    back() { if (open) { hide(); return true; } return false; },
    show() { const t = deepActive(); if (editable(t)) { show(t); return true; } return false; },
    // remote keys while the keyboard is open (used for native apps such as Stremio)
    key(name) {
      if (!open) return false;
      const m = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
      if (m[name]) move(...m[name]);
      else if (name === 'select' || name === 'enter') press();
      else if (name === 'escape' || name === 'back') hide();
      else if (name === 'backspace') backspace();
      else if (/^[0-9]$/.test(name)) insert(name);
      else return false;
      return true;
    },
    // text from the phone into the focused field
    type(text) { const t = deepActive(); if (!editable(t)) return false; target = t; insert(String(text)); return true; },
  };
})();
