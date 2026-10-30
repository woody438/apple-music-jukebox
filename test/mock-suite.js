'use strict';

// MOCK=1 test suite. No real Music, no audio, no Mac required.
// Run: node test/mock-suite.js        (VERBOSE=1 for engine logging)

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { Engine } = require('../lib/engine');
const { createMockMusic } = require('../lib/mock-music');

const VERBOSE = process.env.VERBOSE === '1';
const qlog = VERBOSE ? (...a) => console.log('   ', ...a) : () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, interval = 20, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout}ms waiting for: ${label}`);
    await sleep(interval);
  }
}

function memStore(initial) {
  let s = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    load: () => (s ? JSON.parse(JSON.stringify(s)) : null),
    save: (v) => { s = JSON.parse(JSON.stringify(v)); },
    clear: () => { s = null; },
    peek: () => s,
  };
}

const BASE_CONFIG = {
  playlistName: 'Jukebox',
  maxPerDevice: 3,
  maxPerHost: 10,
  maxQueueLength: 60,
  repeatWindowMin: 60,
};

async function makeRig(mockOpts = {}, cfgOverrides = {}, saved = null) {
  const music = createMockMusic(
    Object.assign(
      { librarySize: 400, trackSeconds: 6, tickMs: 20, writeLatencyMs: 3, startState: 'stopped', autoplay: true },
      mockOpts
    )
  );
  const store = memStore(saved);
  const config = Object.assign({}, BASE_CONFIG, cfgOverrides);
  const engine = new Engine({ music, config, store, log: qlog });
  await engine.start();
  await engine.reindex();
  return {
    music, engine, store, config,
    pids: engine.index.rows.map((r) => r[0]),
    stop() { engine.stop(); music._sim.stopTimer(); },
  };
}

// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1 ------------------------------------------------------------------------
test('a pick starts playback, with shuffle and repeat forced off', async () => {
  const rig = await makeRig();
  try {
    const r = await rig.engine.pick({ pid: rig.pids[0], deviceId: 'phone1', pickedBy: 'Sam', isHost: false });
    assert.ok(r.ok, 'pick should be accepted');
    await waitFor(
      () => rig.music._sim.player.pid === rig.pids[0] && rig.music._sim.player.state === 'playing',
      { label: 'the pick to be playing' }
    );
    assert.equal(rig.engine.queue.length, 0, 'queue drained');
    assert.equal(rig.engine.nowPlaying.pid, rig.pids[0]);
    assert.equal(rig.engine.nowPlaying.pickedBy, 'Sam', 'picked-by name kept');
    assert.equal(rig.music._sim.shuffleEnabled, false, 'shuffle off');
    assert.equal(rig.music._sim.songRepeat, 'off', 'repeat off');
  } finally { rig.stop(); }
});

// 2 ------------------------------------------------------------------------
test('handoff plays the next pick at the end of the current one, clipping under a second', async () => {
  const rig = await makeRig({ trackSeconds: 12 });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'first pick playing' });
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd1' });

    rig.music._sim.leaveSecondsLeft(1.2);
    const t0 = Date.now();
    await waitFor(() => rig.music._sim.player.pid === rig.pids[1], { label: 'second pick to take over' });
    const elapsed = Date.now() - t0;

    // Handoff fires at 0.6s remaining, so from 1.2s left it should take ~600ms.
    assert.ok(elapsed > 200, `handoff cut the song off early (${elapsed}ms after 1.2s remaining)`);
    assert.ok(elapsed < 2500, `handoff was late (${elapsed}ms)`);
    assert.equal(rig.music._sim.player.isAutoplay, false, 'Autoplay never got a look in');
  } finally { rig.stop(); }
});

// 3 ------------------------------------------------------------------------
test('a pick made during Autoplay waits for the Autoplay song to finish', async () => {
  const rig = await makeRig({ trackSeconds: 12, autoplay: true });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'pick playing' });

    // Let the queue run dry so Music's Autoplay takes the room.
    rig.music._sim.leaveSecondsLeft(0.15);
    await waitFor(() => rig.music._sim.player.isAutoplay === true, { label: 'Autoplay to take over' });
    const autoPid = rig.music._sim.player.pid;

    const r = await rig.engine.pick({ pid: rig.pids[5], deviceId: 'd2', pickedBy: 'Jo' });
    assert.ok(r.ok);

    // The whole point: it must not interrupt.
    await sleep(1500);
    assert.equal(rig.music._sim.player.pid, autoPid, 'the Autoplay song was cut off');
    assert.equal(rig.engine.queue.length, 1, 'the pick is still waiting its turn');

    // ...and then it goes on at the end of that song.
    rig.music._sim.leaveSecondsLeft(1.2);
    await waitFor(() => rig.music._sim.player.pid === rig.pids[5], { label: 'the pick to follow Autoplay' });
  } finally { rig.stop(); }
});

// 4 ------------------------------------------------------------------------
test('guest limits: 3 per phone, 10 for the laptop, no duplicates', async () => {
  const rig = await makeRig();
  try {
    rig.engine.hold = true; // keep everything in the queue so the caps are visible

    for (let i = 0; i < 3; i++) {
      const r = await rig.engine.pick({ pid: rig.pids[i], deviceId: 'phoneA' });
      assert.ok(r.ok, `phoneA pick ${i + 1} accepted`);
    }
    const fourth = await rig.engine.pick({ pid: rig.pids[3], deviceId: 'phoneA' });
    assert.equal(fourth.ok, false, 'phoneA blocked at 4');
    assert.match(fourth.reason, /already/i);

    const otherPhone = await rig.engine.pick({ pid: rig.pids[3], deviceId: 'phoneB' });
    assert.ok(otherPhone.ok, 'a different phone is unaffected');

    for (let i = 4; i < 14; i++) {
      const r = await rig.engine.pick({ pid: rig.pids[i], deviceId: 'laptop', isHost: true });
      assert.ok(r.ok, `host pick ${i - 3} accepted`);
    }
    const eleventh = await rig.engine.pick({ pid: rig.pids[14], deviceId: 'laptop', isHost: true });
    assert.equal(eleventh.ok, false, 'host blocked at 11');

    const dup = await rig.engine.pick({ pid: rig.pids[0], deviceId: 'phoneC' });
    assert.equal(dup.ok, false, 'duplicate of a queued song refused');
    assert.match(dup.reason, /already in the queue/i);

    const unknown = await rig.engine.pick({ pid: 'NOT-A-REAL-PID', deviceId: 'phoneC' });
    assert.equal(unknown.ok, false, 'unknown pid refused');
  } finally { rig.stop(); }
});

// 5 ------------------------------------------------------------------------
test('queue length cap, and the 60-minute repeat rule that the host bypasses', async () => {
  const rig = await makeRig({}, { maxQueueLength: 3 });
  try {
    rig.engine.hold = true;
    for (let i = 0; i < 3; i++) {
      assert.ok((await rig.engine.pick({ pid: rig.pids[i], deviceId: 'p' + i })).ok);
    }
    const full = await rig.engine.pick({ pid: rig.pids[3], deviceId: 'p9' });
    assert.equal(full.ok, false, 'queue cap enforced');
    assert.match(full.reason, /full/i);

    // Something played ten minutes ago.
    rig.engine.queue = [];
    rig.engine.history.push({ pid: rig.pids[20], at: Date.now() - 10 * 60000 });

    const guest = await rig.engine.pick({ pid: rig.pids[20], deviceId: 'phoneA' });
    assert.equal(guest.ok, false, 'guest blocked by the repeat window');
    assert.match(guest.reason, /recently/i);

    const host = await rig.engine.pick({ pid: rig.pids[20], deviceId: 'laptop', isHost: true });
    assert.ok(host.ok, 'host bypasses the repeat rule');
  } finally { rig.stop(); }
});

// 6 ------------------------------------------------------------------------
test('an external pause sets hold: picks queue up but nothing starts until resume', async () => {
  const rig = await makeRig({ trackSeconds: 30 });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.state === 'playing', { label: 'playing' });

    rig.music._sim.externalPause(); // media key / space bar in Music
    await waitFor(() => rig.engine.hold === true, { label: 'hold to be set' });

    const r = await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd1' });
    assert.ok(r.ok, 'picks are still accepted while held');

    await sleep(1200);
    assert.equal(rig.music._sim.player.state, 'paused', 'still paused -- hold respected');
    assert.equal(rig.engine.queue.length, 1, 'the pick waited');

    rig.music._sim.externalPlay();
    await waitFor(() => rig.engine.hold === false, { label: 'hold to clear on resume' });
  } finally { rig.stop(); }
});

// 7 ------------------------------------------------------------------------
test('a server restart restores the queue and rebuilds the playlist', async () => {
  const music = createMockMusic({ librarySize: 300, trackSeconds: 20, tickMs: 20, writeLatencyMs: 2, startState: 'stopped' });
  const store = memStore(null);
  const config = Object.assign({}, BASE_CONFIG);

  const first = new Engine({ music, config, store, log: qlog });
  await first.start();
  await first.reindex();
  const pids = first.index.rows.map((r) => r[0]);

  first.hold = true;
  await first.pick({ pid: pids[0], deviceId: 'd1', pickedBy: 'Ana' });
  await first.pick({ pid: pids[1], deviceId: 'd2', pickedBy: 'Bo' });
  assert.equal(first.queue.length, 2);
  first.stop();

  const saved = store.peek();
  assert.ok(saved && saved.queue.length === 2, 'queue written to the store');

  // Music kept running; only the server restarted.
  const second = new Engine({ music, config, store, log: qlog });
  await second.start();
  try {
    assert.equal(second.queue.length, 2, 'queue restored');
    assert.equal(second.queue[0].pickedBy, 'Ana', 'picked-by names survived');
    assert.equal(second.hold, true, 'hold survived');
    const st = await music.readState('Jukebox');
    assert.deepEqual(st.playlistPids, [pids[0], pids[1]], 'playlist rebuilt to match the queue');
  } finally { second.stop(); music._sim.stopTimer(); }
});

// 8 ------------------------------------------------------------------------
test('if Music picks up the appended track itself, the pick is promoted not restarted', async () => {
  const rig = await makeRig({ trackSeconds: 30, appendPickedUp: true });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'first pick playing' });
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd1', pickedBy: 'Kit' });
    await sleep(120);

    rig.music._sim.externalNext(); // Music moves on by itself, into our appended track

    await waitFor(
      () => rig.engine.nowPlaying && rig.engine.nowPlaying.pid === rig.pids[1],
      { label: 'the pick to be promoted' }
    );
    assert.equal(rig.engine.queue.length, 0, 'promoted, not left in the queue');
    assert.equal(rig.engine.nowPlaying.pickedBy, 'Kit');
  } finally { rig.stop(); }
});

// 9 ------------------------------------------------------------------------
test('stopped Music starts the next pick immediately', async () => {
  const rig = await makeRig({ trackSeconds: 5, autoplay: false });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'playing' });
    rig.music._sim.leaveSecondsLeft(0.1);
    await waitFor(() => rig.music._sim.player.state === 'stopped', { label: 'Music to stop' });

    const t0 = Date.now();
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[1], { label: 'next pick from a stop' });
    assert.ok(Date.now() - t0 < 2500, 'started promptly from stopped');
  } finally { rig.stop(); }
});

// 10 -----------------------------------------------------------------------
test('a different song starting while picks wait is taken back immediately', async () => {
  const rig = await makeRig({ trackSeconds: 30, autoplay: true });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'pick playing' });
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd1' });
    await sleep(700); // the pick is demonstrably waiting before the track changes

    // Simulate the handoff being missed: Music jumps to an unrelated track.
    rig.engine.nowPlaying = null;
    rig.music._sim.player.isAutoplay = true;
    rig.music._sim.externalNext();

    await waitFor(() => rig.music._sim.player.pid === rig.pids[1], {
      label: 'the waiting pick to take the room back',
    });
  } finally { rig.stop(); }
});

// 11 -----------------------------------------------------------------------
test('a pick missing from the playlist triggers a rebuild rather than silence', async () => {
  const rig = await makeRig({ trackSeconds: 30 });
  try {
    rig.engine.hold = true;
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd1' });

    // Somebody emptied the Jukebox playlist in Music.
    rig.music._sim.playlists.set('Jukebox', []);
    rig.engine.playlistPids = [];
    rig.engine.hold = false;

    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'rebuild then play' });
    const pl = rig.music._sim.playlists.get('Jukebox');
    assert.ok(pl.includes(rig.pids[1]), 'the rest of the queue is back in the playlist');
  } finally { rig.stop(); }
});

// 12 -----------------------------------------------------------------------
test('the playlist is tidied away once the queue runs dry', async () => {
  const rig = await makeRig({ trackSeconds: 5, autoplay: true });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'playing' });
    rig.music._sim.leaveSecondsLeft(0.15);
    await waitFor(() => rig.music._sim.player.isAutoplay === true, { label: 'Autoplay' });

    rig.engine._lastHousekeepAt = 0; // open the 15s housekeeping window now
    await waitFor(() => (rig.music._sim.playlists.get('Jukebox') || []).length === 0, {
      label: 'the playlist to be cleared',
    });
  } finally { rig.stop(); }
});

// 13 -----------------------------------------------------------------------
test('Music writes never overlap, however fast the picks arrive', async () => {
  const rig = await makeRig({ writeLatencyMs: 12 });
  try {
    rig.engine.hold = true;
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => rig.engine.pick({ pid: rig.pids[i], deviceId: 'd' + i })));
    assert.equal(rig.music._sim.maxConcurrentWrites, 1, 'the write mutex held throughout');
    assert.equal(rig.engine.queue.length, 6);
  } finally { rig.stop(); }
});

// 14 -----------------------------------------------------------------------
test('the index drops non-songs, unchecked tracks and unavailable cloud tracks', async () => {
  const rig = await makeRig({ librarySize: 1000 });
  try {
    const s = rig.engine.index.stats;
    assert.equal(s.total, 1000);
    assert.ok(s.excludedNotSong > 0, 'music videos dropped');
    assert.ok(s.excludedDisabled > 0, 'unchecked tracks dropped');
    assert.ok(s.excludedCloud > 0, 'unavailable cloud tracks dropped');
    assert.equal(s.kept, s.total - s.excludedNotSong - s.excludedDisabled - s.excludedCloud - s.excludedNoPid);

    const bad = new Set(rig.music._sim.library
      .filter((t) => t.mediaKind !== 'song' || !t.enabled ||
        ['noLongerAvailable', 'ineligible', 'prerelease', 'error'].includes(t.cloudStatus))
      .map((t) => t.pid));
    assert.ok(!rig.engine.index.rows.some((r) => bad.has(r[0])), 'no excluded track reached the index');

    // Selection codes are unique and shaped like B-42.
    const codes = rig.engine.index.rows.map((r) => r[5]);
    assert.equal(new Set(codes).size, codes.length, 'selection codes unique');
    assert.ok(codes.every((c) => /^[A-Z#]-\d+$/.test(c)), 'selection codes well formed');
  } finally { rig.stop(); }
});

// 15 -----------------------------------------------------------------------
test('host endpoints answer the laptop and refuse everything else', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-test-'));
  const port = 8599;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      MOCK: '1', PORT: String(port), JUKEBOX_DATA_DIR: tmp, MOCK_LIBRARY: '200',
    }),
    stdio: VERBOSE ? 'inherit' : 'ignore',
  });

  const remoteIp = (() => {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return null;
  })();

  try {
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`).catch(() => null);
      return r && r.ok;
    }, { label: 'the server to come up', timeout: 20000 });

    const asHost = await fetch(`http://127.0.0.1:${port}/api/host/skip`, { method: 'POST' });
    assert.equal(asHost.status, 200, 'the laptop may use host controls');

    const cfgLocal = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    assert.equal(cfgLocal.isHost, true, 'loopback is recognised as the host');

    if (!remoteIp) {
      console.log('    (no non-loopback address on this box -- remote rejection not exercised)');
    } else {
      for (const verb of ['skip', 'clear', 'reindex', 'playpause']) {
        const r = await fetch(`http://${remoteIp}:${port}/api/host/${verb}`, { method: 'POST' });
        assert.equal(r.status, 403, `/api/host/${verb} refuses a non-loopback caller`);
      }
      const cfgRemote = await (await fetch(`http://${remoteIp}:${port}/api/config`)).json();
      assert.equal(cfgRemote.isHost, false, 'a phone is not the host');
      assert.equal(cfgRemote.maxPerDevice, 3, 'phones are told the guest limit');

      // A phone can still read state and pick.
      const stRemote = await fetch(`http://${remoteIp}:${port}/api/state`);
      assert.equal(stRemote.status, 200, 'guests can read state');

      const ix = await (await fetch(`http://${remoteIp}:${port}/api/index`)).json();
      assert.ok(ix.rows.length > 0, 'guests can fetch the index');
      const pickRes = await fetch(`http://${remoteIp}:${port}/api/pick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: ix.rows[0][0], deviceId: 'curl-phone', pickedBy: 'Curl' }),
      });
      assert.equal(pickRes.status, 200, 'guests can pick');
      assert.ok((await pickRes.json()).ok);
    }
  } finally {
    child.kill('SIGKILL');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  const t0 = Date.now();
  console.log('\nMOCK SUITE\n' + '='.repeat(72));
  for (const t of tests) {
    const started = Date.now();
    try {
      await t.fn();
      console.log(`PASS  ${t.name}  (${Date.now() - started}ms)`);
      pass++;
    } catch (e) {
      console.log(`FAIL  ${t.name}  (${Date.now() - started}ms)`);
      console.log(`      ${e.message}`);
      if (VERBOSE && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
      fail++;
    }
  }
  console.log('='.repeat(72));
  console.log(`${pass} passed, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  process.exit(fail ? 1 : 0);
})();
