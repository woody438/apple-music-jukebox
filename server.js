'use strict';

// Party jukebox: HTTP + SSE in front of the queue engine.
// Zero npm dependencies, deliberately. The party Wi-Fi gets no say in this.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const { Engine } = require('./lib/engine');
const { createStore } = require('./lib/state');

// ---------------------------------------------------------------------------
// CONFIG -- the knobs worth turning on the night.
// ---------------------------------------------------------------------------
const CONFIG = {
  title: process.env.JUKEBOX_TITLE || 'JUKEBOX',
  playlistName: process.env.JUKEBOX_PLAYLIST || 'Jukebox',

  port: Number(process.env.PORT) || 8484,   // 5000/7000 belong to AirPlay Receiver
  host: '0.0.0.0',

  // Guest rules
  maxPerDevice: 3,        // queued picks per phone
  maxPerHost: 10,         // the laptop counts as one device
  maxQueueLength: 60,
  repeatWindowMin: 60,    // no repeat within this many minutes (host exempt)

  // Phones get this URL on the QR code. Override if the laptop has several
  // interfaces and the detected one is wrong.
  publicUrl: process.env.PUBLIC_URL || null,
};

const MOCK = process.env.MOCK === '1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.JUKEBOX_DATA_DIR || path.join(ROOT, 'data');
const ARTWORK_DIR = path.join(PUBLIC_DIR, 'artwork-cache');

function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...args);
}

// ---------------------------------------------------------------------------
// Music backend
// ---------------------------------------------------------------------------
let music;
if (MOCK) {
  const { createMockMusic } = require('./lib/mock-music');
  music = createMockMusic({
    librarySize: Number(process.env.MOCK_LIBRARY) || 2000,
    trackSeconds: Number(process.env.MOCK_TRACK_SECONDS) || 8,
    appendPickedUp: process.env.MOCK_APPEND_PICKED_UP === '1',
    writeLatencyMs: Number(process.env.MOCK_WRITE_LATENCY) || 5,
    readLatencyMs: Number(process.env.MOCK_READ_LATENCY) || 0,
    autoplay: process.env.MOCK_AUTOPLAY !== '0',
    log,
  });
  log('MOCK MODE: simulated Music, no real audio');
} else {
  if (process.platform !== 'darwin') {
    console.error('This drives the macOS Music app and only runs on macOS. Use MOCK=1 to try the UI.');
    process.exit(1);
  }
  const { createMusic } = require('./lib/music');
  music = createMusic({ log });
}

const store = createStore(path.join(DATA_DIR, 'state.json'));
const engine = new Engine({ music, config: CONFIG, store, log });

// ---------------------------------------------------------------------------
// Index cache: gzipped once per library version, served with an ETag so the
// phones fetch it exactly once.
// ---------------------------------------------------------------------------
let indexGzip = null;
let indexEtag = null;

function cacheIndex(index) {
  const payload = JSON.stringify({
    version: index.version,
    rowSpec: index.rowSpec,
    letterStart: index.letterStart,
    genres: index.genres,
    count: index.rows.length,
    rows: index.rows,
  });
  indexGzip = zlib.gzipSync(Buffer.from(payload), { level: 6 });
  indexEtag = '"' + index.version + '"';
  log(`index payload ${(payload.length / 1048576).toFixed(2)} MB raw, ${(indexGzip.length / 1048576).toFixed(2)} MB gzipped`);
}

// ---------------------------------------------------------------------------
// Networking helpers
// ---------------------------------------------------------------------------
function isLocalRequest(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function lanAddress() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address;
      const priv =
        /^192\.168\./.test(ip) ||
        /^10\./.test(ip) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      if (!priv) continue;
      // en0 is the Mac's Wi-Fi; prefer it over VPN and bridge interfaces.
      candidates.push({ ip, score: name === 'en0' ? 0 : name.startsWith('en') ? 1 : 2 });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates.length ? candidates[0].ip : null;
}

function guestUrl() {
  if (CONFIG.publicUrl) return CONFIG.publicUrl;
  const ip = lanAddress();
  return ip ? `http://${ip}:${CONFIG.port}/` : null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  // Never serve outside public/.
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== PUBLIC_DIR) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(full).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      // fonts.css is 72 KB of base64 and never changes between restarts.
      'Cache-Control': ext === '.woff2' || rel === 'fonts.css' ? 'public, max-age=86400' : 'no-cache',
    };
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  });
}

// ---- SSE -------------------------------------------------------------------
const clients = new Set();

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) { /* client vanished mid-write */ }
}

function broadcast(event, data) {
  for (const res of clients) sseSend(res, event, data);
}

engine.on('change', (snap) => broadcast('state', snap));

// ---- artwork ---------------------------------------------------------------
let artworkFor = { pid: null, file: null, contentType: null, missing: false };
let artworkInFlight = null;   // { pid, promise }

async function ensureArtwork(pid) {
  if (!pid) return null;
  if (artworkFor.pid === pid) return artworkFor.missing ? null : artworkFor;

  // Every phone asks for artwork the moment the track changes. Without this,
  // each one starts its own osascript, they queue up on the write mutex, and
  // the engine's poll loop -- which stands aside for writes -- goes blind for
  // as long as it takes to drain them. Twenty phones would cost seconds at
  // every track change, which is exactly when the handoff needs to see.
  if (artworkInFlight && artworkInFlight.pid === pid) return artworkInFlight.promise;

  const file = path.join(ARTWORK_DIR, 'current.img');
  const promise = (async () => {
    fs.mkdirSync(ARTWORK_DIR, { recursive: true });
    const got = await music.artwork(file);
    artworkFor = got
      ? { pid, file: got.path, contentType: got.contentType, missing: false }
      : { pid, file: null, contentType: null, missing: true };
    return got ? artworkFor : null;
  })();

  artworkInFlight = { pid, promise };
  try {
    return await promise;
  } finally {
    if (artworkInFlight && artworkInFlight.pid === pid) artworkInFlight = null;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const local = isLocalRequest(req);

  // --- public API ---
  if (p === '/api/config') {
    return sendJson(res, 200, {
      title: CONFIG.title,
      isHost: local,
      guestUrl: guestUrl(),
      maxPerDevice: local ? CONFIG.maxPerHost : CONFIG.maxPerDevice,
      mock: MOCK,
    });
  }

  if (p === '/api/state') return sendJson(res, 200, engine.snapshot());

  if (p === '/api/index') {
    if (!indexGzip) return sendJson(res, 503, { error: 'index not ready' });
    if (req.headers['if-none-match'] === indexEtag) { res.writeHead(304).end(); return; }
    const accepts = String(req.headers['accept-encoding'] || '').includes('gzip');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: indexEtag,
      'Cache-Control': 'no-cache',
    };
    if (accepts) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = indexGzip.length;
      res.writeHead(200, headers);
      return res.end(indexGzip);
    }
    const plain = zlib.gunzipSync(indexGzip);
    headers['Content-Length'] = plain.length;
    res.writeHead(200, headers);
    return res.end(plain);
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    sseSend(res, 'state', engine.snapshot());
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  if (p === '/api/pick' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, reason: 'Bad request.' }); }
    const result = await engine.pick({
      pid: body.pid,
      deviceId: body.deviceId,
      pickedBy: body.pickedBy,
      isHost: local,
    });
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  if (p === '/api/artwork') {
    const snap = engine.snapshot();
    const pid = snap.nowPlaying ? snap.nowPlaying.pid : null;
    let art = null;
    try { art = await ensureArtwork(pid); } catch (e) { art = null; }
    // 204, not 404: plenty of tracks simply have no artwork and the UI
    // falls back to a printed label. It is not an error worth logging.
    if (!art) { res.writeHead(204, { 'Cache-Control': 'no-store' }).end(); return; }
    const buf = fs.readFileSync(art.file);
    res.writeHead(200, {
      'Content-Type': art.contentType,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  // --- host-only API: the laptop, and nothing else ---
  if (p.startsWith('/api/host/')) {
    if (!local) return sendJson(res, 403, { ok: false, reason: 'Host controls are laptop-only.' });

    const verb = p.slice('/api/host/'.length);
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); } catch (e) { body = {}; }
    }

    switch (verb) {
      case 'skip':       return sendJson(res, 200, await engine.skip());
      case 'playpause':  return sendJson(res, 200, await engine.togglePlayPause());
      case 'hold':       return sendJson(res, 200, await engine.setHold(!!body.hold));
      case 'volume':
        return sendJson(res, 200, body.delta !== undefined
          ? await engine.nudgeVolume(Number(body.delta))
          : await engine.setVolume(Number(body.value)));
      case 'remove':     return sendJson(res, 200, engine.removeByEntryId(String(body.id || '')));
      case 'remove-last':return sendJson(res, 200, engine.removeLast());
      case 'clear':      return sendJson(res, 200, await engine.clearQueue());
      case 'genres':
        return sendJson(res, 200, engine.setVisibleGenres(
          body.genres === null || body.genres === undefined ? null : body.genres));
      case 'reindex':
        try {
          const ix = await engine.reindex();
          cacheIndex(ix);
          return sendJson(res, 200, { ok: true, count: ix.stats.kept, version: ix.version, elapsedMs: ix.elapsedMs });
        } catch (e) {
          return sendJson(res, 500, { ok: false, reason: e.message });
        }
      default:
        return sendJson(res, 404, { ok: false, reason: 'Unknown host command.' });
    }
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

  return serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('request failed', req.url, e.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
    else try { res.end(); } catch (_) {}
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  await engine.start();

  log('indexing the library...');
  try {
    const ix = await engine.reindex();
    cacheIndex(ix);
    log(`ready: ${ix.stats.kept} playable songs ` +
        `(dropped ${ix.stats.excludedNotSong} non-song, ${ix.stats.excludedDisabled} unchecked, ${ix.stats.excludedCloud} cloud-unavailable)`);
  } catch (e) {
    log('INDEX FAILED:', e.message);
    log('The UI will load but nothing can be picked until a re-index succeeds (control-option-R).');
  }

  server.listen(CONFIG.port, CONFIG.host, () => {
    const guest = guestUrl();
    log('');
    log(`  Jukebox on the laptop : http://localhost:${CONFIG.port}/`);
    log(`  Guests on their phones: ${guest || '(no LAN address found -- set PUBLIC_URL)'}`);
    log('');
    log('  Full screen: control-command-F.  Host panel: control-option-H.');
    log('');
  });
}

function shutdown(sig) {
  log(`${sig} -- shutting down`);
  engine.stop();
  for (const res of clients) { try { res.end(); } catch (e) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { server, engine, music, CONFIG };
