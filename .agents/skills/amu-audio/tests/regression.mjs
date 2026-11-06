import { createRequire } from 'module';
const require = createRequire(process.env.PLAYWRIGHT_FROM || (process.env.HOME + '/.claude/skills/kintsugi/package.json'));
const { chromium } = require('playwright');
const T = process.argv[2];
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const res = [];
const ok = (name, cond, info = '') => res.push(`${cond ? 'OK ' : 'NG '} ${name} ${info}`);
async function page(file, width = 728) {
  const p = await b.newPage({ viewport: { width, height: 700 } });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto('file://' + T + '/' + file); await p.waitForTimeout(1500);
  return { p, errs };
}
const media = (p) => p.evaluate(() => { const a = document.querySelector('#wave div')?.shadowRoot?.querySelector('audio') || [...document.querySelectorAll('audio')][0]; return null; });
// 1 empty
{ const { p, errs } = await page('empty.html');
  ok('empty: play disabled', await p.$eval('#play', (e) => e.disabled));
  ok('empty: prev/next disabled', await p.$eval('#prev', (e) => e.disabled) && await p.$eval('#next', (e) => e.disabled));
  ok('empty: no errors', errs.length === 0, errs.join('|'));
  await p.focus('#drop'); ok('empty: drop focusable', await p.evaluate(() => document.activeElement.id === 'drop'));
  await p.close(); }
// 2 full
{ const { p, errs } = await page('full.html');
  await p.waitForTimeout(1000);
  const durs = await p.$$eval('.row .d', (els) => els.map((e) => e.textContent));
  ok('durations shown upfront', durs.slice(0, 3).every((d) => d), JSON.stringify(durs));
  const errRow = await p.$$eval('.row .m.err', (els) => els.length);
  ok('broken file flagged', errRow === 1);
  await p.selectOption('#rate', '1.5');
  await p.click('.row >> nth=1'); await p.waitForTimeout(1200);
  const st = await p.evaluate(() => { const m = [...document.querySelectorAll('*')].map(e=>e.shadowRoot).filter(Boolean).flatMap(r=>[...r.querySelectorAll('audio,video')]).concat([...document.querySelectorAll('audio,video')]); return m.map(a=>({rate:a.playbackRate,paused:a.paused,t:a.currentTime,vol:a.volume})); });
  ok('rate kept after switch', st.some((a) => a.rate === 1.5), JSON.stringify(st));
  ok('playing after row click', st.some((a) => !a.paused));
  ok('label 一時停止', (await p.textContent('#play')) === '一時停止');
  ok('aria-current on row2', await p.$eval('.row >> nth=1', (e) => e.getAttribute('aria-current') === 'true'));
  await p.click('#loop'); ok('loop aria-pressed', (await p.getAttribute('#loop', 'aria-pressed')) === 'true');
  // space on range
  await p.focus('#vol'); await p.keyboard.press('Space'); await p.waitForTimeout(200);
  ok('space on volume toggles', (await p.textContent('#play')) === '再生');
  // keyboard rows
  await p.focus('.row >> nth=2'); await p.keyboard.press('Enter'); await p.waitForTimeout(800);
  ok('enter on row plays', (await p.textContent('#now')) === '効果音 チャイム');
  // broken
  await p.click('.row >> nth=3'); await p.waitForTimeout(1500);
  ok('broken: message shown', (await p.textContent('#msg')).includes('再生できません'), await p.textContent('#msg'));
  ok('broken: label 再生', (await p.textContent('#play')) === '再生');
  // non-audio files
  await p.setInputFiles('#file', [{ name: 'memo.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  ok('non-audio message', (await p.textContent('#msg')).includes('memo.txt'));
  ok('aria labels', await p.getAttribute('#prev', 'aria-label') === '前の曲');
  ok('no page errors', errs.length === 0, errs.join('|'));
  await p.close(); }
// 3 mobile layout
for (const w of [390, 360]) { const { p } = await page('full.html', w); await p.waitForTimeout(800);
  const m = await p.evaluate(() => {
    const starts = [...document.querySelectorAll('.row .nm')].map((e) => Math.round(e.getBoundingClientRect().left));
    const over = [...document.querySelectorAll('.row .b')].filter((e) => e.scrollWidth > e.clientWidth + 1).length;
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
    const fs = [...document.querySelectorAll('.row .b, .row .m')].map((e) => parseFloat(getComputedStyle(e).fontSize));
    return { starts: [...new Set(starts)], over, prev: r('#prev'), vol: r('#vol'), minFont: Math.min(...fs), hscroll: document.documentElement.scrollWidth > innerWidth };
  });
  ok(`w${w}: title aligned`, m.starts.length === 1, JSON.stringify(m.starts));
  ok(`w${w}: badge no overflow`, m.over === 0);
  ok(`w${w}: prev >=40x40`, m.prev[0] >= 40 && m.prev[1] >= 40, JSON.stringify(m.prev));
  ok(`w${w}: min font 12`, m.minFont >= 12, String(m.minFont));
  ok(`w${w}: no h-scroll`, !m.hscroll);
  await p.screenshot({ path: `${T}/shot-${w}.png` }); await p.close(); }
{ const { p } = await page('full.html', 728); await p.waitForTimeout(800); await p.screenshot({ path: `${T}/shot-728.png` }); await p.close(); }
// 4 narrow chat column / split view: names stay readable, rows stay tappable
for (const w of [240, 300]) { const { p } = await page('full.html', w); await p.waitForTimeout(800);
  const g = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    nm: Math.min(...[...document.querySelectorAll('.row .nm')].map((e) => e.getBoundingClientRect().width)),
    rowH: Math.min(...[...document.querySelectorAll('.row')].map((e) => e.getBoundingClientRect().height)),
  }));
  ok(`w${w}: no h-scroll`, g.sw <= w, String(g.sw));
  ok(`w${w}: name readable`, g.nm >= w * 0.5, String(Math.round(g.nm)));
  ok(`w${w}: row >=44px`, g.rowH >= 44, String(Math.round(g.rowH)));
  await p.click('.row >> nth=2'); await p.waitForTimeout(400);
  ok(`w${w}: row clickable`, await p.$eval('.row >> nth=2', (e) => e.getAttribute('aria-current') === 'true'));
  await p.screenshot({ path: `${T}/shot-${w}.png` }); await p.close(); }
await b.close();
console.log(res.join('\n'));
