// JXA. Bulk-index the library. One Apple Event per property, which is the
// only way this finishes in reasonable time on a large library.
//   osascript -l JavaScript scripts/index-library.js
// Prints JSON: { ok, total, elapsedMs, cols: {...} } with RAW parallel arrays.
// Filtering and enum normalising happen in lib/music.js.
function run() {
  var t0 = Date.now();
  var out = { ok: true, total: 0, elapsedMs: 0, cols: {}, error: null, partial: [] };

  var Music;
  try {
    Music = Application('Music');
  } catch (e) {
    out.ok = false;
    out.error = 'cannot address Music: ' + e;
    return JSON.stringify(out);
  }

  var tracks;
  try {
    tracks = Music.libraryPlaylists[0].tracks;
  } catch (e) {
    out.ok = false;
    out.error = 'no library playlist: ' + e;
    return JSON.stringify(out);
  }

  // Each of these is one Apple Event returning a whole column.
  // A single bad track can fail a whole column, so each is independent and
  // a failure is recorded rather than aborting the index.
  var wanted = [
    ['pid', function () { return tracks.persistentID(); }],
    ['name', function () { return tracks.name(); }],
    ['artist', function () { return tracks.artist(); }],
    ['album', function () { return tracks.album(); }],
    ['duration', function () { return tracks.duration(); }],
    ['mediaKind', function () { return tracks.mediaKind(); }],
    ['enabled', function () { return tracks.enabled(); }],
    ['cloudStatus', function () { return tracks.cloudStatus(); }]
  ];

  for (var i = 0; i < wanted.length; i++) {
    var key = wanted[i][0];
    try {
      out.cols[key] = wanted[i][1]();
    } catch (e) {
      out.cols[key] = null;
      out.partial.push(key + ': ' + e);
    }
  }

  // pid is the only column we cannot work without.
  if (!out.cols.pid) {
    out.ok = false;
    out.error = 'persistent ID column failed: ' + out.partial.join('; ');
    return JSON.stringify(out);
  }

  out.total = out.cols.pid.length;
  out.elapsedMs = Date.now() - t0;
  return JSON.stringify(out);
}
