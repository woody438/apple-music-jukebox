/* Party Jukebox DEMO.
 *
 * The real client talks to server.js over fetch + SSE, which drives the
 * macOS Music app. This file keeps the identical markup, stylesheet and
 * interaction code, and swaps that server for a simulator running in the
 * page -- a fake player, a fake queue engine, a fake library.
 *
 * It proves NOTHING about the Music integration. preflight.js does that.
 */
'use strict';

var MODIFIER = { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false };

var FLIP_MS = 420;
var IDLE_RESET_MS = 90000;
var ATTRACT_IDLE_MS = 30000;
var ATTRACT_STEP_MS = 8000;
var MAX_GENRE_BUTTONS = 18;
var STRIP_MIN_W = 190;
var STRIP_MIN_H = 62;
var PHONE_STRIP_H = 72;

var HANDOFF_SEC = 0.6;
var ALL = '__ALL__';
var OTHER = '__OTHER__';

var COL = { PID: 0, TITLE: 1, ARTIST: 2, ALBUM: 3, DURATION: 4, CODE: 5, GENRE: 6 };

// ---------------------------------------------------------------------------
// helpers (identical to the real client)
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function store(key, value) {
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value);
  } catch (e) {}
  return null;
}

function makeId() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function fold(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function mmss(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function hashOf(s) {
  var h = 0;
  s = String(s || '');
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function bandFor(artist) { return 'var(--band-' + ((hashOf(artist) % 6) + 1) + ')'; }

function artistSortKey(artist) {
  var a = fold(artist).trim().replace(/^(the|a|an)\s+/, '');
  return a || fold(artist).trim();
}

function railLetterOf(artist) {
  var c = artistSortKey(artist).charAt(0);
  return c >= 'a' && c <= 'z' ? c.toUpperCase() : '#';
}

// ===========================================================================
// THE SIMULATOR -- stands in for server.js + lib/engine.js + the Music app
// ===========================================================================
var SIM = {
  rows: [],
  genres: [],
  byPid: {},
  queue: [],
  nowPlaying: null,      // { ...row fields, pickedBy, isPick }
  startedAtMs: 0,
  frozenPos: 0,
  state: 'stopped',
  hold: false,
  volume: 55,
  history: [],
  seq: 0,
  speed: 8,              // demo clock multiplier, so a 4-minute song is ~30s
  lastError: null,
};

var LIMITS = { perDevice: 3, perHost: 10, maxQueue: 60, repeatMin: 60 };

function buildSimIndex(raw) {
  var rows = raw.map(function (t, i) {
    return ['DEMO' + String(i).padStart(5, '0'), t[0], t[1], '', t[3], '', t[2]];
  });

  rows.sort(function (a, b) {
    var ka = artistSortKey(a[COL.ARTIST]), kb = artistSortKey(b[COL.ARTIST]);
    if (ka !== kb) return ka < kb ? -1 : 1;
    var ta = fold(a[COL.TITLE]), tb = fold(b[COL.TITLE]);
    return ta === tb ? 0 : (ta < tb ? -1 : 1);
  });

  var counters = {};
  for (var i = 0; i < rows.length; i++) {
    var L = railLetterOf(rows[i][COL.ARTIST]);
    counters[L] = (counters[L] || 0) + 1;
    rows[i][COL.CODE] = L + '-' + counters[L];
  }

  var counts = {};
  rows.forEach(function (r) { counts[r[COL.GENRE]] = (counts[r[COL.GENRE]] || 0) + 1; });
  var genres = Object.keys(counts).map(function (n) { return { name: n, count: counts[n] }; })
    .sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });

  SIM.rows = rows;
  SIM.genres = genres;
  SIM.byPid = {};
  rows.forEach(function (r) { SIM.byPid[r[COL.PID]] = r; });
}

function simPosition() {
  if (SIM.state !== 'playing') return SIM.frozenPos;
  return SIM.frozenPos + ((Date.now() - SIM.startedAtMs) / 1000) * SIM.speed;
}

function simStart(entry, isPick) {
  SIM.nowPlaying = {
    pid: entry.pid, title: entry.title, artist: entry.artist,
    album: entry.album || '', duration: entry.duration,
    pickedBy: isPick ? entry.pickedBy : null, isPick: !!isPick,
  };
  SIM.state = 'playing';
  SIM.startedAtMs = Date.now();
  SIM.frozenPos = 0;
  SIM.history.push({ pid: entry.pid, at: Date.now() });
}

function simAutoplay() {
  var r = SIM.rows[Math.floor(Math.random() * SIM.rows.length)];
  simStart({
    pid: r[COL.PID], title: r[COL.TITLE], artist: r[COL.ARTIST],
    album: r[COL.ALBUM], duration: r[COL.DURATION],
  }, false);
}

function simStartNextPick() {
  if (!SIM.queue.length) return false;
  simStart(SIM.queue.shift(), true);
  return true;
}

// The engine rules from lib/engine.js, in miniature.
function simTick() {
  if (SIM.hold) return;

  if (SIM.state !== 'playing' || !SIM.nowPlaying) {
    if (SIM.queue.length) simStartNextPick();
    return;
  }

  var dur = SIM.nowPlaying.duration || 0;
  var pos = simPosition();

  if (SIM.queue.length) {
    // Was the waiting pick already queued when this song started? If so the
    // handoff was missed and the room gets its pick now. If it arrived after
    // this song was under way (the Autoplay case), ride the song out.
    var trackStartedAtMs = Date.now() - (pos / SIM.speed) * 1000;
    var missedHandoff = SIM.queue[0].addedAt < trackStartedAtMs - 250;

    if (!SIM.nowPlaying.isPick && missedHandoff) { simStartNextPick(); return; }
    if (dur > 0 && dur - pos <= HANDOFF_SEC * SIM.speed) { simStartNextPick(); return; }
  }

  if (dur > 0 && pos >= dur) {
    if (!simStartNextPick()) simAutoplay();
  }
}

function simPick(pid, deviceId, pickedBy, isHost) {
  var row = SIM.byPid[pid];
  if (!row) return { ok: false, reason: "That song isn't in the jukebox index." };
  if (SIM.queue.length >= LIMITS.maxQueue) return { ok: false, reason: 'The queue is full. Try again later.' };
  if (SIM.nowPlaying && SIM.nowPlaying.pid === pid) return { ok: false, reason: "That one's playing right now." };
  for (var i = 0; i < SIM.queue.length; i++) {
    if (SIM.queue[i].pid === pid) return { ok: false, reason: "That one's already in the queue." };
  }

  var limit = isHost ? LIMITS.perHost : LIMITS.perDevice;
  var mine = SIM.queue.filter(function (q) { return q.deviceId === deviceId; }).length;
  if (mine >= limit) return { ok: false, reason: "You've got " + mine + ' songs waiting already. Wait for one to play.' };

  if (!isHost) {
    var cutoff = Date.now() - LIMITS.repeatMin * 60000;
    for (var h = 0; h < SIM.history.length; h++) {
      if (SIM.history[h].pid === pid && SIM.history[h].at >= cutoff) {
        return { ok: false, reason: 'That was played recently. Try again later.' };
      }
    }
  }

  SIM.queue.push({
    id: 'p' + (++SIM.seq), pid: pid,
    title: row[COL.TITLE], artist: row[COL.ARTIST], album: row[COL.ALBUM],
    duration: row[COL.DURATION], code: row[COL.CODE],
    pickedBy: (pickedBy || '').trim().slice(0, 24) || null,
    deviceId: deviceId, isHost: !!isHost, addedAt: Date.now(),
  });

  if (SIM.state !== 'playing' && !SIM.hold) simTick();
  return { ok: true, position: SIM.queue.length };
}

function simHost(verb, body) {
  body = body || {};
  switch (verb) {
    case 'skip':
      if (SIM.queue.length) { simStartNextPick(); return { ok: true, via: 'pick' }; }
      simAutoplay(); return { ok: true, via: 'music' };
    case 'playpause':
      if (SIM.state === 'playing') { SIM.frozenPos = simPosition(); SIM.state = 'paused'; SIM.hold = true; }
      else { SIM.startedAtMs = Date.now(); SIM.state = SIM.nowPlaying ? 'playing' : 'stopped'; SIM.hold = false; }
      return { ok: true, hold: SIM.hold };
    case 'hold':
      SIM.hold = !!body.hold;
      if (SIM.hold && SIM.state === 'playing') { SIM.frozenPos = simPosition(); SIM.state = 'paused'; }
      else if (!SIM.hold && SIM.nowPlaying) { SIM.startedAtMs = Date.now(); SIM.state = 'playing'; }
      return { ok: true, hold: SIM.hold };
    case 'volume':
      SIM.volume = Math.max(0, Math.min(100, body.delta !== undefined
        ? SIM.volume + Number(body.delta) : Number(body.value)));
      return { ok: true, volume: SIM.volume };
    case 'remove': {
      var i = SIM.queue.findIndex(function (q) { return q.id === body.id; });
      if (i === -1) return { ok: false, reason: 'Not in the queue.' };
      return { ok: true, entry: SIM.queue.splice(i, 1)[0] };
    }
    case 'remove-last':
      if (!SIM.queue.length) return { ok: false, reason: 'Queue is empty.' };
      return { ok: true, entry: SIM.queue.pop() };
    case 'clear':
      SIM.queue = []; return { ok: true };
    case 'reindex':
      return { ok: true, count: SIM.rows.length, version: 'demo' };
    default:
      return { ok: false, reason: 'Unknown host command.' };
  }
}

function simSnapshot() {
  return {
    hold: SIM.hold,
    indexing: false,
    indexVersion: 'demo',
    indexCount: SIM.rows.length,
    player: {
      running: true,
      state: SIM.state,
      position: Math.min(simPosition(), SIM.nowPlaying ? SIM.nowPlaying.duration : 0),
      duration: SIM.nowPlaying ? SIM.nowPlaying.duration : 0,
      volume: SIM.volume,
    },
    nowPlaying: SIM.nowPlaying ? {
      pid: SIM.nowPlaying.pid, title: SIM.nowPlaying.title, artist: SIM.nowPlaying.artist,
      album: SIM.nowPlaying.album, duration: SIM.nowPlaying.duration,
      pickedBy: SIM.nowPlaying.pickedBy, isPick: SIM.nowPlaying.isPick,
    } : null,
    queue: SIM.queue.map(function (q) {
      return { id: q.id, pid: q.pid, title: q.title, artist: q.artist, code: q.code,
               duration: q.duration, pickedBy: q.pickedBy };
    }),
    queuedPids: SIM.queue.map(function (q) { return q.pid; }),
    lastError: SIM.lastError,
    at: Date.now(),
  };
}

// Stand-in artwork: a printed label drawn per artist. The real app pulls the
// actual album art out of Music.
var artCache = {};
function simArtwork(pid) {
  if (artCache[pid]) return artCache[pid];
  var row = SIM.byPid[pid];
  if (!row) return null;
  // Roughly one song in five has no artwork, so the fallback label is visible.
  if (hashOf(row[COL.ARTIST] + row[COL.TITLE]) % 5 === 0) { artCache[pid] = null; return null; }

  var PALETTE = [['#1f6f8b', '#0d3b4c'], ['#9c2b2b', '#4f1414'], ['#2e6b3f', '#133420'],
                 ['#6b3fa0', '#301a4c'], ['#b4651a', '#5a3009'], ['#16556b', '#0a2b36']];
  var p = PALETTE[hashOf(row[COL.ARTIST]) % PALETTE.length];

  var c = document.createElement('canvas');
  c.width = c.height = 240;
  var x = c.getContext('2d');
  var g = x.createLinearGradient(0, 0, 240, 240);
  g.addColorStop(0, p[0]); g.addColorStop(1, p[1]);
  x.fillStyle = g; x.fillRect(0, 0, 240, 240);

  x.strokeStyle = 'rgba(255,255,255,.22)'; x.lineWidth = 3;
  for (var r = 30; r < 200; r += 26) { x.beginPath(); x.arc(120, 120, r, 0, Math.PI * 2); x.stroke(); }

  var initials = row[COL.ARTIST].replace(/^(The|A|An)\s+/i, '')
    .split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  x.fillStyle = 'rgba(0,0,0,.45)';
  x.beginPath(); x.arc(120, 120, 74, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff';
  x.font = 'bold 62px Oswald, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(initials, 120, 126);

  artCache[pid] = c.toDataURL('image/png');
  return artCache[pid];
}

// ===========================================================================
// THE CLIENT -- same code as public/app.js, minus the network
// ===========================================================================
var cfg = { title: 'JUKEBOX', isHost: false, guestUrl: null, maxPerDevice: 3, mock: true };
var deviceId = store('jukebox.deviceId') || (function () { var i = makeId(); store('jukebox.deviceId', i); return i; })();

var rows = [], hay = [], genres = [], topGenreNames = {};
var genre = ALL, query = '';
var view = [], viewLetterStart = {}, pageStart = 0, pageSize = 16;
var cols = 4, rows_ = 4, pending = null;
var snap = null, snapAt = 0;
var queuedPids = Object.create(null);
var nowPid = null, artPid = null;
var idleTimer = null, attractIdleTimer = null, attractTimer = null;
var attractOn = false, flipping = false, isPhone = false;

function boot() {
  buildSimIndex(DEMO_LIBRARY);
  measure();
  window.addEventListener('resize', function () { measure(); render(); updateGenreArrows(); });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { measure(); render(); updateGenreArrows(); }, 250);
  });

  // In the real app the host is whoever is on the laptop itself (loopback).
  // Here, the big layout is the cabinet and the narrow one is a guest phone.
  cfg.isHost = !isPhone;
  cfg.guestUrl = location.href;
  $('jbTitle').textContent = cfg.title;

  if (cfg.isHost) {
    setupQr(cfg.guestUrl);
    bindHotkeys();
    startIdleWatch();
  }

  loadIndex();
  bindUi();
  buildDemoBar();

  setInterval(function () { simTick(); applySnapshot(simSnapshot()); }, 250);
  setInterval(paintProgress, 250);
  simTick();
  applySnapshot(simSnapshot());
}

function measure() {
  isPhone = window.matchMedia('(max-width: 820px)').matches ||
            (window.matchMedia('(orientation: portrait)').matches && window.innerWidth <= 1100);
  var area = $('pageArea');
  var w = area.clientWidth || 800, h = area.clientHeight || 400, gap = 8;
  if (isPhone) {
    cols = 1;
    rows_ = Math.max(3, Math.floor((h + gap) / (PHONE_STRIP_H + gap)));
  } else {
    cols = Math.max(1, Math.min(8, Math.floor((w + gap) / (STRIP_MIN_W + gap))));
    rows_ = Math.max(1, Math.min(9, Math.floor((h + gap) / (STRIP_MIN_H + gap))));
  }
  pageSize = Math.max(1, cols * rows_);
  $('grid').style.setProperty('--cols', cols);
  $('grid').style.setProperty('--rows', rows_);
}

function loadIndex() {
  rows = SIM.rows;
  genres = SIM.genres;
  buildGenreBar();
  applyFilters();
  buildHay();
}

function buildHay() {
  hay = new Array(rows.length);
  for (var i = 0; i < rows.length; i++) {
    hay[i] = fold(rows[i][COL.TITLE]) + '\u0000' + fold(rows[i][COL.ARTIST]) + '\u0000' + fold(rows[i][COL.ALBUM]);
  }
}

function buildGenreBar() {
  var el = $('genres');
  el.textContent = '';
  var top = genres.slice(0, MAX_GENRE_BUTTONS);
  topGenreNames = Object.create(null);
  top.forEach(function (g) { topGenreNames[g.name] = true; });
  var tail = 0;
  for (var i = MAX_GENRE_BUTTONS; i < genres.length; i++) tail += genres[i].count;

  var buttons = [{ key: ALL, label: 'ALL', count: rows.length }];
  top.forEach(function (g) { buttons.push({ key: g.name, label: g.name, count: g.count }); });
  if (tail) buttons.push({ key: OTHER, label: 'OTHER', count: tail });

  buttons.forEach(function (g) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'gbtn'; b.dataset.genre = g.key;
    var n = document.createElement('span'); n.className = 'g-name'; n.textContent = g.label;
    var c = document.createElement('span'); c.className = 'g-count'; c.textContent = g.count.toLocaleString();
    b.appendChild(n); b.appendChild(c);
    b.addEventListener('click', function () { selectGenre(g.key); });
    el.appendChild(b);
  });
  markGenre();
  updateGenreArrows();
}

function markGenre() {
  var k = $('genres').children;
  for (var i = 0; i < k.length; i++) k[i].classList.toggle('on', k[i].dataset.genre === genre);
}

function scrollGenreIntoView() {
  var k = $('genres').children, wrap = $('genres');
  for (var i = 0; i < k.length; i++) {
    if (k[i].dataset.genre === genre) {
      wrap.scrollLeft = Math.max(0, k[i].offsetLeft - (wrap.clientWidth - k[i].clientWidth) / 2);
      return;
    }
  }
}

function updateGenreArrows() {
  var wrap = $('genres');
  var overflow = wrap.scrollWidth > wrap.clientWidth + 4;
  $('genreLeft').hidden = !overflow || isPhone;
  $('genreRight').hidden = !overflow || isPhone;
}

function selectGenre(name) {
  genre = name;
  if (query) { query = ''; $('search').value = ''; $('clearSearch').hidden = true; }
  closeSearch(false);
  markGenre();
  scrollGenreIntoView();
  applyFilters();
}

function genreFilter(list) {
  if (genre === ALL) return list;
  if (genre === OTHER) return list.filter(function (r) { return !topGenreNames[r[COL.GENRE]]; });
  return list.filter(function (r) { return r[COL.GENRE] === genre; });
}

function searchRows(q) {
  var toks = fold(q).split(/\s+/).filter(Boolean);
  if (!toks.length) return rows;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var h = hay[i], ok = true, score = 0;
    for (var t = 0; t < toks.length; t++) {
      var idx = h.indexOf(toks[t]);
      if (idx < 0) { ok = false; break; }
      var prev = idx === 0 ? '\u0000' : h.charAt(idx - 1);
      if (prev === '\u0000') score += 4; else if (prev === ' ') score += 2; else score += 1;
      if (idx < h.indexOf('\u0000')) score += 1;
    }
    if (ok) out.push([score, i]);
  }
  out.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });
  return out.map(function (x) { return rows[x[1]]; });
}

function computeLetters(list) {
  var m = Object.create(null);
  for (var i = 0; i < list.length; i++) {
    var L = railLetterOf(list[i][COL.ARTIST]);
    if (!(L in m)) m[L] = i;
  }
  return m;
}

function applyFilters() {
  view = query.trim() ? searchRows(query) : genreFilter(rows);
  viewLetterStart = computeLetters(view);
  pageStart = 0;
  buildRail();
  render();
}

function runSearch(q) {
  query = q;
  if (q.trim() && genre !== ALL) { genre = ALL; markGenre(); scrollGenreIntoView(); }
  applyFilters();
}

function render() {
  var grid = $('grid');
  if (pageStart < 0) pageStart = 0;
  if (pageStart >= view.length) pageStart = Math.max(0, (Math.ceil(view.length / pageSize) - 1) * pageSize);

  grid.textContent = '';
  var slice = view.slice(pageStart, pageStart + pageSize);
  for (var i = 0; i < slice.length; i++) grid.appendChild(stripFor(slice[i]));

  var none = view.length === 0;
  $('empty').hidden = !none;
  if (none) $('empty').textContent = query ? 'No songs match "' + query + '"' : 'Nothing in this genre.';

  var totalPages = Math.max(1, Math.ceil(view.length / pageSize));
  var pageNum = Math.min(totalPages, Math.floor(pageStart / pageSize) + 1);
  $('resultCount').textContent = view.length ? view.length.toLocaleString() + ' SONGS' : '';
  $('pageNo').textContent = view.length ? 'PAGE ' + pageNum + ' OF ' + totalPages : '';
  $('prevPage').disabled = pageStart <= 0;
  $('nextPage').disabled = pageStart + pageSize >= view.length;
  markRail();
}

function stripFor(row) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'strip' + (row[COL.PID] === nowPid ? ' playing' : (queuedPids[row[COL.PID]] ? ' queued' : ''));
  var code = document.createElement('span'); code.className = 'code'; code.textContent = row[COL.CODE];
  var t = document.createElement('span'); t.className = 't';
  var ti = document.createElement('span'); ti.textContent = row[COL.TITLE]; t.appendChild(ti);
  var a = document.createElement('span'); a.className = 'a'; a.textContent = row[COL.ARTIST];
  a.style.setProperty('--band', bandFor(row[COL.ARTIST]));
  b.appendChild(code); b.appendChild(t); b.appendChild(a);
  b.addEventListener('click', function () { openConfirm(row); });
  return b;
}

function buildRail() {
  var rail = $('rail');
  rail.textContent = '';
  '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(function (L) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = L; b.dataset.letter = L;
    if (!(L in viewLetterStart)) b.disabled = true;
    b.addEventListener('click', function () { jumpToLetter(L); });
    rail.appendChild(b);
  });
}

function jumpToLetter(L) {
  var at = viewLetterStart[L];
  if (at === undefined) return;
  flipToStart(at, at > pageStart ? 1 : -1);
}

function markRail() {
  var k = $('rail').children, current = null;
  if (view.length) {
    for (var L in viewLetterStart) {
      if (viewLetterStart[L] <= pageStart &&
          (current === null || viewLetterStart[L] > viewLetterStart[current])) current = L;
    }
  }
  for (var i = 0; i < k.length; i++) k[i].classList.toggle('on', k[i].dataset.letter === current);
}

function flipToStart(target, dir) {
  target = Math.max(0, Math.min(target, Math.max(0, view.length - 1)));
  if (target === pageStart || flipping || !view.length) return;
  flipping = true;
  var f = $('flipper');
  f.classList.add(dir > 0 ? 'out-left' : 'out-right');
  setTimeout(function () {
    pageStart = target;
    render();
    f.classList.add('in-instant');
    f.classList.remove('out-left', 'out-right');
    f.classList.add(dir > 0 ? 'out-right' : 'out-left');
    requestAnimationFrame(function () {
      f.classList.remove('in-instant');
      requestAnimationFrame(function () {
        f.classList.remove('out-left', 'out-right');
        setTimeout(function () { flipping = false; }, FLIP_MS);
      });
    });
  }, FLIP_MS);
}

function nextPage() { flipToStart(pageStart + pageSize, 1); }
function prevPage() { flipToStart(Math.max(0, pageStart - pageSize), -1); }

function attractStop() {
  if (attractTimer) { clearTimeout(attractTimer); attractTimer = null; }
  if (attractOn) { attractOn = false; document.body.classList.remove('attract'); render(); }
}

function kickAttract() {
  attractStop();
  if (attractIdleTimer) clearTimeout(attractIdleTimer);
  if (!cfg.isHost || isPhone) return;
  attractIdleTimer = setTimeout(function () {
    attractOn = true;
    document.body.classList.add('attract');
    render();
    attractStep();
  }, ATTRACT_IDLE_MS);
}

function attractStep() {
  attractTimer = setTimeout(function () {
    if (!attractOn) return;
    if ($('confirm').hidden && $('searchDrawer').hidden && !query) {
      var total = Math.max(1, Math.ceil(view.length / pageSize));
      if (Math.floor(pageStart / pageSize) + 1 < total) flipToStart(pageStart + pageSize, 1);
      else attractNextGenre();
    }
    attractStep();
  }, ATTRACT_STEP_MS);
}

function attractNextGenre() {
  var k = $('genres').children;
  if (k.length < 2) { flipToStart(0, -1); return; }
  var at = 0;
  for (var i = 0; i < k.length; i++) if (k[i].dataset.genre === genre) { at = i; break; }
  genre = k[(at + 1) % k.length].dataset.genre;
  markGenre(); scrollGenreIntoView(); applyFilters();
}

function openSearch(focus) {
  $('searchDrawer').hidden = false;
  $('searchToggle').classList.add('on');
  $('searchToggle').setAttribute('aria-expanded', 'true');
  attractStop();
  if (focus !== false) $('search').focus();
}

function closeSearch(clear) {
  $('searchDrawer').hidden = true;
  $('searchToggle').classList.remove('on');
  $('searchToggle').setAttribute('aria-expanded', 'false');
  if (clear && query) { $('search').value = ''; $('clearSearch').hidden = true; runSearch(''); }
}

function toggleSearch() { if ($('searchDrawer').hidden) openSearch(); else closeSearch(true); }

function openConfirm(row) {
  pending = row;
  $('cfCode').textContent = row[COL.CODE];
  $('cfTitle').textContent = row[COL.TITLE];
  $('cfArtist').textContent = row[COL.ARTIST];
  $('cfArtist').style.background = bandFor(row[COL.ARTIST]);
  $('cfWho').value = cfg.isHost ? '' : (store('jukebox.name') || '');
  $('confirm').hidden = false;
  kickIdle(); kickAttract();
}

function closeConfirm() { $('confirm').hidden = true; pending = null; }

function submitPick() {
  if (!pending) return;
  var row = pending, who = $('cfWho').value.trim();
  if (!cfg.isHost) store('jukebox.name', who);
  closeConfirm();
  var res = simPick(row[COL.PID], deviceId, who, cfg.isHost);
  if (res.ok) toast(res.position === 1 ? "You're next up!" : "You're #" + res.position + ' in line', 'good');
  else toast(res.reason, 'bad');
  applySnapshot(simSnapshot());
}

function toast(msg, kind) {
  var el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(function () {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
  }, 2600);
}

function applySnapshot(s) {
  snap = s; snapAt = Date.now();
  queuedPids = Object.create(null);
  (s.queuedPids || []).forEach(function (p) { queuedPids[p] = true; });
  var newNow = s.nowPlaying ? s.nowPlaying.pid : null;
  var marksChanged = newNow !== nowPid;
  nowPid = newNow;
  paintNow(); paintQueue();
  if (cfg.isHost) paintHost();
  if (marksChanged) { render(); updateArt(); }
}

function paintNow() {
  var np = snap && snap.nowPlaying;
  document.body.classList.toggle('playing-now', !!(snap && snap.player.state === 'playing'));
  if (!np) {
    $('nowKicker').textContent = snap && snap.hold ? 'PAUSED' : 'NOTHING PLAYING';
    $('nowTitle').textContent = '—';
    $('nowArtist').textContent = '';
    $('miniTitle').textContent = 'Nothing playing';
    $('miniArtist').textContent = '';
    $('discLabelText').textContent = cfg.title;
    $('discLabel').className = 'label';
    return;
  }
  var kicker = np.isPick ? (np.pickedBy ? 'PICKED BY ' + np.pickedBy.toUpperCase() : 'PICKED') : 'AUTOPLAY';
  if (snap.hold) kicker = 'PAUSED · ' + kicker;
  $('nowKicker').textContent = kicker;
  $('nowTitle').textContent = np.title;
  $('nowArtist').textContent = np.artist;
  $('miniTitle').textContent = np.title;
  $('miniArtist').textContent = np.artist + (np.isPick && np.pickedBy ? ' · ' + np.pickedBy : (np.isPick ? '' : ' · Autoplay'));
  $('discLabelText').textContent = np.title;
  $('timeTotal').textContent = mmss(np.duration);
}

function updateArt() {
  var np = snap && snap.nowPlaying;
  var label = $('discLabel'), mini = $('miniDisc');
  if (!np) {
    label.className = 'label'; label.style.backgroundImage = '';
    mini.style.backgroundImage = ''; artPid = null; return;
  }
  if (np.pid === artPid) return;
  artPid = np.pid;
  var url = simArtwork(np.pid);
  if (!url) {
    label.className = 'label'; label.style.backgroundImage = '';
    mini.style.backgroundImage = ''; return;
  }
  label.className = 'label has-art';
  label.style.backgroundImage = 'url("' + url + '")';
  mini.style.backgroundImage = 'url("' + url + '")';
}

function paintProgress() {
  if (!snap || !snap.nowPlaying) {
    $('progressBar').style.width = '0%'; $('miniBar').style.width = '0%'; return;
  }
  var dur = snap.nowPlaying.duration || 0;
  var pos = snap.player.position || 0;
  if (snap.player.state === 'playing') pos += ((Date.now() - snapAt) / 1000) * SIM.speed;
  if (dur > 0) pos = Math.min(pos, dur);
  var pct = dur > 0 ? (pos / dur) * 100 : 0;
  $('progressBar').style.width = pct.toFixed(2) + '%';
  $('miniBar').style.width = pct.toFixed(2) + '%';
  $('timeNow').textContent = mmss(pos);
}

function queueItem(entry, n, withPickedBy) {
  var li = document.createElement('li');
  var num = document.createElement('span'); num.className = 'n'; num.textContent = n;
  var main = document.createElement('span'); main.className = 'q-main';
  var t = document.createElement('span'); t.className = 'q-title'; t.textContent = entry.title;
  var s = document.createElement('span'); s.className = 'q-sub';
  s.textContent = entry.artist + (withPickedBy && entry.pickedBy ? '  ·  ' + entry.pickedBy : '');
  main.appendChild(t); main.appendChild(s);
  li.appendChild(num); li.appendChild(main);
  return li;
}

function paintQueue() {
  var q = (snap && snap.queue) || [];
  $('queueCount').textContent = q.length;
  var list = $('queueList'); list.textContent = '';
  q.forEach(function (e, i) { list.appendChild(queueItem(e, i + 1, true)); });
  $('queueEmpty').hidden = q.length > 0;
  var ml = $('miniQueueList'); ml.textContent = '';
  q.forEach(function (e, i) { ml.appendChild(queueItem(e, i + 1, true)); });
  $('miniQueueEmpty').hidden = q.length > 0;
}

function setupQr(url) {
  if (!url || typeof qrcode !== 'function') return;
  try {
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qrBox').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    $('qrUrl').textContent = 'Scan to open on your phone';
    $('qrSection').hidden = false;
  } catch (e) {}
}

function host(verb, body) { var r = simHost(verb, body); applySnapshot(simSnapshot()); return Promise.resolve(r); }

function matchesModifier(e) {
  return e.ctrlKey === MODIFIER.ctrlKey && e.altKey === MODIFIER.altKey &&
         e.metaKey === MODIFIER.metaKey && e.shiftKey === MODIFIER.shiftKey;
}

function bindHotkeys() {
  document.addEventListener('keydown', function (e) {
    if (!matchesModifier(e)) return;
    var handled = true;
    switch (e.code) {
      case 'ArrowRight': host('skip').then(function (r) { toast(r.via === 'pick' ? 'Skipped to the next pick' : 'Skipped'); }); break;
      case 'Space': host('playpause').then(function (r) { toast(r.hold ? 'Paused (hold on)' : 'Playing'); }); break;
      case 'ArrowUp': host('volume', { delta: 10 }).then(function (r) { toast('Volume ' + r.volume); }); break;
      case 'ArrowDown': host('volume', { delta: -10 }).then(function (r) { toast('Volume ' + r.volume); }); break;
      case 'Backspace': host('remove-last').then(function (r) { toast(r.ok ? 'Removed ' + r.entry.title : r.reason, r.ok ? '' : 'bad'); }); break;
      case 'KeyH': toggleHost(); break;
      case 'KeyR': toast('Re-index is a no-op in the demo'); break;
      case 'KeyF': toggleFullscreen(); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); kickIdle(); kickAttract(); }
  });
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    var p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(function () { toast('Full screen is blocked here — it works in the real app', 'bad'); });
    else if (!p) toast('Full screen is blocked here — it works in the real app', 'bad');
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}

function toggleHost() {
  var p = $('hostPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) paintHost();
}

function paintHost() {
  if ($('hostPanel').hidden) return;
  var q = (snap && snap.queue) || [];
  var list = $('hostQueue'); list.textContent = '';
  q.forEach(function (e, i) {
    var li = queueItem(e, i + 1, true);
    var rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rm'; rm.textContent = 'Remove';
    rm.addEventListener('click', function () { host('remove', { id: e.id }); });
    li.appendChild(rm); list.appendChild(li);
  });
  $('hostQueueEmpty').hidden = q.length > 0;

  var vol = snap && snap.player ? snap.player.volume : null;
  $('hVolNum').textContent = vol == null ? '--' : vol;
  $('hVolBar').style.width = (vol == null ? 0 : vol) + '%';
  $('hHold').textContent = 'Hold: ' + (snap && snap.hold ? 'ON' : 'off');
  $('hHold').classList.toggle('on', !!(snap && snap.hold));

  var bits = [
    'DEMO — simulated player, no Music app',
    'Index: ' + rows.length.toLocaleString() + ' songs in ' + genres.length + ' genres',
    'Showing: ' + (genre === ALL ? 'all genres' : genre === OTHER ? 'other genres' : genre) +
      ' — ' + view.length.toLocaleString() + ' songs',
    'Clock: ' + SIM.speed + '× real time',
  ];
  $('hostStatus').innerHTML = bits.map(function (b) { return '<div>' + b.replace(/[<>&]/g, '') + '</div>'; }).join('');
}

function kickIdle() {
  if (!cfg.isHost || isPhone) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(function () {
    closeSearch(false);
    $('search').value = ''; $('clearSearch').hidden = true;
    query = ''; genre = ALL;
    markGenre(); scrollGenreIntoView(); applyFilters();
    closeConfirm();
    $('hostPanel').hidden = true;
  }, IDLE_RESET_MS);
}

function startIdleWatch() {
  ['keydown', 'pointerdown', 'touchstart', 'wheel'].forEach(function (ev) {
    document.addEventListener(ev, function () { kickIdle(); kickAttract(); }, { passive: true });
  });
  kickIdle(); kickAttract();
}

// ---------------------------------------------------------------------------
// demo-only controls
// ---------------------------------------------------------------------------
function buildDemoBar() {
  var bar = document.createElement('div');
  bar.className = 'demobar';
  bar.innerHTML =
    '<button type="button" class="demotag" id="demoTag">DEMO</button>' +
    '<div class="demobody" id="demoBody" hidden>' +
    '<p>Simulated player. No Music app, nothing plays. The real jukebox drives ' +
    'the macOS Music app through AppleScript.</p>' +
    '<div class="demorow"><span>Clock</span>' +
    '<button type="button" data-speed="1">1&times;</button>' +
    '<button type="button" data-speed="8" class="on">8&times;</button>' +
    '<button type="button" data-speed="30">30&times;</button></div>' +
    '<div class="demorow"><button type="button" id="demoEnd">Jump to end of song</button></div>' +
    '<p class="dim">Queue two songs, then jump to the end to watch the handoff. ' +
    'Let the queue run dry and Autoplay takes over.</p>' +
    '</div>';
  document.body.appendChild(bar);

  $('demoTag').addEventListener('click', function () {
    var b = $('demoBody');
    b.hidden = !b.hidden;
    bar.classList.toggle('open', !b.hidden);
  });

  bar.querySelectorAll('[data-speed]').forEach(function (b) {
    b.addEventListener('click', function () {
      SIM.frozenPos = simPosition();
      SIM.startedAtMs = Date.now();
      SIM.speed = Number(b.dataset.speed);
      bar.querySelectorAll('[data-speed]').forEach(function (o) { o.classList.toggle('on', o === b); });
    });
  });

  $('demoEnd').addEventListener('click', function () {
    if (!SIM.nowPlaying) { toast('Nothing playing yet — pick a song', 'bad'); return; }
    SIM.frozenPos = Math.max(0, SIM.nowPlaying.duration - 2);
    SIM.startedAtMs = Date.now();
  });
}

function bindUi() {
  var search = $('search'), debounce = null;
  search.addEventListener('input', function () {
    $('clearSearch').hidden = !search.value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(function () { runSearch(search.value); }, 120);
  });
  $('clearSearch').addEventListener('click', function () {
    search.value = ''; $('clearSearch').hidden = true; runSearch(''); search.focus();
  });
  $('searchToggle').addEventListener('click', toggleSearch);
  $('searchClose').addEventListener('click', function () { closeSearch(true); });
  $('genreLeft').addEventListener('click', function () { $('genres').scrollLeft -= 240; });
  $('genreRight').addEventListener('click', function () { $('genres').scrollLeft += 240; });
  $('prevPage').addEventListener('click', prevPage);
  $('nextPage').addEventListener('click', nextPage);
  $('cfNo').addEventListener('click', closeConfirm);
  $('cfYes').addEventListener('click', submitPick);
  $('confirm').addEventListener('click', function (e) { if (e.target === $('confirm')) closeConfirm(); });
  $('cfWho').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPick(); });
  $('hostClose').addEventListener('click', toggleHost);
  $('hPlay').addEventListener('click', function () { host('playpause'); });
  $('hSkip').addEventListener('click', function () { host('skip'); });
  $('hHold').addEventListener('click', function () { host('hold', { hold: !(snap && snap.hold) }); });
  $('hReindex').addEventListener('click', function () { toast('Re-index is a no-op in the demo'); });
  $('hClear').addEventListener('click', function () { host('clear'); toast('Queue cleared'); });
  $('hVolUp').addEventListener('click', function () { host('volume', { delta: 10 }); });
  $('hVolDown').addEventListener('click', function () { host('volume', { delta: -10 }); });
  $('minibarToggle').addEventListener('click', function () {
    var open = $('minibarQueue').hidden;
    $('minibarQueue').hidden = !open;
    $('minibar').classList.toggle('open', open);
  });

  document.addEventListener('keydown', function (e) {
    if (matchesModifier(e)) return;
    var inField = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      if (!$('confirm').hidden) { closeConfirm(); return; }
      if (!$('hostPanel').hidden) { $('hostPanel').hidden = true; return; }
      if (!$('searchDrawer').hidden) { closeSearch(true); search.blur(); return; }
      return;
    }
    if (!$('confirm').hidden) { if (e.key === 'Enter') { e.preventDefault(); submitPick(); } return; }
    if (e.key === 'ArrowRight' && !inField) { e.preventDefault(); nextPage(); return; }
    if (e.key === 'ArrowLeft' && !inField) { e.preventDefault(); prevPage(); return; }
    if (!inField && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) openSearch();
  });

  var sx = 0, sy = 0, tracking = false, area = $('pageArea');
  area.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { tracking = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  area.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) { if (dx < 0) nextPage(); else prevPage(); }
  }, { passive: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
