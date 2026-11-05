// NovaTV overlay, injected into every app tab.
// Draws the phone-trackpad pointer and the volume / notification pill.
// DOM APIs only (no innerHTML) so it works on sites with Trusted Types.
(() => {
  if (window.top !== window || window.__novatv) return;
  const NS = 'http://www.w3.org/2000/svg';
  let host, root, cursor, hud, hudTimer, cursorTimer;

  function el(tag, css, parent) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (parent) parent.appendChild(e);
    return e;
  }

  function ensure() {
    if (host && host.isConnected) return true;
    if (!document.documentElement) return false;
    host = el('div', 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;');
    root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);

    cursor = el('div', 'position:fixed;left:0;top:0;width:28px;height:28px;opacity:0;' +
      'transition:opacity .25s;will-change:transform;filter:drop-shadow(0 2px 6px rgba(0,0,0,.5));', root);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '28');
    const c1 = document.createElementNS(NS, 'circle');
    c1.setAttribute('cx', '14'); c1.setAttribute('cy', '14'); c1.setAttribute('r', '11');
    c1.setAttribute('fill', 'rgba(255,255,255,0.92)');
    c1.setAttribute('stroke', 'rgba(0,0,0,0.25)'); c1.setAttribute('stroke-width', '1');
    svg.appendChild(c1);
    cursor.appendChild(svg);

    hud = el('div', 'position:fixed;top:48px;right:56px;min-width:220px;padding:16px 22px;border-radius:22px;' +
      'background:rgba(30,30,34,.72);backdrop-filter:blur(30px) saturate(1.6);-webkit-backdrop-filter:blur(30px);' +
      'color:#fff;font:600 20px/1.2 Inter,system-ui,sans-serif;display:flex;align-items:center;gap:16px;' +
      'opacity:0;transform:translateY(-12px) scale(.96);transition:opacity .25s,transform .35s cubic-bezier(.2,.9,.3,1.2);' +
      'box-shadow:0 20px 50px rgba(0,0,0,.45);', root);
    return true;
  }

  document.addEventListener('mousemove', (e) => {
    if (!ensure()) return;
    cursor.style.transform = `translate(${e.clientX - 14}px, ${e.clientY - 14}px)`;
    cursor.style.opacity = '1';
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => (cursor.style.opacity = '0'), 2500);
  }, true);
  document.addEventListener('mousedown', () => {
    if (!cursor) return;
    cursor.animate([{ scale: 1 }, { scale: 0.75 }, { scale: 1 }], { duration: 220 });
  }, true);

  function speaker(level, muted) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '26'); svg.setAttribute('height', '26');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M4 9h4l5-4v14l-5-4H4z'); p.setAttribute('fill', '#fff');
    svg.appendChild(p);
    const w = document.createElementNS(NS, 'path');
    w.setAttribute('fill', 'none'); w.setAttribute('stroke', '#fff'); w.setAttribute('stroke-width', '2');
    w.setAttribute('stroke-linecap', 'round');
    w.setAttribute('d', muted ? 'M17 9l5 6M22 9l-5 6' : level > 50 ? 'M16 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12' : 'M16 8.5a5 5 0 010 7');
    svg.appendChild(w);
    return svg;
  }

  window.__novatv = {
    hud(kind, value) {
      if (!ensure()) return;
      while (hud.firstChild) hud.firstChild.remove();
      if (kind === 'volume') {
        const level = value.muted ? 0 : value.level;
        hud.appendChild(speaker(value.level, value.muted));
        const bar = el('div', 'flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.22);overflow:hidden;min-width:170px;', hud);
        el('div', `height:100%;width:${level}%;background:#fff;border-radius:4px;transition:width .2s;`, bar);
      } else {
        el('span', '', hud).textContent = String(value);
      }
      hud.style.opacity = '1';
      hud.style.transform = 'none';
      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => {
        hud.style.opacity = '0';
        hud.style.transform = 'translateY(-12px) scale(.96)';
      }, 1800);
    },
  };
})();
