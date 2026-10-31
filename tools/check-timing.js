#!/usr/bin/env node
'use strict';

// Read-only diagnostic for the handoff. Touches nothing.
//
//   node tools/check-timing.js
//
// Answers two questions:
//   1. How long does one read of Music's player state actually take? The
//      handoff fires at 0.6s remaining and polls at 200ms, so osascript
//      latency is what sets the real resolution.
//   2. Do tracks stop before their reported duration? A track has a finish
//      point, and Music stops there. If finish < duration the engine would
//      wait for an end that never comes and fall back on its missed-handoff
//      rule, which costs a fraction of a second of the wrong song.

const path = require('path');
const { createMusic } = require('../lib/music');
const { execFile } = require('child_process');

if (process.platform !== 'darwin') {
  console.error('Run this on the Mac with Music open.');
  process.exit(1);
}

const PLAYLIST = process.env.JUKEBOX_PLAYLIST || 'Jukebox';
const music = createMusic({ log: () => {} });

const jxa = (file) => new Promise((res, rej) => {
  execFile('osascript', ['-l', 'JavaScript', path.join(__dirname, file)],
    { timeout: 600000, maxBuffer: 64 * 1024 * 1024 },
    (e, out, err) => (e ? rej(new Error(String(err || e.message))) : res(String(out))));
});

(async () => {
  console.log('\nHANDOFF TIMING CHECK\n' + '='.repeat(64));

  // --- 1. how fast is a state read, really? -------------------------------
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const t0 = Date.now();
    await music.readState(PLAYLIST);
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)];
  const p90 = samples[Math.floor(samples.length * 0.9)];
  const max = samples[samples.length - 1];
  console.log(`\nState read latency over ${samples.length} samples:`);
  console.log(`  median ${p50}ms   p90 ${p90}ms   worst ${max}ms`);
  console.log(`  all: ${samples.join(', ')}`);
  if (p90 > 600) {
    console.log('  -> SLOW. The 0.6s handoff has little room; tell Claude this number.');
  } else {
    console.log('  -> Fine. Comfortably inside the 0.6s handoff window.');
  }

  // --- 2. do tracks finish before their duration? -------------------------
  console.log('\nComparing duration against finish point across the library...');
  const raw = JSON.parse(await jxa('track-timing.jxa.js'));
  if (!raw.ok) {
    console.log('  could not read track timings: ' + raw.error);
  } else {
    console.log(`  ${raw.total.toLocaleString()} tracks checked`);
    console.log(`  ${raw.trimmedStart.toLocaleString()} have a start point above 0s`);
    console.log(`  ${raw.trimmedFinish.toLocaleString()} stop more than 0.5s before their duration`);
    if (raw.trimmedFinish) {
      const d = raw.diffs.slice().sort((a, b) => a - b);
      const pct = ((raw.trimmedFinish / raw.total) * 100).toFixed(1);
      console.log(`  that is ${pct}% of the library`);
      console.log(`  shortfall: median ${d[Math.floor(d.length / 2)]}s, worst ${d[d.length - 1]}s`);
      console.log('\n  -> This is the cause. Tell Claude and it will use the finish');
      console.log('     point instead of the duration when deciding the handoff.');
    } else {
      console.log('\n  -> Not the cause. Tracks end where their duration says.');
      console.log('     The 3s overrun was something else; tell Claude the numbers above.');
    }
  }
  console.log('\n' + '='.repeat(64) + '\n');
})().catch((e) => { console.error('\ncheck failed:', e.message, '\n'); process.exit(1); });
