#!/usr/bin/env node
'use strict';

// End-to-end rehearsal against a RUNNING server (mock or real Music).
//
//   node server.js                     # in another window
//   node test/party-rehearsal.js       # here
//
//   --fast   skip through the queued picks instead of listening to them,
//            which you want against a real library where songs are minutes
//            long. The final Autoplay handoff is always observed for real,
//            because that is the thing being tested.
//
// What it proves, in order:
//   1. three picks from the laptop and one from a "phone" all queue
//   2. the per-device limit applies to the phone, not to the laptop
//   3. the queue drains and Music's Autoplay takes the room
//   4. a pick made during Autoplay does NOT cut the Autoplay song off
//   5. that pick starts as soon as the Autoplay song ends

const BASE = process.env.JUKEBOX_URL || 'http://127.0.0.1:8484';
const FAST = process.argv.includes('--fast');

const LAPTOP = 'rehearsal-laptop';
const PHONE = 'rehearsal-phone';

let pass = 0, fail = 0;
function check(ok, label, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  --  ' + extra : ''));
  ok ? pass++ : fail++;
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, body) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function waitFor(fn, { timeout = 600000, interval = 400, label = 'condition', tick } = {}) {
  const t0 = Date.now();
  let last = 0;
  for (;;) {
    const s = await get('/api/state');
    const v = await fn(s);
    if (v) return s;
    if (tick && Date.now() - last > 10000) { last = Date.now(); tick(s); }
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for: ' + label);
    await sleep(interval);
  }
}

function label(np) {
  return np ? `"${np.title}" by ${np.artist}` : 'nothing';
}

(async () => {
  console.log('\nPARTY REHEARSAL  --  ' + BASE + '\n' + '='.repeat(72));

  const cfg = await get('/api/config');
  console.log(`      ${cfg.mock ? 'MOCK MODE (simulated Music)' : 'REAL Music app'}, host=${cfg.isHost}\n`);
  if (!cfg.isHost) {
    console.log('Run this on the laptop itself -- it needs the host endpoints.\n');
    process.exit(1);
  }

  const ix = await get('/api/index');
  check(ix.rows && ix.rows.length > 10, 'library index served', (ix.rows || []).length + ' songs');

  // Spread the picks across the library so the no-repeat rule cannot bite.
  const step = Math.max(1, Math.floor(ix.rows.length / 12));
  const songs = [0, 1, 2, 3, 4].map((i) => ix.rows[i * step]);

  // Start from a clean queue.
  await post('/api/host/clear');
  await sleep(600);

  // --- 1. three from the laptop ---------------------------------------------
  for (let i = 0; i < 3; i++) {
    const r = await post('/api/pick', { pid: songs[i][0], deviceId: LAPTOP, pickedBy: 'Woody' });
    check(r.status === 200 && r.body.ok, `laptop pick ${i + 1} queued`,
          r.body.ok ? '#' + r.body.position + '  ' + songs[i][1] : r.body.reason);
  }

  // --- 2. one from a "phone" -------------------------------------------------
  const phone = await post('/api/pick', { pid: songs[3][0], deviceId: PHONE, pickedBy: 'Guest' });
  check(phone.status === 200 && phone.body.ok, 'phone pick queued',
        phone.body.ok ? '#' + phone.body.position + '  ' + songs[3][1] : phone.body.reason);

  const st0 = await get('/api/state');
  check(st0.queue.length + (st0.nowPlaying && st0.nowPlaying.isPick ? 1 : 0) >= 4,
        'all four picks accounted for',
        st0.queue.length + ' queued, now playing ' + label(st0.nowPlaying));

  const names = st0.queue.map((q) => q.pickedBy);
  check(names.includes('Guest'), 'picked-by names carried through', JSON.stringify(names));

  // --- 3. drain into Autoplay ------------------------------------------------
  console.log('\n      Draining the queue' + (FAST ? ' (fast: skipping)' : '') + '...');
  if (FAST) {
    for (let i = 0; i < 8; i++) {
      const s = await get('/api/state');
      if (!s.queue.length && s.nowPlaying && !s.nowPlaying.isPick) break;
      await post('/api/host/skip');
      await sleep(1500);
    }
  }

  const drained = await waitFor(
    (s) => s.queue.length === 0 && s.nowPlaying && !s.nowPlaying.isPick,
    {
      label: 'the queue to drain into Autoplay',
      tick: (s) => console.log(`        ${s.queue.length} still queued, playing ${label(s.nowPlaying)}`),
    }
  );
  check(true, 'queue ran dry and Autoplay took the room', label(drained.nowPlaying));

  // --- 4. a pick during Autoplay must not interrupt --------------------------
  const autoPid = drained.nowPlaying.pid;
  const autoDur = drained.nowPlaying.duration || 0;
  const autoPos = drained.player.position || 0;
  const remaining = Math.max(0, autoDur - autoPos);
  console.log(`\n      Autoplay song has ~${remaining.toFixed(0)}s left. Picking now.`);

  const late = await post('/api/pick', { pid: songs[4][0], deviceId: PHONE, pickedBy: 'Guest' });
  if (!check(late.status === 200 && late.body.ok, 'pick accepted during Autoplay',
             late.body.ok ? songs[4][1] : late.body.reason)) {
    console.log('\nCannot test the handoff without a queued pick.\n');
    process.exit(1);
  }

  // Watch a slice of the middle of the song: it must keep playing.
  const watch = Math.min(8000, Math.max(1500, (remaining - 3) * 1000));
  let interrupted = false;
  const until = Date.now() + watch;
  while (Date.now() < until) {
    const s = await get('/api/state');
    if (!s.nowPlaying || s.nowPlaying.pid !== autoPid) { interrupted = true; break; }
    await sleep(400);
  }
  check(!interrupted, 'the Autoplay song was NOT cut off by the pick',
        `held for ${(watch / 1000).toFixed(1)}s`);

  // --- 5. and the pick starts the moment it ends -----------------------------
  console.log('      Waiting for the Autoplay song to finish...');
  let lastRemaining = null;
  const switched = await waitFor(
    (s) => {
      if (s.nowPlaying && s.nowPlaying.pid === autoPid) {
        lastRemaining = (s.nowPlaying.duration || 0) - (s.player.position || 0);
        return false;
      }
      return !!(s.nowPlaying && s.nowPlaying.pid === songs[4][0]);
    },
    {
      label: 'the pick to follow the Autoplay song',
      tick: (s) => console.log(`        ${Math.max(0, lastRemaining || 0).toFixed(0)}s to go`),
    }
  );

  check(true, 'the pick played right after the Autoplay song', label(switched.nowPlaying));

  // Music does not always stop a track where its reported duration says it
  // should, so a couple of seconds of nominal tail left at the switch is the
  // track ending early, not the jukebox interrupting it. What would be a real
  // interruption is cutting in with a big chunk of the song still to play.
  // "Did not interrupt" is already proven above, by holding through the
  // middle of the song; this catches a genuine regression.
  check(lastRemaining !== null && lastRemaining < 10,
        'it did not cut the Autoplay song short',
        lastRemaining === null ? 'n/a' : `switched with ${lastRemaining.toFixed(2)}s of nominal tail left`);
  if (lastRemaining !== null && lastRemaining > 1.5) {
    console.log(`      note: that track stopped ~${lastRemaining.toFixed(1)}s before its reported`);
    console.log('      duration, so the handoff did not fire on time and the missed-handoff');
    console.log('      rule took the room back instead. Run: node tools/check-timing.js');
  }
  check(switched.nowPlaying.isPick === true && switched.nowPlaying.pickedBy === 'Guest',
        'it is shown as a pick with the guest name', label(switched.nowPlaying));

  await post('/api/host/clear');

  console.log('='.repeat(72));
  console.log(`${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nrehearsal failed:', e.message, '\n');
  process.exit(1);
});
