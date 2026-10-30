// JXA. Just the library song count -- preflight uses it to prove the library
// is the same size at the end of the run as it was at the start.
function run() {
  try {
    return JSON.stringify({ ok: true, count: Application('Music').libraryPlaylists[0].tracks.length });
  } catch (e) {
    return JSON.stringify({ ok: false, count: null, error: String(e) });
  }
}
