'use strict';

// MOCK=1 test suite. No real Music, no audio, no Mac required.
// Run: node test/mock-suite.js        (VERBOSE=1 for engine logging,
//                                     ONLY=<text> for a subset)

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { Engine } = require('../lib/engine');
const { createMockMusic } = require('../lib/mock-music');
const { pickLanAddress, lanCandidates, isPrivateIPv4, wifiQrText } = require('../lib/net');

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
test('the handoff survives a slow osascript read instead of falling back', async () => {
  // A healthy Mac answers a state read in ~300ms; a Mac busy streaming to a
  // party while twenty phones hit the server is slower. The position it
  // reports is stale by that whole round trip, so uncorrected the engine
  // believes it has more time than it has, fires after the track has already
  // ended, and lands on the recovery path -- a fraction of a second of the
  // wrong song, on every single track.
  //
  // 700ms is chosen because it is where the difference decides the outcome:
  // without the correction this test fails with reason "recovered".
  const rig = await makeRig({ trackSeconds: 16, readLatencyMs: 700 });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'first pick playing' });
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd1' });

    rig.music._sim.leaveSecondsLeft(3.5);
    await waitFor(() => rig.music._sim.player.pid === rig.pids[1], { label: 'second pick to take over' });

    const how = rig.engine.lastStart;
    assert.equal(how.reason, 'handoff',
      `expected the clean handoff, got "${how.reason}" -- the read latency correction is not working`);
    assert.ok(how.remaining !== null && how.remaining <= 0.6 + 0.01,
      `fired at ${how.remaining}s remaining, outside the handoff window`);
    assert.equal(rig.music._sim.player.isAutoplay, false, 'Autoplay never got in');
  } finally { rig.stop(); }
});

// 16 -----------------------------------------------------------------------

test('host endpoints answer the laptop and refuse everything else', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-test-'));
  const port = 8599;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      MOCK: '1', PORT: String(port), JUKEBOX_DATA_DIR: tmp, MOCK_LIBRARY: '200',
      // Explicit and different, so "a phone is told the GUEST limit" is
      // testable whatever the shipped defaults happen to be.
      JUKEBOX_MAX_PER_PHONE: '4', JUKEBOX_MAX_PER_LAPTOP: '11',
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
      assert.equal(cfgRemote.maxPerDevice, 4, 'phones are told the GUEST limit');
      assert.equal(cfgLocal.maxPerDevice, 11, 'the laptop is told the HOST limit');

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

// 17 -----------------------------------------------------------------------
test('a pick keeps its picked-by name when a stale read lands on the handoff', async () => {
  // A read takes ~300ms. One already in flight when the handoff fires still
  // reports the PREVIOUS track, and taking that at face value wipes
  // nowPlaying -- so the song plays out shown as AUTOPLAY with nobody's name
  // on it. At a party that is the entire point of the feature, gone.
  const rig = await makeRig({ trackSeconds: 14, readLatencyMs: 400 });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1', pickedBy: 'Ana' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'first pick playing' });
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd2', pickedBy: 'Bo' });

    // Let the poll loop settle into its rhythm first. The race needs a read
    // to be IN FLIGHT when the handoff timer fires, and firing immediately
    // after the pick lands on the wrong side of that rhythm.
    await sleep(250);
    rig.music._sim.leaveSecondsLeft(2.5);
    await waitFor(() => rig.music._sim.player.pid === rig.pids[1], { label: 'the handoff' });

    // Give any in-flight read time to land and do its damage.
    //
    // Checked on EVERY sample, not only once the snapshot catches up to the
    // new track id: a stale read reports the OLD track for a moment after
    // the handoff, and an earlier version of this test skipped exactly those
    // samples -- which is precisely the window where the name is lost.
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const np = rig.engine.snapshot().nowPlaying;
      assert.ok(np, 'nothing playing at all after the handoff');
      assert.equal(np.isPick, true, 'the pick was reported as Autoplay');
      assert.equal(np.pickedBy, 'Bo', 'the picked-by name was lost');
      await sleep(100);
    }

    const final = rig.engine.snapshot();
    assert.equal(final.nowPlaying.pid, rig.pids[1]);
    assert.equal(final.nowPlaying.isPick, true, 'still a pick once everything settled');
    assert.equal(final.nowPlaying.pickedBy, 'Bo');
  } finally { rig.stop(); }
});

// 18 -----------------------------------------------------------------------

test('a crowd of phones asking for artwork costs one Music call, not one each', async () => {
  // Artwork rides the write mutex, and the poll loop stands aside for writes.
  // Without an in-flight guard, every phone that sees a new track starts its
  // own osascript; they queue, and the engine goes blind for as long as it
  // takes to drain them -- at exactly the moment the handoff needs to see.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-art-'));
  const port = 8601;
  const WRITE_MS = 200;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      MOCK: '1', PORT: String(port), JUKEBOX_DATA_DIR: tmp,
      MOCK_LIBRARY: '200', MOCK_WRITE_LATENCY: String(WRITE_MS),
    }),
    stdio: VERBOSE ? 'inherit' : 'ignore',
  });

  try {
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`).catch(() => null);
      return r && r.ok;
    }, { label: 'the server to come up', timeout: 20000 });

    // Get something playing, so there is a track to fetch artwork for.
    const ix = await (await fetch(`http://127.0.0.1:${port}/api/index`)).json();
    await fetch(`http://127.0.0.1:${port}/api/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: ix.rows[0][0], deviceId: 'phone-0' }),
    });
    await waitFor(async () => {
      const s = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
      return !!(s.nowPlaying && s.nowPlaying.pid === ix.rows[0][0]);
    }, { label: 'the pick to be playing' });

    const PHONES = 12;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: PHONES }, () =>
      fetch(`http://127.0.0.1:${port}/api/artwork`).then((r) => r.status)));
    const elapsed = Date.now() - t0;

    // Serialised, twelve phones would cost twelve round trips through the
    // mutex. Deduped, they share one.
    assert.ok(elapsed < WRITE_MS * 4,
      `${PHONES} concurrent artwork requests took ${elapsed}ms; ` +
      `one call is ~${WRITE_MS}ms, twelve would be ~${WRITE_MS * PHONES}ms`);
  } finally {
    child.kill('SIGKILL');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

// 18 -----------------------------------------------------------------------
test('the QR code follows the default route, not the interface name', async () => {
  // A Mac mini with two adapters advertised the wrong network and no phone
  // could reach it. The old rule preferred en0 believing it was the Wi-Fi --
  // true on a laptop, false on a mini, where en0 is usually Ethernet.
  const mini = {
    en0: [{ family: 'IPv4', internal: false, address: '10.77.0.5' }],      // Ethernet
    en1: [{ family: 'IPv4', internal: false, address: '192.168.1.40' }],   // Wi-Fi
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  };
  assert.equal(pickLanAddress(lanCandidates(mini), 'en1'), '192.168.1.40',
    'should follow the default route to Wi-Fi, not pick en0 by name');
  assert.equal(pickLanAddress(lanCandidates(mini), 'en0'), '10.77.0.5',
    'and to Ethernet when that is the default route');

  // The laptop case must not regress.
  assert.equal(pickLanAddress(lanCandidates({
    en0: [{ family: 'IPv4', internal: false, address: '10.0.0.23' }],
  }), 'en0'), '10.0.0.23');

  // No routing information (not macOS, or route refused) still yields one.
  assert.ok(pickLanAddress(lanCandidates(mini), null));

  // A VPN tunnel must not outrank the real network.
  assert.equal(pickLanAddress(lanCandidates({
    utun3: [{ family: 'IPv4', internal: false, address: '10.9.9.9' }],
    en1: [{ family: 'IPv4', internal: false, address: '192.168.1.40' }],
  }), 'en1'), '192.168.1.40');

  // Guests are never handed a public address.
  assert.equal(lanCandidates({ en0: [{ family: 'IPv4', internal: false, address: '192.0.2.2' }] }).length, 0);
  assert.ok(!isPrivateIPv4('192.0.2.2'));
  assert.ok(isPrivateIPv4('172.16.4.4') && isPrivateIPv4('192.168.0.1') && isPrivateIPv4('10.1.2.3'));
  assert.ok(pickLanAddress([], 'en0') === null, 'no addresses at all is not a crash');
});

// Records every track the mock starts, in order, for tests that need to know
// what the room actually heard rather than where the engine ended up.
function playRecorder() {
  const plays = [];
  return {
    plays,
    log: (m) => {
      const x = /\[mock\] play (\(autoplay\) )?(\S+)/.exec(String(m));
      if (x) plays.push({ pid: x[2], at: Date.now(), autoplay: !!x[1] });
    },
  };
}

// 20 -----------------------------------------------------------------------
test('two starts at once play one pick, and never drop the pick behind it', async () => {
  // The booked handoff and a poll can both decide the moment has come. Each
  // took the queue head AFTER awaiting the play, so the second played the
  // same pick again and then shifted the NEXT pick off the queue unplayed.
  // A host double-tapping skip did exactly the same.
  const rig = await makeRig({ writeLatencyMs: 40 });
  try {
    rig.engine.hold = true;   // let the queue build without anything starting
    for (let i = 0; i < 4; i++) await rig.engine.pick({ pid: rig.pids[i], deviceId: 'd' + i });
    assert.equal(rig.engine.queue.length, 4);

    await Promise.all([rig.engine.skip(), rig.engine.skip()]);

    assert.equal(rig.music._sim.ops.filter((o) => o === 'playTrack').length, 1, 'one play, not two');
    assert.equal(rig.engine.nowPlaying.pid, rig.pids[0]);
    assert.deepEqual(rig.engine.queue.map((q) => q.pid), rig.pids.slice(1, 4),
      'the pick behind the one that started was dropped without playing');
  } finally { rig.stop(); }
});

// 21 -----------------------------------------------------------------------
test('a read in flight across a handoff never cuts the new pick short', async () => {
  // A read takes ~300ms and the handoff timer fires on its own schedule, so
  // a read is often in flight at the handoff. It comes back describing the
  // OLD track with ~0.3s left, and the engine used to act on it: "track
  // ending, picks waiting, hand off" -- starting the pick AFTER the one that
  // had just begun. The room heard the end of one song, half a second of the
  // next, then a third. Test 17 never saw this because it queues one pick
  // behind the current one, so the stale handoff found an empty queue.
  const rec = playRecorder();
  const N = 4;
  const rig = await makeRig({ trackSeconds: 14, readLatencyMs: 400, writeLatencyMs: 250, log: rec.log });
  try {
    for (let i = 0; i < N; i++) await rig.engine.pick({ pid: rig.pids[i], deviceId: 'd' + i });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'first pick playing' });

    for (let i = 1; i < N; i++) {
      // Vary the phase against the poll rhythm, so the timer lands both
      // inside and outside a read across the run.
      // 3s left, not less: a 400ms read on an 800ms poll needs that long to
      // see the jump at all, and real songs do not jump -- they approach.
      await sleep(250 + i * 90);
      rig.music._sim.leaveSecondsLeft(3);
      await waitFor(() => rig.music._sim.player.pid === rig.pids[i], { label: `pick ${i} to take over`, timeout: 5000 });
      await sleep(1200);   // long enough for a stale read to land and do its damage
    }

    assert.deepEqual(rec.plays.map((p) => p.pid), rig.pids.slice(0, N),
      'every pick should play exactly once, in order, with nothing in between');
    for (let i = 1; i < N - 1; i++) {
      const heard = rec.plays[i + 1].at - rec.plays[i].at;
      assert.ok(heard > 1200, `pick ${i} was cut off after ${heard}ms by the pick behind it`);
    }
  } finally { rig.stop(); }
});

// 22 -----------------------------------------------------------------------
test('with crossfade on, the handoff learns to get in before Music does', async () => {
  // Crossfade Songs makes Music start its own next track N seconds before
  // the end. A handoff at 0.6s left never wins that race, so every pick came
  // in by the recovery path and the room heard a second of whatever Music
  // had chosen first. The engine now measures how early Music leaves a track
  // and books the handoff that much sooner.
  const rec = playRecorder();
  const rig = await makeRig({ trackSeconds: 12, crossfadeSec: 3, readLatencyMs: 150, log: rec.log });
  try {
    // A pick plays out into Autoplay with nothing waiting. Music leaves it 3s
    // early, and that is the measurement.
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'pick playing' });
    await sleep(300);
    rig.music._sim.leaveSecondsLeft(4);
    await waitFor(() => rig.music._sim.player.isAutoplay, { label: 'Autoplay to take over' });
    await waitFor(() => rig.engine.musicLeadSec > 0, { label: 'the crossfade to be measured', timeout: 3000 });
    assert.ok(Math.abs(rig.engine.musicLeadSec - 3) < 0.4,
      `measured Music leaving ${rig.engine.musicLeadSec}s early, expected ~3s`);

    // Somebody picks during that Autoplay song. It must ride the song out
    // and still arrive BEFORE Music crossfades into another Autoplay song.
    const autoplayPid = rig.music._sim.player.pid;
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd2' });
    await sleep(300);
    rig.music._sim.leaveSecondsLeft(5);
    await waitFor(() => rig.music._sim.player.pid === rig.pids[1], { label: 'the pick to take over', timeout: 5000 });

    const how = rig.engine.lastStart;
    assert.equal(how.reason, 'handoff', `expected the clean handoff, got "${how.reason}"`);
    assert.ok(how.remaining > 3 && how.remaining <= 3.6 + 0.05,
      `handed off at ${how.remaining}s left; Music crossfades at 3s`);
    const i = rec.plays.findIndex((p) => p.pid === rig.pids[1]);
    assert.equal(rec.plays[i - 1].pid, autoplayPid, 'another Autoplay song got in before the pick');
  } finally { rig.stop(); }
});

// 23 -----------------------------------------------------------------------
test('with crossfade on, Music still showing the old song after a handoff does not skip the pick', async () => {
  // Not measured on a real Mac: Music may go on reporting the song it is
  // crossfading OUT of for a while after the play. Past the 1s settle window
  // the engine took that as "the pick is gone, a song is ending, hand off"
  // and started the pick after next -- the reported skip again, by another
  // road. Readings that still show the song we played over now get the
  // length of the crossfade before anything is decided on them.
  const rig = await makeRig({ trackSeconds: 14, crossfadeSec: 3, playSwitchLagMs: 2000, readLatencyMs: 150 });
  try {
    await rig.engine.pick({ pid: rig.pids[0], deviceId: 'd1' });
    await waitFor(() => rig.music._sim.player.pid === rig.pids[0], { label: 'pick playing' });
    await sleep(300);
    rig.music._sim.leaveSecondsLeft(4);
    await waitFor(() => rig.engine.musicLeadSec > 0, { label: 'the crossfade to be measured', timeout: 4000 });

    // Two picks during the Autoplay song: the first rides it out, the
    // second must wait for the first.
    await rig.engine.pick({ pid: rig.pids[1], deviceId: 'd2', pickedBy: 'Ana' });
    await rig.engine.pick({ pid: rig.pids[2], deviceId: 'd3', pickedBy: 'Bo' });
    await sleep(300);
    rig.music._sim.leaveSecondsLeft(5);
    await waitFor(() => rig.music._sim.player.pid === rig.pids[1], { label: 'the first pick to take over', timeout: 5000 });

    // Out past the lag and the settle window, with room to spare.
    await sleep(3500);
    assert.equal(rig.music._sim.player.pid, rig.pids[1], 'the first pick was skipped');
    assert.equal(rig.engine.nowPlaying && rig.engine.nowPlaying.pickedBy, 'Ana', 'the first pick lost its name');
    assert.deepEqual(rig.engine.queue.map((q) => q.pid), [rig.pids[2]], 'the second pick should still be waiting');
  } finally { rig.stop(); }
});

// 24 -----------------------------------------------------------------------
test('the measured crossfade survives a restart, and junk on disk is ignored', async () => {
  // Otherwise a restart mid-party relearns it on a guest's song.
  const rig = await makeRig({}, {}, { queue: [], leadSamples: [6.1, 'x', 5.9, -3, 99, 6] });
  try {
    assert.equal(rig.engine.musicLeadSec, 6, 'median of the sane samples');
    rig.engine._persist();
    assert.deepEqual(rig.store.peek().leadSamples, [6.1, 5.9, 6], 'saved back as it was loaded');
  } finally { rig.stop(); }

  const quiet = await makeRig({}, {}, { queue: [], leadSamples: [0.2, 0, 0.3] });
  try {
    assert.equal(quiet.engine.musicLeadSec, 0, 'under half a second is noise, not crossfade');
  } finally { quiet.stop(); }
});

// 25 -----------------------------------------------------------------------
test('a stale reading that shows Music already on its own song still measures the crossfade', async () => {
  // With a 1s crossfade Music moves 0.4s before the 0.6s handoff -- inside a
  // single read, and reads stand aside while the play is being written. The
  // one reading that can catch Music on its own song is then one that began
  // before our play finished, which is thrown away as stale; so the
  // crossfade was never measured while picks kept coming, and Music won by
  // 0.4s on every song. Whether such a reading exists is down to timing, so
  // this hands the engine exactly that reading rather than racing for it.
  const rig = await makeRig();
  try {
    const e = rig.engine;
    e.stop();   // no background ticks: this test is the only reader
    const [A, B, X] = rig.pids;
    const real = rig.music.readState;
    const stale = (pid) => async () => Object.assign(await real('Jukebox'), {
      readLatencyMs: 300, state: 'playing', position: 0.2,
      track: { pid, title: 't', artist: 'a', album: 'b', duration: 200 },
    });
    const setScene = () => {
      const t = Date.now();
      e._leadSamples = []; e._applyLeadSamples();
      e._lastObs = { pid: A, sampledAtMs: t - 900, endsAtMs: t + 500 };   // A due to end in 0.5s
      e._lastCommandPid = B; e._lastCommandAt = t - 250; e._lastPlayAt = t - 5;   // B just sent
      e._lastTrackPid = B;
    };

    // A reading that began before B was sent, showing X 0.2s in (0.5s with
    // the read's own 0.3s): X started 0.5s ago, A was due in 0.5s -> 1.0s.
    setScene();
    rig.music.readState = stale(X);
    await e._tickOnce();
    assert.ok(Math.abs(e.musicLeadSec - 1.0) < 0.1, `measured ${e.musicLeadSec}s, expected ~1.0s`);
    assert.equal(e._lastTrackPid, B, 'a stale reading must still decide nothing');

    // Showing our own pick, or the old song, it proves nothing about Music.
    for (const [pid, what] of [[B, 'the pick we sent'], [A, 'the song we were timing']]) {
      setScene();
      rig.music.readState = stale(pid);
      await e._tickOnce();
      assert.equal(e.musicLeadSec, 0, `measured a crossfade from a stale reading of ${what}`);
    }
  } finally { rig.stop(); }
});

// 26 -----------------------------------------------------------------------
test('the Wi-Fi QR text escapes the characters that would end a field early', async () => {
  assert.equal(wifiQrText('Home', 'secret123'), 'WIFI:T:WPA;S:Home;P:secret123;;');
  // An unescaped ; ends the password early and the phone joins with the
  // wrong one. Apostrophes and spaces are ordinary characters, not escaped.
  assert.equal(wifiQrText("Woody's Wi-Fi", 'a;b,c:d"e\\f'),
    "WIFI:T:WPA;S:Woody's Wi-Fi;P:a\\;b\\,c\\:d\\\"e\\\\f;;");
  assert.equal(wifiQrText('Café 🎶', 'x'), 'WIFI:T:WPA;S:Café 🎶;P:x;;', 'non-ASCII passes through');
  assert.equal(wifiQrText('Open House', ''), 'WIFI:T:nopass;S:Open House;;', 'no password is an open network');
  assert.equal(wifiQrText('', 'x'), null, 'no name, no code');
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  const t0 = Date.now();
  console.log('\nMOCK SUITE\n' + '='.repeat(72));
  // ONLY=<text> runs the tests whose name contains it, e.g. ONLY=crossfade.
  const only = process.env.ONLY;
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
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
