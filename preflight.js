#!/usr/bin/env node
'use strict';

// Preflight against the REAL Music app. Run this on the party laptop before
// the party, not during it.
//
//   node preflight.js              normal run, asks before making noise
//   node preflight.js --yes        do not ask (it WILL play audio for ~5s)
//   node preflight.js --no-audio   skip the playback step entirely
//
// Everything destructive happens in its own scratch playlist, and the
// library track count is checked at the start and the end.

const os = require('os');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const TEST_PLAYLIST = 'Jukebox Preflight';

const args = new Set(process.argv.slice(2));
const AUTO_YES = args.has('--yes') || args.has('-y');
const NO_AUDIO = args.has('--no-audio');

let pass = 0, fail = 0, skip = 0;
const failures = [];

function report(status, name, detail) {
  const tag = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? '  --  ' + detail : ''}`);
  if (status === 'PASS') pass++;
  else if (status === 'SKIP') skip++;
  else { fail++; failures.push(`${name}: ${detail}`); }
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    report('PASS', name, detail ? `${detail} (${Date.now() - t0}ms)` : `${Date.now() - t0}ms`);
    return true;
  } catch (e) {
    report('FAIL', name, e.message);
    return false;
  }
}

function ask(question) {
  if (AUTO_YES) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + ' [y/N] ', (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\nJUKEBOX PREFLIGHT  --  real Music app\n' + '='.repeat(72));

  // --- environment ---------------------------------------------------------
  if (process.platform !== 'darwin') {
    report('FAIL', 'macOS', `this is ${process.platform}, not darwin -- preflight must run on the party Mac`);
    console.log('\nStopping: nothing else can be checked off a Mac.\n');
    process.exit(1);
  }
  report('PASS', 'macOS', `${os.release()} (darwin), ${os.arch()}`);

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) report('FAIL', 'Node version', `${process.version} -- need 18 or newer`);
  else report('PASS', 'Node version', process.version);

  const { createMusic } = require('./lib/music');
  const music = createMusic({ log: () => {} });

  // --- the automation permission prompt -----------------------------------
  let baselineCount = null;
  const canTalk = await step('control Music (automation permission)', async () => {
    const st = await music.readState(TEST_PLAYLIST);
    if (!st.ok) throw new Error(st.error || 'Music did not answer');
    if (!st.running) throw new Error('Music is not running -- open it and run preflight again');
    return `player state "${st.state}", volume ${st.volume}`;
  });

  if (!canTalk) {
    console.log(
      '\nMusic would not answer. Usually this is the one-off permission prompt:\n' +
      '  System Settings > Privacy & Security > Automation > (your Terminal) > Music\n' +
      'Tick it, then run preflight again.\n'
    );
    process.exit(1);
  }

  await step('library track count (baseline)', async () => {
    baselineCount = await music.libraryCount();
    if (!Number.isFinite(baselineCount)) throw new Error('no count returned');
    return `${baselineCount} tracks in the library`;
  });

  // --- the index -----------------------------------------------------------
  let index = null;
  await step('index the library', async () => {
    index = await music.indexLibrary();
    const s = index.stats;
    if (!s.kept) throw new Error('indexed 0 playable songs -- check the exclusion rules');
    return `${s.kept} playable of ${s.total} in ${(index.elapsedMs / 1000).toFixed(1)}s ` +
           `(dropped ${s.excludedNotSong} non-song, ${s.excludedDisabled} unchecked, ${s.excludedCloud} cloud-unavailable)`;
  });

  if (index && index.partial) {
    report('FAIL', 'index completeness', `some columns failed: ${index.partial.join('; ')}`);
  }

  if (!index || !index.rows.length) {
    console.log('\nNo playable songs indexed, so the playlist steps cannot run.\n');
    process.exit(1);
  }

  const [a, b] = [index.rows[0], index.rows[Math.min(1, index.rows.length - 1)]];
  console.log(`      test tracks: "${a[1]}" by ${a[2]}  /  "${b[1]}" by ${b[2]}`);

  // --- the scratch playlist ------------------------------------------------
  let playlistMade = false;
  playlistMade = await step(`create the "${TEST_PLAYLIST}" playlist`, async () => {
    await music.ensurePlaylist(TEST_PLAYLIST);
    const st = await music.readState(TEST_PLAYLIST);
    if (!st.playlistExists) throw new Error('playlist still missing after create');
    return `${st.playlistPids.length} tracks in it`;
  });

  await step('append 2 tracks to it', async () => {
    await music.appendTrack(TEST_PLAYLIST, a[0]);
    await music.appendTrack(TEST_PLAYLIST, b[0]);
    const st = await music.readState(TEST_PLAYLIST);
    if (st.playlistPids.length < 2) throw new Error(`expected 2 tracks, found ${st.playlistPids.length}`);
    return `playlist now holds ${st.playlistPids.length}`;
  });

  // --- playback (makes noise) ----------------------------------------------
  let played = false;
  if (NO_AUDIO) {
    report('SKIP', 'play a track for ~5s', '--no-audio');
  } else {
    const ok = await ask(`\n  This next step PLAYS AUDIO for about 5 seconds ("${a[1]}" by ${a[2]}).\n  Turn the volume down first if you need to. Go ahead?`);
    if (!ok) {
      report('SKIP', 'play a track for ~5s', 'declined');
    } else {
      played = await step('play a track for ~5s', async () => {
        await music.playTrack(TEST_PLAYLIST, a[0]);
        await sleep(1200);
        const mid = await music.readState(TEST_PLAYLIST);
        if (mid.state !== 'playing') throw new Error(`expected playing, got "${mid.state}"`);
        if (!mid.track || mid.track.pid !== a[0]) {
          throw new Error(`playing "${mid.track ? mid.track.title : 'nothing'}" rather than the requested track`);
        }
        await sleep(3800);
        const end = await music.readState(TEST_PLAYLIST);
        const moved = (end.position || 0) > (mid.position || 0);
        if (!moved) throw new Error('player position did not advance -- is it actually playing?');
        return `position advanced ${(mid.position || 0).toFixed(1)}s -> ${(end.position || 0).toFixed(1)}s, ` +
               `playlist "${end.currentPlaylist}"`;
      });
    }
  }

  // --- artwork -------------------------------------------------------------
  if (played) {
    await step('fetch the current track artwork', async () => {
      const out = path.join(os.tmpdir(), 'jukebox-preflight-art.img');
      const got = await music.artwork(out);
      if (!got) return 'no artwork on this track (the UI falls back to a printed label)';
      const size = fs.statSync(got.path).size;
      fs.unlinkSync(got.path);
      if (!size) throw new Error('artwork file was empty');
      return `${(size / 1024).toFixed(0)} KB ${got.contentType}`;
    });
  } else {
    report('SKIP', 'fetch the current track artwork', 'nothing was playing');
  }

  // --- transport -----------------------------------------------------------
  await step('shuffle off / repeat off', async () => {
    await music.resetModes();
    return 'modes reset';
  });

  await step('read and set the volume', async () => {
    const before = (await music.readState(TEST_PLAYLIST)).volume;
    if (typeof before !== 'number') throw new Error('could not read sound volume');
    await music.transport('volume', before);   // set it straight back
    return `sound volume ${before}, writable`;
  });

  if (played) {
    await step('pause', async () => {
      await music.transport('pause');
      await sleep(600);
      const st = await music.readState(TEST_PLAYLIST);
      if (st.state === 'playing') throw new Error('still playing after pause');
      return `state "${st.state}"`;
    });
  }

  // --- teardown ------------------------------------------------------------
  await step('remove one track from the playlist', async () => {
    await music.removeTrack(TEST_PLAYLIST, b[0]);
    const st = await music.readState(TEST_PLAYLIST);
    if (st.playlistPids.includes(b[0])) throw new Error('track still in the playlist');
    return `${st.playlistPids.length} left`;
  });

  await step('clear the playlist', async () => {
    await music.clearPlaylist(TEST_PLAYLIST);
    const st = await music.readState(TEST_PLAYLIST);
    if (st.playlistPids.length) throw new Error(`${st.playlistPids.length} tracks survived the clear`);
    return 'empty';
  });

  if (playlistMade) {
    await step(`delete the "${TEST_PLAYLIST}" playlist`, async () => {
      await music.deletePlaylist(TEST_PLAYLIST);
      const st = await music.readState(TEST_PLAYLIST);
      if (st.playlistExists) throw new Error('playlist still there');
      return 'gone';
    });
  }

  // --- the check that actually matters -------------------------------------
  await step('library track count unchanged', async () => {
    const after = await music.libraryCount();
    if (after !== baselineCount) {
      throw new Error(`library went from ${baselineCount} to ${after} tracks -- STOP and check your library`);
    }
    return `${after} tracks, same as at the start`;
  });

  // --- hotkey clash --------------------------------------------------------
  await step('check for a window-manager hotkey clash', async () => {
    const suspects = [
      ['Rectangle', '/Applications/Rectangle.app'],
      ['Rectangle Pro', '/Applications/Rectangle Pro.app'],
      ['Magnet', '/Applications/Magnet.app'],
      ['Moom', '/Applications/Moom.app'],
      ['BetterSnapTool', '/Applications/BetterSnapTool.app'],
    ];
    const found = suspects.filter(([, p]) => fs.existsSync(p)).map(([n]) => n);
    if (!found.length) return 'none of Rectangle / Magnet / Moom / BetterSnapTool installed';
    throw new Error(
      `${found.join(', ')} installed. Rectangle and Magnet use control-option-left/right by ` +
      `default, which clashes with the jukebox skip hotkey (control-option-right). ` +
      `Either quit it for the party or change MODIFIER in public/app.js.`
    );
  });

  // --- summary -------------------------------------------------------------
  console.log('='.repeat(72));
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
    console.log('');
  } else {
    console.log('\nAll good. Run the real server next:  ./start.command\n');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\npreflight crashed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
