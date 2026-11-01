'use strict';

// The queue engine.
//
// The server owns the queue. The Music playlist is a mirror of it, never the
// source of truth, because the Playing Next queue is not scriptable and a
// playlist that is already playing may not notice tracks appended to it.
//
// The two rules that look like they contradict each other:
//
//   "a pick made during Autoplay waits for the Autoplay song to end"
//   "if the track changes to anything else while picks are waiting,
//    start the next pick immediately"
//
// They are distinguished by whether a track CHANGE was observed while picks
// were already waiting. An Autoplay song that was running before the pick
// arrived is left alone and handed off at the end. An Autoplay song that
// STARTS while picks are waiting means the handoff was missed, so it is cut
// off at once rather than making the room wait another three minutes.

const EventEmitter = require('events');

// How close to the end of a track we force the next pick. Deliberately
// clips well under a second of tail: that is inaudible against a room, and
// it guarantees Music never gets the chance to slot in an Autoplay song.
const HANDOFF_SEC = 0.6;
const POLL_NORMAL_MS = 800;
const POLL_CLOSE_MS = 200;
const POLL_CLOSE_WINDOW_SEC = 4;
const HOUSEKEEP_MS = 15000;
// How long after starting a pick we refuse to act on a reading that does not
// show it. Covers Music taking a moment to actually switch tracks.
const PICK_SETTLE_MS = 1000;
// Crossfade Songs makes Music start its next track up to 12s before the end
// of this one. Measured leads beyond that are somebody pressing next; under
// half a second is measurement noise, not crossfade (Music's shortest is 1s).
const MAX_MUSIC_LEAD_SEC = 13;
const MIN_MUSIC_LEAD_SEC = 0.5;
const LEAD_SAMPLES = 3;

function nowMs() { return Date.now(); }

class Engine extends EventEmitter {
  constructor({ music, config, store, log = () => {} }) {
    super();
    this.music = music;
    this.cfg = config;
    this.store = store;
    this.log = log;

    this.queue = [];
    this.nowPlaying = null;   // the pick we started and believe is playing
    this.history = [];        // [{ pid, at }] for the no-repeat window
    this.hold = false;

    this.index = null;
    this.byPid = new Map();
    this.visibleGenres = null;   // null = pick the biggest automatically

    this.player = { state: 'stopped', position: 0, duration: 0, volume: null, track: null, running: false };
    this.playlistPids = [];   // our view of the Music playlist, refreshed each poll
    this.lastError = null;
    this.lastStart = null;   // why the last pick started: the party's black box
    this.indexing = false;

    this._lastTrackPid = null;
    this._primed = false;
    this._everPlayed = false;  // has this session ever seen Music actually playing?
    this._nowPlayingAt = 0;    // when we told Music to play the current pick
    this._starting = false;    // a pick is being started right now
    this._lastPlayAt = 0;      // when our last play command finished
    this._lastCommandAt = 0;   // when we last told Music to change track
    this._lastCommandPid = null; // ...to which pick
    this._playedOverPid = null; // the track that was playing when we did
    this._lastObs = null;      // the last playing track seen, and when it should end
    this._leadSamples = [];    // how early Music has been seen leaving tracks
    this.musicLeadSec = 0;     // ...and the figure the handoff uses
    this._ticking = false;
    this._timer = null;
    this._handoffTimer = null;
    this._stopped = true;
    this._lastHousekeepAt = 0;
    this._seq = 0;
  }

  // ---- lifecycle --------------------------------------------------------

  async start() {
    this._stopped = false;

    const saved = this.store.load();
    if (saved) {
      this.queue = Array.isArray(saved.queue) ? saved.queue : [];
      this.nowPlaying = saved.nowPlaying || null;
      this.history = Array.isArray(saved.history) ? saved.history : [];
      this.hold = !!saved.hold;
      this.visibleGenres = Array.isArray(saved.visibleGenres) ? saved.visibleGenres : null;
      this._seq = saved.seq || 0;
      // Kept across restarts so a restart mid-party does not have to learn
      // the crossfade again on a guest's song.
      this._leadSamples = (Array.isArray(saved.leadSamples) ? saved.leadSamples : [])
        .map(Number).filter((n) => n >= 0 && n < MAX_MUSIC_LEAD_SEC).slice(-LEAD_SAMPLES);
      this._applyLeadSamples();
      this.log(`restored ${this.queue.length} queued pick(s) from disk`);
    }

    try {
      await this.music.ensurePlaylist(this.cfg.playlistName);
      await this.music.resetModes();
    } catch (e) {
      this._recordError('startup', e);
    }

    // The playlist on disk may be stale after a restart. Make it match.
    if (this.queue.length) {
      try { await this._rebuildPlaylist(); } catch (e) { this._recordError('rebuild', e); }
    }

    this._schedule(0);
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._disarmHandoff();
  }

  // ---- the armed handoff -------------------------------------------------
  //
  // Polling cannot do this job alone. Each poll costs an osascript round trip
  // (~300ms on a healthy Mac, more on a busy one), so the effective poll
  // period is wider than the 0.6s window it is looking for, and the window
  // gets stepped straight over: 1.1s left, then already ended. The engine then
  // falls back on the recovery path and the room hears a moment of whatever
  // Music moved to.
  //
  // So instead of watching for the moment, we book it. Knowing the position
  // and the duration, we know when the handoff is due, and set a timer for
  // exactly then that plays the pick WITHOUT another read. It is re-armed on
  // every poll, so the estimate never gets stale.
  //
  // The poll-based check and the recovery rule both stay: if this timer never
  // fires, behaviour degrades to exactly what it was before.
  _disarmHandoff() {
    if (this._handoffTimer) clearTimeout(this._handoffTimer);
    this._handoffTimer = null;
  }

  _armHandoff(msUntilHandoff, trackPid, remainingAtFireSec) {
    this._disarmHandoff();
    if (this._stopped) return;
    this._handoffTimer = setTimeout(() => {
      this._handoffTimer = null;
      // Everything may have moved on while the timer ran.
      if (this._stopped || this.hold || this._starting) return;
      if (!this.queue.length) return;
      if (this._lastTrackPid !== trackPid) return;   // Music changed track itself
      if (this.nowPlaying && this.nowPlaying.pid !== trackPid) return;
      this._startNextPick('handoff', remainingAtFireSec).catch((e) => this._recordError('handoff', e));
    }, Math.max(0, msUntilHandoff));
    if (this._handoffTimer.unref) this._handoffTimer.unref();
  }

  _schedule(ms) {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick().catch((e) => this._recordError('tick', e)), ms);
    if (this._timer.unref) this._timer.unref();
  }

  _recordError(op, e) {
    this.lastError = { at: new Date().toISOString(), op, message: String(e && e.message ? e.message : e) };
    this.log(`error [${op}] ${this.lastError.message}`);
  }

  _persist() {
    this.store.save({
      queue: this.queue,
      nowPlaying: this.nowPlaying,
      history: this.history,
      hold: this.hold,
      visibleGenres: this.visibleGenres,
      seq: this._seq,
      leadSamples: this._leadSamples,
    });
  }

  _changed() {
    this._persist();
    this.emit('change', this.snapshot());
  }

  // ---- library index ----------------------------------------------------

  async reindex() {
    if (this.indexing) return this.index;
    this.indexing = true;
    this.emit('change', this.snapshot());
    try {
      const index = await this.music.indexLibrary();
      this.index = index;
      this.byPid = new Map(index.rows.map((r) => [r[0], r]));
      this.log(`index ready: ${index.stats.kept} playable of ${index.stats.total} (${index.elapsedMs}ms)`);
      return index;
    } catch (e) {
      this._recordError('reindex', e);
      throw e;
    } finally {
      this.indexing = false;
      this._changed();
    }
  }

  // ---- picking ----------------------------------------------------------

  // Returns { ok: true, position } or { ok: false, reason }.
  async pick({ pid, deviceId, pickedBy, isHost }) {
    pid = String(pid || '');
    deviceId = String(deviceId || '');
    const row = this.byPid.get(pid);

    if (!this.index) return { ok: false, reason: 'The jukebox is still reading the library. Try again in a moment.' };
    if (!row) return { ok: false, reason: "That song isn't in the jukebox index." };
    if (!deviceId) return { ok: false, reason: 'Missing device id.' };

    if (this.queue.length >= this.cfg.maxQueueLength) {
      return { ok: false, reason: `The queue is full (${this.cfg.maxQueueLength} songs). Try again later.` };
    }
    if (this.nowPlaying && this.nowPlaying.pid === pid) {
      return { ok: false, reason: "That one's playing right now." };
    }
    if (this.queue.some((q) => q.pid === pid)) {
      return { ok: false, reason: "That one's already in the queue." };
    }

    const limit = isHost ? this.cfg.maxPerHost : this.cfg.maxPerDevice;
    const mine = this.queue.filter((q) => q.deviceId === deviceId).length;
    if (mine >= limit) {
      return { ok: false, reason: `You've got ${mine} songs waiting already. Wait for one to play.` };
    }

    if (!isHost) {
      const cutoff = nowMs() - this.cfg.repeatWindowMin * 60000;
      const recent = this.history.find((h) => h.pid === pid && h.at >= cutoff);
      if (recent) {
        const mins = Math.ceil((recent.at + this.cfg.repeatWindowMin * 60000 - nowMs()) / 60000);
        return { ok: false, reason: `That was played recently. Try again in ${mins} min.` };
      }
    }

    const entry = {
      id: 'p' + (++this._seq),
      pid,
      title: row[1],
      artist: row[2],
      album: row[3],
      duration: row[4],
      code: row[5],
      pickedBy: (pickedBy || '').toString().trim().slice(0, 24) || null,
      deviceId,
      isHost: !!isHost,
      addedAt: nowMs(),
    };

    try {
      await this.music.ensurePlaylist(this.cfg.playlistName);
      await this.music.appendTrack(this.cfg.playlistName, pid);
    } catch (e) {
      this._recordError('appendTrack', e);
      return { ok: false, reason: 'The jukebox could not add that song. Tell the host.' };
    }

    this.queue.push(entry);
    this.playlistPids.push(pid);
    this._changed();

    // Nothing playing and no hold? Do not make the room wait for a poll.
    if (!this.hold && (this.player.state === 'stopped' || (!this.nowPlaying && this.player.state === 'paused'))) {
      this._schedule(0);
    }

    return { ok: true, position: this.queue.length, entry };
  }

  removeByEntryId(id) {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i === -1) return { ok: false, reason: 'Not in the queue.' };
    const [entry] = this.queue.splice(i, 1);
    this.music.removeTrack(this.cfg.playlistName, entry.pid).catch((e) => this._recordError('removeTrack', e));
    this._changed();
    return { ok: true, entry };
  }

  removeLast() {
    if (!this.queue.length) return { ok: false, reason: 'Queue is empty.' };
    return this.removeByEntryId(this.queue[this.queue.length - 1].id);
  }

  async clearQueue() {
    this.queue = [];
    this.playlistPids = this.nowPlaying ? [this.nowPlaying.pid] : [];
    try { await this.music.clearPlaylist(this.cfg.playlistName); } catch (e) { this._recordError('clearPlaylist', e); }
    if (this.nowPlaying) {
      // Keep the playing pick in the playlist so Music does not lose its place.
      try { await this.music.appendTrack(this.cfg.playlistName, this.nowPlaying.pid); } catch (e) { /* best effort */ }
    }
    this._changed();
    return { ok: true };
  }

  // Which genres get their own button. null means choose the biggest
  // automatically; a list means the host picked. Kept on the server, not in
  // the browser, so the laptop and every phone show the same bar.
  setVisibleGenres(list) {
    if (list === null || list === undefined) {
      this.visibleGenres = null;
    } else if (Array.isArray(list)) {
      const known = new Set((this.index ? this.index.genres : []).map((g) => g.name));
      const clean = list.map(String).filter((n) => known.has(n));
      // An empty list is a real choice -- ALL and OTHER only -- and is not
      // the same as null, which means choose the biggest automatically.
      this.visibleGenres = Array.from(new Set(clean));
    } else {
      return { ok: false, reason: 'Expected a list of genre names.' };
    }
    this._changed();
    return { ok: true, visibleGenres: this.visibleGenres };
  }

  // ---- host transport ---------------------------------------------------

  async skip() {
    if (this.queue.length) {
      const started = await this._startNextPick('skip');
      return { ok: started, via: 'pick' };
    }
    this._lastCommandAt = nowMs();   // so the crossfade measurement ignores it
    try { await this.music.transport('next'); } catch (e) { this._recordError('next', e); return { ok: false }; }
    this._schedule(0);
    return { ok: true, via: 'music' };
  }

  async togglePlayPause() {
    const wasPlaying = this.player.state === 'playing';
    // Set hold straight away so a pick arriving before the next poll behaves.
    this.hold = wasPlaying;
    try {
      await this.music.transport(wasPlaying ? 'pause' : 'play');
    } catch (e) {
      this._recordError('playpause', e);
      return { ok: false };
    }
    // Resuming with nothing playing but picks waiting: start one.
    if (!this.hold && !this.nowPlaying && this.queue.length) this._schedule(0);
    this._changed();
    return { ok: true, hold: this.hold };
  }

  async setHold(hold) {
    this.hold = !!hold;
    try { await this.music.transport(this.hold ? 'pause' : 'play'); } catch (e) { this._recordError('hold', e); }
    if (!this.hold && this.queue.length && !this.nowPlaying) this._schedule(0);
    this._changed();
    return { ok: true, hold: this.hold };
  }

  async nudgeVolume(delta) {
    const base = typeof this.player.volume === 'number' ? this.player.volume : 50;
    const next = Math.max(0, Math.min(100, Math.round(base + delta)));
    try { await this.music.transport('volume', next); } catch (e) { this._recordError('volume', e); return { ok: false }; }
    this.player.volume = next;
    this._changed();
    return { ok: true, volume: next };
  }

  async setVolume(v) {
    const next = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    try { await this.music.transport('volume', next); } catch (e) { this._recordError('volume', e); return { ok: false }; }
    this.player.volume = next;
    this._changed();
    return { ok: true, volume: next };
  }

  // ---- the loop ---------------------------------------------------------

  async _tick() {
    if (this._stopped) return;
    if (this._ticking) return this._schedule(POLL_NORMAL_MS);

    // A read racing a write is how Apple Events get wedged.
    if (this.music.isWriting()) return this._schedule(POLL_CLOSE_MS);

    this._ticking = true;
    let delay = POLL_NORMAL_MS;
    try {
      delay = await this._tickOnce();
    } catch (e) {
      this._recordError('tick', e);
    } finally {
      this._ticking = false;
      this._schedule(delay);
    }
  }

  async _tickOnce() {
    // Deliberately does NOT disarm here. Cancelling at the top of the tick
    // and re-arming after the read leaves the engine blind for the whole
    // round trip, and the handoff moment lands in that hole often enough to
    // matter. _armHandoff replaces any existing timer, and the timer checks
    // for itself that the situation still holds before it fires.
    const st = await this.music.readState(this.cfg.playlistName);
    const readStartedAtMs = nowMs() - (Number(st.readLatencyMs) || 0);

    // A reading that began before our own play command finished describes a
    // room that no longer exists, so it is thrown away whole -- not merely
    // stopped from clearing nowPlaying, which is all an earlier fix did.
    //
    // A read takes ~300ms and the booked handoff fires on its own schedule,
    // so a read is in flight at the handoff more often than not. It comes
    // back showing the OLD track with ~0.3s left, and the rest of this
    // function, taking it at face value, concluded "track ending, picks
    // waiting, hand off" and started the pick AFTER the one that had just
    // begun. The room heard the end of one song, half a second of the next,
    // then a third. Test 21 pins this.
    //
    // Stale is no basis for a decision, but it is still a true record of the
    // past. If it shows Music already on a THIRD song -- neither the one we
    // were timing nor the pick we sent -- Music moved first, and that is the
    // crossfade measurement. With a short crossfade (~1s) our handoff lands
    // within one read of Music's own move, so this is the only reading that
    // ever sees it while picks keep coming. Test 25.
    if (this._starting || readStartedAtMs < this._lastPlayAt) {
      const prev = this._lastObs;
      const pid = st.track ? st.track.pid : null;
      if (prev && pid && st.state === 'playing' && pid !== prev.pid && pid !== this._lastCommandPid &&
          readStartedAtMs > prev.sampledAtMs) {
        this._recordMusicLead(prev, (Number(st.position) || 0) + (Number(st.readLatencyMs) || 0) / 1000);
      }
      return POLL_CLOSE_MS;
    }

    // Fresh, but Music has not caught up with the pick we just started.
    // Nothing this reading says about the queue can be trusted yet: acting on
    // it skips the pick exactly as a stale read does. Wait for the next one.
    //
    // With crossfade on, Music may go on showing the song it is fading OUT
    // of for the length of the fade (unmeasured -- test 23 simulates it), so
    // a reading of the very song we played over gets that much longer.
    // Bounded: at worst a play that never took is noticed a crossfade late.
    const seenPid = st.track ? st.track.pid : null;
    const settleMs = PICK_SETTLE_MS +
      (seenPid && seenPid === this._playedOverPid ? this.musicLeadSec * 1000 : 0);
    if (st.running && this.nowPlaying && seenPid !== this.nowPlaying.pid &&
        this._nowPlayingAt > 0 && nowMs() - this._nowPlayingAt < settleMs) {
      return POLL_CLOSE_MS;
    }

    // read-state.js samples the position near the start of its osascript run,
    // so by the time we act the track has already moved on by about the
    // round-trip time. Uncorrected, the handoff consistently fires late --
    // on a ~300ms read that is half the 0.6s window gone before we look.
    const readLagSec = (Number(st.readLatencyMs) || 0) / 1000;
    this.player = {
      running: st.running,
      state: st.state,
      position: (st.position || 0) + (st.state === 'playing' ? readLagSec : 0),
      duration: st.track ? st.track.duration : 0,
      volume: st.volume,
      track: st.track,
    };
    this.playlistPids = st.playlistPids;

    if (!st.running) {
      this.emit('change', this.snapshot());
      return POLL_NORMAL_MS;
    }

    const track = st.track;
    const trackPid = track ? track.pid : null;

    // First tick after startup just records where things stand. Acting on a
    // "change" from nothing to whatever was already playing would cut off a
    // song that was running before the jukebox started.
    if (!this._primed) {
      this._primed = true;
      this._lastTrackPid = trackPid;
      this.emit('change', this.snapshot());
      return POLL_NORMAL_MS;
    }

    const trackChanged = trackPid !== this._lastTrackPid;
    this._lastTrackPid = trackPid;

    const prevObs = this._lastObs;
    this._lastObs = st.state === 'playing' && trackPid && this.player.duration > 0
      ? {
          pid: trackPid,
          sampledAtMs: readStartedAtMs,
          endsAtMs: nowMs() + (this.player.duration - this.player.position) * 1000,
        }
      : null;
    if (trackChanged) this._measureMusicLead(prevObs, trackPid, st.state);

    // Hold tracks what the room can hear, however it got that way: our own
    // pause, the media key, or the space bar in Music.
    //
    // Deliberately NOT a playing->paused transition test. A pause landing
    // between starting a pick and the next poll would never be seen as a
    // transition, and the room would stay silent while picks piled up.
    // Instead: paused counts as hold once we know Music has played at all.
    // Paused at startup, which nobody did on purpose, leaves hold clear so
    // the first pick starts playback.
    if (st.state === 'playing') {
      this._everPlayed = true;
      if (this.hold) this.hold = false;
    } else if (st.state === 'paused' && this._everPlayed) {
      this.hold = true;
    }

    // Our pick is no longer the thing playing.
    //
    // Readings older than the pick, or taken before Music caught up with it,
    // never get this far (see the top of this function). Believing one of
    // them here wiped nowPlaying, and the song then played out labelled
    // AUTOPLAY with nobody's name on it -- at a party the entire point of the
    // feature, gone. Test 17 pins that.
    if (this.nowPlaying && trackPid !== this.nowPlaying.pid) {
      this.nowPlaying = null;
      this._nowPlayingAt = 0;
      this._changed();
    }

    const playingOurPick = !!(this.nowPlaying && trackPid === this.nowPlaying.pid);

    if (this.hold) {
      this.emit('change', this.snapshot());
      return POLL_NORMAL_MS;
    }

    if (this.queue.length) {
      // Music started the queue head by itself (it did notice the append).
      if (trackChanged && trackPid && this.queue[0].pid === trackPid) {
        this._promoteHead();
        return POLL_NORMAL_MS;
      }

      // Nothing playing at all: go now.
      if (st.state === 'stopped' || !track) {
        await this._startNextPick('stopped');
        return POLL_CLOSE_MS;
      }

      const dur = Number(this.player.duration) || 0;
      const pos = Number(this.player.position) || 0;

      // Was the waiting pick already in the queue when this song started?
      //
      // This is the whole distinction between the two rules, and it is done
      // by timestamp rather than by "did the track change since the last
      // poll" because the poll can easily land on the wrong side of a pick:
      //
      //   pick added AFTER this song started  -> somebody chose during
      //      Autoplay. Ride the song out and hand off at the end.
      //   pick added BEFORE this song started -> this song began while a
      //      pick was waiting, so the handoff was missed. Take the room back.
      //
      // Derived from the player position, so it does not care when we polled.
      // The margin absorbs position jitter and osascript round-trip time.
      const trackStartedAtMs = nowMs() - pos * 1000;
      const missedHandoff = this.queue[0].addedAt < trackStartedAtMs - 250;

      if (!playingOurPick && missedHandoff) {
        await this._startNextPick('recovered', dur - pos);
        return POLL_CLOSE_MS;
      }

      // Paused with nothing of ours playing (e.g. Music was idle at startup):
      // the first pick starts playback.
      if (st.state === 'paused' && !playingOurPick) {
        await this._startNextPick('first-pick');
        return POLL_CLOSE_MS;
      }

      // Otherwise ride the current song out and hand off at the very end.
      // This is what stops a pick cutting an Autoplay song in half.
      if (st.state === 'playing' && dur > 0) {
        const remaining = dur - pos;
        // With crossfade on, Music leaves the track musicLeadSec early by
        // itself, so the handoff has to come that much sooner to beat it.
        const handoffAt = HANDOFF_SEC + this.musicLeadSec;
        if (remaining <= handoffAt) {
          await this._startNextPick('handoff', remaining);
          return POLL_CLOSE_MS;
        }
        // Book the handoff for the exact moment it is due, rather than hoping
        // a poll lands inside the window.
        this._armHandoff((remaining - handoffAt) * 1000, trackPid, handoffAt);
        if (remaining <= POLL_CLOSE_WINDOW_SEC + this.musicLeadSec) return POLL_CLOSE_MS;
      }
    } else {
      await this._housekeep();
    }

    this.emit('change', this.snapshot());
    return POLL_NORMAL_MS;
  }

  _promoteHead() {
    const entry = this.queue.shift();
    this.nowPlaying = entry;
    this._nowPlayingAt = nowMs();
    this._playedOverPid = null;   // Music moved by itself; nothing was played over
    this.history.push({ pid: entry.pid, at: nowMs() });
    this._pruneHistory();
    this.log(`promoted ${entry.artist} - ${entry.title} (Music started it itself)`);
    this._changed();
  }

  async _startNextPick(reason, remainingSec) {
    // One start at a time. The booked handoff, a poll and the host's skip can
    // each decide the moment has come, and two overlapping starts used to
    // each take the queue head AFTER awaiting the play: the first played B,
    // the second played B again and then shifted C off the queue unplayed.
    // Whoever got here first wins; the rest stand down. Test 20 pins this.
    if (this._starting) return false;
    this._disarmHandoff();
    if (!this.queue.length) return false;
    this._starting = true;
    try {
      return await this._startPick(this.queue[0], reason, remainingSec);
    } finally {
      this._starting = false;
    }
  }

  // Remove exactly this entry. Never queue.shift() after an await: the head
  // may not be the entry we started by then.
  _dropFromQueue(entry) {
    const i = this.queue.indexOf(entry);
    if (i !== -1) this.queue.splice(i, 1);
  }

  async _startPick(entry, reason, remainingSec) {
    const previous = this.nowPlaying;

    // The playlist must actually contain the pick, or play-track finds nothing.
    const pids = this.playlistPids || [];
    if (!pids.includes(entry.pid)) {
      this.log(`pick ${entry.pid} missing from playlist, rebuilding`);
      try {
        await this._rebuildPlaylist();
      } catch (e) {
        this._recordError('rebuild', e);
        return false;
      }
    }

    this._lastCommandAt = nowMs();
    this._lastCommandPid = entry.pid;
    this._playedOverPid = this._lastTrackPid;   // what the room was hearing
    try {
      await this.music.playTrack(this.cfg.playlistName, entry.pid);
    } catch (e) {
      this._lastPlayAt = nowMs();
      this._recordError('playTrack', e);
      // A pick that cannot be played must not wedge the queue for the night.
      this._dropFromQueue(entry);
      this._changed();
      return false;
    }
    this._lastPlayAt = nowMs();

    this._dropFromQueue(entry);
    this.nowPlaying = entry;
    this._nowPlayingAt = nowMs();
    this.hold = false;
    this._everPlayed = true;
    this.player.state = 'playing';   // true until the next poll says otherwise
    this._lastTrackPid = entry.pid;
    this.history.push({ pid: entry.pid, at: nowMs() });
    this._pruneHistory();

    // Recorded and logged so the party's own log says how every pick got on
    // air. "handoff" is the clean path; "recovered" means the handoff was
    // missed and the next track was taken back instead, which costs a
    // fraction of a second of the wrong song.
    this.lastStart = {
      at: nowMs(),
      reason: reason || 'unknown',
      title: entry.title,
      remaining: typeof remainingSec === 'number' ? Math.round(remainingSec * 100) / 100 : null,
    };
    const how = reason === 'handoff' && typeof remainingSec === 'number'
      ? `handoff at ${remainingSec.toFixed(2)}s left`
      : reason === 'recovered'
        ? `RECOVERED (handoff missed${typeof remainingSec === 'number' ? `, ${remainingSec.toFixed(2)}s of tail unplayed` : ''})`
        : reason || 'unknown';
    this.log(`playing ${entry.artist} - ${entry.title}` +
             `${entry.pickedBy ? ' (for ' + entry.pickedBy + ')' : ''}  [${how}]`);

    // Keep the playlist mirroring [current, ...queued] by dropping the one
    // that just finished. Best effort: it must never stop the music.
    if (previous && previous.pid !== entry.pid) {
      this.music.removeTrack(this.cfg.playlistName, previous.pid).catch(() => {});
    }

    this._changed();
    return true;
  }

  // ---- crossfade ----------------------------------------------------------
  //
  // With Crossfade Songs on, Music starts its next track N seconds before the
  // end of this one -- long before the 0.6s handoff. The handoff never won
  // that race: every pick arrived by the recovery path, and the room heard
  // the first song fading, a second of whatever Music had chosen, and only
  // then the pick.
  //
  // Music's scripting dictionary does not expose the crossfade setting, so
  // the engine measures it instead. Each time Music changes track by itself
  // -- an Autoplay song ending, a pick running out into Autoplay -- compare
  // when the old track was due to end with when the new one started. With
  // crossfade off that is ~0; with it on it is N. The handoff is then booked
  // N seconds earlier, so the pick goes on before Music's own move.
  //
  // The median of the last three readings, so one stray measurement (the
  // host pressing next in Music near the end of a song) cannot move it.
  _measureMusicLead(prev, trackPid, state) {
    if (!prev || !trackPid || prev.pid === trackPid || state !== 'playing') return;
    // A change we caused says nothing about Music.
    if (this._lastCommandAt >= prev.sampledAtMs) return;
    this._recordMusicLead(prev, Number(this.player.position) || 0);
  }

  // prev: the last sighting of the old track. newPosSec: where the new one
  // is now, already corrected for read latency.
  _recordMusicLead(prev, newPosSec) {
    const startedAtMs = nowMs() - newPosSec * 1000;
    const lead = (prev.endsAtMs - startedAtMs) / 1000;
    // Much later than due: a stall or a pause, not a crossfade. Much earlier
    // than any crossfade: somebody skipped.
    if (!(lead > -1 && lead < MAX_MUSIC_LEAD_SEC)) return;
    this._leadSamples.push(Math.round(Math.max(0, lead) * 100) / 100);
    if (this._leadSamples.length > LEAD_SAMPLES) this._leadSamples.shift();
    const before = this.musicLeadSec;
    this._applyLeadSamples();
    if (Math.abs(this.musicLeadSec - before) >= 0.25) {
      this.log(this.musicLeadSec
        ? `Music is leaving tracks ${this.musicLeadSec.toFixed(1)}s early (crossfade): ` +
          `handing off at ${(this.musicLeadSec + HANDOFF_SEC).toFixed(1)}s left to get in first`
        : `Music is playing tracks to the end (no crossfade): handing off at ${HANDOFF_SEC}s left`);
    }
    this._persist();
  }

  _applyLeadSamples() {
    const s = this._leadSamples.slice().sort((a, b) => a - b);
    const n = s.length;
    const median = !n ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    this.musicLeadSec = median < MIN_MUSIC_LEAD_SEC ? 0 : Math.round(median * 100) / 100;
  }

  async _rebuildPlaylist() {
    await this.music.ensurePlaylist(this.cfg.playlistName);
    await this.music.clearPlaylist(this.cfg.playlistName);
    for (const entry of this.queue) {
      await this.music.appendTrack(this.cfg.playlistName, entry.pid);
    }
    this.playlistPids = this.queue.map((q) => q.pid);
    this.log(`rebuilt playlist with ${this.queue.length} track(s)`);
  }

  async _housekeep() {
    if (this.nowPlaying) return;
    if (nowMs() - this._lastHousekeepAt < HOUSEKEEP_MS) return;
    this._lastHousekeepAt = nowMs();
    const pids = this.playlistPids || [];
    if (!pids.length) return;
    try {
      await this.music.clearPlaylist(this.cfg.playlistName);
      this.log('cleared the jukebox playlist (queue empty, Autoplay has the room)');
    } catch (e) {
      this._recordError('housekeep', e);
    }
  }

  _pruneHistory() {
    const cutoff = nowMs() - this.cfg.repeatWindowMin * 60000;
    this.history = this.history.filter((h) => h.at >= cutoff);
  }

  // ---- view -------------------------------------------------------------

  snapshot() {
    // Fall back to the pick we just started. player.track only refreshes on
    // the next poll, so without this the Now Playing panel blinks empty for
    // a moment every time a pick takes over.
    const t = this.player.track || (this.nowPlaying
      ? {
          pid: this.nowPlaying.pid,
          title: this.nowPlaying.title,
          artist: this.nowPlaying.artist,
          album: this.nowPlaying.album,
          duration: this.nowPlaying.duration,
        }
      : null);
    return {
      hold: this.hold,
      indexing: this.indexing,
      indexVersion: this.index ? this.index.version : null,
      indexCount: this.index ? this.index.stats.kept : 0,
      visibleGenres: this.visibleGenres,
      player: {
        running: this.player.running,
        state: this.player.state,
        position: this.player.position,
        duration: this.player.duration,
        volume: this.player.volume,
      },
      nowPlaying: t
        ? {
            pid: t.pid,
            title: t.title,
            artist: t.artist,
            album: t.album,
            duration: t.duration,
            pickedBy: this.nowPlaying ? this.nowPlaying.pickedBy : null,
            isPick: !!this.nowPlaying,
          }
        : null,
      queue: this.queue.map((q) => ({
        id: q.id,
        pid: q.pid,
        title: q.title,
        artist: q.artist,
        code: q.code,
        duration: q.duration,
        pickedBy: q.pickedBy,
      })),
      queuedPids: this.queue.map((q) => q.pid),
      lastError: this.lastError,
      lastStart: this.lastStart,
      musicLeadSec: this.musicLeadSec,
      at: nowMs(),
    };
  }
}

module.exports = { Engine, HANDOFF_SEC, POLL_NORMAL_MS, POLL_CLOSE_MS };
