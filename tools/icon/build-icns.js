#!/usr/bin/env node
'use strict';
// Renders tools/icon/icon.html at every size macOS wants and packs the PNGs
// into a .icns. Needs Playwright, so it is a build-time tool only -- the
// finished AppIcon.icns is committed and nobody has to run this.
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'app', 'Resources', 'AppIcon.icns');      // the Mac app's icon
// OSType -> pixel size. Both the 1x and @2x slots macOS looks for.
const SLOTS = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64],
  ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512],
  ['ic09', 512], ['ic10', 1024],
];

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const pngs = new Map();
  for (const size of [...new Set(SLOTS.map((s) => s[1]))]) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: size / 1024 });
    await page.goto('file://' + path.join(__dirname, 'icon.html'));
    await page.waitForTimeout(120);
    pngs.set(size, await page.locator('.c').screenshot({ omitBackground: true }));
    await page.close();
  }
  await browser.close();

  // icns: 'icns' + total length, then [OSType][length incl. header][png].
  const chunks = SLOTS.map(([type, size]) => {
    const png = pngs.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const bodyLen = chunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(bodyLen + 8, 4);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.concat([header, ...chunks]));
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ${SLOTS.length} sizes)`);
})();
