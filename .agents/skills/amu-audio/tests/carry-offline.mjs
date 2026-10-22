import { createRequire } from 'module';
const require = createRequire(process.env.PLAYWRIGHT_FROM || (process.env.HOME + '/.claude/skills/kintsugi/package.json'));
const { chromium } = require('playwright');
const T = process.argv[2];
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const out = []; const ok = (n, c, i = '') => out.push(`${c ? 'OK' : 'NG'} ${n} ${i}`);
const mediaT = (p) => p.evaluate(() => [...document.querySelectorAll('*')].map(e => e.shadowRoot).filter(Boolean).flatMap(r => [...r.querySelectorAll('audio')]).concat([...document.querySelectorAll('audio')]).map(a => a.currentTime));
for (const [file, offline] of [['carry.html', false], ['offline.html', true]]) {
  const ctx = await b.newContext(); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  if (offline) await p.route(/^https?:/, r => r.abort());
  await p.goto('file://' + T + '/' + file); await p.waitForTimeout(1500);
  ok(`${file}: loaded`, (await p.$$('.row')).length === 3, errs.join('|'));
  await p.click('#play'); await p.waitForTimeout(2200);
  await p.click('.row >> nth=1'); await p.waitForTimeout(1200);
  const t1 = Math.max(...await mediaT(p));
  ok(`${file}: voice->voice carries`, t1 > 2.5, t1.toFixed(2));
  await p.click('.row >> nth=2'); await p.waitForTimeout(800);
  const t2 = Math.max(...await mediaT(p));
  ok(`${file}: voice->music restarts`, t2 < 1.5, t2.toFixed(2));
  ok(`${file}: no errors`, errs.length === 0, errs.join('|'));
  await ctx.close();
}
await b.close(); console.log(out.join('\n'));
