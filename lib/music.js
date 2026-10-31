'use strict';

// The osascript bridge. Reads go through JXA (which can return JSON),
// writes through AppleScript (which has the saner syntax for them).
//
// Every write is serialised through one mutex, and reads are told to stand
// aside while a write is in flight -- two osascript processes talking to
// Music at once is how you get stuck Apple Events and a silent room.

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const { buildIndex } = require('./library');
const { normalisePlayerState } = require('./util');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

const DEFAULT_TIMEOUT_MS = 30000;
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;
const INDEX_MAX_BUFFER = 256 * 1024 * 1024;

// Names we refuse to mutate no matter what the config says.
const RESERVED_PLAYLIST_NAMES = new Set([
  'library', 'music', 'movies', 'tv shows', 'podcasts', 'audiobooks',
  'purchased', 'recently added', 'recently played', 'top 25 most played',
]);

function assertSafePlaylistName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw new Error('playlist name is empty');
  if (RESERVED_PLAYLIST_NAMES.has(n.toLowerCase())) {
    throw new Error(`refusing to operate on reserved playlist "${n}"`);
  }
  return n;
}

function run(cmd, args, { timeout = DEFAULT_TIMEOUT_MS, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || '').trim();
        const e = new Error(detail || 'osascript failed');
        e.stderr = detail;
        e.code = err.code;
        if (err.killed) e.message = `osascript timed out after ${timeout}ms: ${detail}`;
        return reject(e);
      }
      resolve(String(stdout));
    });
  });
}

const jxa = (file, args = [], opts) =>
  run('osascript', ['-l', 'JavaScript', path.join(SCRIPTS, file), ...args.map(String)], opts);

const applescript = (file, args = [], opts) =>
  run('osascript', [path.join(SCRIPTS, file), ...args.map(String)], opts);

function parseJson(out, what) {
  const s = String(out).trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`${what}: could not parse output (${s.slice(0, 200)})`);
  }
}

function createMusic(options = {}) {
  const log = options.log || (() => {});

  let chain = Promise.resolve();
  let pendingWrites = 0;
  let lastError = null;

  // Serialise writes. pendingWrites goes up the moment a write is QUEUED,
  // not when it starts, so the poll loop backs off for the whole burst.
  // quiet: failures that are expected and harmless, so they never become the
  // "last error" the host panel shows. A track with no cover art is normal;
  // letting it sit in that panel all night hides a real fault behind noise.
  function write(label, fn, quiet) {
    pendingWrites += 1;
    const task = chain.then(fn, fn).then(
      (v) => { pendingWrites -= 1; return v; },
      (e) => {
        pendingWrites -= 1;
        if (!quiet) {
          lastError = { at: new Date().toISOString(), op: label, message: e.message };
          log('music write failed', label, e.message);
        }
        throw e;
      }
    );
    chain = task.then(() => {}, () => {});
    return task;
  }

  const api = {
    kind: 'real',

    isWriting: () => pendingWrites > 0,
    getLastError: () => lastError,
    clearLastError: () => { lastError = null; },

    async readState(playlistName) {
      const name = assertSafePlaylistName(playlistName);
      // osascript costs real time (~300ms on a healthy Mac) and read-state.js
      // samples the player position near the START of that run. Report how
      // long it took, so the engine can correct for a position that is
      // already stale by the time it acts on it.
      const t0 = Date.now();
      const raw = parseJson(await jxa('read-state.js', [name]), 'read-state');
      const readLatencyMs = Date.now() - t0;
      return {
        readLatencyMs,
        ok: !!raw.ok,
        running: !!raw.running,
        state: normalisePlayerState(raw.state),
        position: typeof raw.position === 'number' ? raw.position : null,
        volume: typeof raw.volume === 'number' ? raw.volume : null,
        currentPlaylist: raw.currentPlaylist || null,
        track: raw.track
          ? {
              pid: String(raw.track.pid),
              title: String(raw.track.name || ''),
              artist: String(raw.track.artist || ''),
              album: String(raw.track.album || ''),
              duration: Number(raw.track.duration) || 0,
            }
          : null,
        playlistExists: !!raw.playlistExists,
        playlistPids: Array.isArray(raw.playlistPids) ? raw.playlistPids.map(String) : [],
        error: raw.error || null,
      };
    },

    async indexLibrary() {
      const t0 = Date.now();
      const raw = parseJson(
        await jxa('index-library.js', [], { timeout: INDEX_TIMEOUT_MS, maxBuffer: INDEX_MAX_BUFFER }),
        'index-library'
      );
      if (!raw.ok) throw new Error(raw.error || 'index failed');
      const index = buildIndex(raw.cols || {});
      index.elapsedMs = Date.now() - t0;
      index.scriptElapsedMs = raw.elapsedMs || null;
      if (raw.partial && raw.partial.length) index.partial = raw.partial;
      log(`indexed ${index.stats.kept}/${index.stats.total} tracks in ${index.elapsedMs}ms`);
      return index;
    },

    async libraryCount() {
      const raw = parseJson(await jxa('library-count.js'), 'library-count');
      if (!raw.ok) throw new Error(raw.error || 'library count failed');
      return raw.count;
    },

    ensurePlaylist(playlistName) {
      const name = assertSafePlaylistName(playlistName);
      return write('ensurePlaylist', () => applescript('ensure-playlist.applescript', [name]));
    },

    appendTrack(playlistName, pid) {
      const name = assertSafePlaylistName(playlistName);
      return write('appendTrack', () => applescript('append-track.applescript', [name, pid]));
    },

    playTrack(playlistName, pid) {
      const name = assertSafePlaylistName(playlistName);
      return write('playTrack', () => applescript('play-track.applescript', [name, pid]));
    },

    removeTrack(playlistName, pid) {
      const name = assertSafePlaylistName(playlistName);
      return write('removeTrack', () => applescript('remove-track.applescript', [name, pid]));
    },

    clearPlaylist(playlistName) {
      const name = assertSafePlaylistName(playlistName);
      return write('clearPlaylist', () => applescript('clear-playlist.applescript', [name]));
    },

    deletePlaylist(playlistName) {
      const name = assertSafePlaylistName(playlistName);
      return write('deletePlaylist', () => applescript('delete-playlist.applescript', [name]));
    },

    transport(verb, arg) {
      const args = arg === undefined ? [verb] : [verb, arg];
      return write('transport:' + verb, () => applescript('transport.applescript', args));
    },

    resetModes() {
      return api.transport('reset-modes');
    },

    // Writes the current artwork and returns { path, contentType } or null.
    async artwork(outPath) {
      try {
        await write('artwork', () => applescript('artwork.applescript', [outPath]), true);
      } catch (e) {
        return null;
      }
      try {
        const fd = fs.openSync(outPath, 'r');
        const head = Buffer.alloc(12);
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        if (head[0] === 0xff && head[1] === 0xd8) return { path: outPath, contentType: 'image/jpeg' };
        if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
          return { path: outPath, contentType: 'image/png' };
        }
        if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') {
          return { path: outPath, contentType: 'image/webp' };
        }
        return { path: outPath, contentType: 'application/octet-stream' };
      } catch (e) {
        return null;
      }
    },
  };

  return api;
}

module.exports = { createMusic, assertSafePlaylistName, RESERVED_PLAYLIST_NAMES };
