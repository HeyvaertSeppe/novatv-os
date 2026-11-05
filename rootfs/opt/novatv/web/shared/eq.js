// NovaTV equalizer helpers (shared by the TV and the phone):
// frequency response of the filters, the response curve drawing and a DJ-mixer style knob.
window.EQ = (() => {
  const FS = 48000;
  const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  const ISO = { low: { f: 220, q: 0.7, type: 'lowshelf' }, mid: { f: 1000, q: 0.7, type: 'peaking' }, high: { f: 4500, q: 0.7, type: 'highshelf' } };
  const BAND_MIN = -12, BAND_MAX = 12, ISO_MIN = -26, ISO_MAX = 6;

  // RBJ audio-EQ-cookbook biquads, same as PipeWire's builtin bq_* filters
  function coeffs(type, f, q, g) {
    const A = Math.pow(10, g / 40), w = 2 * Math.PI * f / FS, cs = Math.cos(w), al = Math.sin(w) / (2 * q), sA = 2 * Math.sqrt(A) * al;
    if (type === 'peaking') return [1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A];
    if (type === 'lowshelf') return [A * ((A + 1) - (A - 1) * cs + sA), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - sA),
      (A + 1) + (A - 1) * cs + sA, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - sA];
    return [A * ((A + 1) + (A - 1) * cs + sA), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - sA),
      (A + 1) - (A - 1) * cs + sA, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - sA];
  }
  function magDb(c, f) {
    const w = 2 * Math.PI * f / FS, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
    const dr = c[3] + c[4] * c1 + c[5] * c2, di = -(c[4] * s1 + c[5] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  function filters(eq) {
    if (!eq || !eq.enabled) return [];
    const list = BANDS.map((f, i) => coeffs('peaking', f, 1.41, eq.bands[i] || 0));
    for (const k of ['low', 'mid', 'high']) list.push(coeffs(ISO[k].type, ISO[k].f, ISO[k].q, eq[k] || 0));
    return list;
  }
  function response(eq, f) { return filters(eq).reduce((s, c) => s + magDb(c, f), 0); }

  // draws the curve; range in dB is +/- `range`
  function draw(canvas, eq, opt = {}) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const range = opt.range || 15, fl = filters(eq);
    const x2f = (x) => 20 * Math.pow(1000, x / w);
    const y = (db) => h / 2 - Math.max(-range, Math.min(range, db)) / range * (h / 2 - 4);
    // grid
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
    for (const db of [-12, -6, 0, 6, 12]) { g.beginPath(); g.moveTo(0, y(db)); g.lineTo(w, y(db)); g.stroke(); }
    const pts = [];
    for (let x = 0; x <= w; x += 2) pts.push([x, y(fl.reduce((s, c) => s + magDb(c, x2f(x)), 0))]);
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, opt.c1 || '#ff7a1a'); grad.addColorStop(0.5, opt.c2 || '#ff3d7f'); grad.addColorStop(1, opt.c3 || '#7c6bff');
    g.beginPath(); g.moveTo(0, h / 2); pts.forEach(([px, py]) => g.lineTo(px, py)); g.lineTo(w, h / 2); g.closePath();
    const fill = g.createLinearGradient(0, 0, 0, h);
    fill.addColorStop(0, 'rgba(255,90,120,.22)'); fill.addColorStop(0.5, 'rgba(255,90,120,.04)'); fill.addColorStop(1, 'rgba(255,90,120,.22)');
    g.fillStyle = fill; g.fill();
    g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.strokeStyle = grad; g.lineWidth = opt.width || 3; g.shadowColor = 'rgba(255,80,120,.6)'; g.shadowBlur = opt.glow ?? 12; g.stroke();
    g.shadowBlur = 0;
  }

  // ---- DJ mixer knob (SVG). Centre = 0 dB, full left = kill (-26 dB), full right = +6 dB
  const angleOf = (v) => (v <= 0 ? 135 * v / -ISO_MIN : 135 * v / ISO_MAX);
  function arc(r, a0, a1) {
    const p = (a) => [50 + r * Math.sin(a * Math.PI / 180), 50 - r * Math.cos(a * Math.PI / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  let uid = 0;
  function knobSVG() {
    const id = `k${uid++}`;
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const a = -135 + i * 27, r1 = 47.5, r2 = 49.5, s = Math.sin(a * Math.PI / 180), c = Math.cos(a * Math.PI / 180);
      return `<line x1="${50 + r1 * s}" y1="${50 - r1 * c}" x2="${50 + r2 * s}" y2="${50 - r2 * c}" />`;
    }).join('');
    return `<svg viewBox="0 0 100 100" class="knob-svg">
      <defs>
        <radialGradient id="${id}b" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#4a4a52"/><stop offset=".55" stop-color="#1d1d22"/><stop offset="1" stop-color="#09090b"/></radialGradient>
        <radialGradient id="${id}c" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#5c5c66"/><stop offset="1" stop-color="#1a1a1f"/></radialGradient>
      </defs>
      <g stroke="rgba(255,255,255,.35)" stroke-width="1">${ticks}</g>
      <path class="k-track" d="${arc(42, -135, 135)}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="4" stroke-linecap="round"/>
      <path class="k-val" d="" fill="none" stroke="#ff7a1a" stroke-width="4" stroke-linecap="round"/>
      <circle cx="50" cy="50" r="34" fill="url(#${id}b)"/>
      <circle cx="50" cy="50" r="33" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.6" stroke-dasharray="1.2 2.2"/>
      <circle cx="50" cy="50" r="23" fill="url(#${id}c)" stroke="rgba(0,0,0,.5)" stroke-width="1"/>
      <g class="k-ptr"><line x1="50" y1="46" x2="50" y2="19" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/></g>
    </svg>`;
  }
  function setKnob(el, v) {
    const a = angleOf(v);
    const val = el.querySelector('.k-val');
    val.setAttribute('d', Math.abs(a) < 0.5 ? '' : arc(42, Math.min(0, a), Math.max(0, a)));
    val.setAttribute('stroke', v <= ISO_MIN + 0.01 ? '#ff3b30' : '#ff7a1a');
    el.querySelector('.k-ptr').setAttribute('transform', `rotate(${a.toFixed(1)} 50 50)`);
  }
  const fmt = (v, kill) => (kill && v <= ISO_MIN + 0.01 ? 'KILL' : `${v > 0 ? '+' : ''}${(+v).toFixed(1)} dB`);

  return { BANDS, LABELS, BAND_MIN, BAND_MAX, ISO_MIN, ISO_MAX, response, draw, knobSVG, setKnob, fmt };
})();
