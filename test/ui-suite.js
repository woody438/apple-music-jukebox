// Browser-driven UI checks. OPTIONAL: needs Playwright, which is NOT a
// dependency of the jukebox itself. Start the mock server first:
//
//   MOCK=1 PUBLIC_URL="http://192.168.1.42:8484/" node server.js
//   node test/ui-suite.js [screenshot-dir]
//
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('SKIP  UI suite: Playwright is not installed (npm i -D playwright).');
  process.exit(0);
}
const OUT = process.argv[2] || require('os').tmpdir();
const BASE = process.env.JUKEBOX_URL || 'http://127.0.0.1:8484/';
let pass = 0, fail = 0;
function check(ok, label, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  --  ' + extra : ''));
  ok ? pass++ : fail++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ---------- laptop ----------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.strip', { timeout: 15000 });

  check((await page.textContent('#jbTitle')).trim() === 'JUKEBOX', 'marquee title rendered');

  const stripCount = await page.locator('.strip').count();
  check(stripCount > 4, 'strips fill the grid', stripCount + ' strips on page 1');

  const code = await page.locator('.strip .code').first().textContent();
  check(/^[A-Z#]-\d+$/.test(code.trim()), 'selection code format', code.trim());

  const fontOk = await page.evaluate(() => document.fonts.check("16px 'Monoton'") && document.fonts.check("16px 'Oswald'"));
  check(fontOk, 'embedded Monoton + Oswald loaded (no CDN)');

  const countTxt = await page.textContent('#resultCount');
  check(/1,901|1901/.test(countTxt), 'index count shown', countTxt.trim());

  check(!(await page.locator('#qrSection').isHidden()), 'QR panel shown for the host');
  const qrSvg = await page.locator('#qrBox svg').count();
  check(qrSvg === 1, 'QR code rendered as inline SVG');
  check((await page.textContent('#qrUrl')).includes('192.168.1.42'), 'guest URL displayed');

  // ---------- paging ----------
  const firstBefore = await page.locator('.strip .t span').first().textContent();
  const pageNoBefore = await page.textContent('#pageNo');
  await page.click('#nextPage');
  await sleep(1100);
  const firstAfter = await page.locator('.strip .t span').first().textContent();
  const pageNoAfter = await page.textContent('#pageNo');
  check(firstBefore !== firstAfter && pageNoBefore !== pageNoAfter, 'page flip advances',
        pageNoBefore.trim() + ' -> ' + pageNoAfter.trim());

  await page.click('#prevPage');
  await sleep(1100);
  check((await page.textContent('#pageNo')) === pageNoBefore, 'page flip goes back');

  // ---------- A-Z rail ----------
  await page.click('.rail button[data-letter="M"]:not([disabled])');
  await sleep(1100);
  const railArtist = await page.locator('.strip .a').first().textContent();
  check(/^(the\s+)?m/i.test(railArtist.replace(/^the\s+/i, '')), 'A-Z rail jumps to M', railArtist);

  // ---------- search ----------
  await page.fill('#search', 'beatles');
  await sleep(500);
  const artists = await page.locator('.strip .a').allTextContents();
  check(artists.length > 0 && artists.every(a => /beatles/i.test(a)), 'search filters to matching artist',
        artists.length + ' strips, all Beatles');

  await page.fill('#search', 'beyonce');   // accent-insensitive: library has Beyoncé
  await sleep(500);
  const accented = await page.locator('.strip .a').allTextContents();
  check(accented.length > 0 && accented.every(a => /beyonc/i.test(a)), 'accent-insensitive search finds Beyonce',
        accented.length + ' strips');

  await page.fill('#search', '');
  await sleep(400);

  // ---------- pick ----------
  const pickTitle = (await page.locator('.strip .t span').first().textContent()).trim();
  await page.locator('.strip').first().click();
  await page.waitForSelector('#confirm:not([hidden])', { timeout: 4000 });
  check((await page.textContent('#cfTitle')).trim() === pickTitle, 'confirm card shows the right song');

  await page.fill('#cfWho', 'Woody');
  await page.click('#cfYes');
  await page.waitForSelector('.toast', { timeout: 5000 });
  const toastTxt = await page.locator('.toast').first().textContent();
  check(/next up|in line/i.test(toastTxt), 'pick accepted with a queue-position toast', toastTxt.trim());

  await page.waitForFunction(() => {
    const t = document.getElementById('nowTitle');
    return t && t.textContent.trim() !== '—';
  }, { timeout: 10000 });
  check((await page.textContent('#nowTitle')).trim() === pickTitle, 'SSE pushed it to Now Playing');
  check(/PICKED BY WOODY/.test(await page.textContent('#nowKicker')), 'picked-by name shown',
        (await page.textContent('#nowKicker')).trim());

  const playingMark = await page.locator('.strip.playing').count();
  check(playingMark >= 1, 'the playing song is marked on its strip');

  // queue a second one and check the QUEUED mark + Up Next
  await page.locator('.strip').nth(3).click();
  await page.waitForSelector('#confirm:not([hidden])');
  await page.click('#cfYes');
  await sleep(1200);
  check((await page.locator('.strip.queued').count()) >= 1, 'queued song marked on its strip');
  check((await page.locator('#queueList li').count()) >= 1, 'Up Next list populated');

  // ---------- host panel ----------
  await page.keyboard.down('Control'); await page.keyboard.down('Alt');
  await page.keyboard.press('KeyH');
  await page.keyboard.up('Alt'); await page.keyboard.up('Control');
  await sleep(400);
  check(!(await page.locator('#hostPanel').isHidden()), 'control-option-H opens the host panel');
  check((await page.locator('#hostQueue li').count()) >= 1, 'host panel lists the queue with remove buttons');

  await page.screenshot({ path: OUT + '/laptop-host.png' });
  await page.keyboard.down('Control'); await page.keyboard.down('Alt');
  await page.keyboard.press('KeyH');
  await page.keyboard.up('Alt'); await page.keyboard.up('Control');
  await sleep(400);
  await page.screenshot({ path: OUT + '/laptop.png' });

  check(errors.length === 0, 'no JavaScript errors on the laptop view', errors.slice(0, 2).join(' | ') || 'clean');

  // ---------- phone ----------
  const pctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const phone = await pctx.newPage();
  const perrors = [];
  phone.on('pageerror', e => perrors.push(String(e)));
  await phone.goto(BASE, { waitUntil: 'networkidle' });
  await phone.waitForSelector('.strip', { timeout: 15000 });

  check(!(await phone.locator('#minibar').isHidden()), 'phone shows the now-playing mini bar');
  check(await phone.locator('.panel').isHidden() || !(await phone.locator('.panel').isVisible()), 'phone hides the side panel (no QR)');

  const gridCols = await phone.evaluate(() => getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length);
  check(gridCols === 1, 'phone uses one-column strip pages', gridCols + ' column(s)');

  await phone.click('#minibarToggle');
  await sleep(350);
  check(!(await phone.locator('#minibarQueue').isHidden()), 'mini bar expands to show Up Next');

  const miniRows = await phone.evaluate(() => Array.from(document.querySelectorAll('#miniQueueList li')).map(li => {
    const t = li.querySelector('.q-title'), s2 = li.querySelector('.q-sub');
    return { t: t.textContent, s: s2.textContent, block: getComputedStyle(t).display };
  }));
  check(miniRows.length > 0 && miniRows.every(r => r.block === 'block'),
        'mini bar queue puts title and artist on separate lines',
        miniRows.length ? miniRows[0].t + ' / ' + miniRows[0].s : 'no rows');

  await phone.screenshot({ path: OUT + '/phone.png', fullPage: false });
  check(perrors.length === 0, 'no JavaScript errors on the phone view', perrors.slice(0, 2).join(' | ') || 'clean');

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('uitest crashed:', e); process.exit(1); });
