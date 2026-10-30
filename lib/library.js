'use strict';

const { isPlayableCloudStatus, isSong, isEnabled, artistSortKey, railLetter, fold } = require('./util');

// Row layout sent to the browser. Arrays, not objects: on a 40k-track library
// the JSON key names alone would cost more than the data.
const ROW = { PID: 0, TITLE: 1, ARTIST: 2, ALBUM: 3, DURATION: 4, CODE: 5 };

// Turn the raw parallel columns from scripts/index-library.js into the index
// the jukebox actually serves. Pure: the mock feeds it the same shape.
function buildIndex(cols) {
  const pids = cols.pid || [];
  const n = pids.length;
  const get = (key, i) => (Array.isArray(cols[key]) ? cols[key][i] : undefined);

  const stats = {
    total: n,
    excludedNotSong: 0,
    excludedDisabled: 0,
    excludedCloud: 0,
    excludedNoPid: 0,
    kept: 0,
  };

  const rows = [];
  for (let i = 0; i < n; i++) {
    const pid = pids[i];
    if (!pid) { stats.excludedNoPid++; continue; }
    if (!isSong(get('mediaKind', i))) { stats.excludedNotSong++; continue; }
    if (!isEnabled(get('enabled', i))) { stats.excludedDisabled++; continue; }
    if (!isPlayableCloudStatus(get('cloudStatus', i))) { stats.excludedCloud++; continue; }

    const title = String(get('name', i) || 'Unknown Title');
    const artist = String(get('artist', i) || 'Unknown Artist');
    const album = String(get('album', i) || '');
    const durRaw = Number(get('duration', i));
    const duration = Number.isFinite(durRaw) && durRaw > 0 ? Math.round(durRaw) : 0;

    rows.push([String(pid), title, artist, album, duration, '']);
  }
  stats.kept = rows.length;

  // Browse order: artist (leading article ignored), then title.
  rows.sort((a, b) => {
    const ka = artistSortKey(a[ROW.ARTIST]);
    const kb = artistSortKey(b[ROW.ARTIST]);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ta = fold(a[ROW.TITLE]);
    const tb = fold(b[ROW.TITLE]);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return 0;
  });

  // Selection codes: letter of the artist bucket plus position within it.
  const counters = Object.create(null);
  const letterStart = Object.create(null);
  for (let i = 0; i < rows.length; i++) {
    const letter = railLetter(rows[i][ROW.ARTIST]);
    if (!(letter in counters)) {
      counters[letter] = 0;
      letterStart[letter] = i;
    }
    counters[letter] += 1;
    rows[i][ROW.CODE] = letter + '-' + counters[letter];
  }

  return {
    version: String(Date.now()),
    builtAt: new Date().toISOString(),
    rowSpec: ['pid', 'title', 'artist', 'album', 'duration', 'code'],
    letterStart,
    rows,
    stats,
  };
}

module.exports = { buildIndex, ROW };
