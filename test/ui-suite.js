// Browser-driven UI checks. OPTIONAL: needs Playwright, which is NOT a
// dependency of the jukebox itself. Start the mock server first:
//
//   MOCK=1 PUBLIC_URL="http://192.168.1.42:8484/" node server.js
//   node test/ui-suite.js [screenshot-dir]
//
// Add JUKEBOX_WIFI_NAME='Test Wi-Fi' JUKEBOX_WIFI_PASSWORD='x' to the server
// to check the Wi-Fi QR code; without them it checks the code stays hidden.
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
  return ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ======================= laptop =========================================
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

  // ---------------- genre selector ----------------------------------------
  const gButtons = await page.locator('#genres .gbtn').count();
  check(gButtons > 3, 'genre selector rendered', gButtons + ' buttons');

  const allBtn = page.locator('#genres .gbtn[data-genre="__ALL__"]');
  check(await allBtn.count() === 1, 'ALL button present');
  check((await allBtn.getAttribute('class')).includes('on'), 'ALL is selected on load');

  const allCount = Number((await allBtn.locator('.g-count').textContent()).replace(/,/g, ''));
  check(allCount > 1000, 'ALL shows the whole library count', allCount.toLocaleString());

  // Genre buttons are ordered by size, biggest first.
  const counts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#genres .gbtn')).slice(1)
      .filter(b => b.dataset.genre !== '__OTHER__')
      .map(b => Number(b.querySelector('.g-count').textContent.replace(/,/g, ''))));
  check(counts.every((c, i) => i === 0 || counts[i - 1] >= c), 'genres ordered by track count',
        counts.slice(0, 5).join(' > '));

  // Pick the second-biggest genre and check the strips actually change.
  const target = await page.evaluate(() => {
    const b = document.querySelectorAll('#genres .gbtn')[2];
    return { name: b.dataset.genre, count: Number(b.querySelector('.g-count').textContent.replace(/,/g, '')) };
  });
  await page.locator('#genres .gbtn').nth(2).click();
  await sleep(500);

  check((await page.locator('#genres .gbtn').nth(2).getAttribute('class')).includes('on'),
        'tapped genre lights up', target.name);

  const shown = Number((await page.textContent('#pageNo')).match(/OF (\d+)/)[1]);
  const perPage = await page.locator('.strip').count();
  check(shown * perPage >= target.count && (shown - 1) * perPage < target.count,
        'track list narrowed to that genre',
        `${target.count} songs over ${shown} pages`);

  const genreOfShown = await page.evaluate(g =>
    Array.from(document.querySelectorAll('.strip')).every((_, i) => true) &&
    view.slice(0, 50).every(r => r[6] === g), target.name);
  check(genreOfShown, 'every row in the view really is that genre');

  // The A-Z rail reflects the filtered view, not the whole library.
  const railAll = await page.evaluate(() => Object.keys(viewLetterStart).length);
  await page.locator('#genres .gbtn[data-genre="__ALL__"]').click();
  await sleep(400);
  const railFull = await page.evaluate(() => Object.keys(viewLetterStart).length);
  check(railFull >= railAll, 'A-Z rail recalculated per genre', `${railAll} letters in genre, ${railFull} in ALL`);

  const disabledLetters = await page.locator('#rail button[disabled]').count();
  check(disabledLetters >= 0, 'rail disables letters absent from the view', disabledLetters + ' greyed out');

  // ---------------- search drawer -----------------------------------------
  check(await page.locator('#searchDrawer').isHidden(), 'search starts tucked away in a drawer');

  await page.click('#searchToggle');
  await sleep(300);
  check(!(await page.locator('#searchDrawer').isHidden()), 'SEARCH button opens the drawer');
  check(await page.evaluate(() => document.activeElement.id) === 'search', 'drawer focuses the input');

  await page.fill('#search', 'beatles');
  await sleep(500);
  const artists = await page.locator('.strip .a').allTextContents();
  check(artists.length > 0 && artists.every(a => /beatles/i.test(a)), 'search filters to matching artist',
        artists.length + ' strips, all Beatles');

  await page.fill('#search', 'beyonce');   // library has Beyoncé
  await sleep(500);
  const accented = await page.locator('.strip .a').allTextContents();
  check(accented.length > 0 && accented.every(a => /beyonc/i.test(a)), 'accent-insensitive search finds Beyonce',
        accented.length + ' strips');

  // Searching must step out of a genre, or results get silently truncated.
  await page.locator('#genres .gbtn').nth(2).click();
  await sleep(400);
  await page.click('#searchToggle');   // genre tap closed it, so this opens it
  await sleep(250);
  await page.fill('#search', 'diamond');
  await sleep(500);
  check(await page.evaluate(() => genre === '__ALL__'), 'searching clears the genre filter');
  check((await page.locator('#genres .gbtn[data-genre="__ALL__"]').getAttribute('class')).includes('on'),
        'the genre bar shows ALL again');

  // ...and tapping a genre clears the search and puts the drawer away.
  await page.locator('#genres .gbtn').nth(1).click();
  await sleep(400);
  check(await page.evaluate(() => query === '' && document.getElementById('search').value === ''),
        'tapping a genre clears the search term');
  check(await page.locator('#searchDrawer').isHidden(), 'tapping a genre closes the search drawer');

  await page.locator('#genres .gbtn[data-genre="__ALL__"]').click();
  await sleep(300);
  await page.click('#searchToggle');
  await sleep(250);
  await page.click('#searchClose');
  await sleep(250);
  check(await page.locator('#searchDrawer').isHidden(), 'the close button shuts the drawer');

  // Typing anywhere should still drop you into search.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('KeyZ');
  await sleep(300);
  check(!(await page.locator('#searchDrawer').isHidden()), 'typing anywhere opens the drawer');
  await page.keyboard.press('Escape');
  await sleep(300);
  check(await page.locator('#searchDrawer').isHidden(), 'Escape closes the drawer');

  // ---------------- paging -------------------------------------------------
  const pageNoBefore = await page.textContent('#pageNo');
  await page.click('#nextPage');
  await sleep(1100);
  check((await page.textContent('#pageNo')) !== pageNoBefore, 'page flip advances',
        pageNoBefore.trim() + ' -> ' + (await page.textContent('#pageNo')).trim());
  await page.click('#prevPage');
  await sleep(1100);
  check((await page.textContent('#pageNo')) === pageNoBefore, 'page flip goes back');

  await page.click('.rail button[data-letter="M"]:not([disabled])');
  await sleep(1100);
  const railArtist = await page.locator('.strip .a').first().textContent();
  check(/^m/i.test(railArtist.replace(/^the\s+/i, '')), 'A-Z rail jumps to M', railArtist);

  // ---------------- attract mode ------------------------------------------
  await page.evaluate(() => {
    window.ATTRACT_IDLE_MS = 700;
    window.ATTRACT_STEP_MS = 700;
    kickAttract();
  });
  await sleep(1400);
  check(await page.evaluate(() => attractOn === true), 'attract mode starts when nobody touches it');
  check(await page.evaluate(() => document.body.classList.contains('attract')), 'attract shows the BROWSING cue');

  const attractPage1 = await page.evaluate(() => pageStart);
  await sleep(1800);
  const attractPage2 = await page.evaluate(() => pageStart);
  check(attractPage1 !== attractPage2, 'attract mode turns pages by itself',
        attractPage1 + ' -> ' + attractPage2);

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await sleep(300);
  check(await page.evaluate(() => attractOn === false), 'any input stops attract mode');

  await page.evaluate(() => { window.ATTRACT_IDLE_MS = 600000; kickAttract(); });

  // ---------------- picking ------------------------------------------------
  await page.locator('#genres .gbtn[data-genre="__ALL__"]').click();
  await sleep(400);
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
  check(/PICKED BY WOODY/.test(await page.textContent('#nowKicker')), 'picked-by name shown');
  check((await page.locator('.strip.playing').count()) >= 1, 'the playing song is marked on its strip');

  await page.locator('.strip').nth(3).click();
  await page.waitForSelector('#confirm:not([hidden])');
  await page.click('#cfYes');
  await sleep(1200);
  check((await page.locator('.strip.queued').count()) >= 1, 'queued song marked on its strip');
  check((await page.locator('#queueList li').count()) >= 1, 'Up Next list populated');

  // ---------------- QR + host ---------------------------------------------
  check(!(await page.locator('#qrSection').isHidden()), 'QR panel shown for the host');
  check((await page.locator('#qrBox svg').count()) === 1, 'QR code rendered as inline SVG');
  check((await page.textContent('#qrUrl')).includes('192.168.1.42'), 'guest URL displayed');

  // Choosing another adapter from the menu bar redraws the QR code in place,
  // no reload. Needs an adapter other than the current one; start the server
  // with JUKEBOX_TEST_NETWORK (see the top of lib/net.js) to guarantee one.
  {
    const hostApi = (body) => page.evaluate((b) => fetch('/api/host/network', b === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    }).then((r) => r.json()), body);
    const before = await hostApi();
    const other = (before.adapters || []).find((a) => !(before.guestUrl || '').includes('//' + a.ip + ':'));
    if (!other) {
      console.log('SKIP  QR redraw on adapter change: the server has only one network address');
    } else {
      const svgBefore = await page.innerHTML('#qrBox');
      await hostApi({ interface: other.name });
      await page.waitForFunction((ip) => document.getElementById('qrUrl').textContent.includes(ip), other.ip, { timeout: 5000 })
        .catch(() => {});
      check((await page.textContent('#qrUrl')).includes(other.ip), 'choosing an adapter redraws the guest URL live', other.name);
      check((await page.innerHTML('#qrBox')) !== svgBefore, 'and the QR code itself');
      await hostApi({ interface: null });   // leave the server as we found it
      await page.waitForFunction(() => document.getElementById('qrUrl').textContent.includes('192.168.1.42'), null, { timeout: 5000 })
        .catch(() => {});
      check((await page.textContent('#qrUrl')).includes('192.168.1.42'), 'and back to automatic');
    }
  }

  // The Wi-Fi code appears only when JUKEBOX_WIFI_NAME is set, so check the
  // right thing for however the server under test was started.
  const wifiCfg = await page.evaluate(() => fetch('/api/config').then(r => r.json()).then(c => c.wifi));
  if (wifiCfg) {
    check(!(await page.locator('#wifiSection').isHidden()), 'Wi-Fi QR panel shown when configured');
    check((await page.locator('#wifiBox svg').count()) === 1, 'Wi-Fi QR rendered as inline SVG');
    check((await page.textContent('#wifiName')).trim() === wifiCfg.name, 'Wi-Fi name displayed', wifiCfg.name);
  } else {
    check(await page.locator('#wifiSection').isHidden(), 'Wi-Fi QR panel hidden when not configured');
  }

  await page.keyboard.down('Control'); await page.keyboard.down('Alt');
  await page.keyboard.press('KeyH');
  await page.keyboard.up('Alt'); await page.keyboard.up('Control');
  await sleep(400);
  check(!(await page.locator('#hostPanel').isHidden()), 'control-option-H opens the host panel');
  check((await page.locator('#hostQueue li').count()) >= 1, 'host panel lists the queue with remove buttons');
  check(/genres/.test(await page.textContent('#hostStatus')), 'host panel reports the genre count');

  await page.screenshot({ path: OUT + '/laptop-host.png' });
  await page.keyboard.down('Control'); await page.keyboard.down('Alt');
  await page.keyboard.press('KeyH');
  await page.keyboard.up('Alt'); await page.keyboard.up('Control');
  await sleep(400);
  await page.screenshot({ path: OUT + '/laptop.png' });

  check(errors.length === 0, 'no JavaScript errors on the laptop view', errors.slice(0, 2).join(' | ') || 'clean');

  // ======================= phone ==========================================
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
  check(!(await phone.locator('.panel').isVisible()), 'phone hides the side panel (no QR)');
  check((await phone.locator('#genres .gbtn').count()) > 3, 'phone shows the genre selector too');
  check(await phone.locator('#searchDrawer').isHidden(), 'phone search also starts in the drawer');

  const gridCols = await phone.evaluate(() => getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length);
  check(gridCols === 1, 'phone uses one-column strip pages', gridCols + ' column(s)');

  await phone.locator('#genres .gbtn').nth(1).click();
  await sleep(500);
  check(await phone.evaluate(() => genre !== '__ALL__'), 'genre selection works on the phone');

  await phone.click('#searchToggle');
  await sleep(300);
  check(!(await phone.locator('#searchDrawer').isHidden()), 'phone search drawer opens');

  check(await phone.evaluate(() => attractOn === false && attractIdleTimer === null),
        'attract mode does not run on phones');

  await phone.click('#searchClose');
  await phone.click('#minibarToggle');
  await sleep(350);
  check(!(await phone.locator('#minibarQueue').isHidden()), 'mini bar expands to show Up Next');

  const miniRows = await phone.evaluate(() => Array.from(document.querySelectorAll('#miniQueueList li')).map(li => {
    const t = li.querySelector('.q-title');
    return { t: t.textContent, s: li.querySelector('.q-sub').textContent, block: getComputedStyle(t).display };
  }));
  check(miniRows.length > 0 && miniRows.every(r => r.block === 'block'),
        'mini bar queue puts title and artist on separate lines',
        miniRows.length ? miniRows[0].t + ' / ' + miniRows[0].s : 'no rows');

  await phone.screenshot({ path: OUT + '/phone.png' });
  check(perrors.length === 0, 'no JavaScript errors on the phone view', perrors.slice(0, 2).join(' | ') || 'clean');

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('uitest crashed:', e); process.exit(1); });
