'use strict';

const { isPlayableCloudStatus, isSong, isEnabled, artistSortKey, railLetter, fold } = require('./util');

// Row layout sent to the browser. Arrays, not objects: on a 40k-track library
// the JSON key names alone would cost more than the data.
const ROW = { PID: 0, TITLE: 1, ARTIST: 2, ALBUM: 3, DURATION: 4, CODE: 5, GENRE: 6 };

const UNKNOWN_GENRE = 'Unknown';

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
    const genre = String(get('genre', i) || '').trim() || UNKNOWN_GENRE;
    const durRaw = Number(get('duration', i));
    const duration = Number.isFinite(durRaw) && durRaw > 0 ? Math.round(durRaw) : 0;

    rows.push([String(pid), title, artist, album, duration, '', genre]);
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
  // Computed over the WHOLE library, so a code identifies a song no matter
  // which genre you are filtered to.
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

  // Genres, grouped case-insensitively. A big library reliably contains
  // "Rock" and "rock" and treating them as two categories looks broken.
  // Separators are left alone -- deciding that "Hip-Hop" and "Hip Hop" are
  // the same thing is an opinion, and not ours to impose on someone's tags.
  const byKey = new Map();
  for (const r of rows) {
    const key = fold(r[ROW.GENRE]);
    let e = byKey.get(key);
    if (!e) { e = { count: 0, spellings: new Map() }; byKey.set(key, e); }
    e.count += 1;
    e.spellings.set(r[ROW.GENRE], (e.spellings.get(r[ROW.GENRE]) || 0) + 1);
  }

  // Settle on the commonest spelling and write it back, so the client can
  // filter on an exact string match.
  const canonical = new Map();
  for (const [key, e] of byKey) {
    let best = null, bestN = -1;
    for (const [spelling, n2] of e.spellings) if (n2 > bestN) { best = spelling; bestN = n2; }
    canonical.set(key, best);
  }
  for (const r of rows) r[ROW.GENRE] = canonical.get(fold(r[ROW.GENRE]));

  const genres = Array.from(byKey, ([key, e]) => ({ name: canonical.get(key), count: e.count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));

  return {
    version: String(Date.now()),
    builtAt: new Date().toISOString(),
    rowSpec: ['pid', 'title', 'artist', 'album', 'duration', 'code', 'genre'],
    letterStart,
    genres,
    rows,
    stats,
  };
}

module.exports = { buildIndex, ROW, UNKNOWN_GENRE };
