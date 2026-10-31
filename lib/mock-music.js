'use strict';

// A fake Music.app. Same API as lib/music.js, so the engine cannot tell the
// difference. Playback advances in real time against short tracks, and the
// nastier real-world behaviours are switchable:
//
//   appendPickedUp: false  -- Music has already fixed its play order, so a
//                             track appended to the playing playlist is NOT
//                             picked up. This is the case the handoff exists
//                             for, so it is the default.
//   autoplay: true         -- when the playlist runs out, Music keeps going
//                             with something else (the infinity button).

const { buildIndex } = require('./library');
const { assertSafePlaylistName } = require('./music');

const ARTISTS = [
  'The Beatles', 'Blondie', 'Chic', 'David Bowie', 'Earth Wind & Fire',
  'Fleetwood Mac', 'Grace Jones', 'Hall & Oates', 'INXS', 'Joy Division',
  'Kate Bush', 'LCD Soundsystem', 'Madonna', 'New Order', 'Outkast',
  'Prince', 'Queen', 'Roxy Music', 'Stevie Wonder', 'Talking Heads',
  'Underworld', 'Van Halen', 'Wham!', 'The xx', 'Yazoo', 'ZZ Top',
  'Édith Piaf', 'Beyoncé', 'Sigur Rós', 'Mötley Crüe',
];
const WORDS = [
  'Midnight', 'Electric', 'Golden', 'Velvet', 'Neon', 'Paper', 'Silver',
  'Rubber', 'Crystal', 'Plastic', 'Harbour', 'Saturday', 'Disco', 'Static',
  'Diamond', 'Thunder', 'Tiny', 'Wild', 'Slow', 'Secret',
];
// Deliberately includes 'rock' alongside 'Rock' and a long tail of
// one-track genres, because a real library is exactly this untidy.
const GENRES = [
  'Rock', 'Rock', 'Rock', 'Pop', 'Pop', 'Pop', 'Disco', 'Disco',
  'Soul', 'Funk', 'New Wave', 'Electronic', 'Hip-Hop', 'Jazz',
  'rock', 'Alternative', 'Reggae', 'Country', 'Blues', 'Classical',
  'Spoken Word', 'Ska', 'Gospel', 'Bluegrass',
];

const NOUNS = [
  'Heart', 'Dancer', 'Machine', 'Radio', 'Lights', 'Rain', 'Train', 'Fever',
  'Ghost', 'Parade', 'Sunrise', 'Motion', 'Weekend', 'Hands', 'Stranger',
];

// Small deterministic PRNG so every test run sees the same library.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLibrary(size, rnd, trackSeconds) {
  const tracks = [];
  for (let i = 0; i < size; i++) {
    const artist = ARTISTS[Math.floor(rnd() * ARTISTS.length)];
    const title =
      WORDS[Math.floor(rnd() * WORDS.length)] + ' ' + NOUNS[Math.floor(rnd() * NOUNS.length)] + ' #' + i;
    const r = rnd();

    // Salt the library with the things the index is meant to throw away,
    // roughly 6% of it, so the filters are exercised on every run.
    let mediaKind = 'song';
    let enabled = true;
    let cloudStatus = 'matched';
    if (r < 0.02) mediaKind = 'musicVideo';
    else if (r < 0.035) enabled = false;
    else if (r < 0.045) cloudStatus = 'noLongerAvailable';
    else if (r < 0.05) cloudStatus = 'ineligible';
    else if (r < 0.055) cloudStatus = 'prerelease';
    else if (r < 0.06) cloudStatus = 'error';

    tracks.push({
      pid: 'MOCK' + String(i).padStart(8, '0'),
      name: title,
      artist,
      album: 'Album ' + ((i % 97) + 1),
      genre: GENRES[Math.floor(rnd() * GENRES.length)],
      // 8-14s so a full queue-to-autoplay test runs in under a minute.
      duration: trackSeconds + (i % 7),
      mediaKind,
      enabled,
      cloudStatus,
    });
  }
  return tracks;
}

function createMockMusic(options = {}) {
  const cfg = Object.assign(
    {
      librarySize: 2000,
      trackSeconds: 8,
      seed: 1234,
      autoplay: true,
      appendPickedUp: false,
      writeLatencyMs: 5,
      readLatencyMs: 0,   // simulate osascript round-trip cost
      tickMs: 25,
      running: true,
      startState: 'paused',
      log: () => {},
    },
    options
  );

  const rnd = mulberry32(cfg.seed);
  const library = makeLibrary(cfg.librarySize, rnd, cfg.trackSeconds);
  const byPid = new Map(library.map((t) => [t.pid, t]));
  const playlists = new Map(); // name -> array of pids

  const ops = []; // every write, for test assertions
  let shuffleEnabled = true; // deliberately wrong at startup; resetModes must fix it
  let songRepeat = 'all';
  let soundVolume = 50;
  let lastError = null;

  const player = {
    state: cfg.startState,
    pid: null,
    playlistName: null,
    isAutoplay: false,
    order: [],
    orderIndex: -1,
    startedAtMs: 0,
    startPosSec: 0,
    frozenPosSec: 0,
  };

  const durationOf = (pid) => (byPid.has(pid) ? byPid.get(pid).duration : 0);

  function position() {
    if (player.state !== 'playing') return player.frozenPosSec;
    return player.startPosSec + (Date.now() - player.startedAtMs) / 1000;
  }

  function startTrack(pid, { playlistName = null, isAutoplay = false, order = [], orderIndex = -1 }) {
    player.pid = pid;
    player.playlistName = playlistName;
    player.isAutoplay = isAutoplay;
    player.order = order;
    player.orderIndex = orderIndex;
    player.state = 'playing';
    player.startedAtMs = Date.now();
    player.startPosSec = 0;
    player.frozenPosSec = 0;
    cfg.log(`[mock] play ${isAutoplay ? '(autoplay) ' : ''}${pid} ${byPid.get(pid)?.name || '?'}`);
  }

  function startAutoplay() {
    if (!cfg.autoplay) {
      player.state = 'stopped';
      player.pid = null;
      player.frozenPosSec = 0;
      cfg.log('[mock] stopped (autoplay off)');
      return;
    }
    // Music's Autoplay keeps the playlist showing while playing something
    // that is not in it -- the awkward case for the engine.
    const playable = library.filter((t) => t.mediaKind === 'song' && t.enabled);
    const pick = playable[Math.floor(rnd() * playable.length)];
    startTrack(pick.pid, { playlistName: player.playlistName, isAutoplay: true });
  }

  function advance() {
    if (player.isAutoplay) return startAutoplay();

    const name = player.playlistName;
    // appendPickedUp decides whether Music re-reads the playlist or sticks
    // to the order it already worked out.
    const order = cfg.appendPickedUp && name && playlists.has(name) ? playlists.get(name) : player.order;
    const nextIndex = player.orderIndex + 1;
    if (nextIndex >= 0 && nextIndex < order.length) {
      startTrack(order[nextIndex], {
        playlistName: name,
        isAutoplay: false,
        order,
        orderIndex: nextIndex,
      });
      return;
    }
    startAutoplay();
  }

  const timer = setInterval(() => {
    if (player.state !== 'playing' || !player.pid) return;
    if (position() >= durationOf(player.pid)) advance();
  }, cfg.tickMs);
  if (timer.unref) timer.unref();

  // ---- write mutex, mirroring lib/music.js -------------------------------
  let chain = Promise.resolve();
  let pendingWrites = 0;
  let maxConcurrentWrites = 0;
  let activeWrites = 0;

  function write(label, fn) {
    pendingWrites += 1;
    const task = chain
      .then(() => {
        activeWrites += 1;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
        return new Promise((r) => setTimeout(r, cfg.writeLatencyMs)).then(fn);
      })
      .then(
        (v) => { activeWrites -= 1; pendingWrites -= 1; ops.push(label); return v; },
        (e) => {
          activeWrites -= 1;
          pendingWrites -= 1;
          lastError = { at: new Date().toISOString(), op: label, message: e.message };
          throw e;
        }
      );
    chain = task.then(() => {}, () => {});
    return task;
  }

  function requirePlaylist(name) {
    if (!playlists.has(name)) throw new Error(`NOTFOUND: playlist ${name}`);
    return playlists.get(name);
  }

  const api = {
    kind: 'mock',

    isWriting: () => pendingWrites > 0,
    getLastError: () => lastError,
    clearLastError: () => { lastError = null; },

    async readState(playlistName) {
      const name = assertSafePlaylistName(playlistName);

      // SAMPLE FIRST, THEN WAIT. A real osascript reads the player near the
      // start of its run and hands that reading back ~300ms later, so what
      // the caller receives describes the past -- including WHICH TRACK was
      // playing, not merely how far into it the player had got.
      //
      // Sleeping and then sampling would be easier, and would be a lie: it
      // hides every bug that staleness causes. One of those bugs -- a read
      // in flight across a handoff wiping the pick's name, so the song plays
      // out labelled AUTOPLAY -- reached a real party rehearsal precisely
      // because this mock used to do it the easy way.
      const sampled = {
        state: player.state,
        pid: player.pid,
        pos: player.pid ? position() : null,
        playlistName: player.playlistName,
        exists: playlists.has(name),
        pids: playlists.has(name) ? playlists.get(name).slice() : [],
      };

      if (cfg.readLatencyMs) await new Promise((r) => setTimeout(r, cfg.readLatencyMs));

      const t = sampled.pid ? byPid.get(sampled.pid) : null;
      return {
        readLatencyMs: cfg.readLatencyMs,
        ok: true,
        running: cfg.running,
        state: cfg.running ? sampled.state : 'stopped',
        position: cfg.running && sampled.pos !== null ? Number(sampled.pos.toFixed(3)) : null,
        volume: soundVolume,
        currentPlaylist: sampled.playlistName,
        track:
          cfg.running && t
            ? { pid: t.pid, title: t.name, artist: t.artist, album: t.album, duration: t.duration }
            : null,
        playlistExists: sampled.exists,
        playlistPids: sampled.pids,
        error: null,
      };
    },

    async indexLibrary() {
      const t0 = Date.now();
      const cols = {
        pid: library.map((t) => t.pid),
        name: library.map((t) => t.name),
        artist: library.map((t) => t.artist),
        album: library.map((t) => t.album),
        genre: library.map((t) => t.genre),
        duration: library.map((t) => t.duration),
        mediaKind: library.map((t) => t.mediaKind),
        enabled: library.map((t) => t.enabled),
        cloudStatus: library.map((t) => t.cloudStatus),
      };
      const index = buildIndex(cols);
      index.elapsedMs = Date.now() - t0;
      return index;
    },

    async libraryCount() { return library.length; },

    ensurePlaylist(playlistName) {
      const name = assertSafePlaylistName(playlistName);
      return write('ensurePlaylist', () => {
        if (!playlists.has(name)) playlists.set(name, []);
        return 'ok|' + playlists.get(name).length;
      });
    },

    appendTrack(playlistName, pid) {
      const name = assertSafePlaylistName(playlistName);
      return write('appendTrack', () => {
        const pl = requirePlaylist(name);
        if (!byPid.has(pid)) throw new Error('NOTFOUND: ' + pid);
        pl.push(pid);
        return 'ok|' + pl.length;
      });
    },

    playTrack(playlistName, pid) {
      const name = assertSafePlaylistName(playlistName);
      return write('playTrack', () => {
        const pl = requirePlaylist(name);
        const idx = pl.lastIndexOf(pid); // LAST match, as the real script does
        if (idx === -1) throw new Error('NOTFOUND: ' + pid);
        shuffleEnabled = false;
        songRepeat = 'off';
        startTrack(pid, { playlistName: name, isAutoplay: false, order: pl.slice(), orderIndex: idx });
        return 'ok';
      });
    },

    removeTrack(playlistName, pid) {
      const name = assertSafePlaylistName(playlistName);
      return write('removeTrack', () => {
        const pl = requirePlaylist(name);
        let n = 0;
        for (let i = pl.length - 1; i >= 0; i--) if (pl[i] === pid) { pl.splice(i, 1); n++; }
        return 'ok|' + n;
      });
    },

    clearPlaylist(playlistName) {
      const name = assertSafePlaylistName(playlistName);
      return write('clearPlaylist', () => {
        if (!playlists.has(name)) return 'ok|0';
        const n = playlists.get(name).length;
        playlists.set(name, []);
        return 'ok|' + n;
      });
    },

    deletePlaylist(playlistName) {
      const name = assertSafePlaylistName(playlistName);
      return write('deletePlaylist', () => {
        const had = playlists.delete(name);
        return 'ok|' + (had ? 'deleted' : 'absent');
      });
    },

    transport(verb, arg) {
      return write('transport:' + verb, () => {
        if (verb === 'play') {
          if (player.pid) {
            player.startPosSec = player.frozenPosSec;
            player.startedAtMs = Date.now();
            player.state = 'playing';
          }
        } else if (verb === 'pause') {
          if (player.state === 'playing') { player.frozenPosSec = position(); player.state = 'paused'; }
        } else if (verb === 'playpause') {
          return api.transport(player.state === 'playing' ? 'pause' : 'play');
        } else if (verb === 'next') {
          if (player.pid) advance();
        } else if (verb === 'volume') {
          soundVolume = Math.max(0, Math.min(100, parseInt(arg, 10) || 0));
        } else if (verb === 'reset-modes') {
          shuffleEnabled = false;
          songRepeat = 'off';
        } else {
          throw new Error('UNKNOWN VERB: ' + verb);
        }
        return 'ok';
      });
    },

    resetModes() { return api.transport('reset-modes'); },

    // Goes through the write mutex exactly as the real one does, so the
    // server's in-flight dedupe is testable. The simulator has no images,
    // so the result is always "no artwork".
    artwork() { return write('artwork', () => null); },

    // ---- test hooks ------------------------------------------------------
    _sim: {
      library,
      playlists,
      ops,
      cfg,
      get shuffleEnabled() { return shuffleEnabled; },
      get songRepeat() { return songRepeat; },
      get soundVolume() { return soundVolume; },
      get maxConcurrentWrites() { return maxConcurrentWrites; },
      position,
      player,
      // Playable tracks, in index order, for tests that need real pids.
      playable: () => library.filter((t) => t.mediaKind === 'song' && t.enabled &&
        !['noLongerAvailable', 'ineligible', 'prerelease', 'error'].includes(t.cloudStatus)),
      setAppendPickedUp(v) { cfg.appendPickedUp = !!v; },
      setAutoplay(v) { cfg.autoplay = !!v; },
      // Fast-forward so a test does not have to wait out a whole track.
      leaveSecondsLeft(sec) {
        if (!player.pid) return;
        const dur = durationOf(player.pid);
        const target = Math.max(0, dur - sec);
        if (player.state === 'playing') {
          player.startPosSec = target;
          player.startedAtMs = Date.now();
        } else {
          player.frozenPosSec = target;
        }
      },
      // Somebody hit the media key / the space bar in Music itself.
      externalPause() {
        if (player.state === 'playing') { player.frozenPosSec = position(); player.state = 'paused'; }
      },
      externalPlay() {
        if (player.pid && player.state !== 'playing') {
          player.startPosSec = player.frozenPosSec;
          player.startedAtMs = Date.now();
          player.state = 'playing';
        }
      },
      externalNext() { if (player.pid) advance(); },
      stopTimer() { clearInterval(timer); },
    },
  };

  return api;
}

module.exports = { createMockMusic };
