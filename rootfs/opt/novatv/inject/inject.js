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

    hud = el('div', 'position:fixed;top:44px;right:60px;width:460px;padding:16px 26px 16px 18px;border-radius:36px;' +
      'background:rgba(44,44,52,.72);backdrop-filter:blur(40px) saturate(1.8);-webkit-backdrop-filter:blur(40px) saturate(1.8);' +
      'color:#fff;font:600 20px/1.2 Inter,system-ui,sans-serif;display:flex;align-items:center;gap:20px;' +
      'opacity:0;transform:translateY(-20px) scale(.94);transition:opacity .3s,transform .45s cubic-bezier(.2,.9,.25,1.15);' +
      'box-shadow:0 24px 60px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.1);', root);
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

  function icon(kind) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '28'); svg.setAttribute('height', '28');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#fff'); p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('d', kind === 'bt' ? 'M7 7l10 10-5 4.5V2.5L17 7 7 17'
      : kind === 'mute' ? 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6' : 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12');
    svg.appendChild(p);
    return svg;
  }

  window.__novatv = {
    hud(kind, value) {
      if (!ensure()) return;
      while (hud.firstChild) hud.firstChild.remove();
      if (kind === 'volume') {
        const level = value.muted ? 0 : value.level;
        const kindIcon = value.muted ? 'mute' : value.bluetooth ? 'bt' : 'spk';
        const bg = value.muted ? '#55555c' : value.bluetooth ? 'linear-gradient(150deg,#3d8bff,#6a5cff)' : 'linear-gradient(150deg,#ff8a3d,#ff3d7f)';
        const ic = el('div', `width:52px;height:52px;border-radius:50%;display:grid;place-items:center;flex:none;background:${bg};`, hud);
        ic.appendChild(icon(kindIcon));
        const body = el('div', 'flex:1;min-width:0;', hud);
        el('div', 'font-size:19px;color:rgba(235,235,245,.62);margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', body)
          .textContent = value.output || 'TV';
        const bar = el('div', 'height:12px;border-radius:10px;background:rgba(255,255,255,.16);overflow:hidden;', body);
        el('div', `height:100%;width:${level}%;background:#fff;border-radius:10px;transition:width .25s;`, bar);
        el('div', 'font-size:30px;font-weight:700;width:54px;text-align:right;font-variant-numeric:tabular-nums;', hud)
          .textContent = value.muted ? '' : String(level);
      } else {
        el('span', '', hud).textContent = String(value);
      }
      hud.style.opacity = '1';
      hud.style.transform = 'none';
      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => {
        hud.style.opacity = '0';
        hud.style.transform = 'translateY(-20px) scale(.94)';
      }, 2200);
    },
  };
})();
