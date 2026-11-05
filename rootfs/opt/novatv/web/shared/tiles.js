// Renders the face of an app tile. Used by the TV launcher and the phone remote.
window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.tileFace = (app) => {
  const style = `--c1:${esc(app.c1 || '#3a3a46')};--c2:${esc(app.c2 || '#111')};--tfg:${esc(app.fg || '#fff')}`;
  let inner;
  if (app.icon && /^(https?:|data:|\/)/.test(app.icon)) {
    inner = `<img class="custom" src="${esc(app.icon)}" alt="">`;
  } else if (app.icon && window.ICONS[app.icon]) {
    inner = `<span class="glyph">${window.ICONS[app.icon]}</span>`;
  } else {
    const label = app.label || app.name || '';
    const upper = label === label.toUpperCase() && /[A-Z]/.test(label);
    const len = label.length;
    const size = len <= 4 ? 1.35 : len <= 7 ? 1.1 : len <= 10 ? .86 : .7;
    inner = `<span class="wm${upper ? ' upper' : ''}" style="--wm:${size}em">${esc(label)}</span>`;
  }
  return `<div class="tile-face" style="${style}">${inner}</div>`;
};
