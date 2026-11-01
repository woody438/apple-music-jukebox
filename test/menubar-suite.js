'use strict';

// The menu bar icon, tested without a Mac as far as that can go.
//
//   node test/menubar-suite.js          (VERBOSE=1 for detail, ONLY=<text> for a subset)
//
// What runs where:
//   - everywhere: the guest-network rules, the helper (menu model, actions,
//     update checks against real local git repos), menubar.js driven through
//     a strict fake of the JXA Objective-C bridge, and Jukebox.app's launcher
//     and Update.command run for real with the macOS-only tools stubbed out.
//   - on a Mac, additionally: menubar.js --selftest against the REAL AppKit,
//     and the helper against the real network adapters.
//
// What this CANNOT prove, on any machine: that clicking the icon in the real
// menu bar opens the menu. The fake bridge checks every call is a real AppKit
// selector used the JXA way; it cannot check AppKit's behaviour. Look at it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn, execFileSync, spawnSync } = require('child_process');

const net = require('../lib/net');
const helper = require('../menubar/helper');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'menubar', 'helper.js');
const MENUBAR_JS = path.join(ROOT, 'menubar', 'menubar.js');
const NODE = process.execPath;
const VERBOSE = process.env.VERBOSE === '1';
const vlog = VERBOSE ? (...a) => console.log('   ', ...a) : () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pretend Mac mini: Ethernet on en0, Wi-Fi on en1, Wi-Fi is the default route.
const FAKE_NET = {
  interfaces: {
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '10.77.0.5' }],
    en1: [{ family: 'IPv4', internal: false, address: '192.168.1.40' }],
  },
  primary: 'en1',
  ports: { en0: 'Ethernet', en1: 'Wi-Fi', en5: 'USB 10/100/1000 LAN' },
};
const FAKE_NET_ENV = JSON.stringify(FAKE_NET);

async function waitFor(fn, { timeout = 10000, interval = 25, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout}ms waiting for: ${label}`);
    await sleep(interval);
  }
}

function tmpdir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `jukebox-${tag}-`)); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

function getJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c)) }); } catch (e) { resolve({ status: res.statusCode, json: null }); } });
    }).on('error', () => resolve(null));
  });
}

function postJson(url, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c)) }); } catch (e) { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

// Every SSE event the server sends, as it arrives.
function sseListen(url) {
  const events = [];
  let buf = '';
  const req = http.get(url, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev && data) { try { events.push({ event: ev[1], data: JSON.parse(data[1]) }); } catch (e) {} }
      }
    });
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}

function startServer({ port, dataDir, publicUrl }) {
  const env = Object.assign({}, process.env, {
    MOCK: '1', PORT: String(port), JUKEBOX_DATA_DIR: dataDir, MOCK_LIBRARY: '150',
    JUKEBOX_TEST_NETWORK: FAKE_NET_ENV,
  });
  if (publicUrl) env.PUBLIC_URL = publicUrl; else delete env.PUBLIC_URL;
  const child = spawn(NODE, [path.join(ROOT, 'server.js')], { env, stdio: VERBOSE ? 'inherit' : 'ignore' });
  return {
    child,
    ready: () => waitFor(async () => { const r = await getJson(`http://127.0.0.1:${port}/api/config`); return r && r.status === 200; },
      { label: 'the mock server to come up', timeout: 20000 }),
    stop: () => { try { child.kill('SIGKILL'); } catch (e) {} },
  };
}

// Run the helper as the menu bar does: a separate process, JSON on stdout.
function runHelper(args, { repo, port, publicUrl, extraEnv } = {}) {
  const argv = [HELPER].concat(args, ['--repo', repo, '--port', String(port)]);
  if (publicUrl) argv.push('--public-url', publicUrl);
  const env = Object.assign({}, process.env, { JUKEBOX_TEST_NETWORK: FAKE_NET_ENV, JUKEBOX_HELPER_DRYRUN: '1' }, extraEnv || {});
  delete env.JUKEBOX_DATA_DIR;
  delete env.PUBLIC_URL;
  return execFileSync(NODE, argv, { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const menuOf = (opts) => JSON.parse(runHelper(['menu'], opts));
const titles = (m) => m.items.filter((i) => !i.separator).map((i) => i.title);
const itemOf = (m, re) => m.items.find((i) => !i.separator && re.test(i.title));

// A fake repo the helper and launcher can treat as home: the real code,
// symlinked, and a data/ of its own so nothing touches the real one.
function fakeRepo(tag) {
  const dir = tmpdir(tag);
  fs.symlinkSync(path.join(ROOT, 'menubar'), path.join(dir, 'menubar'));
  fs.mkdirSync(path.join(dir, 'data'));
  return dir;
}

// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1 ------------------------------------------------------------------------
test('guest address: menu choice, then jukebox.conf, then the routing table', () => {
  const candidates = net.lanCandidates(FAKE_NET.interfaces);
  const base = { port: 8484, candidates, primary: 'en1' };
  const r = (x) => net.resolveGuestUrl(Object.assign({}, base, x));

  assert.deepEqual(
    [r({}).url, r({}).source, r({}).iface],
    ['http://192.168.1.40:8484/', 'auto', 'en1'], 'nothing chosen follows the default route');
  assert.equal(r({ publicUrl: 'http://jb.local:8484/' }).url, 'http://jb.local:8484/', 'jukebox.conf beats the route');
  assert.equal(r({ publicUrl: 'http://jb.local:8484/' }).source, 'conf');
  assert.equal(r({ choice: 'en0', publicUrl: 'http://jb.local:8484/' }).url, 'http://10.77.0.5:8484/',
    'the menu choice beats jukebox.conf');
  assert.equal(r({ choice: 'en0' }).source, 'chosen');

  // Cable out: never put a dead address on the QR code.
  const gone = r({ choice: 'en5' });
  assert.equal(gone.url, 'http://192.168.1.40:8484/', 'an adapter with no address falls back');
  assert.equal(gone.chosenMissing, true, 'and says so');
  assert.equal(r({ choice: 'en5', publicUrl: 'http://jb.local:8484/' }).url, 'http://jb.local:8484/');
  assert.equal(r({ choice: 'en0' }).chosenMissing, false);

  const none = net.resolveGuestUrl({ port: 8484, candidates: [], primary: null });
  assert.equal(none.url, null); assert.equal(none.source, 'none');
});

// 2 ------------------------------------------------------------------------
test('the adapter choice survives on disk and junk in the file is ignored', () => {
  const dir = tmpdir('choice');
  try {
    const f = path.join(dir, 'sub', 'network.json');
    assert.equal(net.readNetworkChoice(f), null, 'no file is automatic');
    assert.equal(net.writeNetworkChoice(f, 'en1'), 'en1');
    assert.equal(net.readNetworkChoice(f), 'en1');
    assert.ok(!fs.existsSync(f + '.tmp'), 'written by rename, no temp left behind');
    net.writeNetworkChoice(f, 'auto');
    assert.ok(!fs.existsSync(f), '"auto" removes the file');
    net.writeNetworkChoice(f, null);   // already gone: fine
    for (const bad of ['en0; rm -rf ~', '../../etc', '', 'x'.repeat(16), 42]) {
      if (bad === '') continue;
      assert.throws(() => net.writeNetworkChoice(f, bad), /not an interface/, `refuses ${JSON.stringify(bad)}`);
    }
    fs.writeFileSync(f, '{"interface":"en0; reboot"}');
    assert.equal(net.readNetworkChoice(f), null, 'a hand-edited bad value reads as automatic');
    fs.writeFileSync(f, 'not json');
    assert.equal(net.readNetworkChoice(f), null);
  } finally { rm(dir); }
});

// 3 ------------------------------------------------------------------------
test('adapter names come from networksetup, as a Mac prints them', () => {
  // Verbatim shape of `networksetup -listallhardwareports` on a Mac mini.
  const text = [
    '',
    'Hardware Port: Ethernet',
    'Device: en0',
    'Ethernet Address: 3c:a6:f6:00:00:01',
    '',
    'Hardware Port: Wi-Fi',
    'Device: en1',
    'Ethernet Address: 3c:a6:f6:00:00:02',
    '',
    'Hardware Port: Thunderbolt Bridge',
    'Device: bridge0',
    'Ethernet Address: N/A',
    '',
    'VLAN Configurations',
    '===================',
    '',
  ].join('\n');
  assert.deepEqual(net.parseHardwarePorts(text), { en0: 'Ethernet', en1: 'Wi-Fi', bridge0: 'Thunderbolt Bridge' });
  assert.deepEqual(net.parseHardwarePorts(text.replace(/\n/g, '\r\n')).en1, 'Wi-Fi', 'CRLF too');
  assert.deepEqual(net.parseHardwarePorts(''), {});
  assert.deepEqual(net.parseHardwarePorts(null), {});
});

// 4 ------------------------------------------------------------------------
test('the menu model: what is enabled in each state', () => {
  const network = {
    choice: null, labels: FAKE_NET.ports,
    adapters: [{ name: 'en0', ip: '10.77.0.5', label: 'Ethernet' }, { name: 'en1', ip: '192.168.1.40', label: 'Wi-Fi' }],
    guestUrl: 'http://192.168.1.40:8484/', source: 'auto', iface: 'en1', chosenMissing: false,
    autoSource: 'auto', autoIface: 'en1', autoUrl: 'http://192.168.1.40:8484/',
  };
  const en = (m, re) => itemOf(m, re).enabled;

  const run = helper.buildMenu({ running: true, starting: false, network, update: { state: 'idle' } });
  assert.equal(run.state, 'running');
  assert.equal(run.items[0].title, 'Jukebox is running');
  assert.equal(run.items[1].title, 'Guests: 192.168.1.40:8484');
  assert.ok(en(run, /^Open Jukebox Page$/) && en(run, /^Stop Jukebox$/) && !en(run, /^Start Jukebox$/));
  assert.ok(/192\.168\.1\.40/.test(run.tooltip));

  const stop = helper.buildMenu({ running: false, starting: false, network, update: { state: 'idle' } });
  assert.equal(stop.items[0].title, 'Jukebox is stopped');
  assert.ok(!en(stop, /^Open Jukebox Page$/) && !en(stop, /^Stop Jukebox$/) && en(stop, /^Start Jukebox$/));

  const starting = helper.buildMenu({ running: false, starting: true, network, update: { state: 'idle' } });
  assert.equal(starting.state, 'starting');
  assert.ok(!en(starting, /^Start Jukebox$/), 'no second start while one is on its way');
  assert.ok(!en(starting, /^Stop Jukebox$/));

  // Every item that does something says what, and headers do nothing.
  for (const m of [run, stop, starting]) {
    for (const i of m.items) {
      if (i.separator) continue;
      if (i.enabled) assert.ok(i.action, `"${i.title}" is clickable but does nothing`);
      assert.equal(typeof i.title, 'string');
    }
    assert.equal(m.items[m.items.length - 1].action, 'quit', 'Quit is last');
    assert.ok(!m.items[0].enabled && !m.items[1].enabled, 'the status lines are not buttons');
  }
});

// 5 ------------------------------------------------------------------------
test('the menu model: the Guest Network section', () => {
  const adapters = [{ name: 'en0', ip: '10.77.0.5', label: 'Ethernet' }, { name: 'en1', ip: '192.168.1.40', label: 'Wi-Fi' }];
  const mk = (over) => helper.buildMenu({
    running: true, starting: false, update: { state: 'idle' },
    network: Object.assign({
      choice: null, labels: FAKE_NET.ports, adapters,
      guestUrl: 'http://192.168.1.40:8484/', source: 'auto', iface: 'en1', chosenMissing: false,
      autoSource: 'auto', autoIface: 'en1', autoUrl: 'http://192.168.1.40:8484/',
    }, over),
  });
  const net0 = mk({});
  const section = (m) => m.items.filter((i) => i.action === 'network' || /not connected$/.test(i.title || ''));
  assert.deepEqual(section(net0).map((i) => [i.title, !!i.checked, i.arg]), [
    ['Automatic — Wi-Fi', true, 'auto'],
    ['Ethernet (en0) — 10.77.0.5', false, 'en0'],
    ['Wi-Fi (en1) — 192.168.1.40', false, 'en1'],
  ]);

  const chosen = mk({ choice: 'en0', guestUrl: 'http://10.77.0.5:8484/', source: 'chosen', iface: 'en0' });
  assert.deepEqual(section(chosen).map((i) => !!i.checked), [false, true, false], 'exactly the chosen one is ticked');
  assert.equal(chosen.items[1].title, 'Guests: 10.77.0.5:8484');

  const conf = mk({ autoSource: 'conf' });
  assert.equal(section(conf)[0].title, 'Automatic — jukebox.conf', 'says where automatic gets it from');

  const missing = mk({ choice: 'en5', chosenMissing: true });
  const last = section(missing).pop();
  assert.equal(last.title, 'USB 10/100/1000 LAN (en5) — not connected');
  assert.ok(last.checked && !last.enabled, 'still shown as the choice, but not clickable');
  assert.ok(/USB 10\/100\/1000 LAN not connected/.test(missing.items[1].title), 'the guest line says why');
  assert.ok(!section(missing)[0].checked, 'Automatic is not ticked while a choice stands');

  const nothing = mk({ adapters: [], guestUrl: null, autoSource: 'none', autoIface: null });
  assert.ok(titles(nothing).includes('No network address found'));
  assert.ok(titles(nothing).includes('Automatic — no address'));
  assert.equal(nothing.items[1].title, 'Guests: no network address');
});

// 6 ------------------------------------------------------------------------
test('the menu model: updates are offered, but never while the jukebox plays', () => {
  const network = {
    choice: null, labels: {}, adapters: [], guestUrl: null, source: 'none', iface: null,
    chosenMissing: false, autoSource: 'none', autoIface: null,
  };
  const mk = (running, update) => helper.buildMenu({ running, starting: false, network, update });

  assert.ok(itemOf(mk(false, { state: 'idle' }), /^Check for Updates…$/).enabled);
  const checking = mk(false, { state: 'checking' });
  assert.ok(itemOf(checking, /^Checking for Updates…$/) && !itemOf(checking, /^Checking/).enabled);

  const avail = { state: 'available', behind: 3, ahead: 0, dirty: false };
  const stopped = mk(false, avail);
  const install = itemOf(stopped, /^Install Update/);
  assert.equal(install.title, 'Install Update (3 changes)…');
  assert.ok(install.enabled && install.action === 'install-update');
  assert.ok(itemOf(stopped, /^Check Again$/).enabled);

  const running = mk(true, avail);
  assert.ok(!running.items.some((i) => i.action === 'install-update'), 'no install while it is running');
  assert.ok(itemOf(running, /stop the jukebox to install/));

  assert.equal(itemOf(mk(false, Object.assign({}, avail, { behind: 1 })), /^Install/).title, 'Install Update (1 change)…');
  assert.ok(itemOf(mk(false, Object.assign({}, avail, { dirty: true })), /local edits/), 'warns Update.command will refuse');
  assert.ok(itemOf(mk(false, Object.assign({}, avail, { ahead: 2 })), /own commits/));
  assert.ok(itemOf(mk(false, { state: 'current', checkedAt: Date.now() }), /^Up to date · checked \d\d:\d\d$/));
  assert.ok(itemOf(mk(false, { state: 'error', message: 'Could not reach GitHub. Check the internet.' }), /Could not reach GitHub/));
});

// 7 ------------------------------------------------------------------------
test('with the server up: the menu reads it, and choosing an adapter redraws the QR live', async () => {
  const repo = fakeRepo('live');
  const port = 8611;
  const conf = 'http://jukebox.local:8611/';
  const srv = startServer({ port, dataDir: path.join(repo, 'data'), publicUrl: conf });
  let sse = null;
  try {
    await srv.ready();
    const opts = { repo, port };     // note: no --public-url, the server knows it

    let m = menuOf(opts);
    assert.equal(m.state, 'running');
    assert.equal(m.items[1].title, 'Guests: jukebox.local:8611', 'shows what the SERVER gives guests');
    assert.equal(itemOf(m, /^Automatic/).checked, true);

    sse = sseListen(`http://127.0.0.1:${port}/api/events`);
    await waitFor(() => sse.events.some((e) => e.event === 'state'), { label: 'SSE connected' });

    const out = runHelper(['do', 'network', 'en0'], opts);
    vlog(out.trim());
    assert.ok(/NOTIFY Guests now get 10\.77\.0\.5:8611/.test(out), 'tells the host where guests go now');
    await waitFor(() => sse.events.some((e) => e.event === 'config'), { label: 'a config event', timeout: 3000 });
    assert.deepEqual(sse.events.find((e) => e.event === 'config').data, { guestUrl: 'http://10.77.0.5:8611/' },
      'the laptop is told the new address without reloading');
    assert.equal((await getJson(`http://127.0.0.1:${port}/api/config`)).json.guestUrl, 'http://10.77.0.5:8611/',
      'a page loaded now gets it too');
    assert.equal(net.readNetworkChoice(path.join(repo, 'data', 'network.json')), 'en0', 'and it is kept for next time');

    m = menuOf(opts);
    assert.equal(itemOf(m, /\(en0\)/).checked, true);
    assert.equal(itemOf(m, /^Automatic/).checked, false);
    assert.equal(m.items[1].title, 'Guests: 10.77.0.5:8611');

    // Chosen, then unplugged: the server falls back and the menu says why.
    runHelper(['do', 'network', 'en5'], opts);
    m = menuOf(opts);
    assert.equal(m.items[1].title, 'Guests: jukebox.local:8611 (USB 10/100/1000 LAN not connected)');
    assert.ok(itemOf(m, /not connected$/).checked);

    runHelper(['do', 'network', 'auto'], opts);
    assert.ok(!fs.existsSync(path.join(repo, 'data', 'network.json')));
    assert.equal((await getJson(`http://127.0.0.1:${port}/api/config`)).json.guestUrl, conf, 'automatic is jukebox.conf again');

    const bad = await postJson(`http://127.0.0.1:${port}/api/host/network`, { interface: '../etc' });
    assert.equal(bad.status, 400, 'the server refuses a non-interface');
    assert.throws(() => runHelper(['do', 'network', 'en0;ls'], opts), 'and so does the helper');
  } finally {
    if (sse) sse.close();
    srv.stop();
    rm(repo);
  }
});

// 8 ------------------------------------------------------------------------
test('the network route is laptop-only, like every host route', async () => {
  const remoteIp = (() => {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return null;
  })();
  if (!remoteIp) { console.log('    (no non-loopback address on this box -- not exercised)'); return; }
  const repo = fakeRepo('remote');
  const port = 8612;
  const srv = startServer({ port, dataDir: path.join(repo, 'data') });
  try {
    await srv.ready();
    const r = await postJson(`http://${remoteIp}:${port}/api/host/network`, { interface: 'en0' });
    assert.equal(r.status, 403, 'a phone cannot repoint the QR code');
    assert.ok(!fs.existsSync(path.join(repo, 'data', 'network.json')));
    const g = await getJson(`http://${remoteIp}:${port}/api/host/network`);
    assert.equal(g.status, 403, 'or even read it');
  } finally { srv.stop(); rm(repo); }
});

// 9 ------------------------------------------------------------------------
test('with the server down: Start offered, choice written straight to disk, starting shown', async () => {
  const repo = fakeRepo('down');
  const port = 8613;     // nothing listens here
  try {
    let m = menuOf({ repo, port });
    assert.equal(m.state, 'stopped');
    assert.equal(m.items[1].title, 'Guests: 192.168.1.40:8613', 'says what guests WILL get');
    assert.ok(itemOf(m, /^Start Jukebox$/).enabled);

    m = menuOf({ repo, port, publicUrl: 'http://jb.local:8613/' });
    assert.equal(m.items[1].title, 'Guests: jb.local:8613', 'uses jukebox.conf when the launcher passes it');

    const out = runHelper(['do', 'network', 'en0'], { repo, port });
    assert.ok(/Guests now get 10\.77\.0\.5:8613/.test(out));
    assert.equal(net.readNetworkChoice(path.join(repo, 'data', 'network.json')), 'en0');

    // The Dock app's marker, with a live pid: on its way up.
    const sleeper = spawn('sleep', ['20']);
    try {
      fs.writeFileSync(path.join(repo, 'data', 'launcher-starting.pid'), String(sleeper.pid));
      m = menuOf({ repo, port });
      assert.equal(m.state, 'starting');
      assert.equal(m.items[0].title, 'Jukebox is starting…');
    } finally { sleeper.kill(); }
    await sleep(100);
    fs.writeFileSync(path.join(repo, 'data', 'launcher-starting.pid'), '999999');
    assert.equal(menuOf({ repo, port }).state, 'stopped', 'a marker left by a dead launcher is ignored');
  } finally { rm(repo); }
});

// 10 -----------------------------------------------------------------------
test('start and stop go through Jukebox.app, and the page is always localhost', async () => {
  const repo = fakeRepo('actions');
  const port = 8614;
  try {
    const app = path.join(repo, 'Jukebox.app');
    assert.equal(runHelper(['do', 'start'], { repo, port }).trim(), `RUN /usr/bin/open -n -g ${app} --args start`);
    assert.equal(runHelper(['do', 'stop'], { repo, port }).trim(), `RUN /usr/bin/open -n -g ${app} --args stop`);
    assert.equal(runHelper(['do', 'open-page'], { repo, port }).trim(), `RUN /usr/bin/open http://localhost:${port}/`,
      'never the LAN address: only localhost gets host rights');
    assert.equal(runHelper(['do', 'install-update'], { repo, port }).trim(), `RUN /usr/bin/open ${path.join(repo, 'Update.command')}`);
    assert.throws(() => runHelper(['do', 'reboot'], { repo, port }), 'unknown actions are refused');
    const logText = fs.readFileSync(path.join(repo, 'data', 'menubar.log'), 'utf8');
    assert.ok(/helper: run \/usr\/bin\/open -n -g .* --args start/.test(logText), 'actions are logged');
  } finally { rm(repo); }
});

// 11 -----------------------------------------------------------------------
test('Install Update refuses while the jukebox is running', async () => {
  const repo = fakeRepo('install');
  const port = 8615;
  const srv = startServer({ port, dataDir: path.join(repo, 'data') });
  try {
    await srv.ready();
    const out = runHelper(['do', 'install-update'], { repo, port });
    assert.ok(!/^RUN/m.test(out), 'Update.command is not opened');
    assert.ok(/NOTIFY Stop the jukebox first/.test(out));
  } finally { srv.stop(); rm(repo); }
});

// 12 -----------------------------------------------------------------------
const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir(),
});
function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commitFile(cwd, file, text, msg) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  g(cwd, 'add', '-A');
  g(cwd, 'commit', '-q', '-m', msg);
}
// origin.git, plus a "dev" clone to publish from and an "install" clone that
// plays the party Mac.
function gitWorld(seed) {
  const top = tmpdir('git');
  const origin = path.join(top, 'origin.git');
  const dev = path.join(top, 'dev');
  const install = path.join(top, 'install');
  g(top, 'init', '-q', '--bare', '-b', 'main', origin);
  g(top, 'clone', '-q', origin, dev);
  g(dev, 'checkout', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(seed || { 'README.md': 'one\n' })) {
    fs.mkdirSync(path.dirname(path.join(dev, f)), { recursive: true });
    fs.writeFileSync(path.join(dev, f), t);
  }
  g(dev, 'add', '-A'); g(dev, 'commit', '-q', '-m', 'first');
  g(dev, 'push', '-q', '-u', 'origin', 'main');
  g(top, 'clone', '-q', origin, install);
  return { top, origin, dev, install };
}

test('Check for Updates: finds new commits, notices local edits, goes stale after a pull', () => {
  const w = gitWorld();
  const dataDir = path.join(w.top, 'data');
  const o = { repo: w.install, dataDir, port: 1, dryRun: true };
  const quiet = console.log; console.log = () => {};
  try {
    let r = helper.checkUpdates(o);
    assert.equal(r.state, 'current', 'nothing new yet');
    assert.equal(helper.updateView(o).state, 'current');

    commitFile(w.dev, 'README.md', 'two\n', 'Add the menu bar');
    commitFile(w.dev, 'b.txt', 'b\n', 'And another');
    g(w.dev, 'push', '-q');

    r = helper.checkUpdates(o);
    assert.equal(r.state, 'available');
    assert.equal(r.behind, 2);
    assert.deepEqual(r.subjects, ['And another', 'Add the menu bar']);
    assert.equal(r.dirty, false);
    assert.equal(g(w.install, 'rev-parse', 'HEAD'), r.local, 'checking never moves the checkout');
    assert.equal(fs.readFileSync(path.join(w.install, 'README.md'), 'utf8'), 'one\n', 'or touches a file');

    fs.writeFileSync(path.join(w.install, 'stray.txt'), 'x');
    assert.equal(helper.checkUpdates(o).dirty, true, 'an edit Update.command would refuse over is flagged');
    fs.unlinkSync(path.join(w.install, 'stray.txt'));

    g(w.install, 'pull', '-q', '--ff-only');            // what Update.command does
    assert.equal(helper.updateView(o).state, 'idle', '"update available" is stale once HEAD moves');
    assert.equal(helper.checkUpdates(o).state, 'current');
  } finally { console.log = quiet; rm(w.top); }
});

// 13 -----------------------------------------------------------------------
test('Check for Updates: offline, no upstream, and a check that died all say so', () => {
  const w = gitWorld();
  const dataDir = path.join(w.top, 'data');
  const o = { repo: w.install, dataDir, port: 1, dryRun: true };
  try {
    g(w.install, 'remote', 'set-url', 'origin', path.join(w.top, 'no-such-remote.git'));
    let r = helper.checkUpdates(o);
    assert.equal(r.state, 'error');
    assert.equal(r.message, 'Could not reach GitHub. Check the internet.');

    g(w.install, 'checkout', '-q', '-b', 'local-only');
    r = helper.checkUpdates(o);
    assert.equal(r.message, 'This copy is not following a branch on GitHub.');

    const notRepo = path.join(w.top, 'plain');
    fs.mkdirSync(notRepo);
    r = helper.checkUpdates({ repo: notRepo, dataDir, port: 1, dryRun: true });
    assert.equal(r.state, 'error', 'not a git checkout at all: an error, not a crash');

    fs.writeFileSync(path.join(dataDir, 'update-check.json'),
      JSON.stringify({ state: 'checking', pid: 999999, startedAt: Date.now() }));
    assert.equal(helper.updateView(o).state, 'error', 'a check whose process died is not still checking');
    fs.writeFileSync(path.join(dataDir, 'update-check.json'),
      JSON.stringify({ state: 'checking', pid: process.pid, startedAt: Date.now() }));
    assert.equal(helper.updateView(o).state, 'checking');
    assert.equal(helper.checkUpdates(o).state, 'checking', 'a second check does not start while one runs');
    fs.writeFileSync(path.join(dataDir, 'update-check.json'), 'garbage');
    assert.equal(helper.updateView(o).state, 'idle');
  } finally { rm(w.top); }
});

// ---------------------------------------------------------------------------
// menubar.js under a fake JXA bridge.
//
// STRICT: every object throws on any member it does not define, and refuses
// plain assignment. The members it does define are the real AppKit
// selectors, spelled the way JXA spells them (initWithTitle:action:
// keyEquivalent: -> initWithTitleActionKeyEquivalent; zero-argument methods
// called as properties). So a typo, or a method AppKit does not have, fails
// here rather than silently on the party Mac.
// ---------------------------------------------------------------------------
function strict(name, members) {
  members.isNil = () => false;
  return new Proxy(members, {
    get(t, k) {
      if (typeof k === 'symbol' || k === 'then' || k === 'toJSON' || k === 'inspect') return t[k];
      if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
      throw new Error(`fake JXA: ${name} has no member "${String(k)}"`);
    },
    set(t, k) { throw new Error(`fake JXA: ${name}.${String(k)} = ... (call the setter instead)`); },
  });
}

function makeBridge({ env }) {
  const rec = { shell: [], log: [], timers: [], policy: null, ran: false, terminated: false, removed: false };
  const classes = {};
  let controllerDef = null;

  const mkItem = (title, action, key) => {
    assert.equal(typeof title, 'string', 'item title is a string');
    assert.equal(action, 'menuAction:', 'every item routes to menuAction:');
    assert.equal(key, '', 'no key equivalents');
    const it = { title, enabled: true, state: 0, tag: 0, target: null, indent: 0 };
    return strict('NSMenuItem', {
      _it: it,
      setTarget: (x) => { it.target = x; },
      setTag: (n) => { assert.ok(Number.isInteger(n)); it.tag = n; },
      setEnabled: (b) => { assert.equal(typeof b, 'boolean'); it.enabled = b; },
      setState: (n) => { assert.ok(n === 0 || n === 1); it.state = n; },
      setIndentationLevel: (n) => { it.indent = n; },
      get tag() { return it.tag; },
    });
  };
  const separator = strict('NSMenuItem(separator)', { _it: { separator: true } });

  let items = [];
  const menu = strict('NSMenu', {
    get removeAllItems() { items = []; return undefined; },
    addItem: (i) => { items.push(i); },
    setAutoenablesItems: (b) => { rec.autoenables = b; },
    setDelegate: (d) => { rec.delegate = d; },
    get numberOfItems() { return items.length; },
    itemAtIndex: (i) => items[i],
  });

  const button = { image: null, title: null, disabled: null, tooltip: null, position: null };
  const statusItem = strict('NSStatusItem', {
    get button() {
      return strict('NSStatusBarButton', {
        setImage: (x) => { button.image = x; },
        setImagePosition: (n) => { button.position = n; },
        setTitle: (s) => { assert.equal(typeof s, 'string'); button.title = s; },
        setAppearsDisabled: (b) => { button.disabled = b; },
        setToolTip: (s) => { button.tooltip = s; },
      });
    },
    setMenu: (m) => { rec.menu = m; },
  });

  const app = strict('NSApplication', {
    setActivationPolicy: (n) => { rec.policy = n; return true; },
    get run() { rec.ran = true; return undefined; },
    terminate: (x) => { rec.terminated = true; },
  });

  const $ = strict('$', {
    NSApplication: strict('NSApplication class', { get sharedApplication() { return app; } }),
    NSStatusBar: strict('NSStatusBar class', {
      get systemStatusBar() {
        return strict('NSStatusBar', {
          statusItemWithLength: (n) => { assert.equal(n, -1, 'NSVariableStatusItemLength'); return statusItem; },
          removeStatusItem: (i) => { rec.removed = true; },
        });
      },
    }),
    NSMenu: strict('NSMenu class', {
      get alloc() { return strict('NSMenu alloc', { initWithTitle: (t) => menu }); },
    }),
    NSMenuItem: strict('NSMenuItem class', {
      get alloc() { return strict('NSMenuItem alloc', { initWithTitleActionKeyEquivalent: mkItem }); },
      get separatorItem() { return separator; },
    }),
    NSImage: strict('NSImage class', {
      imageWithSystemSymbolNameAccessibilityDescription: (n, d) => {
        assert.equal(n, 'music.note');
        return strict('NSImage', { setTemplate: (b) => { rec.template = b; } });
      },
    }),
    NSTimer: strict('NSTimer class', {
      scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats: (secs, target, sel, info, repeats) => {
        assert.equal(sel, 'tick:');
        rec.timers.push({ secs, repeats });
        return strict('NSTimer', { get invalidate() { return undefined; } });
      },
    }),
  });

  const ObjC = strict('ObjC', {
    import: (n) => { assert.equal(n, 'Cocoa'); },
    registerSubclass: (def) => {
      assert.equal(def.superclass, 'NSObject');
      for (const [sel, m] of Object.entries(def.methods)) {
        assert.ok(/^[A-Za-z]+:$/.test(sel), `selector ${sel}`);
        assert.deepEqual(m.types, ['void', ['id']], `${sel} types`);
        assert.equal(typeof m.implementation, 'function');
      }
      controllerDef = def;
      const call = (sel) => (arg) => def.methods[sel].implementation(arg);
      classes[def.name] = strict(def.name + ' class', {
        get alloc() {
          return strict(def.name + ' alloc', {
            get init() {
              return strict(def.name, {
                menuNeedsUpdate: call('menuNeedsUpdate:'),
                menuAction: call('menuAction:'),
                tick: call('tick:'),
                respondsToSelector: (s) => Object.prototype.hasOwnProperty.call(def.methods, s),
              });
            },
          });
        },
      });
      // $.JukeboxMenuController appears once registered, as in JXA.
      Object.defineProperty($, def.name, { get: () => classes[def.name] });
    },
  });

  const SA = new Proxy({ includeStandardAdditions: false }, {
    get(t, k) {
      if (k === 'includeStandardAdditions') return t[k];
      if (k === 'doShellScript') {
        return (cmd, opts) => {
          assert.ok(t.includeStandardAdditions, 'StandardAdditions switched on before use');
          assert.deepEqual(opts, { alteringLineEndings: false }, 'line endings left alone');
          rec.shell.push(cmd);
          // Like do shell script: /bin/sh, waits for stdout to close, throws on failure.
          const r = spawnSync('/bin/sh', ['-c', cmd], { env, encoding: 'utf8', timeout: 20000 });
          if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
          return r.stdout.replace(/\n$/, '');
        };
      }
      throw new Error(`fake JXA: StandardAdditions has no "${String(k)}"`);
    },
    set(t, k, v) {
      if (k !== 'includeStandardAdditions') throw new Error(`fake JXA: cannot set ${String(k)}`);
      t[k] = v; return true;
    },
  });
  const Application = strict('Application', { currentApplication: () => SA });

  const ctx = vm.createContext({
    ObjC, $, Application,
    console: { log: (...a) => { rec.log.push(a.join(' ')); vlog('jxa:', a.join(' ')); } },
  });
  vm.runInContext(fs.readFileSync(MENUBAR_JS, 'utf8'), ctx, { filename: 'menubar.js' });

  return {
    rec, button, ctx,
    items: () => items.map((i) => i._it),
    run: (argv) => ctx.run(argv),
    controller: () => controllerDef,
    openMenu: () => controllerDef.methods['menuNeedsUpdate:'].implementation(menu),
    click: (title) => {
      const i = items.find((x) => x._it.title === title);
      assert.ok(i, `no item "${title}" in ${JSON.stringify(items.map((x) => x._it.title))}`);
      assert.ok(i._it.enabled, `"${title}" is greyed out`);
      controllerDef.methods['menuAction:'].implementation(i);
    },
    tick: () => controllerDef.methods['tick:'].implementation(null),
  };
}

function jxaEnv(extra) {
  const env = Object.assign({}, process.env, {
    JUKEBOX_TEST_NETWORK: FAKE_NET_ENV, JUKEBOX_HELPER_DRYRUN: '1',
  }, extra || {});
  delete env.JUKEBOX_DATA_DIR;
  delete env.PUBLIC_URL;
  return env;
}

// 14 -----------------------------------------------------------------------
test('menubar.js: draws the helper\'s menu, and the icon follows the server', async () => {
  const repo = fakeRepo('jxa');
  const port = 8616;
  const b = makeBridge({ env: jxaEnv() });
  let srv = null;
  try {
    b.run([repo, NODE, String(port), '']);
    assert.ok(b.rec.ran, 'reached the event loop');
    assert.equal(b.rec.policy, 1, 'accessory: no Dock icon');
    assert.equal(b.rec.autoenables, false, 'AppKit must not re-enable greyed items');
    assert.ok(b.rec.delegate, 'menu delegate set, so it rebuilds on open');
    assert.ok(b.rec.menu, 'menu attached to the icon');
    assert.equal(b.rec.template, true);
    assert.deepEqual(b.rec.timers, [{ secs: 3, repeats: true }], 'one repeating state tick');
    assert.equal(b.button.disabled, true, 'greyed while stopped');
    assert.equal(b.button.title, '');

    b.openMenu();
    const expected = menuOf({ repo, port });
    const drawn = b.items();
    assert.equal(drawn.length, expected.items.length, 'one menu item per model item');
    expected.items.forEach((m, i) => {
      const d = drawn[i];
      if (m.separator) return assert.ok(d.separator, `item ${i} is a separator`);
      assert.equal(d.title, m.title);
      assert.equal(d.enabled, !!m.enabled, `"${m.title}" enabled`);
      assert.equal(d.state, m.checked ? 1 : 0, `"${m.title}" tick`);
      assert.equal(d.tag, i, 'tag is the index into the model');
      assert.equal(d.indent, m.indent || 0);
      assert.ok(d.target, 'every item targets the controller');
    });

    srv = startServer({ port, dataDir: path.join(repo, 'data') });
    await srv.ready();
    b.tick();
    assert.equal(b.button.disabled, false, 'bright once the server answers');
    b.openMenu();
    assert.equal(b.items()[0].title, 'Jukebox is running');
    assert.ok(/running · guests 192\.168\.1\.40:8616/.test(b.button.tooltip));

    srv.stop(); srv = null;
    await waitFor(async () => !(await getJson(`http://127.0.0.1:${port}/api/config`)), { label: 'server gone' });
    b.tick();
    assert.equal(b.button.disabled, true, 'greyed again once it stops');

    // The Dock app on its way up.
    const sleeper = spawn('sleep', ['20']);
    try {
      fs.writeFileSync(path.join(repo, 'data', 'launcher-starting.pid'), String(sleeper.pid));
      b.tick();
      assert.equal(b.button.title, '…', 'an ellipsis while starting');
      assert.equal(b.button.disabled, false);
    } finally { sleeper.kill(); fs.unlinkSync(path.join(repo, 'data', 'launcher-starting.pid')); }
  } finally { if (srv) srv.stop(); rm(repo); }
});

// 15 -----------------------------------------------------------------------
test('menubar.js: clicks reach the helper in the background, and Quit quits', async () => {
  const repo = fakeRepo('jxa-click');
  const port = 8617;
  const b = makeBridge({ env: jxaEnv() });
  try {
    b.run([repo, NODE, String(port), 'http://jb.local:8617/']);
    b.openMenu();
    assert.equal(b.items()[1].title, 'Guests: jb.local:8617', 'the launcher\'s PUBLIC_URL reaches the helper');

    const logFile = path.join(repo, 'data', 'menubar.log');
    const t0 = Date.now();
    b.click('Start Jukebox');
    assert.ok(Date.now() - t0 < 1500, 'the click returns at once, it does not wait for the helper');
    const bg = b.rec.shell[b.rec.shell.length - 1];
    assert.ok(/ 'do' 'start' >>'[^']*menubar\.log' 2>&1 &$/.test(bg), 'backgrounded with all output redirected: ' + bg);
    await waitFor(() => /RUN \/usr\/bin\/open -n -g .*Jukebox\.app --args start/.test(fs.readFileSync(logFile, 'utf8')),
      { label: 'the helper to run start', timeout: 8000 });
    assert.deepEqual(b.rec.timers.slice(-1), [{ secs: 1, repeats: false }], 'and looks again sooner');

    b.click('Ethernet (en0) — 10.77.0.5');
    await waitFor(() => net.readNetworkChoice(path.join(repo, 'data', 'network.json')) === 'en0',
      { label: 'the adapter choice', timeout: 8000 });
    b.openMenu();
    assert.equal(b.items().find((i) => /\(en0\)/.test(i.title)).state, 1, 'ticked next time it opens');

    // Headers and greyed items do nothing, even if AppKit were to call them.
    const before = b.rec.shell.length;
    b.controller().methods['menuAction:'].implementation(strict('NSMenuItem', { get tag() { return 0; } }));
    b.controller().methods['menuAction:'].implementation(strict('NSMenuItem', { get tag() { return 999; } }));
    assert.equal(b.rec.shell.length, before, 'no shell for a header or a stale tag');

    b.click('Quit Menu Bar Icon');
    assert.ok(b.rec.terminated);
  } finally { rm(repo); }
});

// 16 -----------------------------------------------------------------------
test('menubar.js: a broken helper still leaves a working menu', () => {
  const repo = fakeRepo('jxa-broken');
  const b = makeBridge({ env: jxaEnv() });
  try {
    b.run([repo, '/nonexistent/node', '8618', '']);
    b.openMenu();
    const t = b.items().filter((i) => !i.separator).map((i) => i.title);
    assert.ok(/^Menu unavailable/.test(t[0]), t[0]);
    assert.deepEqual(t.slice(1), ['Details are in data/menubar.log', 'Open Jukebox Page', 'Quit Menu Bar Icon']);
    b.click('Open Jukebox Page');
    assert.ok(/^\/usr\/bin\/open 'http:\/\/localhost:8618\/' >\/dev\/null 2>&1 &$/.test(b.rec.shell[b.rec.shell.length - 1]));
    assert.ok(b.rec.log.some((l) => /helper menu failed/.test(l)), 'and says why in the log');
  } finally { rm(repo); }
});

// 17 -----------------------------------------------------------------------
test('menubar.js --selftest passes against the fake bridge and leaves no icon', () => {
  const repo = fakeRepo('jxa-self');
  const b = makeBridge({ env: jxaEnv() });
  try {
    const r = b.run(['--selftest', repo, NODE, '8619', '']);
    assert.equal(r, 'PASS', b.rec.log.join('\n'));
    assert.ok(!b.rec.ran, 'never enters the event loop');
    assert.ok(b.rec.removed, 'removes its icon');
    assert.ok(b.rec.log.some((l) => /ALL PASSED/.test(l)));
  } finally { rm(repo); }
});

// 18 -----------------------------------------------------------------------
test('menubar.js quotes everything it hands the shell', () => {
  const repo = fakeRepo("it's a 'test' $(x)");
  const b = makeBridge({ env: jxaEnv() });
  try {
    b.run([repo, NODE, '8620', '']);
    b.openMenu();
    assert.equal(b.items()[0].title, 'Jukebox is stopped', 'a repo path with quotes and $() still works');
  } finally { rm(repo); }
});

// ---------------------------------------------------------------------------
// The launcher and Update.command, run for real with the Mac-only tools
// (open, osascript, caffeinate, /usr/sbin/lsof) replaced by stubs that log.
// ---------------------------------------------------------------------------
function stubDir(top) {
  const dir = path.join(top, 'stubs');
  fs.mkdirSync(dir);
  const calls = path.join(top, 'calls.log');
  const w = (name, body) => {
    fs.writeFileSync(path.join(dir, name), '#!/bin/bash\n' + body + '\n');
    fs.chmodSync(path.join(dir, name), 0o755);
  };
  w('open', `echo "open $*" >> '${calls}'`);
  w('caffeinate', `echo "caffeinate $*" >> '${calls}'`);
  // The menu bar launch stays alive (so pgrep can find it); notifications return at once.
  w('osascript', `echo "osascript $*" >> '${calls}'\ncase "$*" in *menubar.js*) sleep 30 ;; esac`);
  // The real lsof by absolute path: a bare "lsof" would find this stub again.
  const realLsof = ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'].find((p) => fs.existsSync(p));
  w('lsof', `exec ${realLsof} "$@"`);
  return { dir, calls, read: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '') };
}

// The icon pattern is narrowed to this test's own temp folder, so that on a
// Mac the suite neither kills the REAL menu bar icon nor mistakes it for the
// one under test.
const ICON_PATTERN = "MENU_PATTERN='osascript -l JavaScript .*menubar/menubar[.]js'";
const scopedPattern = (scope) => `osascript -l JavaScript .*${scope}.*menubar/menubar[.]js`;

function stubbed(src, stubs, scope) {
  assert.ok(src.includes(ICON_PATTERN), 'the script still finds the icon with the pattern this suite expects');
  return src.split('/usr/sbin/lsof').join(path.join(stubs.dir, 'lsof'))
            .split('/usr/bin/osascript').join(path.join(stubs.dir, 'osascript'))
            .split(ICON_PATTERN).join(`MENU_PATTERN='${scopedPattern(scope)}'`);
}

function killMenubars(scope) {
  spawnSync('pkill', ['-f', scopedPattern(scope)]);
}

// 19 -----------------------------------------------------------------------
test('Jukebox.app: start, start again, stop, stop again, toggle -- and the icon comes up once', async () => {
  if (!fs.existsSync('/bin/bash')) { console.log('    (no bash -- not exercised)'); return; }
  if (!['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'].some((p) => fs.existsSync(p))) {
    console.log('    (no lsof -- not exercised)'); return;
  }
  const top = tmpdir('launcher');
  const scope = path.basename(top);
  const repo = path.join(top, 'repo');
  const port = 8621;
  const stubs = stubDir(top);
  const macos = path.join(repo, 'Jukebox.app', 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(path.join(repo, 'menubar'));
  fs.writeFileSync(path.join(repo, 'menubar', 'menubar.js'), '// stand-in\n');
  fs.symlinkSync(path.join(ROOT, 'server.js'), path.join(repo, 'server.js'));
  const launcher = path.join(macos, 'Jukebox');
  fs.writeFileSync(launcher, stubbed(fs.readFileSync(path.join(ROOT, 'Jukebox.app/Contents/MacOS/Jukebox'), 'utf8'), stubs, scope));
  fs.chmodSync(launcher, 0o755);

  const env = Object.assign({}, process.env, {
    PATH: stubs.dir + ':' + path.dirname(NODE) + ':' + process.env.PATH,
    PORT: String(port), MOCK: '1', MOCK_LIBRARY: '150',
    JUKEBOX_DATA_DIR: path.join(top, 'server-data'), JUKEBOX_TEST_NETWORK: FAKE_NET_ENV,
  });
  delete env.PUBLIC_URL;
  const L = (...args) => {
    const r = spawnSync('/bin/bash', [launcher, ...args], { env, encoding: 'utf8', timeout: 60000 });
    vlog(`Jukebox ${args.join(' ')} -> ${r.status}`);
    return r.status;
  };
  const up = async () => !!(await getJson(`http://127.0.0.1:${port}/api/config`));
  const menubarLaunches = () => (stubs.read().match(/osascript -l JavaScript .*menubar\.js/g) || []).length;
  const listener = () => spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();

  try {
    assert.equal(L('start'), 0);
    assert.ok(await up(), 'start starts it');
    const calls = stubs.read();
    assert.ok(calls.includes(`open http://localhost:${port}/`), 'and opens the page');
    assert.ok(calls.includes('open -ga Music'), 'and Music');
    assert.ok(/caffeinate -dimsu -t 43200 -w \d+/.test(calls), 'and keeps the Mac awake, capped');
    // Whichever node it found first: /usr/local/bin/node and friends, as on a Mac.
    const launch = new RegExp(`osascript -l JavaScript ${path.join(repo, 'menubar', 'menubar.js')} ${repo} (\\S*node) ${port} \n`);
    const m = launch.exec(calls);
    assert.ok(m, 'and puts the icon up with the repo, node and port:\n' + calls);
    assert.ok(fs.existsSync(m[1]), 'with a node that exists');
    assert.equal(menubarLaunches(), 1);
    assert.ok(!fs.existsSync(path.join(repo, 'data', 'launcher-starting.pid')), 'the starting marker is cleared on exit');
    const pid = listener();

    assert.equal(L('start'), 0);
    assert.equal(listener(), pid, 'start while running starts nothing new');
    assert.equal((stubs.read().match(new RegExp(`open http://localhost:${port}/`, 'g')) || []).length, 2, 'it just opens the page');
    assert.equal(menubarLaunches(), 1, 'the icon is not started twice');

    assert.equal(L('menu'), 0);
    assert.ok(await up(), '"menu" leaves the jukebox alone');
    assert.equal(menubarLaunches(), 1);

    assert.equal(L('stop'), 0);
    assert.ok(!(await up()), 'stop stops it');
    assert.ok(stubs.read().includes('Stopped. Music carries on playing.'));

    assert.equal(L('stop'), 0);
    assert.ok(!(await up()), 'stop while stopped starts nothing');
    assert.ok(stubs.read().includes('Already stopped.'));

    assert.equal(L(), 0);
    assert.ok(await up(), 'the Dock click (no verb) still toggles on');
    assert.equal(L('-psn_0_12345'), 0);
    assert.ok(!(await up()), 'and off -- old-style Finder arguments count as the toggle');

    // Turned off in jukebox.conf.
    killMenubars(scope);
    await sleep(200);
    fs.writeFileSync(path.join(repo, 'jukebox.conf'), 'JUKEBOX_MENU_BAR=0\n');
    const before = menubarLaunches();
    assert.equal(L('menu'), 0);
    assert.equal(menubarLaunches(), before, 'JUKEBOX_MENU_BAR=0 keeps the icon away');
  } finally {
    const p = listener();
    if (p) spawnSync('kill', ['-9', ...p.split(/\s+/)]);
    killMenubars(scope);
    rm(top);
  }
});

// 20 -----------------------------------------------------------------------
test('Update.command: pulls, then restarts the icon only if it was running; refuses mid-party', async () => {
  const port = 8622;
  const seed = {
    'README.md': 'one\n',
    'test/mock-suite.js': 'process.exit(0)\n',      // the real gate is tested elsewhere
    'Jukebox.app/Contents/Info.plist': '<plist/>\n',
  };
  const w = gitWorld(seed);
  const stubs = stubDir(w.top);
  const scope = path.basename(w.top);
  const src = stubbed(fs.readFileSync(path.join(ROOT, 'Update.command'), 'utf8'), stubs, scope);
  const env = Object.assign({}, GIT_ENV, {
    PATH: stubs.dir + ':' + path.dirname(NODE) + ':' + process.env.PATH, PORT: String(port),
  });
  // Committed into the "installed" copy so it is part of the checkout, as on the Mac.
  const installUpdate = () => {
    fs.writeFileSync(path.join(w.install, 'Update.command'), src);
    fs.chmodSync(path.join(w.install, 'Update.command'), 0o755);
  };
  const runUpdate = () => spawnSync('/bin/bash', [path.join(w.install, 'Update.command')],
    { cwd: w.install, env, encoding: 'utf8', input: '', timeout: 60000 });
  // A stand-in for the running icon: a process whose command line reads like its launch line.
  const fakeIcon = () => spawn(NODE, ['-e', 'setTimeout(() => {}, 30000)', 'osascript', '-l', 'JavaScript', `/${scope}/menubar/menubar.js`],
    { stdio: 'ignore' });
  // And one that only mentions the file, like an editor with it open. It must survive.
  const editor = spawn(NODE, ['-e', 'setTimeout(() => {}, 30000)', 'vim', `/${scope}/menubar/menubar.js`], { stdio: 'ignore' });

  try {
    // Ship the same Update.command in the repo so the pull does not touch it.
    fs.writeFileSync(path.join(w.dev, 'Update.command'), src);
    fs.chmodSync(path.join(w.dev, 'Update.command'), 0o755);
    g(w.dev, 'add', '-A'); g(w.dev, 'commit', '-q', '-m', 'ship updater'); g(w.dev, 'push', '-q');
    g(w.install, 'pull', '-q', '--ff-only');
    installUpdate();

    commitFile(w.dev, 'README.md', 'two\n', 'Menu bar icon');
    g(w.dev, 'push', '-q');

    const icon = fakeIcon();
    await sleep(150);
    let r = runUpdate();
    vlog(r.stdout);
    assert.ok(/Updated [0-9a-f]+ -> [0-9a-f]+/.test(r.stdout), r.stdout);
    assert.ok(/Menu bar icon/.test(r.stdout), 'lists what changed');
    assert.ok(/All good/.test(r.stdout));
    assert.ok(/Restarted the menu bar icon/.test(r.stdout), 'restarts the icon');
    await waitFor(() => icon.exitCode !== null || icon.signalCode !== null, { label: 'the old icon to be stopped', timeout: 3000 });
    assert.ok(stubs.read().includes(`open -g -n ${w.install}/Jukebox.app --args menu`), 'and starts it again via Jukebox.app');
    assert.ok(editor.exitCode === null && editor.signalCode === null, 'an editor with menubar.js open is left alone');
    editor.kill();

    // Nothing running: no icon conjured up.
    commitFile(w.dev, 'README.md', 'three\n', 'Another');
    g(w.dev, 'push', '-q');
    const opensBefore = (stubs.read().match(/--args menu/g) || []).length;
    r = runUpdate();
    assert.ok(/All good/.test(r.stdout), r.stdout);
    assert.ok(!/Restarted the menu bar icon/.test(r.stdout), 'someone who quit the icon does not get it back');
    assert.equal((stubs.read().match(/--args menu/g) || []).length, opensBefore);

    // Mid-party: refuses, says how to stop.
    const busy = http.createServer((q, s) => s.end('x'));
    await new Promise((res) => busy.listen(port, '127.0.0.1', res));
    try {
      r = runUpdate();
      assert.ok(/The jukebox is RUNNING/.test(r.stdout));
      assert.ok(/Stop Jukebox in the menu bar/.test(r.stdout));
    } finally { busy.close(); }
  } finally {
    killMenubars(scope);
    try { editor.kill(); } catch (e) {}
    rm(w.top);
  }
});

// 21 -----------------------------------------------------------------------
test('on a Mac: menubar.js --selftest against the real AppKit, and the real adapters', () => {
  if (process.platform !== 'darwin') {
    console.log('    (not a Mac -- run this suite on the party Mac to exercise the real menu bar)');
    return;
  }
  const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', MENUBAR_JS, '--selftest', ROOT, NODE, process.env.PORT || '8484'],
    { encoding: 'utf8', timeout: 60000 });
  const lines = (r.stderr || '').split('\n').filter(Boolean);
  for (const l of lines) console.log('    ' + l.replace(/^\[menubar\] /, ''));
  assert.equal(r.stdout.trim(), 'PASS', 'osascript selftest: ' + (r.stdout || r.error || r.status));

  const env = Object.assign({}, process.env);
  delete env.JUKEBOX_TEST_NETWORK;
  const view = JSON.parse(execFileSync(NODE, [HELPER, 'view', '--repo', ROOT], { env, encoding: 'utf8' }));
  console.log('    adapters: ' + (view.network.adapters.map(helper.adapterTitle).join(' | ') || 'none'));
  console.log('    guests get: ' + (view.network.guestUrl || 'nothing') + ' (' + view.network.source + ')');
  assert.ok(Object.keys(view.network.labels).length > 0, 'networksetup named the adapters');
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  const t0 = Date.now();
  console.log('\nMENU BAR SUITE\n' + '='.repeat(72));
  const only = process.env.ONLY;
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
    const started = Date.now();
    try {
      await t.fn();
      console.log(`PASS  ${t.name}  (${Date.now() - started}ms)`);
      pass++;
    } catch (e) {
      console.log(`FAIL  ${t.name}  (${Date.now() - started}ms)`);
      console.log(`      ${e.message}`);
      if (VERBOSE && e.stack) console.log(e.stack.split('\n').slice(1, 5).join('\n'));
      fail++;
    }
  }
  console.log('='.repeat(72));
  console.log(`${pass} passed, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  process.exit(fail ? 1 : 0);
})();
