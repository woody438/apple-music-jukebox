// JXA, read-only. Bulk-compares each library track's reported duration with
// its finish point, which is where Music actually stops playing it.
function run() {
  var out = { ok: true, total: 0, trimmedFinish: 0, trimmedStart: 0, diffs: [], error: null };
  try {
    var t = Application('Music').libraryPlaylists[0].tracks;
    var dur = t.duration();
    var fin = t.finish();
    var sta = t.start();
    out.total = dur.length;
    for (var i = 0; i < dur.length; i++) {
      var d = Number(dur[i]), f = Number(fin[i]), s = Number(sta[i]);
      if (isFinite(s) && s > 0.5) out.trimmedStart++;
      if (isFinite(d) && isFinite(f) && d - f > 0.5) {
        out.trimmedFinish++;
        if (out.diffs.length < 2000) out.diffs.push(Math.round((d - f) * 100) / 100);
      }
    }
  } catch (e) {
    out.ok = false;
    out.error = String(e);
  }
  return JSON.stringify(out);
}
