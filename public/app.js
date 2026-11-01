/* Party jukebox client. No framework, no CDN, no build step. */
'use strict';

// Hotkey modifier in one place. Rectangle and Magnet both grab
// control-option-left/right by default; if one of those is running at the
// party, change this (and tell the host) rather than fighting it.
var MODIFIER = { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false };

var FLIP_MS = 420;
var IDLE_RESET_MS = 90000;    // clear search and go back to ALL
var ATTRACT_IDLE_MS = 30000;  // start thumbing through on its own
var ATTRACT_STEP_MS = 8000;   // ...a page at a time
var MAX_GENRE_BUTTONS = 18;   // the rest roll up into OTHER
var STRIP_MIN_W = 190;
var STRIP_MIN_H = 62;
var PHONE_STRIP_H = 72;

var ALL = '__ALL__';
var OTHER = '__OTHER__';

var COL = { PID: 0, TITLE: 1, ARTIST: 2, ALBUM: 3, DURATION: 4, CODE: 5, GENRE: 6 };

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function store(key, value) {
  // Safari in private mode throws on every localStorage touch.
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value);
  } catch (e) { /* carry on without it */ }
  return null;
}

// crypto.randomUUID is unavailable on iOS Safari over plain HTTP.
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

function bandFor(artist) {
  var h = 0, s = String(artist || '');
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'var(--band-' + ((h % 6) + 1) + ')';
}

// Same rule the server sorts by: ignore a leading article.
function railLetterOf(artist) {
  var a = fold(artist).trim().replace(/^(the|a|an)\s+/, '');
  var c = a.charAt(0);
  return c >= 'a' && c <= 'z' ? c.toUpperCase() : '#';
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
var cfg = { title: 'JUKEBOX', isHost: false, guestUrl: null, maxPerDevice: 3, mock: false };
var deviceId = store('jukebox.deviceId') || (function () { var id = makeId(); store('jukebox.deviceId', id); return id; })();

var rows = [];              // the whole library index
var hay = [];               // folded "title \0 artist \0 album", built lazily
var genres = [];            // [{ name, count }] by count desc
var topGenreNames = {};     // the ones with their own button
var genre = ALL;
var query = '';
var visibleGenres = null;   // from the server; null = pick the biggest automatically

var view = [];              // what is currently being paged through
var viewLetterStart = {};   // A-Z positions WITHIN the current view
var pageStart = 0;          // index of the first strip on screen
var pageSize = 16;
var cols = 4, rows_ = 4;
var pending = null;         // the row awaiting confirmation

var snap = null;
var snapAt = 0;
var queuedPids = Object.create(null);
var nowPid = null;
var artPid = null;
var artUrl = null;
var idleTimer = null;
var attractIdleTimer = null;
var attractTimer = null;
var attractOn = false;
var flipping = false;
var isPhone = false;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function boot() {
  measure();
  window.addEventListener('resize', function () { measure(); render(); updateGenreArrows(); });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { measure(); render(); updateGenreArrows(); }, 250);
  });

  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    cfg = c;
    $('jbTitle').textContent = c.title || 'JUKEBOX';
    document.title = c.title || 'Jukebox';
    if (c.isHost && !isPhone) {
      $('genreSettings').hidden = false;
      setupQr(c.guestUrl);
      setupWifiQr(c.wifi);
      bindHotkeys();
      startIdleWatch();
    } else if (!isPhone) {
      // A big screen that is NOT the host: almost always the laptop opened by
      // its own LAN address rather than localhost. The gear vanishes and the
      // host hotkeys do nothing, which looks like a broken build rather than
      // a deliberate rule. Say so instead of failing silently.
      bindHostHint();
    }
  }).catch(function () {});

  loadIndex();
  connectSse();
  bindUi();
  setInterval(paintProgress, 250);
}

function measure() {
  isPhone = window.matchMedia('(max-width: 820px)').matches ||
            (window.matchMedia('(orientation: portrait)').matches && window.innerWidth <= 1100);
  var area = $('pageArea');
  var w = area.clientWidth || 800;
  var h = area.clientHeight || 400;
  var gap = 8;
  if (isPhone) {
    cols = 1;
    rows_ = Math.max(3, Math.floor((h + gap) / (PHONE_STRIP_H + gap)));
  } else {
    cols = Math.max(1, Math.min(8, Math.floor((w + gap) / (STRIP_MIN_W + gap))));
    rows_ = Math.max(1, Math.min(9, Math.floor((h + gap) / (STRIP_MIN_H + gap))));
  }
  pageSize = Math.max(1, cols * rows_);
  var grid = $('grid');
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--rows', rows_);
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------
function loadIndex() {
  fetch('/api/index')
    .then(function (r) {
      if (r.status === 503) throw new Error('not ready');
      return r.json();
    })
    .then(function (ix) {
      rows = ix.rows || [];
      genres = ix.genres || [];
      if (!genreExists(genre)) genre = ALL;
      buildGenreBar();
      applyFilters();
      buildHay();
    })
    .catch(function () {
      // The server is still indexing a big library. Try again shortly.
      $('empty').hidden = false;
      $('empty').textContent = 'Reading your library...';
      setTimeout(loadIndex, 2500);
    });
}

// Folding 40,000 rows up front would freeze a phone for a second or two, so
// it is done in slices between frames. Search works before it finishes.
function buildHay() {
  hay = new Array(rows.length);
  var i = 0;
  function slice() {
    var end = Math.min(rows.length, i + 4000);
    for (; i < end; i++) {
      var r = rows[i];
      hay[i] = fold(r[COL.TITLE]) + '\u0000' + fold(r[COL.ARTIST]) + '\u0000' + fold(r[COL.ALBUM]);
    }
    if (i < rows.length) setTimeout(slice, 0);
    else if (query) applyFilters();
  }
  slice();
}

// ---------------------------------------------------------------------------
// genre + search -> view
// ---------------------------------------------------------------------------
function genreExists(name) {
  if (name === ALL || name === OTHER) return true;
  for (var i = 0; i < genres.length; i++) if (genres[i].name === name) return true;
  return false;
}

function buildGenreBar() {
  var el = $('genres');
  el.textContent = '';

  // The host can pick the genres by hand; otherwise take the biggest.
  var top;
  if (visibleGenres) {
    var wanted = Object.create(null);
    visibleGenres.forEach(function (n) { wanted[n] = true; });
    top = genres.filter(function (g) { return wanted[g.name]; });
  } else {
    top = genres.slice(0, MAX_GENRE_BUTTONS);
  }

  topGenreNames = Object.create(null);
  top.forEach(function (g) { topGenreNames[g.name] = true; });

  var tailCount = 0;
  for (var i = 0; i < genres.length; i++) {
    if (!topGenreNames[genres[i].name]) tailCount += genres[i].count;
  }

  var buttons = [{ key: ALL, label: 'ALL', count: rows.length }];
  top.forEach(function (g) { buttons.push({ key: g.name, label: g.name, count: g.count }); });
  // A long tail of one-track genres would make the bar useless, so it rolls
  // up. Those songs are still reachable through OTHER and through search.
  if (tailCount) buttons.push({ key: OTHER, label: 'OTHER', count: tailCount });

  buttons.forEach(function (g) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'gbtn';
    b.dataset.genre = g.key;
    var n = document.createElement('span');
    n.className = 'g-name';
    n.textContent = g.label;
    var c = document.createElement('span');
    c.className = 'g-count';
    c.textContent = g.count.toLocaleString();
    b.appendChild(n); b.appendChild(c);
    b.addEventListener('click', function () { selectGenre(g.key); });
    el.appendChild(b);
  });

  markGenre();
  updateGenreArrows();
}

function genreStillShown() {
  if (genre === ALL || genre === OTHER) return true;
  return !!topGenreNames[genre];
}

function markGenre() {
  var kids = $('genres').children;
  for (var i = 0; i < kids.length; i++) {
    kids[i].classList.toggle('on', kids[i].dataset.genre === genre);
  }
}

function scrollGenreIntoView() {
  var kids = $('genres').children;
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].dataset.genre === genre) {
      var b = kids[i], wrap = $('genres');
      var left = b.offsetLeft - (wrap.clientWidth - b.clientWidth) / 2;
      wrap.scrollLeft = Math.max(0, left);
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
  // Genre and search are two ways of narrowing the same thing, and they are
  // mutually exclusive here. Tapping a genre means "I'm browsing now", so
  // the search term goes and the drawer gets out of the way with it.
  if (query) {
    query = '';
    $('search').value = '';
    $('clearSearch').hidden = true;
  }
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

// Search always runs over the WHOLE library, never within the selected
// genre. "I searched for my song and it wasn't there" is the worst thing
// that can happen to a guest at a party.
function searchRows(q) {
  var toks = fold(q).split(/\s+/).filter(Boolean);
  if (!toks.length) return rows;

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var h = hay[i];
    if (h === undefined) {
      var r = rows[i];
      h = fold(r[COL.TITLE]) + '\u0000' + fold(r[COL.ARTIST]) + '\u0000' + fold(r[COL.ALBUM]);
    }
    var ok = true, score = 0;
    for (var t = 0; t < toks.length; t++) {
      var idx = h.indexOf(toks[t]);
      if (idx < 0) { ok = false; break; }
      // A match at the start of a word beats one buried mid-word, and the
      // title counts for more than the album.
      var prev = idx === 0 ? '\u0000' : h.charAt(idx - 1);
      if (prev === '\u0000') score += 4;
      else if (prev === ' ') score += 2;
      else score += 1;
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
  // Searching steps out of whatever genre was selected, so results are never
  // silently cut down to a category the guest cannot see.
  if (q.trim() && genre !== ALL) { genre = ALL; markGenre(); scrollGenreIntoView(); }
  applyFilters();
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function render() {
  var grid = $('grid');
  if (pageStart < 0) pageStart = 0;
  if (pageStart >= view.length) pageStart = Math.max(0, (Math.ceil(view.length / pageSize) - 1) * pageSize);

  grid.textContent = '';
  var slice = view.slice(pageStart, pageStart + pageSize);
  for (var i = 0; i < slice.length; i++) grid.appendChild(stripFor(slice[i]));

  var none = view.length === 0;
  $('empty').hidden = !none;
  if (none) {
    $('empty').textContent = query
      ? 'No songs match "' + query + '"'
      : (genre === ALL ? 'Nothing in the index yet.' : 'Nothing in this genre.');
  }

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
  b.className = 'strip';
  if (row[COL.PID] === nowPid) b.className += ' playing';
  else if (queuedPids[row[COL.PID]]) b.className += ' queued';

  var code = document.createElement('span');
  code.className = 'code';
  code.textContent = row[COL.CODE];

  var t = document.createElement('span');
  t.className = 't';
  var ti = document.createElement('span');
  ti.textContent = row[COL.TITLE];
  t.appendChild(ti);

  var a = document.createElement('span');
  a.className = 'a';
  a.textContent = row[COL.ARTIST];
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
    b.type = 'button';
    b.textContent = L;
    b.dataset.letter = L;
    // Disabled letters reflect the CURRENT view, so a genre with no Q
    // artists greys its Q out rather than jumping nowhere.
    if (!(L in viewLetterStart)) b.disabled = true;
    b.addEventListener('click', function () { jumpToLetter(L); });
    rail.appendChild(b);
  });
}

function jumpToLetter(L) {
  var at = viewLetterStart[L];
  if (at === undefined) return;
  // Anchor the page ON the letter. Rounding to a page boundary instead would
  // put the tail of the previous artist at the top, which just looks broken.
  flipToStart(at, at > pageStart ? 1 : -1);
}

function markRail() {
  var kids = $('rail').children;
  var current = null;
  if (view.length) {
    for (var L in viewLetterStart) {
      if (viewLetterStart[L] <= pageStart &&
          (current === null || viewLetterStart[L] > viewLetterStart[current])) current = L;
    }
  }
  for (var i = 0; i < kids.length; i++) {
    kids[i].classList.toggle('on', kids[i].dataset.letter === current);
  }
}

// ---------------------------------------------------------------------------
// page turning
// ---------------------------------------------------------------------------
function flipToStart(target, dir) {
  target = Math.max(0, Math.min(target, Math.max(0, view.length - 1)));
  if (target === pageStart || flipping || !view.length) return;
  flipping = true;

  var f = $('flipper');
  f.classList.add(dir > 0 ? 'out-left' : 'out-right');

  setTimeout(function () {
    pageStart = target;
    render();
    // Snap to the far side with no transition, then swing back in.
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

// ---------------------------------------------------------------------------
// attract mode -- the cabinet thumbing through itself
// ---------------------------------------------------------------------------
function attractStop() {
  if (attractTimer) { clearTimeout(attractTimer); attractTimer = null; }
  if (attractOn) { attractOn = false; document.body.classList.remove('attract'); render(); }
}

function kickAttract() {
  attractStop();
  if (attractIdleTimer) clearTimeout(attractIdleTimer);
  // Laptop only: a phone doing this in somebody's pocket is just battery.
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
    // Never flip the page out from under an open dialog.
    if ($('confirm').hidden && $('searchDrawer').hidden && $('genrePanel').hidden && !query) {
      var total = Math.max(1, Math.ceil(view.length / pageSize));
      var current = Math.floor(pageStart / pageSize);
      if (current + 1 < total) {
        flipToStart(pageStart + pageSize, 1);
      } else {
        // End of the genre: show off a different corner of the library.
        attractNextGenre();
      }
    }
    attractStep();
  }, ATTRACT_STEP_MS);
}

function attractNextGenre() {
  var kids = $('genres').children;
  if (kids.length < 2) { flipToStart(0, -1); return; }
  var at = 0;
  for (var i = 0; i < kids.length; i++) if (kids[i].dataset.genre === genre) { at = i; break; }
  var next = kids[(at + 1) % kids.length];
  genre = next.dataset.genre;
  markGenre();
  scrollGenreIntoView();
  applyFilters();
}

// ---------------------------------------------------------------------------
// search drawer
// ---------------------------------------------------------------------------
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
  if (clear && query) {
    $('search').value = '';
    $('clearSearch').hidden = true;
    runSearch('');
  }
}

function toggleSearch() {
  if ($('searchDrawer').hidden) openSearch();
  else closeSearch(true);
}

// ---------------------------------------------------------------------------
// picking
// ---------------------------------------------------------------------------
function openConfirm(row) {
  pending = row;
  $('cfCode').textContent = row[COL.CODE];
  $('cfTitle').textContent = row[COL.TITLE];
  $('cfArtist').textContent = row[COL.ARTIST];
  $('cfArtist').style.background = bandFor(row[COL.ARTIST]);
  // Phones remember who you are. The laptop is everybody, so it does not.
  $('cfWho').value = cfg.isHost ? '' : (store('jukebox.name') || '');
  $('confirm').hidden = false;
  kickIdle();
  kickAttract();
}

function closeConfirm() { $('confirm').hidden = true; pending = null; }

function submitPick() {
  if (!pending) return;
  var row = pending;
  var who = $('cfWho').value.trim();
  if (!cfg.isHost) store('jukebox.name', who);
  closeConfirm();

  fetch('/api/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: row[COL.PID], deviceId: deviceId, pickedBy: who })
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res.ok) {
        toast(res.position === 1 ? "You're next up!" : "You're #" + res.position + ' in line', 'good');
      } else {
        toast(res.reason || 'Not this time.', 'bad');
      }
    })
    .catch(function () { toast('Lost the jukebox for a second. Try again.', 'bad'); });
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// live state
// ---------------------------------------------------------------------------
function connectSse() {
  var es;
  try { es = new EventSource('/api/events'); } catch (e) { setTimeout(connectSse, 3000); return; }

  es.addEventListener('state', function (ev) {
    try { applySnapshot(JSON.parse(ev.data)); } catch (e) {}
  });
  // The host chose another network adapter from the menu bar. Redraw the QR
  // code where it stands: a cabinet showing a dead address is the one thing
  // that silently stops every guest, and nobody thinks to reload it.
  es.addEventListener('config', function (ev) {
    try {
      var c = JSON.parse(ev.data);
      if (!('guestUrl' in c)) return;
      cfg.guestUrl = c.guestUrl;
      if (cfg.isHost && !isPhone) setupQr(c.guestUrl);
    } catch (e) {}
  });
  es.onerror = function () {
    // EventSource reconnects by itself, but if it gives up entirely we
    // rebuild it rather than leaving the room looking at a frozen screen.
    if (es.readyState === 2) setTimeout(connectSse, 2000);
  };
}

function applySnapshot(s) {
  var prevIndexVersion = snap ? snap.indexVersion : null;
  var prevVisible = JSON.stringify(visibleGenres);
  snap = s;
  snapAt = Date.now();

  // The host changed which genres get a button; everyone follows.
  visibleGenres = s.visibleGenres || null;
  if (JSON.stringify(visibleGenres) !== prevVisible && rows.length) {
    buildGenreBar();
    paintGenrePanel();
    if (!genreStillShown()) { genre = ALL; markGenre(); }
    applyFilters();
  }

  queuedPids = Object.create(null);
  (s.queuedPids || []).forEach(function (p) { queuedPids[p] = true; });
  var newNow = s.nowPlaying ? s.nowPlaying.pid : null;
  var marksChanged = newNow !== nowPid;
  nowPid = newNow;

  paintNow();
  paintQueue();
  if (cfg.isHost) paintHost();

  // The library was re-indexed under us.
  if (prevIndexVersion && s.indexVersion && s.indexVersion !== prevIndexVersion) {
    loadIndex();
    return;
  }
  // Repaint the visible page so queued/playing marks stay honest.
  render();
  if (marksChanged) updateArt();
}

function paintNow() {
  var np = snap && snap.nowPlaying;
  var playing = snap && snap.player && snap.player.state === 'playing';
  document.body.classList.toggle('playing-now', !!playing);

  if (!np) {
    $('nowKicker').textContent = snap && snap.hold ? 'PAUSED' : 'NOTHING PLAYING';
    $('nowTitle').textContent = '—';
    $('nowArtist').textContent = '';
    $('miniTitle').textContent = 'Nothing playing';
    $('miniArtist').textContent = '';
    $('discLabelText').textContent = cfg.title || 'JUKEBOX';
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
  var label = $('discLabel');
  var mini = $('miniDisc');

  function clearArt() {
    if (artUrl) { URL.revokeObjectURL(artUrl); artUrl = null; }
    label.className = 'label';
    label.style.backgroundImage = '';
    mini.style.backgroundImage = '';
  }

  if (!np) { clearArt(); artPid = null; return; }
  if (np.pid === artPid) return;
  artPid = np.pid;
  var want = np.pid;

  // fetch rather than an <img>, because the server answers 204 when a track
  // has no artwork and an <img> would log a failed load for every such song.
  fetch('/api/artwork?pid=' + encodeURIComponent(want))
    .then(function (r) { return r.status === 200 ? r.blob() : null; })
    .then(function (blob) {
      if (want !== artPid) return;          // the song moved on while we fetched
      if (!blob || !blob.size) { clearArt(); return; }
      if (artUrl) URL.revokeObjectURL(artUrl);
      artUrl = URL.createObjectURL(blob);
      var css = 'url("' + artUrl + '")';
      label.className = 'label has-art';
      label.style.backgroundImage = css;
      mini.style.backgroundImage = css;
    })
    .catch(function () { if (want === artPid) clearArt(); });
}

function paintProgress() {
  if (!snap || !snap.nowPlaying) {
    $('progressBar').style.width = '0%';
    $('miniBar').style.width = '0%';
    return;
  }
  var dur = snap.nowPlaying.duration || 0;
  var pos = snap.player.position || 0;
  // Interpolate between polls so the bar moves smoothly.
  if (snap.player.state === 'playing') pos += (Date.now() - snapAt) / 1000;
  if (dur > 0) pos = Math.min(pos, dur);
  var pct = dur > 0 ? (pos / dur) * 100 : 0;
  $('progressBar').style.width = pct.toFixed(2) + '%';
  $('miniBar').style.width = pct.toFixed(2) + '%';
  $('timeNow').textContent = mmss(pos);
}

function queueItem(entry, n, withPickedBy) {
  var li = document.createElement('li');
  var num = document.createElement('span');
  num.className = 'n';
  num.textContent = n;
  var main = document.createElement('span');
  main.className = 'q-main';
  var t = document.createElement('span');
  t.className = 'q-title';
  t.textContent = entry.title;
  var s = document.createElement('span');
  s.className = 'q-sub';
  s.textContent = entry.artist + (withPickedBy && entry.pickedBy ? '  ·  ' + entry.pickedBy : '');
  main.appendChild(t); main.appendChild(s);
  li.appendChild(num); li.appendChild(main);
  return li;
}

function paintQueue() {
  var q = (snap && snap.queue) || [];
  $('queueCount').textContent = q.length;

  var list = $('queueList');
  list.textContent = '';
  q.forEach(function (e, i) { list.appendChild(queueItem(e, i + 1, true)); });
  $('queueEmpty').hidden = q.length > 0;

  var ml = $('miniQueueList');
  ml.textContent = '';
  q.forEach(function (e, i) { ml.appendChild(queueItem(e, i + 1, true)); });
  $('miniQueueEmpty').hidden = q.length > 0;
}

// ---------------------------------------------------------------------------
// genre settings (laptop only -- phones never see host UI)
// ---------------------------------------------------------------------------
function toggleGenrePanel() {
  var p = $('genrePanel');
  p.hidden = !p.hidden;
  $('genreSettings').classList.toggle('on', !p.hidden);
  if (!p.hidden) paintGenrePanel();
  kickIdle();
  kickAttract();
}

function shownSet() {
  var set = Object.create(null);
  (visibleGenres || genres.slice(0, MAX_GENRE_BUTTONS).map(function (g) { return g.name; }))
    .forEach(function (n) { set[n] = true; });
  return set;
}

function paintGenrePanel() {
  if ($('genrePanel').hidden) return;
  var set = shownSet();
  var list = $('gpList');
  list.textContent = '';

  genres.forEach(function (g) {
    var label = document.createElement('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!set[g.name];
    cb.addEventListener('change', function () { saveGenreSelection(); });
    cb.dataset.genre = g.name;
    var name = document.createElement('span');
    name.className = 'gp-name';
    name.textContent = g.name;
    var n = document.createElement('span');
    n.className = 'gp-n';
    n.textContent = g.count.toLocaleString();
    label.appendChild(cb); label.appendChild(name); label.appendChild(n);
    list.appendChild(label);
  });

  var on = Object.keys(set).length;
  $('gpCount').textContent = (visibleGenres ? on + ' CHOSEN' : 'AUTOMATIC (' + on + ')') +
                             ' OF ' + genres.length;
}

function saveGenreSelection() {
  var chosen = [];
  Array.prototype.forEach.call($('gpList').querySelectorAll('input'), function (cb) {
    if (cb.checked) chosen.push(cb.dataset.genre);
  });
  host('genres', { genres: chosen });
}

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------
function qrSvg(text) {
  // The library's default encoder keeps only the low byte of each character,
  // which mangles a Wi-Fi name with an accent or an emoji in it. UTF-8 is
  // what phone cameras assume, and for plain ASCII the bytes are identical.
  if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) {
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  }
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function setupQr(url) {
  if (!url) { $('qrSection').hidden = true; return; }   // no address: no QR beats a wrong one
  if (typeof qrcode !== 'function') return;
  try {
    $('qrBox').innerHTML = qrSvg(url);
    $('qrUrl').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('qrSection').hidden = false;
  } catch (e) { /* no QR is survivable; the URL is still in the terminal */ }
}

// The password is printed under the code as well, for a phone whose camera
// will not join from a QR code. The code carries it in plain text anyway, so
// printing it gives away nothing the code does not.
function setupWifiQr(w) {
  if (!w || !w.qr || typeof qrcode !== 'function') return;
  try {
    $('wifiBox').innerHTML = qrSvg(w.qr);
    $('wifiName').textContent = w.name;
    if (w.password) $('wifiPass').textContent = w.password;
    else $('wifiPassLine').textContent = 'Open network, no password';
    $('wifiSection').hidden = false;
  } catch (e) { /* no Wi-Fi code is survivable; people can still ask */ }
}

// ---------------------------------------------------------------------------
// host controls
// ---------------------------------------------------------------------------
function host(verb, body) {
  return fetch('/api/host/' + verb, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(function (r) { return r.json(); }).catch(function () { return { ok: false }; });
}

function matchesModifier(e) {
  return e.ctrlKey === MODIFIER.ctrlKey && e.altKey === MODIFIER.altKey &&
         e.metaKey === MODIFIER.metaKey && e.shiftKey === MODIFIER.shiftKey;
}

function bindHotkeys() {
  // e.code, not e.key: option changes e.key on macOS (option-R gives a ®).
  document.addEventListener('keydown', function (e) {
    if (!matchesModifier(e)) return;
    var handled = true;
    switch (e.code) {
      case 'ArrowRight':
        host('skip').then(function (r) { toast(r.via === 'pick' ? 'Skipped to the next pick' : 'Skipped'); });
        break;
      case 'Space':
        host('playpause').then(function (r) { toast(r.hold ? 'Paused (hold on)' : 'Playing'); });
        break;
      case 'ArrowUp':
        host('volume', { delta: 10 }).then(function (r) { toast('Volume ' + r.volume); });
        break;
      case 'ArrowDown':
        host('volume', { delta: -10 }).then(function (r) { toast('Volume ' + r.volume); });
        break;
      case 'Backspace':
        host('remove-last').then(function (r) {
          toast(r.ok ? 'Removed ' + r.entry.title : (r.reason || 'Nothing to remove'), r.ok ? '' : 'bad');
        });
        break;
      case 'KeyH':
        toggleHost();
        break;
      case 'KeyG':
        toggleGenrePanel();
        break;
      case 'KeyR':
        toast('Re-indexing the library...');
        host('reindex').then(function (r) {
          toast(r.ok ? 'Indexed ' + r.count.toLocaleString() + ' songs' : 'Re-index failed', r.ok ? 'good' : 'bad');
          if (r.ok) loadIndex();
        });
        break;
      case 'KeyF':
        toggleFullscreen();
        break;
      default:
        handled = false;
    }
    if (handled) { e.preventDefault(); kickIdle(); kickAttract(); }
  });
}

// Host keys on a non-host screen explain themselves rather than doing nothing.
function bindHostHint() {
  document.addEventListener('keydown', function (e) {
    if (!matchesModifier(e)) return;
    if (['KeyH', 'KeyG', 'KeyR', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Backspace'].indexOf(e.code) === -1) return;
    e.preventDefault();
    toast('Host controls only work at http://localhost:' + (location.port || '8484') + '/ \u2014 this window is a guest.', 'bad');
  });
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    (document.documentElement.requestFullscreen || function () {}).call(document.documentElement);
    toast('Full screen — control-option-F to exit');
  } else {
    (document.exitFullscreen || function () {}).call(document);
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
  var list = $('hostQueue');
  list.textContent = '';
  q.forEach(function (e, i) {
    var li = queueItem(e, i + 1, true);
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = 'Remove';
    rm.addEventListener('click', function () {
      host('remove', { id: e.id }).then(function (r) { if (!r.ok) toast(r.reason || 'Could not remove', 'bad'); });
    });
    li.appendChild(rm);
    list.appendChild(li);
  });
  $('hostQueueEmpty').hidden = q.length > 0;

  var vol = snap && snap.player ? snap.player.volume : null;
  $('hVolNum').textContent = vol == null ? '--' : vol;
  $('hVolBar').style.width = (vol == null ? 0 : vol) + '%';
  $('hHold').textContent = 'Hold: ' + (snap && snap.hold ? 'ON' : 'off');
  $('hHold').classList.toggle('on', !!(snap && snap.hold));

  var bits = [];
  if (snap) {
    bits.push('Music: ' + (snap.player.running ? snap.player.state : 'NOT RUNNING'));
    bits.push('Index: ' + (snap.indexCount || 0).toLocaleString() + ' songs in ' + genres.length + ' genres' +
              (snap.indexing ? ' (re-indexing...)' : ''));
    bits.push('Showing: ' + (genre === ALL ? 'all genres' : genre === OTHER ? 'other genres' : genre) +
              ' — ' + view.length.toLocaleString() + ' songs');
    bits.push('Device: ' + deviceId);
    if (cfg.guestUrl) bits.push('Guests: ' + cfg.guestUrl);
    if (cfg.mock) bits.push('MOCK MODE — no real audio');
  }
  var html = bits.map(function (b) { return '<div>' + b.replace(/[<>&]/g, '') + '</div>'; }).join('');
  if (snap && snap.lastError) {
    html += '<div class="err">Last error [' + String(snap.lastError.op).replace(/[<>&]/g, '') + '] ' +
            String(snap.lastError.message).replace(/[<>&]/g, '') + '</div>';
  }
  $('hostStatus').innerHTML = html;
}

// ---------------------------------------------------------------------------
// idle reset (laptop only)
// ---------------------------------------------------------------------------
function kickIdle() {
  if (!cfg.isHost || isPhone) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(function () {
    closeSearch(false);
    $('search').value = '';
    $('clearSearch').hidden = true;
    query = '';
    genre = ALL;
    markGenre();
    scrollGenreIntoView();
    applyFilters();
    closeConfirm();
    $('hostPanel').hidden = true;
    $('genrePanel').hidden = true;
    $('genreSettings').classList.remove('on');
  }, IDLE_RESET_MS);
}

function startIdleWatch() {
  ['keydown', 'pointerdown', 'touchstart', 'wheel'].forEach(function (ev) {
    document.addEventListener(ev, function () { kickIdle(); kickAttract(); }, { passive: true });
  });
  kickIdle();
  kickAttract();
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
function bindUi() {
  var search = $('search');
  var debounce = null;
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

  $('genreSettings').addEventListener('click', toggleGenrePanel);
  $('genreClose').addEventListener('click', toggleGenrePanel);
  $('gpAuto').addEventListener('click', function () { host('genres', { genres: null }); });
  $('gpAll').addEventListener('click', function () {
    host('genres', { genres: genres.map(function (g) { return g.name; }) });
  });
  $('gpNone').addEventListener('click', function () { host('genres', { genres: [] }); });
  $('genrePanel').addEventListener('click', function (e) { if (e.target === $('genrePanel')) toggleGenrePanel(); });

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
  $('hReindex').addEventListener('click', function () {
    toast('Re-indexing...');
    host('reindex').then(function (r) { if (r.ok) { toast('Indexed ' + r.count.toLocaleString(), 'good'); loadIndex(); } });
  });
  $('hClear').addEventListener('click', function () { host('clear').then(function () { toast('Queue cleared'); }); });
  $('hVolUp').addEventListener('click', function () { host('volume', { delta: 10 }); });
  $('hVolDown').addEventListener('click', function () { host('volume', { delta: -10 }); });

  $('minibarToggle').addEventListener('click', function () {
    var open = $('minibarQueue').hidden;
    $('minibarQueue').hidden = !open;
    $('minibar').classList.toggle('open', open);
  });

  // Arrow keys turn pages; typing anywhere opens the drawer and searches.
  document.addEventListener('keydown', function (e) {
    if (matchesModifier(e)) return;
    var inField = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

    if (e.key === 'Escape') {
      if (!$('confirm').hidden) { closeConfirm(); return; }
      if (!$('hostPanel').hidden) { $('hostPanel').hidden = true; return; }
      if (!$('genrePanel').hidden) { toggleGenrePanel(); return; }
      if (!$('searchDrawer').hidden) { closeSearch(true); search.blur(); return; }
      return;
    }
    if (!$('confirm').hidden) {
      if (e.key === 'Enter') { e.preventDefault(); submitPick(); }
      return;
    }
    if (e.key === 'ArrowRight' && !inField) { e.preventDefault(); nextPage(); return; }
    if (e.key === 'ArrowLeft' && !inField) { e.preventDefault(); prevPage(); return; }

    if (!inField && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      openSearch();   // let the character itself land in the field
    }
  });

  // Swipe to turn pages.
  var sx = 0, sy = 0, tracking = false;
  var area = $('pageArea');
  area.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { tracking = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  area.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      if (dx < 0) nextPage(); else prevPage();
    }
  }, { passive: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
