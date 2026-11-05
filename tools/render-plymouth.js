// Renders the NovaTV boot splash (Plymouth theme).
// Usage: node tools/render-plymouth.js   (needs Playwright + Chromium)
//
// Instead of pre-rendered video frames, the splash is made of a few crisp images
// (spark, wordmark, loading dot) at 1080p and 2160p size. Plymouth's script fades and
// moves them at the screen's native resolution, so the logo stays sharp and there are
// no soft glows that show banding on TVs. The layout matches the launcher's intro
// exactly, so the splash flows into the interface without a jump.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'rootfs/usr/share/plymouth/themes/novatv');
const FONT = 'file://' + path.join(ROOT, 'rootfs/opt/novatv/web/shared/fonts/inter-var.woff2');
const SPARK = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 2C52.6 30 70 47.4 98 50 70 52.6 52.6 70 50 98 47.4 70 30 52.6 2 50 30 47.4 47.4 30 50 2Z"/></svg>') center/contain no-repeat`;
const W = 1920, H = 1080, PAD = 12;

// same sizes as the launcher's #intro logo at 1080p (1rem = 10px)
const html = `<!doctype html><html><head><style>
@font-face { font-family: Inter; src: url(${FONT}) format('woff2'); font-weight: 100 900; }
html, body { margin: 0; background: transparent; }
#stage { width: ${W}px; height: ${H}px; display: grid; place-items: center; }
.logo { display: flex; align-items: center; gap: 24px; font-family: Inter; color: #f5f5f7; }
.spark { width: 110px; height: 110px; -webkit-mask: ${SPARK}; mask: ${SPARK};
  background: linear-gradient(135deg, #ffffff 20%, #c9ceff 55%, #e7c6ff 85%); }
.word { font-size: 100px; line-height: 1; letter-spacing: -.045em; display: flex; }
.w1 { font-weight: 700; } .w2 { font-weight: 300; margin-left: .06em; color: rgba(255,255,255,.82); }
#dot { position: absolute; left: 0; top: 0; width: 10px; height: 10px; border-radius: 50%; background: #fff; }
</style></head><body><div id="stage"><div class="logo"><div class="spark"></div>
<div class="word"><span class="w1">nova</span><span class="w2">tv</span></div></div></div><div id="dot"></div></body></html>`;

async function render(browser, scale, suffix) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: scale });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const boxes = await page.evaluate(() => Object.fromEntries(['.spark', '.word', '#dot'].map((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return [s, { x: r.x, y: r.y, w: r.width, h: r.height }];
  })));
  const shot = async (sel, file, pad) => {
    const b = boxes[sel];
    const clip = { x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad };
    // hide the other parts so each image holds only its own element
    await page.evaluate((sel) => document.querySelectorAll('.spark, .word, #dot').forEach((e) => {
      e.style.visibility = e.matches(sel) ? 'visible' : 'hidden';
    }), sel);
    await page.screenshot({ path: path.join(OUT, file), clip, omitBackground: true });
    // offset of the image's top-left corner from the screen centre, in 1080p pixels
    return { dx: Math.round(clip.x - W / 2), dy: Math.round(clip.y - H / 2) };
  };
  const pos = {
    spark: await shot('.spark', `spark${suffix}.png`, PAD),
    word: await shot('.word', `word${suffix}.png`, PAD),
  };
  await shot('#dot', `dot${suffix}.png`, 2);
  await page.close();
  return pos;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/\.png$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  const browser = await chromium.launch();
  const pos = await render(browser, 1, '');
  await render(browser, 2, '-2x');
  await browser.close();

  const sgn = (v) => (v < 0 ? `- ${-v}` : `+ ${v}`);   // plymouth's parser prefers "a - b" to "a + -b"
  const script = fs.readFileSync(path.join(__dirname, 'plymouth-template.script'), 'utf8')
    .replace('@SPARK_DX@', sgn(pos.spark.dx)).replace('@SPARK_DY@', sgn(pos.spark.dy))
    .replace('@WORD_DX@', sgn(pos.word.dx)).replace('@WORD_DY@', sgn(pos.word.dy));
  fs.writeFileSync(path.join(OUT, 'novatv.script'), script);
  console.log('positions', JSON.stringify(pos));
})();
