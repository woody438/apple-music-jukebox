// JXA. Read Music player state + the Jukebox playlist contents in one shot.
//   osascript -l JavaScript scripts/read-state.js "Jukebox"
// Prints a single JSON object. Enum values are returned RAW; normalising
// happens in lib/music.js so the rules can be unit-tested off a Mac.
function run(argv) {
  var playlistName = (argv && argv.length) ? argv[0] : 'Jukebox';
  var out = {
    ok: true,
    running: false,
    state: null,
    position: null,
    volume: null,
    currentPlaylist: null,
    track: null,
    playlistExists: false,
    playlistPids: [],
    error: null
  };

  var Music;
  try {
    Music = Application('Music');
  } catch (e) {
    out.ok = false;
    out.error = 'cannot address Music: ' + e;
    return JSON.stringify(out);
  }

  // .running() does NOT launch the app.
  try { out.running = !!Music.running(); } catch (e) { out.running = false; }
  if (!out.running) return JSON.stringify(out);

  try { out.state = Music.playerState(); } catch (e) { out.error = 'state: ' + e; }
  try { out.position = Music.playerPosition(); } catch (e) { out.position = null; }
  try { out.volume = Music.soundVolume(); } catch (e) { out.volume = null; }
  try { out.currentPlaylist = Music.currentPlaylist.name(); } catch (e) { out.currentPlaylist = null; }

  // current track throws when stopped, and for some stream kinds.
  try {
    var t = Music.currentTrack();
    out.track = {
      pid: t.persistentID(),
      name: t.name(),
      artist: t.artist(),
      album: t.album(),
      duration: t.duration()
    };
  } catch (e) {
    out.track = null;
  }

  // Jukebox playlist: existence + ordered persistent IDs (always a short list).
  try {
    var pls = Music.userPlaylists.whose({ name: playlistName })();
    if (pls.length > 0) {
      out.playlistExists = true;
      out.playlistPids = pls[0].tracks.persistentID();
    }
  } catch (e) {
    out.error = (out.error ? out.error + '; ' : '') + 'playlist: ' + e;
  }

  return JSON.stringify(out);
}
