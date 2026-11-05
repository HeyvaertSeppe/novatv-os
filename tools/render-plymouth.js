// Renders the NovaTV boot animation into PNG frames for the Plymouth theme.
// Usage: node tools/render-plymouth.js   (needs Playwright + Chromium)
// Frames 0..44 = intro (spark grows, wordmark slides in), 45..94 = loop (light sweep + glow pulse).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'rootfs/usr/share/plymouth/themes/novatv');
const FONT = 'file://' + path.join(ROOT, 'rootfs/opt/novatv/web/shared/fonts/inter-var.woff2');
const SPARK = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 2C52.6 30 70 47.4 98 50 70 52.6 52.6 70 50 98 47.4 70 30 52.6 2 50 30 47.4 47.4 30 50 2Z"/></svg>') center/contain no-repeat`;
const FPS = 25, INTRO = 45, LOOP = 50, W = 1000, H = 360;

const html = `<!doctype html><html><head><style>
@font-face { font-family: Inter; src: url(${FONT}) format('woff2'); font-weight: 100 900; }
html, body { margin: 0; background: transparent; }
#stage { width: ${W}px; height: ${H}px; display: grid; place-items: center; }
.logo { display: flex; align-items: center; gap: 24px; filter: drop-shadow(0 0 30px rgba(140,150,255,.35)); font-family: Inter; color: #f5f5f7; }
.spark { position: relative; width: 110px; height: 110px; -webkit-mask: ${SPARK}; mask: ${SPARK};
  background: linear-gradient(135deg, #fff 20%, #c9ceff 55%, #e7c6ff 85%); overflow: hidden; }
.flare { position: absolute; inset: -30%; background: linear-gradient(115deg, transparent 40%, rgba(255,255,255,.95) 50%, transparent 60%); transform: translateX(-120%); }
.word { font-size: 100px; line-height: 1; letter-spacing: -.045em; display: flex; }
.w1 { font-weight: 700; } .w2 { font-weight: 300; margin-left: .06em; color: rgba(255,255,255,.82); }
</style></head><body><div id="stage"><div class="logo"><div class="spark"><div class="flare"></div></div>
<div class="word"><span class="w1">nova</span><span class="w2">tv</span></div></div></div></body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/^f\d+\.png$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const ease = 'cubic-bezier(.25,.8,.25,1)', spring = 'cubic-bezier(.2,.9,.25,1.15)';
  await page.evaluate(({ ease, spring }) => {
    const q = (s) => document.querySelector(s);
    const o = (d, delay, easing) => ({ duration: d, delay, easing, fill: 'both' });
    window.intro = [
      q('.spark').animate([{ transform: 'scale(.2) rotate(-90deg)', opacity: 0, filter: 'blur(10px)' },
        { opacity: 1, filter: 'blur(0)', offset: .6 }, { transform: 'scale(1) rotate(0)', opacity: 1 }], o(1100, 0, spring)),
      q('.flare').animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(120%)' }], o(1200, 550, ease)),
      q('.w1').animate([{ opacity: 0, transform: 'translateX(-20px)', filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], o(900, 350, ease)),
      q('.w2').animate([{ opacity: 0, transform: 'translateX(-20px)', filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], o(900, 500, ease)),
    ];
    window.loop = [
      q('.flare').animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(-120%)', offset: .3 }, { transform: 'translateX(120%)' }], { duration: 2000, fill: 'both', easing: ease }),
      q('.logo').animate([{ filter: 'drop-shadow(0 0 30px rgba(140,150,255,.35))' }, { filter: 'drop-shadow(0 0 46px rgba(160,150,255,.6))' }, { filter: 'drop-shadow(0 0 30px rgba(140,150,255,.35))' }], { duration: 2000, fill: 'both' }),
    ];
    [...window.intro, ...window.loop].forEach((a) => a.pause());
    window.loop.forEach((a) => (a.currentTime = 0));
  }, { ease, spring });

  let n = 0;
  for (let i = 0; i < INTRO; i++) {
    const t = Math.min(i * 1000 / FPS * (1800 / (INTRO * 1000 / FPS)), 1799);
    await page.evaluate((t) => { window.loop.forEach((a) => a.cancel()); window.intro.forEach((a) => (a.currentTime = t)); }, t);
    await page.screenshot({ path: path.join(OUT, `f${n++}.png`), omitBackground: true });
  }
  await page.evaluate(() => { window.intro.forEach((a) => a.finish()); window.loop.forEach((a) => a.pause()); });
  for (let i = 0; i < LOOP; i++) {
    await page.evaluate((t) => window.loop.forEach((a) => (a.currentTime = t)), i * 2000 / LOOP);
    await page.screenshot({ path: path.join(OUT, `f${n++}.png`), omitBackground: true });
  }
  await browser.close();
  console.log(`wrote ${n} frames to ${OUT}`);
})();
